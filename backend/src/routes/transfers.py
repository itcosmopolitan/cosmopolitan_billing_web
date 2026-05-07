import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.models import Branch, StockTransfer, TransferLineItem
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import adjust_stock_atomic
from src.routes._serializers import serialize_transfer
from src.security import require_perm

router = APIRouter()

class TransferLine(BaseModel):
    item_id: str
    item_name: str
    qty: int

class TransferCreate(BaseModel):
    from_branch_id: str
    to_branch_id: str
    requested_by: str
    items: List[TransferLine]
    priority: str = "Normal"
    notes: Optional[str] = None
    expected_date: Optional[str] = None

@router.get("/", dependencies=[Depends(require_perm("transfers.view"))])
async def list_transfers(
    status: Optional[str] = None,
    from_branch: Optional[str] = None,
    to_branch: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "ref_number": StockTransfer.ref_number,
            "from_branch_id": StockTransfer.from_branch_id,
            "to_branch_id": StockTransfer.to_branch_id,
            "status": StockTransfer.status,
            "requested_by": StockTransfer.requested_by,
            "created_at": StockTransfer.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = select(StockTransfer).options(selectinload(StockTransfer.items)).order_by(sort_expr)
    cq = select(func.count(StockTransfer.id))
    if status:
        q = q.where(StockTransfer.status == status)
        cq = cq.where(StockTransfer.status == status)
    if from_branch:
        q = q.where(StockTransfer.from_branch_id == from_branch)
        cq = cq.where(StockTransfer.from_branch_id == from_branch)
    if to_branch:
        q = q.where(StockTransfer.to_branch_id == to_branch)
        cq = cq.where(StockTransfer.to_branch_id == to_branch)
    total = int((await db.execute(cq)).scalar() or 0)
    br_result = await db.execute(select(Branch))
    branch_map = {b.id: b.name for b in br_result.scalars().all()}
    result = await db.execute(q.offset(sk).limit(lim))
    transfers = result.unique().scalars().all()
    out = []
    for t in transfers:
        lines = t.items or []
        d = serialize_transfer(t)
        d["from_branch_name"] = branch_map.get(t.from_branch_id, t.from_branch_id)
        d["to_branch_name"] = branch_map.get(t.to_branch_id, t.to_branch_id)
        d["items"] = [{"item_id": ln.item_id, "name": ln.item_name, "qty": ln.qty} for ln in lines]
        out.append(d)
    return paged(out, total, sk, lim)

@router.post("/", status_code=201, dependencies=[Depends(require_perm("transfers.create"))])
async def create_transfer(data: TransferCreate, db: AsyncSession = Depends(get_db)):
    if data.from_branch_id == data.to_branch_id:
        raise HTTPException(400, "Source and destination branches must differ")
    tid = str(uuid.uuid4())
    # Sequential-ish ref number — single COUNT(*) query, no result thrown away.
    count = int((await db.execute(select(func.count(StockTransfer.id)))).scalar() or 0)
    ref = f"TRF-{datetime.now().year}-{str(count + 42).zfill(3)}"

    # Fetch branch names
    from_branch_result = await db.execute(select(Branch).where(Branch.id == data.from_branch_id))
    from_branch = from_branch_result.scalar_one_or_none()
    to_branch_result = await db.execute(select(Branch).where(Branch.id == data.to_branch_id))
    to_branch = to_branch_result.scalar_one_or_none()

    t = StockTransfer(
        id=tid, ref_number=ref,
        from_branch_id=data.from_branch_id,
        from_branch_name=from_branch.name if from_branch else data.from_branch_id,
        to_branch_id=data.to_branch_id,
        to_branch_name=to_branch.name if to_branch else data.to_branch_id,
        requested_by=data.requested_by, status="pending", notes=data.notes,
    )
    db.add(t)
    for item in data.items:
        line = TransferLineItem(id=str(uuid.uuid4()), transfer_id=tid,
                                item_id=item.item_id, item_name=item.item_name,
                                qty=item.qty)
        db.add(line)
    await db.commit()
    return {"id": tid, "ref_number": ref, "status": "pending"}

@router.post("/{transfer_id}/approve", dependencies=[Depends(require_perm("transfers.approve"))])
async def approve_transfer(transfer_id: str, approved_by: str = "Admin", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    if t.status != "pending":
        raise HTTPException(400, f"Transfer is already {t.status}")
    t.status = "transit"
    t.approved_by = approved_by
    # Deduct from source stock atomically. If a line over-draws (race with a
    # concurrent sale), clamp to zero rather than reject the whole transfer.
    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        try:
            await adjust_stock_atomic(
                db,
                item_id=line.item_id,
                branch_id=t.from_branch_id,
                delta=-line.qty,
            )
        except ValueError:
            # Insufficient stock at source — clamp source to zero. The audit
            # log will surface the discrepancy in Phase 4.
            from sqlalchemy import text
            await db.execute(
                text(
                    "UPDATE item_stock SET quantity = 0 "
                    "WHERE item_id = :i AND branch_id = :b"
                ),
                {"i": line.item_id, "b": t.from_branch_id},
            )
    await db.commit()
    return {"status": "transit", "approved_by": approved_by}

@router.post("/{transfer_id}/receive", dependencies=[Depends(require_perm("transfers.receive"))])
async def receive_transfer(transfer_id: str, received_by: str = "Staff", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    if t.status != "transit":
        raise HTTPException(400, "Transfer must be in transit to receive")
    t.status = "received"
    # Add to destination stock atomically (creates the row if missing).
    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        await adjust_stock_atomic(
            db,
            item_id=line.item_id,
            branch_id=t.to_branch_id,
            delta=line.qty,
        )
    await db.commit()
    return {"status": "received", "received_by": received_by}

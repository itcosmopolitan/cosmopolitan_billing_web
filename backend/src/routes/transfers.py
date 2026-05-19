import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.models import Branch, StockTransfer, TransferLineItem
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import (
    add_batch_atomic,
    adjust_stock_atomic,
    consume_batches_atomic,
    is_tracked,
)
from src.routes._serializers import serialize_transfer
from src.security import require_perm

router = APIRouter()

class TransferAllocationEntry(BaseModel):
    """One source-batch entry of an explicit per-line split. Sum of `qty`
    must equal the line's qty when the operator pre-allocates.

    `qty > 0` enforced at the schema layer — see BatchAllocationEntry in
    sales.py for why (negative qty sneaking past the sum-check would corrupt
    the SUM(batches) == item_stock invariant on approve).
    """
    batch_id: str
    qty: int = Field(..., gt=0)


class TransferLine(BaseModel):
    item_id: str
    item_name: str
    qty: int
    # ── Source batch hints (precedence: allocation > batch_id > auto) ──
    # `batch_allocation`: explicit per-line split set by the operator in the
    # New Transfer modal. Honored as-is on approve.
    # `batch_id`: legacy single-batch shortcut (consumed first, rest auto).
    batch_allocation: Optional[List[TransferAllocationEntry]] = None
    batch_id: Optional[str] = None

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
        d["items"] = [_line_dict(ln) for ln in lines]
        out.append(d)
    return paged(out, total, sk, lim)


def _line_dict(ln: TransferLineItem) -> dict:
    """Serialize a transfer line, including any persisted batch manifest so
    the detail view can show:
      • `requested_allocation` — operator's pre-approval split (if any).
      • `batches` — the actual lots drained on approve (post-approve only).
    """
    import json as _json

    def _safe_parse(raw):
        if not raw:
            return []
        try:
            v = _json.loads(raw)
            return v if isinstance(v, list) else []
        except Exception:
            return []

    return {
        "item_id":              ln.item_id,
        "name":                 ln.item_name,
        "qty":                  ln.qty,
        "preferred_batch_id":   ln.preferred_batch_id,
        "requested_allocation": _safe_parse(ln.requested_allocation),
        "batches":              _safe_parse(ln.batch_allocation),
    }

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
    import json as _json
    for item in data.items:
        requested = (
            _json.dumps([e.model_dump() for e in item.batch_allocation])
            if item.batch_allocation else None
        )
        line = TransferLineItem(
            id=str(uuid.uuid4()), transfer_id=tid,
            item_id=item.item_id, item_name=item.item_name,
            qty=item.qty, preferred_batch_id=item.batch_id,
            requested_allocation=requested,
        )
        db.add(line)
    await db.commit()
    return {"id": tid, "ref_number": ref, "status": "pending"}

@router.post("/{transfer_id}/approve", dependencies=[Depends(require_perm("transfers.approve"))])
async def approve_transfer(transfer_id: str, approved_by: str = "Admin", db: AsyncSession = Depends(get_db)):
    """Approve & dispatch a transfer.

    For tracked items we consume source batches in FIFO/FEFO order (honoring
    the operator-picked `preferred_batch_id` if it has stock) and persist the
    consumption manifest onto `TransferLineItem.batch_allocation` so that:
      • `receive()` can recreate the same batches at the destination, and
      • the UI can render which lots were drained from source.

    For untracked items we just decrement aggregate stock as before.
    """
    import json
    from sqlalchemy import text as _text

    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    if t.status != "pending":
        raise HTTPException(400, f"Transfer is already {t.status}")
    t.status = "transit"
    t.approved_by = approved_by

    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        tracked, expiry_tracked = await is_tracked(db, line.item_id)
        if tracked:
            strategy = "fefo" if expiry_tracked else "fifo"
            # Parse operator's explicit split (if any) — saved by create_transfer.
            explicit = None
            if line.requested_allocation:
                try:
                    parsed = json.loads(line.requested_allocation)
                    if isinstance(parsed, list) and parsed:
                        explicit = parsed
                except Exception:
                    explicit = None
            try:
                consumed = await consume_batches_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=t.from_branch_id,
                    qty=line.qty,
                    strategy=strategy,
                    preferred_batch_id=line.preferred_batch_id,
                    explicit_allocation=explicit,
                )
            except ValueError:
                # Two very different failure modes land here:
                #   (a) the operator's `explicit` allocation is invalid for
                #       this source branch — wrong batch_id, batch belongs to
                #       a different branch (e.g. the source branch was changed
                #       in the UI after batches were picked), or insufficient
                #       stock on a specific picked batch.
                #   (b) genuine shortage at the source — even FIFO/FEFO can't
                #       satisfy `line.qty` because the branch is short.
                # The legacy code path treated both the same way (zero out
                # ALL batches AND item_stock for the item at the source
                # branch), which is catastrophically wrong for case (a) —
                # we'd destroy perfectly good stock because the cart sent a
                # batch_id from a different branch. So: if we had an explicit
                # allocation, retry once without it (auto FIFO/FEFO at the
                # real source). Only if THAT also fails do we accept that the
                # source is genuinely short and fall back to the clamp.
                consumed = []
                if explicit:
                    try:
                        consumed = await consume_batches_atomic(
                            db,
                            item_id=line.item_id,
                            branch_id=t.from_branch_id,
                            qty=line.qty,
                            strategy=strategy,
                            preferred_batch_id=line.preferred_batch_id,
                            explicit_allocation=None,
                        )
                    except ValueError:
                        consumed = []
                if not consumed:
                    # Genuine shortage at source — clamp and let receive()
                    # fall back to one anonymous destination batch (Phase 4
                    # audit will flag the gap).
                    await db.execute(
                        _text(
                            "UPDATE item_batches SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": line.item_id, "b": t.from_branch_id},
                    )
                    await db.execute(
                        _text(
                            "UPDATE item_stock SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": line.item_id, "b": t.from_branch_id},
                    )
            line.batch_allocation = json.dumps(consumed)
        else:
            try:
                await adjust_stock_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=t.from_branch_id,
                    delta=-line.qty,
                )
            except ValueError:
                await db.execute(
                    _text(
                        "UPDATE item_stock SET quantity = 0 "
                        "WHERE item_id = :i AND branch_id = :b"
                    ),
                    {"i": line.item_id, "b": t.from_branch_id},
                )
    await db.commit()
    return {"status": "transit", "approved_by": approved_by}

@router.post("/{transfer_id}/receive", dependencies=[Depends(require_perm("transfers.receive"))])
async def receive_transfer(transfer_id: str, received_by: str = "Staff", db: AsyncSession = Depends(get_db)):
    """Receive a dispatched transfer.

    Replays each line's persisted allocation manifest: every source batch
    that was drained on approve is recreated at the destination with the same
    lot number / expiry / cost so FIFO/FEFO ordering carries across branches.
    Untracked items just bump the destination aggregate.
    """
    import json
    from src.models import ItemBatch

    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    if t.status != "transit":
        raise HTTPException(400, "Transfer must be in transit to receive")
    t.status = "received"

    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        tracked, _expiry = await is_tracked(db, line.item_id)
        allocation: list = []
        if tracked and line.batch_allocation:
            try:
                parsed = json.loads(line.batch_allocation)
                if isinstance(parsed, list):
                    allocation = parsed
            except Exception:
                allocation = []

        if tracked and allocation:
            for entry in allocation:
                # Look up the source batch row by id to copy its metadata
                # 1:1 onto the new destination batch.
                src_res = await db.execute(
                    select(ItemBatch).where(ItemBatch.id == entry["batch_id"])
                )
                src = src_res.scalar_one_or_none()
                await add_batch_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=t.to_branch_id,
                    qty=int(entry.get("consumed") or 0),
                    batch_number=(src.batch_number if src else entry.get("batch_number")),
                    mfg_date=(src.mfg_date if src else None),
                    expiry_date=(src.expiry_date if src else entry.get("expiry_date")),
                    cost_price=(src.cost_price if src else 0),
                    vendor_id=(src.vendor_id if src else None),
                    source_type="transfer",
                    source_ref=transfer_id,
                    received_date=(src.received_date if src else None),
                )
        elif tracked:
            # No allocation persisted (e.g. legacy transfer approved before
            # this column existed). Create a single transfer batch carrying
            # the line qty so destination stock at least balances.
            await add_batch_atomic(
                db,
                item_id=line.item_id,
                branch_id=t.to_branch_id,
                qty=line.qty,
                source_type="transfer",
                source_ref=transfer_id,
            )
        else:
            await adjust_stock_atomic(
                db,
                item_id=line.item_id,
                branch_id=t.to_branch_id,
                delta=line.qty,
            )
    await db.commit()
    return {"status": "received", "received_by": received_by}

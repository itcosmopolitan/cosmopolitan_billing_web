from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from sqlalchemy.orm import selectinload
from src.database import get_db
from src.models import StockTransfer, TransferLineItem, ItemStock, Branch
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
import uuid

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

@router.get("/")
async def list_transfers(
    status: Optional[str] = None,
    from_branch: Optional[str] = None,
    to_branch: Optional[str] = None,
    db: AsyncSession = Depends(get_db)
):
    q = select(StockTransfer).order_by(StockTransfer.created_at.desc())
    if status:      q = q.where(StockTransfer.status == status)
    if from_branch: q = q.where(StockTransfer.from_branch_id == from_branch)
    if to_branch:   q = q.where(StockTransfer.to_branch_id == to_branch)
    result = await db.execute(q)
    transfers = result.scalars().all()
    out = []
    for t in transfers:
        lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == t.id))
        lines = lines_result.scalars().all()
        
        # Fetch branch names
        from_branch_result = await db.execute(select(Branch).where(Branch.id == t.from_branch_id))
        from_branch = from_branch_result.scalar_one_or_none()
        to_branch_result = await db.execute(select(Branch).where(Branch.id == t.to_branch_id))
        to_branch = to_branch_result.scalar_one_or_none()
        
        d = _t_dict(t)
        d["from_branch_name"] = from_branch.name if from_branch else t.from_branch_id
        d["to_branch_name"] = to_branch.name if to_branch else t.to_branch_id
        d["items"] = [{"item_id": l.item_id, "name": l.item_name, "qty": l.qty, } for l in lines]
        out.append(d)
    return out

@router.post("/", status_code=201)
async def create_transfer(data: TransferCreate, db: AsyncSession = Depends(get_db)):
    if data.from_branch_id == data.to_branch_id:
        raise HTTPException(400, "Source and destination branches must differ")
    tid = str(uuid.uuid4())
    count_result = await db.execute(select(StockTransfer))
    count = len((await db.execute(select(StockTransfer))).scalars().all())
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

@router.post("/{transfer_id}/approve")
async def approve_transfer(transfer_id: str, approved_by: str = "Admin", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t: raise HTTPException(404, "Transfer not found")
    if t.status != "pending": raise HTTPException(400, f"Transfer is already {t.status}")
    t.status = "transit"
    t.approved_by = approved_by
    # Deduct from source stock
    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        stock_result = await db.execute(select(ItemStock).where(and_(ItemStock.item_id == line.item_id, ItemStock.branch_id == t.from_branch_id)))
        stock = stock_result.scalar_one_or_none()
        if stock: stock.quantity = max(0, stock.quantity - line.qty)
    await db.commit()
    return {"status": "transit", "approved_by": approved_by}

@router.post("/{transfer_id}/receive")
async def receive_transfer(transfer_id: str, received_by: str = "Staff", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t: raise HTTPException(404, "Transfer not found")
    if t.status != "transit": raise HTTPException(400, "Transfer must be in transit to receive")
    t.status = "received"
    # Add to destination stock
    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        stock_result = await db.execute(select(ItemStock).where(and_(ItemStock.item_id == line.item_id, ItemStock.branch_id == t.to_branch_id)))
        stock = stock_result.scalar_one_or_none()
        if stock:
            stock.quantity += line.qty
        else:
            stock = ItemStock(id=str(uuid.uuid4()), item_id=line.item_id, branch_id=t.to_branch_id, quantity=line.qty)
            db.add(stock)
        pass  # received_qty not in model
    await db.commit()
    return {"status": "received", "received_by": received_by}

def _t_dict(t):
    return {
        "id": t.id, "ref_number": t.ref_number,
        "from_branch_id": t.from_branch_id, "to_branch_id": t.to_branch_id,
        "requested_by": t.requested_by, "approved_by": t.approved_by,
        "status": t.status, "notes": t.notes,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }

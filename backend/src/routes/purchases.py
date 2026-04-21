from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from src.database import get_db
from src.models import PurchaseBill, PurchaseLineItem, ItemStock, VendorReturn, ReturnLineItem, Vendor
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
import uuid

router = APIRouter()

# ─── Schemas ─────────────────────────────────────────────────────────────────
class PurchaseLine(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    cost: float
    tax_rate: float = 0

class PurchaseCreate(BaseModel):
    vendor_id: str
    vendor_name: str = ""
    branch_id: str
    branch_name: str = ""
    date: Optional[str] = None
    due_date: Optional[str] = None
    items: List[PurchaseLine]
    discount: float = 0
    notes: Optional[str] = None

class PaymentIn(BaseModel):
    amount: float
    mode: str = "neft"
    ref: str = ""

# ─── LIST ─────────────────────────────────────────────────────────────────────
@router.get("/")
async def list_bills(
    branch_id: Optional[str] = None,
    vendor_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    q = select(PurchaseBill).order_by(PurchaseBill.created_at.desc())
    if branch_id: q = q.where(PurchaseBill.branch_id == branch_id)
    if vendor_id: q = q.where(PurchaseBill.vendor_id == vendor_id)
    if status:    q = q.where(PurchaseBill.status == status)
    if date_from: q = q.where(PurchaseBill.date >= date_from)
    if date_to:   q = q.where(PurchaseBill.date <= date_to)
    if search:
        q = q.where(or_(
            PurchaseBill.number.ilike(f"%{search}%"),
            PurchaseBill.vendor_name.ilike(f"%{search}%"),
        ))
    result = await db.execute(q.offset(skip).limit(limit))
    bills = result.scalars().all()
    out = []
    for b in bills:
        li_res = await db.execute(select(PurchaseLineItem).where(PurchaseLineItem.bill_id == b.id))
        items = li_res.scalars().all()
        out.append(_bill_dict(b, items))
    return out

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{bill_id}")
async def get_bill(bill_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Bill not found")
    li_res = await db.execute(select(PurchaseLineItem).where(PurchaseLineItem.bill_id == bill_id))
    return _bill_dict(b, li_res.scalars().all())

# ─── CREATE ───────────────────────────────────────────────────────────────────
@router.post("/", status_code=201)
async def create_bill(data: PurchaseCreate, db: AsyncSession = Depends(get_db)):
    today = datetime.now().strftime("%Y-%m-%d")
    subtotal  = sum(i.qty * i.cost for i in data.items)
    tax_total = sum(i.qty * i.cost * i.tax_rate / 100 for i in data.items)
    total     = subtotal + tax_total - data.discount

    count_res = await db.execute(select(func.count(PurchaseBill.id)))
    count = count_res.scalar() or 0
    bill_num = f"PUR-{datetime.now().year}-{400 + count:04d}"

    bill = PurchaseBill(
        id=str(uuid.uuid4()), number=bill_num,
        vendor_id=data.vendor_id,
        vendor_name=data.vendor_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        date=data.date or today,
        due_date=data.due_date,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount, 2),
        total=round(total, 2),
        paid_amount=0,
        status="pending",
        notes=data.notes,
    )
    db.add(bill)

    for item in data.items:
        li = PurchaseLineItem(
            id=str(uuid.uuid4()), bill_id=bill.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, cost=item.cost,
            tax_rate=item.tax_rate,
            line_total=round(item.qty * item.cost, 2),
        )
        db.add(li)
        # Auto-update stock (add to inventory on GRN)
        if item.item_id:
            sq = select(ItemStock).where(and_(
                ItemStock.item_id == item.item_id,
                ItemStock.branch_id == data.branch_id,
            ))
            sr = await db.execute(sq)
            stock = sr.scalar_one_or_none()
            if stock:
                stock.quantity += item.qty
            else:
                db.add(ItemStock(
                    id=str(uuid.uuid4()),
                    item_id=item.item_id,
                    branch_id=data.branch_id,
                    quantity=item.qty,
                ))

    await db.commit()
    return {"id": bill.id, "number": bill_num, "total": round(total, 2)}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{bill_id}/payment")
async def record_payment(bill_id: str, data: PaymentIn, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Bill not found")
    b.paid_amount = min(b.total, round(b.paid_amount + data.amount, 2))
    b.payment_ref = data.ref
    b.status = "paid" if b.paid_amount >= b.total else "partial"
    await db.commit()
    return {
        "status": b.status,
        "paid_amount": b.paid_amount,
        "balance": round(b.total - b.paid_amount, 2),
    }

# ─── VENDOR RETURNS ────────────────────────────────────────────────────────────
class ReturnLine(BaseModel):
    item_id: Optional[str] = None
    name: str
    original_qty: int
    return_qty: int
    cost: float
    tax_rate: float = 0

class VendorReturnCreate(BaseModel):
    bill_id: str
    vendor_id: str
    reason: str
    items: List[ReturnLine]
    notes: Optional[str] = None

@router.get("/returns/")
async def list_returns(
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    q = select(VendorReturn).order_by(VendorReturn.created_at.desc())
    if vendor_id: q = q.where(VendorReturn.vendor_id == vendor_id)
    if branch_id: q = q.where(VendorReturn.branch_id == branch_id)
    if status:    q = q.where(VendorReturn.status == status)
    if date_from: q = q.where(VendorReturn.date >= date_from)
    if date_to:   q = q.where(VendorReturn.date <= date_to)
    result = await db.execute(q.offset(skip).limit(limit))
    returns = result.scalars().all()
    out = []
    for r in returns:
        li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == r.id))
        items = li_res.scalars().all()
        out.append(_return_dict(r, items))
    return out

@router.get("/returns/{return_id}")
async def get_return(return_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(VendorReturn).where(VendorReturn.id == return_id))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(404, "Return not found")
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == return_id))
    return _return_dict(r, li_res.scalars().all())

@router.post("/returns/", status_code=201)
async def create_return(data: VendorReturnCreate, db: AsyncSession = Depends(get_db)):
    bill_result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == data.bill_id))
    bill = bill_result.scalar_one_or_none()
    if not bill:
        raise HTTPException(404, "Bill not found")

    today = datetime.now().strftime("%Y-%m-%d")
    count_res = await db.execute(select(func.count(VendorReturn.id)))
    count = count_res.scalar() or 0
    return_num = f"RET-{datetime.now().year}-{300 + count:04d}"

    subtotal = sum(i.return_qty * i.cost for i in data.items)
    tax_total = sum(i.return_qty * i.cost * i.tax_rate / 100 for i in data.items)
    total = subtotal + tax_total

    vendor_result = await db.execute(select(Vendor).where(Vendor.id == data.vendor_id))
    vendor = vendor_result.scalar_one_or_none()

    ret = VendorReturn(
        id=str(uuid.uuid4()),
        number=return_num,
        bill_id=data.bill_id,
        bill_number=bill.number,
        vendor_id=data.vendor_id,
        vendor_name=vendor.name if vendor else data.vendor_id,
        branch_id=bill.branch_id,
        branch_name=bill.branch_name,
        date=today,
        reason=data.reason,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        total=round(total, 2),
        status="pending",
        notes=data.notes,
    )
    db.add(ret)

    for item in data.items:
        li = ReturnLineItem(
            id=str(uuid.uuid4()),
            return_id=ret.id,
            item_id=item.item_id,
            name=item.name,
            original_qty=item.original_qty,
            return_qty=item.return_qty,
            cost=item.cost,
            tax_rate=item.tax_rate,
            line_total=round(item.return_qty * item.cost, 2),
        )
        db.add(li)

    await db.commit()
    await db.refresh(ret)
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == ret.id))
    return _return_dict(ret, li_res.scalars().all())

@router.post("/returns/{return_id}/approve")
async def approve_return(return_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(VendorReturn).where(VendorReturn.id == return_id))
    ret = result.scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    ret.status = "paid"
    await db.commit()
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == return_id))
    return _return_dict(ret, li_res.scalars().all())

# ─── HELPER ───────────────────────────────────────────────────────────────────
def _return_dict(r, items=None):
    d = {
        "id": r.id, "number": r.number,
        "billId": r.bill_id, "billNumber": r.bill_number,
        "vendorId": r.vendor_id, "vendorName": r.vendor_name,
        "branchId": r.branch_id, "branchName": r.branch_name,
        "date": r.date, "reason": r.reason,
        "subtotal": r.subtotal, "taxTotal": r.tax_total,
        "total": r.total, "creditedAmount": r.credited_amount,
        "status": str(r.status.value) if hasattr(r.status, "value") else str(r.status),
        "notes": r.notes,
    }
    if items is not None:
        if len(items) > 0 and isinstance(items[0], dict):
            d["items"] = items
        else:
            d["items"] = [{
                "name": i.name, "originalQty": i.original_qty,
                "returnQty": i.return_qty, "cost": i.cost,
                "taxRate": i.tax_rate, "lineTotal": i.line_total,
            } for i in items]
    return d

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
def _bill_dict(b, items=None):
    d = {
        "id": b.id, "number": b.number,
        "vendorId": b.vendor_id, "vendorName": b.vendor_name,
        "branchId": b.branch_id, "branchName": b.branch_name,
        "date": b.date, "dueDate": b.due_date,
        "subtotal": b.subtotal, "taxTotal": b.tax_total,
        "discount": b.discount, "total": b.total,
        "paidAmount": b.paid_amount, "paymentRef": b.payment_ref,
        "status": str(b.status.value) if hasattr(b.status, "value") else str(b.status),
        "notes": b.notes,
    }
    if items is not None:
        d["items"] = [{
            "name": i.name, "qty": i.qty,
            "cost": i.cost, "taxRate": i.tax_rate,
            "lineTotal": i.line_total,
        } for i in items]
    return d

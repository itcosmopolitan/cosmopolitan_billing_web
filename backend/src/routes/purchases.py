from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from sqlalchemy.orm import selectinload
from src.database import get_db
from src.models import PurchaseBill, PurchaseLineItem, ItemStock, VendorReturn, ReturnLineItem, Vendor
from src.pagination import paged, normalize_limit, normalize_skip
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


def _purchase_bill_filters(
    branch_id: Optional[str],
    vendor_id: Optional[str],
    status: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
):
    conds = []
    if branch_id:
        conds.append(PurchaseBill.branch_id == branch_id)
    if vendor_id:
        conds.append(PurchaseBill.vendor_id == vendor_id)
    if status:
        conds.append(PurchaseBill.status == status)
    if date_from:
        conds.append(PurchaseBill.date >= date_from)
    if date_to:
        conds.append(PurchaseBill.date <= date_to)
    if search:
        conds.append(
            or_(
                PurchaseBill.number.ilike(f"%{search}%"),
                PurchaseBill.vendor_name.ilike(f"%{search}%"),
            )
        )
    return conds


async def _purchase_bills_summary(db: AsyncSession, conds):
    base = and_(*conds) if conds else True
    amount_total = float(
        (await db.execute(select(func.coalesce(func.sum(PurchaseBill.total), 0)).where(base))).scalar() or 0
    )
    collected_paid = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(PurchaseBill.total), 0)).where(and_(base, PurchaseBill.status == "paid"))
            )
        ).scalar()
        or 0
    )
    pending_balance = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0)).where(
                    and_(base, PurchaseBill.status.in_(["pending", "partial"]))
                )
            )
        ).scalar()
        or 0
    )
    overdue_count = int(
        (
            await db.execute(
                select(func.count(PurchaseBill.id)).where(and_(base, PurchaseBill.status == "overdue"))
            )
        ).scalar()
        or 0
    )
    return {
        "amountTotal": amount_total,
        "collectedPaid": collected_paid,
        "pendingBalance": pending_balance,
        "overdueCount": overdue_count,
    }


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
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = _purchase_bill_filters(branch_id, vendor_id, status, search, date_from, date_to)
    q = (
        select(PurchaseBill)
        .options(selectinload(PurchaseBill.line_items))
        .order_by(PurchaseBill.created_at.desc())
    )
    if conds:
        q = q.where(and_(*conds))
    if conds:
        count_r = await db.execute(select(func.count(PurchaseBill.id)).where(and_(*conds)))
    else:
        count_r = await db.execute(select(func.count(PurchaseBill.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    bills = result.unique().scalars().all()
    out = [_bill_dict(b, b.line_items) for b in bills]
    summary = await _purchase_bills_summary(db, conds)
    return paged(out, total, sk, lim, summary=summary)

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
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = []
    if vendor_id:
        conds.append(VendorReturn.vendor_id == vendor_id)
    if branch_id:
        conds.append(VendorReturn.branch_id == branch_id)
    if status:
        conds.append(VendorReturn.status == status)
    if date_from:
        conds.append(VendorReturn.date >= date_from)
    if date_to:
        conds.append(VendorReturn.date <= date_to)
    q = (
        select(VendorReturn)
        .options(selectinload(VendorReturn.line_items))
        .order_by(VendorReturn.created_at.desc())
    )
    if conds:
        q = q.where(and_(*conds))
    if conds:
        count_r = await db.execute(select(func.count(VendorReturn.id)).where(and_(*conds)))
    else:
        count_r = await db.execute(select(func.count(VendorReturn.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    returns = result.unique().scalars().all()
    out = [_return_dict(r, r.line_items) for r in returns]
    return paged(out, total, sk, lim)

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

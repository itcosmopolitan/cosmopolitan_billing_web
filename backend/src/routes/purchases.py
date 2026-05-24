import uuid
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.batch_dates import validate_batch_dates
from src.database import get_db
from src.document_numbering import allocate_number
from src.models import (
    PurchaseBill,
    PurchaseLineItem,
    PurchaseOrder,
    PurchaseOrderLineItem,
    PurchaseOrderStatus,
    ReturnLineItem,
    User,
    Vendor,
    VendorReturn,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import add_batch_atomic, adjust_stock_atomic, is_tracked
from src.routes._serializers import get_user_branch_ids
from src.security import current_user, enforce_branch_access, enforce_branch_access_optional, require_perm

router = APIRouter()

# ─── Schemas ─────────────────────────────────────────────────────────────────
# 2026-05-24: same allow-list as routes/sales.py PaymentMode. Single source
# of truth across the app — POS, Record Payment on invoices, AND Record
# Payment on purchase bills all offer the same 4 methods. Mirror the SO
# `RecordedPaymentMode` decision: cheque NOT included even though vendor
# settlements often use it, because parity with the POS dropdown won out.
PaymentMode = Literal["cash", "card", "upi", "bank_transfer"]


def _coerce_payment_mode_value(v):
    """Shared pre-validator body. Returns None for None / empty / legacy
    'credit' / 'neft' (so historical purchase clients still post without
    a 422). Otherwise lowercases + strips so case/whitespace noise doesn't
    trip the Literal.
    """
    if v is None:
        return None
    if not isinstance(v, str):
        return v
    s = v.strip().lower()
    if s in ("", "credit", "neft"):
        # 'neft' was the historical default — coerce to None so legacy
        # callers don't get rejected. New writes should pick a method.
        return None
    return s


class PurchaseLine(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    cost: float
    tax_rate: float = 0
    # 2026-05-24: per-line discount in PERCENT (parity with SO/Quote).
    # Frontend BillFormModal accepts % or ₹ via toggle and converts to
    # percent before POST. Backend math: line_net = gross × (1 − pct/100).
    discount: float = 0
    # Optional batch metadata captured at receipt time. Used when the item has
    # batch_tracking enabled — every receipt for a tracked item creates an
    # ItemBatch row tagged with this metadata (auto-generates a batch number
    # if the operator left it blank).
    batch_number: Optional[str] = None
    mfg_date:     Optional[str] = None
    expiry_date:  Optional[str] = None

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
    # 2026-05-24: parallel to SaleCreate.payment_mode. When set at create
    # time, the bill is created `paid`; when None, `pending`. Frontend
    # BillFormModal's "Payment received?" checkbox drives this.
    payment_mode: Optional[PaymentMode] = None
    payment_ref: Optional[str] = None

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)


class PaymentIn(BaseModel):
    amount: float
    # 2026-05-24: tightened from `str = "neft"` to a required Literal,
    # matching sales/PaymentIn.mode. Allow-list = same 4 as POS. Legacy
    # callers that send `"neft"` get coerced to None by the validator
    # below — and since mode is required, the resulting None fails the
    # Literal with a 422 telling them the valid set. Force the migration.
    mode: PaymentMode
    ref: str = ""

    @field_validator("mode", mode="before")
    @classmethod
    def _coerce_mode(cls, v):
        return _coerce_payment_mode_value(v)


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
@router.get("/", dependencies=[Depends(require_perm("purchases.view"))])
async def list_bills(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    vendor_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = _purchase_bill_filters(branch_id, vendor_id, status, search, date_from, date_to)
    if branch_id is None and not getattr(user, "all_branches", False):
        branch_ids = await get_user_branch_ids(db, user.id)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(PurchaseBill.branch_id.in_(branch_ids))
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "number": PurchaseBill.number,
            "vendor_name": PurchaseBill.vendor_name,
            "branch_id": PurchaseBill.branch_id,
            "date": PurchaseBill.date,
            "due_date": PurchaseBill.due_date,
            "total": PurchaseBill.total,
            "paid_amount": PurchaseBill.paid_amount,
            "balance_due": (PurchaseBill.total - PurchaseBill.paid_amount),
            "status": PurchaseBill.status,
            "created_at": PurchaseBill.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = (
        select(PurchaseBill)
        .options(selectinload(PurchaseBill.line_items))
    )
    if conds:
        q = q.where(and_(*conds))
        count_r = await db.execute(select(func.count(PurchaseBill.id)).where(and_(*conds)))
    else:
        count_r = await db.execute(select(func.count(PurchaseBill.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    bills = result.unique().scalars().all()
    out = [_bill_dict(b, b.line_items) for b in bills]
    summary = await _purchase_bills_summary(db, conds)
    return paged(out, total, sk, lim, summary=summary)

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{bill_id}", dependencies=[Depends(require_perm("purchases.view"))])
async def get_bill(bill_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Bill not found")
    await enforce_branch_access(b.branch_id, user=user, db=db)
    li_res = await db.execute(select(PurchaseLineItem).where(PurchaseLineItem.bill_id == bill_id))
    return _bill_dict(b, li_res.scalars().all())

# ─── CREATE ───────────────────────────────────────────────────────────────────
@router.post("/", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def create_bill(data: PurchaseCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    if not data.items:
        raise HTTPException(400, "Purchase bill must have at least one line item")
    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have a name and positive quantity")
    today = datetime.now().strftime("%Y-%m-%d")

    # 2026-05-24: rewrote totals to use percent-discount line math (parity
    # with sales create_invoice / _calc_lines). Old code summed gross
    # without subtracting line discount + treated cart discount as a flat
    # subtract from post-tax total. New: per-line net = gross × (1 − pct/100),
    # tax computed on net, cart discount applied post-tax.
    line_rows = []  # list[(item, line_net, line_tax)]
    subtotal = 0.0
    tax_total = 0.0
    for item in data.items:
        gross = round(item.qty * item.cost, 2)
        line_net = round(gross * (1 - (item.discount or 0) / 100), 2)
        line_tax = round(line_net * ((item.tax_rate or 0) / 100), 2)
        line_rows.append((item, line_net, line_tax))
        subtotal += line_net
        tax_total += line_tax
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    bill_num = await allocate_number(
        db, "purchase_bill", branch_id=data.branch_id
    )

    await enforce_branch_access(data.branch_id, user=user, db=db)

    # If operator marked "payment received" at create time, settle the
    # bill in-line — parity with POS create_invoice. Otherwise the bill
    # lands as pending and gets settled later via record_payment.
    paid_at_create = data.payment_mode is not None
    paid_amount = total if paid_at_create else 0.0
    bill_status = "paid" if paid_amount >= total else "pending"

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
        discount=round(data.discount or 0, 2),
        total=total,
        paid_amount=round(paid_amount, 2),
        payment_mode=data.payment_mode,
        payment_ref=data.payment_ref or "",
        status=bill_status,
        notes=data.notes,
    )
    db.add(bill)

    for item, line_net, line_tax in line_rows:
        li = PurchaseLineItem(
            id=str(uuid.uuid4()), bill_id=bill.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, cost=item.cost,
            tax_rate=item.tax_rate,
            discount=item.discount or 0,
            line_total=round(line_net + line_tax, 2),
        )
        db.add(li)
        # Stock side-effect: tracked items create a new batch (carrying vendor
        # lot, mfg/expiry), untracked items just bump the aggregate counter.
        # Both code paths atomically update item_stock so reports stay correct.
        if item.item_id:
            tracked, expiry_tracked = await is_tracked(db, item.item_id)
            if tracked:
                date_errs = validate_batch_dates(
                    mfg_date=item.mfg_date,
                    expiry_date=item.expiry_date,
                    received_date=data.date or today,
                    require_expiry=expiry_tracked,
                )
                if date_errs:
                    raise HTTPException(
                        400,
                        f"{item.name}: {'; '.join(date_errs)}",
                    )
                await add_batch_atomic(
                    db,
                    item_id=item.item_id,
                    branch_id=data.branch_id,
                    qty=item.qty,
                    batch_number=item.batch_number,
                    mfg_date=item.mfg_date,
                    expiry_date=item.expiry_date,
                    cost_price=float(item.cost or 0),
                    vendor_id=data.vendor_id,
                    source_type="purchase",
                    source_ref=bill.id,
                    received_date=data.date or today,
                )
            else:
                await adjust_stock_atomic(
                    db,
                    item_id=item.item_id,
                    branch_id=data.branch_id,
                    delta=item.qty,
                )

    await db.commit()
    return {"id": bill.id, "number": bill_num, "total": round(total, 2)}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{bill_id}/payment", dependencies=[Depends(require_perm("purchases.edit"))])
async def record_payment(bill_id: str, data: PaymentIn, db: AsyncSession = Depends(get_db)):
    """Record a payment against a purchase bill.

    2026-05-24 changes:
      • `mode` is now persisted (purchase_bills.payment_mode column added).
      • Already-paid bills return 400 instead of silently no-oping.
      • Cancelled bills are unpayable.
      • Amount > balance is clamped to balance (vendor over-payments are
        rare and don't have a credit_balance equivalent yet — flag for a
        future "vendor advance" feature). Excess silently discarded
        rather than rejected, mirroring the lenient behaviour the
        purchase side has historically had.
    """
    if data.amount <= 0:
        raise HTTPException(400, "amount must be > 0")
    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Bill not found")
    bill_status = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
    if bill_status == "cancelled":
        raise HTTPException(400, "Bill is cancelled — cannot record payments")
    balance = max(0.0, float(b.total or 0) - float(b.paid_amount or 0))
    if balance <= 0:
        raise HTTPException(400, "Bill already settled")
    applied = min(balance, data.amount)
    b.paid_amount = round(float(b.paid_amount or 0) + applied, 2)
    b.payment_ref = data.ref or b.payment_ref
    b.payment_mode = data.mode
    b.status = "paid" if b.paid_amount >= b.total else "partial"
    await db.commit()
    return {
        "status": b.status,
        "paid_amount": b.paid_amount,
        "balance": round(float(b.total or 0) - float(b.paid_amount or 0), 2),
    }


# ─── CANCEL ───────────────────────────────────────────────────────────────────
@router.post("/{bill_id}/cancel", dependencies=[Depends(require_perm("purchases.edit"))])
async def cancel_bill(bill_id: str, db: AsyncSession = Depends(get_db)):
    """Cancel a purchase bill. Idempotent — already-cancelled bills return
    the same 200 shape.

    Does NOT reverse stock. Once goods are received and batched, reversing
    on cancel would corrupt downstream sales / transfers that may have
    already consumed those batches. Operators that need to physically
    return goods should use the Vendor Returns flow (which handles the
    stock side-effect cleanly via add_batch_atomic). The cancel here is
    purely an accounting status flip — "this bill should be ignored in
    payable totals".
    """
    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Bill not found")
    bill_status = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
    if bill_status == "paid":
        raise HTTPException(400, "Cannot cancel a bill that is already paid")
    b.status = "cancelled"
    await db.commit()
    return {"status": "cancelled"}

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

@router.get("/returns/", dependencies=[Depends(require_perm("purchases.view"))])
async def list_returns(
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
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
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "number": VendorReturn.number,
            "bill_number": VendorReturn.bill_number,
            "vendor_name": VendorReturn.vendor_name,
            "branch_id": VendorReturn.branch_id,
            "date": VendorReturn.date,
            "total": VendorReturn.total,
            "credited_amount": VendorReturn.credited_amount,
            "status": VendorReturn.status,
            "created_at": VendorReturn.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = (
        select(VendorReturn)
        .options(selectinload(VendorReturn.line_items))
    )
    if conds:
        q = q.where(and_(*conds))
    if conds:
        count_r = await db.execute(select(func.count(VendorReturn.id)).where(and_(*conds)))
    else:
        count_r = await db.execute(select(func.count(VendorReturn.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    returns = result.unique().scalars().all()
    out = [_return_dict(r, r.line_items) for r in returns]
    return paged(out, total, sk, lim)

@router.get("/returns/{return_id}", dependencies=[Depends(require_perm("purchases.view"))])
async def get_return(return_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(VendorReturn).where(VendorReturn.id == return_id))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(404, "Return not found")
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == return_id))
    return _return_dict(r, li_res.scalars().all())

@router.post("/returns/", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
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

@router.post("/returns/{return_id}/approve", dependencies=[Depends(require_perm("purchases.edit"))])
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

# ─── SERIALIZERS ──────────────────────────────────────────────────────────────
def _bill_dict(b, items=None):
    d = {
        "id": b.id, "number": b.number,
        "vendorId": b.vendor_id, "vendorName": b.vendor_name,
        "branchId": b.branch_id, "branchName": b.branch_name,
        "date": b.date, "dueDate": b.due_date,
        "subtotal": b.subtotal, "taxTotal": b.tax_total,
        "discount": b.discount, "total": b.total,
        "paidAmount": b.paid_amount, "paymentRef": b.payment_ref,
        # 2026-05-24: payment_mode now persisted. Legacy rows return None.
        "paymentMode": getattr(b, "payment_mode", None),
        "status": str(b.status.value) if hasattr(b.status, "value") else str(b.status),
        "notes": b.notes,
    }
    if items is not None:
        # 2026-05-24: added id + itemId + discount per line. itemId lets
        # the convert (PO→Bill) and return flows tie a line back to its
        # inventory row; discount is the per-line percent.
        d["items"] = [{
            "id": i.id, "itemId": i.item_id,
            "name": i.name, "qty": i.qty,
            "cost": i.cost, "taxRate": i.tax_rate,
            "discount": getattr(i, "discount", 0) or 0,
            "lineTotal": i.line_total,
        } for i in items]
    return d


# ─── PURCHASE ORDER ───────────────────────────────────────────────────────────
# Mirror of routes/sales.py SO endpoints. PO captures intent to buy from a
# vendor; convert spawns a PurchaseBill (which is what actually moves
# stock + creates batches). Status flow: draft → confirmed → converted
# (terminal) | cancelled (terminal). Edit is allowed only while status is
# draft or confirmed.

class PurchaseOrderLineIn(BaseModel):
    """Same shape as PurchaseLine minus the receipt-time fields
    (batch_number, mfg_date, expiry_date — those belong on the bill,
    not the intent doc). `discount` is a percent (0-100)."""
    item_id: Optional[str] = None
    name: str
    qty: int = Field(..., gt=0)
    cost: float
    tax_rate: float = 0
    discount: float = 0


class PurchaseOrderCreate(BaseModel):
    vendor_id: str
    vendor_name: str = ""
    branch_id: str
    branch_name: str = ""
    created_by: str = "Staff"
    date: Optional[str] = None
    expected_date: Optional[str] = None
    items: List[PurchaseOrderLineIn]
    discount: float = 0           # cart-level percent OR amount? amount here, matches SO.
    notes: Optional[str] = None


class PurchaseOrderStatusIn(BaseModel):
    status: str


class ConvertPOToBillLine(BaseModel):
    """Optional per-line receipt metadata supplied at convert time.
    Identified by `item_id`; lines without a matching entry use no
    batch metadata (auto-generated batch # via add_batch_atomic for
    tracked items).
    """
    item_id: str
    batch_number: Optional[str] = None
    mfg_date:     Optional[str] = None
    expiry_date:  Optional[str] = None


class ConvertPOToBillIn(BaseModel):
    """Payload for the PO→Bill convert flow. Mirrors the SO→Invoice
    ConvertToInvoiceIn shape (same payment_received UX) plus per-line
    batch capture metadata (we're RECEIVING goods, so the operator
    captures the actual lot # / mfg / expiry from the physical delivery).
    """
    payment_received: bool = False
    payment_mode: Optional[PaymentMode] = None
    payment_ref: Optional[str] = None
    notes: Optional[str] = None
    due_date: Optional[str] = None
    line_receipts: Optional[List[ConvertPOToBillLine]] = None

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)


def _po_dict(po, items=None):
    d = {
        "id": po.id, "number": po.number,
        "vendorId": po.vendor_id, "vendorName": po.vendor_name,
        "branchId": po.branch_id, "branchName": po.branch_name,
        "createdBy": po.created_by,
        "date": po.date,
        "expectedDate": po.expected_date,
        "subtotal": po.subtotal, "taxTotal": po.tax_total,
        "discount": po.discount, "total": po.total,
        "status": str(po.status.value) if hasattr(po.status, "value") else str(po.status),
        "convertedBillId": po.converted_bill_id,
        "notes": po.notes,
    }
    if items is not None:
        d["items"] = [{
            "id": i.id, "itemId": i.item_id, "name": i.name,
            "qty": i.qty, "cost": i.cost, "taxRate": i.tax_rate,
            "discount": i.discount, "lineTotal": i.line_total,
        } for i in items]
    return d


def _calc_po_lines(lines):
    """Compute line totals + roll up subtotal/tax for PO line shapes.
    Mirrors routes/sales._calc_lines but reads `i.cost` instead of
    `i.price` (purchases buy AT cost, sales sell AT price). Each row in
    the returned list is (line, line_net, line_tax)."""
    rows = []
    subtotal = 0.0
    tax_total = 0.0
    for i in lines:
        gross = round((i.qty or 0) * (i.cost or 0), 2)
        line_net = round(gross * (1 - (i.discount or 0) / 100), 2)
        line_tax = round(line_net * ((i.tax_rate or 0) / 100), 2)
        rows.append((i, line_net, line_tax))
        subtotal += line_net
        tax_total += line_tax
    return rows, subtotal, tax_total


def _po_terminal(po) -> bool:
    s = str(po.status.value) if hasattr(po.status, "value") else str(po.status)
    return s in ("converted", "cancelled")


# ─── PO: LIST ─────────────────────────────────────────────────────────────────
@router.get("/orders/", dependencies=[Depends(require_perm("purchases.view"))])
async def list_orders(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    conds = []
    if vendor_id:
        conds.append(PurchaseOrder.vendor_id == vendor_id)
    if branch_id:
        conds.append(PurchaseOrder.branch_id == branch_id)
    if status:
        conds.append(PurchaseOrder.status == status)
    if date_from:
        conds.append(PurchaseOrder.date >= date_from)
    if date_to:
        conds.append(PurchaseOrder.date <= date_to)
    if search:
        conds.append(
            or_(
                PurchaseOrder.number.ilike(f"%{search}%"),
                PurchaseOrder.vendor_name.ilike(f"%{search}%"),
            )
        )
    base = and_(*conds) if conds else True
    total = int((await db.execute(select(func.count(PurchaseOrder.id)).where(base))).scalar() or 0)
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {
            "number": PurchaseOrder.number,
            "vendor_name": PurchaseOrder.vendor_name,
            "branch_id": PurchaseOrder.branch_id,
            "date": PurchaseOrder.date,
            "expected_date": PurchaseOrder.expected_date,
            "total": PurchaseOrder.total,
            "status": PurchaseOrder.status,
            "created_at": PurchaseOrder.created_at,
        },
        default_key="created_at", default_order="desc",
    )
    q = (
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(base)
        .order_by(sort_expr)
        .offset(sk)
        .limit(lim)
    )
    rows = (await db.execute(q)).scalars().all()
    out = [_po_dict(po, po.line_items) for po in rows]
    return paged(out, total, sk, lim)


# ─── PO: GET ──────────────────────────────────────────────────────────────────
@router.get("/orders/{order_id}", dependencies=[Depends(require_perm("purchases.view"))])
async def get_order(order_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(PurchaseOrder.id == order_id)
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    return _po_dict(po, po.line_items)


# ─── PO: CREATE ───────────────────────────────────────────────────────────────
@router.post("/orders/", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def create_order(data: PurchaseOrderCreate, db: AsyncSession = Depends(get_db)):
    if not data.items:
        raise HTTPException(400, "Purchase order must have at least one line item")
    today = datetime.now().strftime("%Y-%m-%d")
    count = (await db.execute(select(func.count(PurchaseOrder.id)))).scalar() or 0
    po_num = f"PO-{datetime.now().year}-{1000 + count:04d}"

    line_rows, subtotal, tax_total = _calc_po_lines(data.items)
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    po = PurchaseOrder(
        id=str(uuid.uuid4()), number=po_num,
        vendor_id=data.vendor_id,
        vendor_name=data.vendor_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        created_by=data.created_by,
        date=data.date or today,
        expected_date=data.expected_date,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount or 0, 2),
        total=total,
        status=PurchaseOrderStatus.confirmed,
        notes=data.notes,
    )
    db.add(po)
    for line, line_net, line_tax in line_rows:
        db.add(PurchaseOrderLineItem(
            id=str(uuid.uuid4()), order_id=po.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, cost=line.cost,
            tax_rate=line.tax_rate,
            discount=line.discount or 0,
            line_total=round(line_net + line_tax, 2),
        ))
    await db.commit()
    return {"id": po.id, "number": po_num, "total": total, "status": po.status.value}


# ─── PO: UPDATE ───────────────────────────────────────────────────────────────
@router.put("/orders/{order_id}", dependencies=[Depends(require_perm("purchases.edit"))])
async def update_order(order_id: str, data: PurchaseOrderCreate, db: AsyncSession = Depends(get_db)):
    """Full-replacement edit. Same shape as create; allowed only while
    the PO is not in a terminal status. UI hides Edit for converted /
    cancelled POs, this is the server-side defence-in-depth check.
    """
    res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(PurchaseOrder.id == order_id)
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if _po_terminal(po):
        raise HTTPException(400, "Cannot edit a terminal-status purchase order")
    if not data.items:
        raise HTTPException(400, "Purchase order must have at least one line item")

    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(PurchaseOrderLineItem).where(PurchaseOrderLineItem.order_id == po.id))

    line_rows, subtotal, tax_total = _calc_po_lines(data.items)
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    po.vendor_id = data.vendor_id
    po.vendor_name = data.vendor_name
    po.branch_id = data.branch_id
    po.branch_name = data.branch_name or data.branch_id
    po.expected_date = data.expected_date
    po.subtotal = round(subtotal, 2)
    po.tax_total = round(tax_total, 2)
    po.discount = round(data.discount or 0, 2)
    po.total = total
    po.notes = data.notes

    for line, line_net, line_tax in line_rows:
        db.add(PurchaseOrderLineItem(
            id=str(uuid.uuid4()), order_id=po.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, cost=line.cost,
            tax_rate=line.tax_rate,
            discount=line.discount or 0,
            line_total=round(line_net + line_tax, 2),
        ))
    await db.commit()
    return {"id": po.id, "number": po.number, "total": total, "status": po.status.value}


# ─── PO: STATUS ───────────────────────────────────────────────────────────────
@router.patch("/orders/{order_id}/status", dependencies=[Depends(require_perm("purchases.edit"))])
async def update_order_status(order_id: str, body: PurchaseOrderStatusIn, db: AsyncSession = Depends(get_db)):
    """Confirm / cancel a PO. `converted` cannot be set manually — only
    the /convert endpoint sets it (atomically with bill creation)."""
    target = (body.status or "").strip().lower()
    if target not in ("draft", "confirmed", "cancelled"):
        raise HTTPException(400, "Invalid status — only draft / confirmed / cancelled allowed")
    res = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == order_id))
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if _po_terminal(po):
        raise HTTPException(400, "Cannot change status of a terminal-status purchase order")
    po.status = target
    await db.commit()
    return {"status": po.status.value if hasattr(po.status, "value") else str(po.status)}


# ─── PO: CONVERT TO BILL ──────────────────────────────────────────────────────
@router.post("/orders/{order_id}/convert", dependencies=[Depends(require_perm("purchases.create"))])
async def convert_order_to_bill(
    order_id: str,
    data: ConvertPOToBillIn,
    db: AsyncSession = Depends(get_db),
):
    """Spawn a PurchaseBill from a PO. Walks the same receipt-side stock
    path as a manual bill (add_batch_atomic for tracked items, aggregate
    bump for untracked).

    Per-line batch metadata can be supplied via `line_receipts` — the
    operator captures lot # / mfg / expiry from the physical delivery at
    convert time. Lines without an entry use auto-generated batch #s
    (add_batch_atomic handles the default).

    Payment fields parallel ConvertToInvoiceIn (SO→Invoice). If
    payment_received=False (default) the bill lands as `pending` and is
    settled later via /{bill_id}/payment.
    """
    res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(PurchaseOrder.id == order_id)
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status == PurchaseOrderStatus.converted:
        raise HTTPException(400, "Purchase order already converted")
    if po.status == PurchaseOrderStatus.cancelled:
        raise HTTPException(400, "Cannot convert a cancelled purchase order")

    if data.payment_received and not (data.payment_mode or "").strip():
        raise HTTPException(400, "Pick a payment method (or uncheck Payment Received)")

    today = datetime.now().strftime("%Y-%m-%d")
    count = (await db.execute(select(func.count(PurchaseBill.id)))).scalar() or 0
    bill_num = f"PUR-{datetime.now().year}-{400 + count:04d}"

    paid = po.total if data.payment_received else 0.0
    bill_status = "paid" if paid >= po.total else "pending"
    payment_mode = data.payment_mode if data.payment_received else None

    bill = PurchaseBill(
        id=str(uuid.uuid4()), number=bill_num,
        vendor_id=po.vendor_id,
        vendor_name=po.vendor_name,
        branch_id=po.branch_id,
        branch_name=po.branch_name,
        date=today,
        due_date=data.due_date,
        subtotal=po.subtotal,
        tax_total=po.tax_total,
        discount=po.discount,
        total=po.total,
        paid_amount=round(paid, 2),
        payment_mode=payment_mode,
        payment_ref=data.payment_ref or "",
        status=bill_status,
        notes=data.notes or po.notes,
    )
    db.add(bill)

    # Index operator-supplied receipt metadata by item_id for quick lookup.
    receipts_by_item = {}
    if data.line_receipts:
        for r in data.line_receipts:
            receipts_by_item[r.item_id] = r

    for line in po.line_items:
        db.add(PurchaseLineItem(
            id=str(uuid.uuid4()), bill_id=bill.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, cost=line.cost,
            tax_rate=line.tax_rate,
            discount=line.discount or 0,
            line_total=line.line_total,
        ))
        # Stock side-effect — same path as create_bill, just sourced from
        # the operator's per-line receipt metadata (when provided).
        if line.item_id:
            recv = receipts_by_item.get(line.item_id)
            tracked, expiry_tracked = await is_tracked(db, line.item_id)
            if tracked:
                if recv:
                    date_errs = validate_batch_dates(
                        mfg_date=recv.mfg_date,
                        expiry_date=recv.expiry_date,
                        received_date=today,
                        require_expiry=expiry_tracked,
                    )
                    if date_errs:
                        raise HTTPException(
                            400,
                            f"{line.name}: {'; '.join(date_errs)}",
                        )
                await add_batch_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=po.branch_id,
                    qty=line.qty,
                    batch_number=recv.batch_number if recv else None,
                    mfg_date=recv.mfg_date if recv else None,
                    expiry_date=recv.expiry_date if recv else None,
                    cost_price=float(line.cost or 0),
                    vendor_id=po.vendor_id,
                    source_type="purchase",
                    source_ref=bill.id,
                    received_date=today,
                )
            else:
                await adjust_stock_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=po.branch_id,
                    delta=line.qty,
                )

    po.status = PurchaseOrderStatus.converted
    po.converted_bill_id = bill.id
    await db.commit()
    return {
        "bill_id": bill.id,
        "bill_number": bill.number,
        "status": bill_status,
        "total": bill.total,
    }

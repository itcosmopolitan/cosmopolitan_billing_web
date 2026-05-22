import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.models import (
    InvoiceStatus,
    Quotation,
    QuotationLineItem,
    QuotationStatus,
    SaleInvoice,
    SaleLineItem,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import (
    add_payment_atomic,
    adjust_stock_atomic,
    consume_batches_atomic,
    is_tracked,
)
from src.security import require_perm

router = APIRouter()

# ─── Schemas ─────────────────────────────────────────────────────────────────
class BatchAllocationEntry(BaseModel):
    """One entry of an explicit per-line batch split: take `qty` units from
    `batch_id`. Sum of entries must equal the line's qty.

    `qty > 0` is enforced at the schema layer — without it, a payload like
    `[{qty: 15}, {qty: -5}]` would arithmetically sum to 10 (matching a
    line qty of 10), pass the backend sum-check, but only actually drain
    the first batch by 15 while the aggregate stock is decremented by 10,
    silently corrupting the SUM(batches) == item_stock invariant.
    """
    batch_id: str
    qty: int = Field(..., gt=0)


class LineItemIn(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    price: float
    tax_rate: float = 0
    line_discount: float = 0
    line_discount_amount: float = 0
    # ── Batch sourcing (precedence: allocation > batch_id > auto FIFO/FEFO) ──
    # `batch_allocation`: full split set by the cashier in the cart UI when
    # the qty spans multiple lots. Backend consumes exactly these in order.
    # `batch_id`: legacy single-batch shortcut from earlier versions of the
    # API. Treated as a one-entry allocation when allocation is absent.
    batch_allocation: Optional[List[BatchAllocationEntry]] = None
    batch_id: Optional[str] = None

class SaleCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    cashier: str = "Staff"
    date: Optional[str] = None          # defaults to today
    items: List[LineItemIn]
    discount: float = 0
    payment_mode: str = "cash"
    notes: Optional[str] = None

class PaymentIn(BaseModel):
    amount: float
    mode: str = "bank_transfer"
    ref: str = ""

class QuotationCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    created_by: str = "Staff"
    date: Optional[str] = None
    valid_until: Optional[str] = None
    items: List[LineItemIn]
    discount: float = 0
    notes: Optional[str] = None

# ─── SAMPLE RETURNS DATA ──────────────────────────────────────────────────────
# Sample returns data (in production, would be stored in database)
SAMPLE_RETURNS = [
    {
        "id": "cn-001",
        "number": "CN-2024-001",
        "customer_id": "cu-002",
        "customer_name": "Rajesh Stores",
        "ref_invoice": "INV-2024-1847",
        "date": "2024-04-16",
        "amount": 1500,
        "reason": "Defective product - damaged packaging",
        "status": "processed",
        "notes": "Basmati Rice 5kg bag torn, customer requested return"
    },
    {
        "id": "cn-002",
        "number": "CN-2024-002",
        "customer_id": "cu-004",
        "customer_name": "Anand Traders",
        "ref_invoice": "INV-2024-1844",
        "date": "2024-04-15",
        "amount": 2800,
        "reason": "Incorrect quantity delivered",
        "status": "processed",
        "notes": "Received 40 units instead of 50"
    },
    {
        "id": "cn-003",
        "number": "CN-2024-003",
        "customer_id": "cu-001",
        "customer_name": "Priya Sharma",
        "ref_invoice": "INV-2024-1845",
        "date": "2024-04-14",
        "amount": 680,
        "reason": "Expired items returned",
        "status": "processed",
        "notes": "Amul Milk cartons expired before use date"
    }
]


def _sale_invoice_filters(
    branch_id: Optional[str],
    status: Optional[str],
    customer_id: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
):
    conds = []
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
    if status:
        try:
            conds.append(SaleInvoice.status == InvoiceStatus(status))
        except ValueError:
            conds.append(SaleInvoice.status == status)
    if customer_id:
        conds.append(SaleInvoice.customer_id == customer_id)
    if date_from:
        conds.append(SaleInvoice.date >= date_from)
    if date_to:
        conds.append(SaleInvoice.date <= date_to)
    if search:
        conds.append(
            or_(
                SaleInvoice.number.ilike(f"%{search}%"),
                SaleInvoice.customer_name.ilike(f"%{search}%"),
            )
        )
    return conds


async def _sales_list_summary(db: AsyncSession, conds):
    base = and_(*conds) if conds else True
    amount_total = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(base))).scalar() or 0
    )
    collected_paid = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(
                    and_(base, SaleInvoice.status == InvoiceStatus.paid)
                )
            )
        ).scalar()
        or 0
    )
    credit_pending = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0)).where(
                    and_(base, SaleInvoice.status == InvoiceStatus.pending)
                )
            )
        ).scalar()
        or 0
    )
    overdue_total = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(
                    and_(base, SaleInvoice.status == InvoiceStatus.overdue)
                )
            )
        ).scalar()
        or 0
    )
    return {
        "amountTotal": amount_total,
        "collectedPaid": collected_paid,
        "creditPending": credit_pending,
        "overdueTotal": overdue_total,
    }


# ─── LIST ─────────────────────────────────────────────────────────────────────
@router.get("/", dependencies=[Depends(require_perm("invoices.view"))])
async def list_invoices(
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    search: Optional[str] = None,
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
    conds = _sale_invoice_filters(branch_id, status, customer_id, search, date_from, date_to)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "number": SaleInvoice.number,
            "customer_name": SaleInvoice.customer_name,
            "branch_id": SaleInvoice.branch_id,
            "date": SaleInvoice.date,
            "cashier": SaleInvoice.cashier,
            "total": SaleInvoice.total,
            "paid_amount": SaleInvoice.paid_amount,
            "balance_due": (SaleInvoice.total - SaleInvoice.paid_amount),
            "status": SaleInvoice.status,
            "payment_mode": SaleInvoice.payment_mode,
            "created_at": SaleInvoice.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = (
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
    )
    if conds:
        q = q.where(and_(*conds))
    count_r = await db.execute(select(func.count(SaleInvoice.id)).where(and_(*conds)) if conds else select(func.count(SaleInvoice.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    invoices = result.unique().scalars().all()
    out = [_inv_dict(inv, inv.line_items) for inv in invoices]
    summary = await _sales_list_summary(db, conds)
    return paged(out, total, sk, lim, summary=summary)

# ─── LIST RETURNS ────────────────────────────────────────────────────────────
@router.get("/returns", dependencies=[Depends(require_perm("invoices.view"))])
async def list_returns(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
):
    """List all credit notes / returns. Sorted in Python because SAMPLE_RETURNS
    is a static list — no SQL backing yet."""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    key_map = {
        "number":        lambda r: r.get("number", ""),
        "customer_name": lambda r: r.get("customer_name", ""),
        "ref_invoice":   lambda r: r.get("ref_invoice", ""),
        "date":          lambda r: r.get("date", ""),
        "amount":        lambda r: r.get("amount", 0),
        "status":        lambda r: r.get("status", ""),
    }
    selected_key = sort_by if sort_by in key_map else "date"
    desc = (sort_order or "desc").strip().lower() == "desc"
    sorted_data = sorted(SAMPLE_RETURNS, key=key_map[selected_key], reverse=desc)
    data = sorted_data[sk : sk + lim]
    return paged(data, len(SAMPLE_RETURNS), sk, lim)

# ─── QUOTATIONS ───────────────────────────────────────────────────────────────
@router.get("/quotations/", dependencies=[Depends(require_perm("invoices.view"))])
async def list_quotations(
    branch_id: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List all quotations"""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q_count = select(func.count(Quotation.id))
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "number": Quotation.number,
            "customer_name": Quotation.customer_name,
            "branch_id": Quotation.branch_id,
            "date": Quotation.date,
            "valid_until": Quotation.valid_until,
            "total": Quotation.total,
            "status": Quotation.status,
            "created_at": Quotation.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = select(Quotation).options(selectinload(Quotation.line_items)).order_by(sort_expr)
    if branch_id:
        q = q.where(Quotation.branch_id == branch_id)
        q_count = q_count.where(Quotation.branch_id == branch_id)
    total = int((await db.execute(q_count)).scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    quotations = result.unique().scalars().all()
    items_out = [_quote_dict(qt, qt.line_items) for qt in quotations]
    return paged(items_out, total, sk, lim)

@router.get("/quotations/{quote_id}", dependencies=[Depends(require_perm("invoices.view"))])
async def get_quotation(quote_id: str, db: AsyncSession = Depends(get_db)):
    """Get a specific quotation"""
    result = await db.execute(select(Quotation).options(selectinload(Quotation.line_items)).where(Quotation.id == quote_id))
    quote = result.unique().scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    return _quote_dict(quote, quote.line_items)

@router.post("/quotations/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_quotation(data: QuotationCreate, db: AsyncSession = Depends(get_db)):
    """Create a new quotation"""
    # Validate items
    if not data.items or len(data.items) == 0:
        raise HTTPException(400, "Quotation must have at least one item")

    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have name and positive quantity")

    # Generate quotation number
    result = await db.execute(select(func.count(Quotation.id)))
    quote_count = result.scalar() or 0
    quote_num = f"QT-{datetime.now().year}-{str(quote_count + 1).zfill(4)}"

    # Calculate totals
    subtotal = sum(i.qty * i.price for i in data.items)
    tax_total = sum(i.qty * i.price * (i.tax_rate / 100) for i in data.items)
    total = subtotal + tax_total - data.discount

    # Create quotation
    quote = Quotation(
        id=str(uuid.uuid4()),
        number=quote_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name,
        created_by=data.created_by,
        date=data.date or datetime.now().strftime("%Y-%m-%d"),
        valid_until=data.valid_until,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=data.discount,
        total=round(total, 2),
        notes=data.notes,
    )

    # Add line items
    for item in data.items:
        line_total = item.qty * item.price + (item.qty * item.price * item.tax_rate / 100) - item.line_discount
        li = QuotationLineItem(
            id=str(uuid.uuid4()),
            quotation_id=quote.id,
            item_id=item.item_id,
            name=item.name,
            qty=item.qty,
            price=item.price,
            tax_rate=item.tax_rate,
            discount=item.line_discount,
            line_total=round(line_total, 2),
        )
        db.add(li)

    db.add(quote)
    await db.commit()
    await db.refresh(quote)
    return {"id": quote.id, "number": quote.number, "total": round(total, 2), "status": "draft"}

@router.patch("/quotations/{quote_id}/status", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_quotation_status(quote_id: str, status: str, db: AsyncSession = Depends(get_db)):
    """Update quotation status — `status` must be a valid QuotationStatus value."""
    try:
        new_status = QuotationStatus(status)
    except ValueError:
        valid = ", ".join(s.value for s in QuotationStatus)
        raise HTTPException(400, f"Invalid status '{status}'. Must be one of: {valid}")
    result = await db.execute(select(Quotation).where(Quotation.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    quote.status = new_status
    await db.commit()
    return {"status": quote.status.value}

# ─── LIST CREDIT PURCHASES ───────────────────────────────────────────────────
@router.get("/credit/purchases", dependencies=[Depends(require_perm("invoices.view"))])
async def list_credit_purchases(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List all invoices purchased on credit (unpaid)"""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = [SaleInvoice.payment_mode == "credit"]
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "number": SaleInvoice.number,
            "customer_name": SaleInvoice.customer_name,
            "date": SaleInvoice.date,
            "total": SaleInvoice.total,
            "paid_amount": SaleInvoice.paid_amount,
            "balance_due": (SaleInvoice.total - SaleInvoice.paid_amount),
            "status": SaleInvoice.status,
            "created_at": SaleInvoice.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = (
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.payment_mode == "credit")
    )
    total = int((await db.execute(select(func.count(SaleInvoice.id)).where(and_(*conds)))).scalar() or 0)
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    invoices = result.unique().scalars().all()
    out = [_inv_dict(inv, inv.line_items) for inv in invoices]
    return paged(out, total, sk, lim)

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{invoice_id}", dependencies=[Depends(require_perm("invoices.view"))])
async def get_invoice(invoice_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    li_res = await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id))
    return _inv_dict(inv, li_res.scalars().all())

# ─── CREATE ───────────────────────────────────────────────────────────────────
@router.post("/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_invoice(data: SaleCreate, db: AsyncSession = Depends(get_db)):
    if not data.items:
        raise HTTPException(400, "Invoice must have at least one line item")
    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have a name and positive quantity")
    today = datetime.now().strftime("%Y-%m-%d")
    # Line net (pre-tax) after line_discount (percentage off list line gross)
    line_rows = []
    for i in data.items:
        gross = round(i.qty * i.price, 2)
        line_disc_amt = max(0.0, min(gross, round(i.line_discount_amount or 0, 2)))
        if line_disc_amt > 0:
            line_net = round(gross - line_disc_amt, 2)
        else:
            line_net = round(gross * (1 - i.line_discount / 100), 2)
        line_tax = round(line_net * (i.tax_rate / 100), 2)
        line_rows.append((i, line_net, line_tax))
    subtotal  = sum(r[1] for r in line_rows)
    tax_total = sum(r[2] for r in line_rows)
    total     = round(subtotal + tax_total - data.discount, 2)
    paid      = total if data.payment_mode not in ("credit",) else 0.0
    status    = "paid" if paid >= total else "pending"

    # Sequential-ish number
    count = (await db.execute(select(func.count(SaleInvoice.id)))).scalar() or 0
    inv_num = f"INV-{datetime.now().year}-{2000 + count}"

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        cashier=data.cashier,
        date=data.date or today,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount, 2),
        total=round(total, 2),
        paid_amount=round(paid, 2),
        payment_mode=data.payment_mode,
        status=status,
        notes=data.notes,
    )
    db.add(inv)

    for item, line_net, _line_tax in line_rows:
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, price=item.price,
            tax_rate=item.tax_rate,
            line_total=line_net,
        )
        db.add(li)
        # Stock side-effect. For tracked items we walk batches in FEFO order
        # (when the item also tracks expiry) or FIFO otherwise; for untracked
        # items we fall back to the legacy aggregate deduction. Insufficient
        # stock => clamp to zero rather than fail the sale (the POS can
        # oversell; audit log will pick it up in Phase 4 hardening).
        if item.item_id:
            tracked, expiry_tracked = await is_tracked(db, item.item_id)
            if tracked:
                strategy = "fefo" if expiry_tracked else "fifo"
                # Cashier UI sends an explicit allocation when the line spans
                # multiple batches. Convert pydantic models → plain dicts for
                # the atomic helper.
                explicit = (
                    [e.model_dump() for e in item.batch_allocation]
                    if item.batch_allocation else None
                )
                consumed_ok = False
                try:
                    await consume_batches_atomic(
                        db,
                        item_id=item.item_id,
                        branch_id=data.branch_id,
                        qty=item.qty,
                        strategy=strategy,
                        preferred_batch_id=item.batch_id,
                        explicit_allocation=explicit,
                    )
                    consumed_ok = True
                except ValueError:
                    # Stale explicit allocation (another cashier drained a batch,
                    # wrong branch, inactive lot, etc.) is common at POS — retry
                    # once with auto FIFO/FEFO before the destructive clamp.
                    if explicit:
                        try:
                            await consume_batches_atomic(
                                db,
                                item_id=item.item_id,
                                branch_id=data.branch_id,
                                qty=item.qty,
                                strategy=strategy,
                                preferred_batch_id=item.batch_id,
                                explicit_allocation=None,
                            )
                            consumed_ok = True
                        except ValueError:
                            pass
                if not consumed_ok:
                    # Genuine shortage — drain whatever batches we have, then
                    # zero the aggregate (POS allows oversell-to-zero).
                    await db.execute(
                        text(
                            "UPDATE item_batches SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": item.item_id, "b": data.branch_id},
                    )
                    await db.execute(
                        text(
                            "UPDATE item_stock SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": item.item_id, "b": data.branch_id},
                    )
            else:
                try:
                    await adjust_stock_atomic(
                        db,
                        item_id=item.item_id,
                        branch_id=data.branch_id,
                        delta=-item.qty,
                    )
                except ValueError:
                    await db.execute(
                        text(
                            "UPDATE item_stock SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": item.item_id, "b": data.branch_id},
                    )

    await db.commit()
    await db.refresh(inv)
    return {"id": inv.id, "number": inv_num, "total": round(total, 2), "status": status}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/payment", dependencies=[Depends(require_perm("invoices.edit"))])
async def record_payment(invoice_id: str, data: PaymentIn, db: AsyncSession = Depends(get_db)):
    result = await add_payment_atomic(db, invoice_id=invoice_id, amount=data.amount)
    if result is None:
        # Either the invoice doesn't exist or amount <= 0. Differentiate.
        exists = (await db.execute(
            select(SaleInvoice.id).where(SaleInvoice.id == invoice_id)
        )).scalar_one_or_none()
        if not exists:
            raise HTTPException(404, "Invoice not found")
        raise HTTPException(400, "amount must be > 0")
    paid, balance = result
    await db.commit()
    return {
        "status": "paid" if balance <= 0 else "partial",
        "paid_amount": paid,
        "balance": balance,
    }

# ─── CANCEL ───────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/cancel", dependencies=[Depends(require_perm("invoices.cancel"))])
async def cancel_invoice(invoice_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.status == "paid" and inv.paid_amount > 0:
        raise HTTPException(400, "Cannot cancel a paid invoice. Issue a credit note instead.")
    inv.status = "cancelled"
    await db.commit()
    return {"status": "cancelled"}

# ─── HELPER ───────────────────────────────────────────────────────────────────
def _quote_dict(quote, items=None):
    d = {
        "id": quote.id, "number": quote.number,
        "customerId": quote.customer_id,
        "customerName": quote.customer_name or "Walk-in",
        "branchId": quote.branch_id,
        "branchName": quote.branch_name,
        "createdBy": quote.created_by,
        "date": quote.date,
        "validUntil": quote.valid_until,
        "subtotal": quote.subtotal,
        "taxTotal": quote.tax_total,
        "discount": quote.discount,
        "total": quote.total,
        "status": str(quote.status.value) if hasattr(quote.status, "value") else str(quote.status),
        "notes": quote.notes,
    }
    if items is not None:
        d["items"] = [{
            "id": i.id,
            "name": i.name, "qty": i.qty,
            "price": i.price, "taxRate": i.tax_rate,
            "discount": i.discount, "lineTotal": i.line_total,
        } for i in items]
    return d

def _inv_dict(inv, items=None):
    d = {
        "id": inv.id, "number": inv.number,
        "customerId": inv.customer_id,
        "customerName": inv.customer_name or "Walk-in",
        "branchId": inv.branch_id,
        "branchName": inv.branch_name,
        "cashier": inv.cashier,
        "date": inv.date,
        "subtotal": inv.subtotal,
        "taxTotal": inv.tax_total,
        "discount": inv.discount,
        "total": inv.total,
        "paidAmount": inv.paid_amount,
        "paymentMode": inv.payment_mode,
        "status": str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status),
        "notes": inv.notes,
    }
    if items is not None:
        d["items"] = [{
            "name": i.name, "qty": i.qty,
            "price": i.price, "taxRate": i.tax_rate,
            "lineTotal": i.line_total,
        } for i in items]
    return d

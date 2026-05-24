import uuid
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.document_numbering import allocate_number
from src.tax_calc import line_tax_amount, line_taxable_amount, normalize_tax_pricing_mode
from src.models import (
    AuditLog,
    Customer,
    InvoiceStatus,
    Organisation,
    Quotation,
    QuotationLineItem,
    QuotationStatus,
    SaleInvoice,
    SaleLineItem,
    SalesOrder,
    SalesOrderLineItem,
    SalesOrderStatus,
    SalesReturn,
    SalesReturnLineItem,
    SalesReturnStatus,
    User,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import (
    add_batch_atomic,
    add_payment_atomic,
    adjust_stock_atomic,
    consume_batches_atomic,
    is_tracked,
)
from src.routes.dashboard import invalidate_dashboard_cache_for_user
from src.routes._serializers import get_user_branch_ids
from src.security import current_user, enforce_branch_access, enforce_branch_access_optional, require_perm

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

"""Allowed payment methods on a SALE INVOICE.

These are the ONLY values that can sit on `sale_invoices.payment_mode`,
whether the invoice is created paid via POS (`SaleCreate.payment_mode`)
or paid later via the record-payment modal (`PaymentIn.mode`). One
Literal, both endpoints — the POS dropdown and the record-payment
dropdown must offer the same set (enforced UI-side too in
SalesPage.jsx#VALID_PAYMENT_MODES and POSPage.jsx).

`None` is also allowed and means "no payment received yet — invoice is
pending". The `status='pending'` flag already carries that semantic, so we
deliberately don't have a `'credit'` member here — the legacy "credit" mode
was misleading (it meant "no payment", not "paid by credit method"). Held
bills + scripts that still send "credit" are coerced to None by the
field_validator below so existing clients keep working through the cutover.

2026-05-24: dropped the wider `RecordedPaymentMode` (which had included
'cheque'). POS never accepted cheque; carrying a different allow-list
for the record-payment endpoint was just drift. PaymentIn.mode now
reuses the same Literal as SaleCreate.payment_mode.
"""
PaymentMode = Literal["cash", "card", "upi", "bank_transfer"]


def _coerce_payment_mode_value(v):
    """Shared pre-validator body for PaymentMode-family Literals.

    Returns None for None / empty / legacy "credit" (so old held bills
    still land as pending). Otherwise lowercases + strips so case/whitespace
    noise doesn't trip the Literal — `"CASH "` → `"cash"`.
    """
    if v is None:
        return None
    if not isinstance(v, str):
        return v
    s = v.strip().lower()
    if s in ("", "credit"):
        return None
    return s


class SaleCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    cashier: str = "Staff"
    date: Optional[str] = None          # defaults to today
    items: List[LineItemIn]
    discount: float = 0
    # Strict allow-list (see PaymentMode docstring above). Legacy clients
    # that still send "credit" or "" get coerced to None by
    # `_coerce_payment_mode` below so the contract is forgiving on input
    # but strict on storage.
    payment_mode: Optional[PaymentMode] = None
    notes: Optional[str] = None

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)

class PaymentIn(BaseModel):
    amount: float
    # Sales Phase 1 (2026-05-23): `mode` is now required (was defaulted to
    # "bank_transfer" before). Settling an invoice without recording the
    # method loses the audit trail of what cleared it — and the new POS
    # checkbox flow makes the operator pick a method explicitly anyway, so
    # there's no reason this endpoint should silently default.
    #
    # 2026-05-24: tightened from `str` → `PaymentMode` Literal. Same
    # allow-list as SaleCreate.payment_mode (POS). The record-payment
    # modal in SalesPage.jsx offers the same 4 options as POS — cheque
    # was removed at user request (POS never supported it; carrying a
    # wider allow-list here just caused drift). Bogus values now
    # return 422 with the expected list. The mode is also PERSISTED on
    # the invoice (see `record_payment` → `add_payment_atomic`).
    mode: PaymentMode
    ref: str = ""

    @field_validator("mode", mode="before")
    @classmethod
    def _coerce_mode(cls, v):
        return _coerce_payment_mode_value(v)

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

# SAMPLE_RETURNS hardcoded list (legacy placeholder data, 2026-04 era)
# removed 2026-05-23. The real /sales/returns endpoint backed by the
# SalesReturn table lives further down in this file (see "Sales Returns:
# LIST"). Spec: ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md.


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
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
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
    user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = _sale_invoice_filters(branch_id, status, customer_id, search, date_from, date_to)
    if branch_id is None and not getattr(user, "all_branches", False):
        branch_ids = await get_user_branch_ids(db, user.id)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(SaleInvoice.branch_id.in_(branch_ids))
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

# Legacy SAMPLE_RETURNS-backed /returns endpoint removed 2026-05-23 (PR 2).
# The real persisted version lives at "Sales Returns: LIST" below.

# ─── QUOTATIONS ───────────────────────────────────────────────────────────────
@router.get("/quotations/", dependencies=[Depends(require_perm("invoices.view"))])
async def list_quotations(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
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
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_user_branch_ids(db, user.id)
        if not branch_ids:
            return paged([], 0, sk, lim)
        q = q.where(Quotation.branch_id.in_(branch_ids))
        q_count = q_count.where(Quotation.branch_id.in_(branch_ids))
    total = int((await db.execute(q_count)).scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    quotations = result.unique().scalars().all()
    items_out = [_quote_dict(qt, qt.line_items) for qt in quotations]
    return paged(items_out, total, sk, lim)

@router.get("/quotations/{quote_id}", dependencies=[Depends(require_perm("invoices.view"))])
async def get_quotation(quote_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Get a specific quotation"""
    result = await db.execute(select(Quotation).options(selectinload(Quotation.line_items)).where(Quotation.id == quote_id))
    quote = result.unique().scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    await enforce_branch_access(quote.branch_id, user=user, db=db)
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

    quote_num = await allocate_number(
        db, "quotation", branch_id=data.branch_id
    )

    # 2026-05-24: rewrote the totals + line math to match update_quotation
    # and _calc_lines exactly. The old code was buggy in three ways:
    #   1. subtotal / tax_total summed line_gross WITHOUT subtracting
    #      line_discount, so per-line discounts vanished from the rollup.
    #   2. line_total mistreated `line_discount` as a flat amount
    #      (subtracted directly from gross), but update_quotation +
    #      _calc_lines treat it as a percent. Editing a created quote
    #      would silently change the total.
    #   3. line_total stored gross+tax−discount instead of net+tax,
    #      which interpreted the discount as a post-tax deduction.
    # Now: line_discount is always a percent (0-100). Frontend is the
    # source of conversion (it offers a %/₹ toggle and converts ₹ → %
    # before POST). See OrderFormModal / QuoteFormModal.
    line_rows = []  # list[(item, line_net, line_tax)]
    subtotal = 0.0
    tax_total = 0.0
    for item in data.items:
        gross = round(item.qty * item.price, 2)
        line_net = round(gross * (1 - (item.line_discount or 0) / 100), 2)
        line_tax = round(line_net * ((item.tax_rate or 0) / 100), 2)
        line_rows.append((item, line_net, line_tax))
        subtotal += line_net
        tax_total += line_tax
    total = round(subtotal + tax_total - (data.discount or 0), 2)

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
        total=total,
        notes=data.notes,
    )

    # Add line items
    for item, line_net, line_tax in line_rows:
        li = QuotationLineItem(
            id=str(uuid.uuid4()),
            quotation_id=quote.id,
            item_id=item.item_id,
            name=item.name,
            qty=item.qty,
            price=item.price,
            tax_rate=item.tax_rate,
            discount=item.line_discount,
            line_total=round(line_net + line_tax, 2),
        )
        db.add(li)

    db.add(quote)
    await db.commit()
    await db.refresh(quote)
    return {"id": quote.id, "number": quote.number, "total": round(total, 2), "status": "draft"}

@router.put("/quotations/{quote_id}", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_quotation(quote_id: str, data: QuotationCreate, db: AsyncSession = Depends(get_db)):
    """Full replace of an editable quotation. Editable iff status ∈
    {draft, sent}. Converted / accepted / rejected quotes are locked —
    editing them would orphan downstream SOs / invoices that were
    created from the original prices. Items replaced wholesale.

    LineItemIn is reused from the sale-invoice schema (it carries extra
    fields like batch_allocation that quotes ignore — they're optional).
    """
    res = await db.execute(
        select(Quotation)
        .options(selectinload(Quotation.line_items))
        .where(Quotation.id == quote_id)
    )
    quote = res.scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    if quote.status in (QuotationStatus.converted, QuotationStatus.accepted, QuotationStatus.rejected):
        raise HTTPException(400, f"Cannot edit a {quote.status.value} quotation")
    if not data.items:
        raise HTTPException(400, "Quotation must have at least one line item")

    # Same line math as create. LineItemIn's `line_discount` is a percent
    # (matches the invoice/sales convention); QuotationLineItem stores
    # discount as a number too — we mirror what's already done in
    # create_quotation.
    subtotal = 0.0
    tax_total = 0.0
    line_rows = []
    for i in data.items:
        gross = round(i.qty * i.price, 2)
        line_net = round(gross * (1 - (i.line_discount or 0) / 100), 2)
        line_tax = round(line_net * ((i.tax_rate or 0) / 100), 2)
        line_rows.append((i, line_net, line_tax))
        subtotal += line_net
        tax_total += line_tax
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    quote.customer_id = data.customer_id
    quote.customer_name = data.customer_name
    quote.branch_id = data.branch_id
    quote.branch_name = data.branch_name or data.branch_id
    quote.created_by = data.created_by
    quote.date = data.date or quote.date
    quote.valid_until = data.valid_until
    quote.subtotal = round(subtotal, 2)
    quote.tax_total = round(tax_total, 2)
    quote.discount = round(data.discount or 0, 2)
    quote.total = total
    quote.notes = data.notes

    from sqlalchemy import delete as sa_delete
    await db.execute(
        sa_delete(QuotationLineItem).where(QuotationLineItem.quotation_id == quote.id)
    )
    for line, line_net, _line_tax in line_rows:
        db.add(QuotationLineItem(
            id=str(uuid.uuid4()), quotation_id=quote.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate,
            discount=line.line_discount or 0,
            line_total=line_net,
        ))
    await db.commit()
    return {"id": quote.id, "number": quote.number, "total": total, "status": quote.status.value}


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

# ─── (REMOVED 2026-05-23) GET /credit/purchases ─────────────────────────────
# The "Credit Purchases" tab was dropped in Sales Phase 1. The list was just
# `SaleInvoice.payment_mode == "credit"` — same data is available via the
# main `GET /sales/` endpoint with a payment_mode filter if anyone needs it.
# See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md for the rationale.

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{invoice_id}", dependencies=[Depends(require_perm("invoices.view"))])
async def get_invoice(invoice_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await enforce_branch_access(inv.branch_id, user=user, db=db)
    li_res = await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id))
    return _inv_dict(inv, li_res.scalars().all())

# ─── CREATE ───────────────────────────────────────────────────────────────────
@router.post("/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_invoice(data: SaleCreate, user: User = Depends(require_perm("invoices.create")), db: AsyncSession = Depends(get_db)):

    if not data.items:
        raise HTTPException(400, "Invoice must have at least one line item")
    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have a name and positive quantity")
    today = datetime.now().strftime("%Y-%m-%d")
    org_row = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    tax_mode = normalize_tax_pricing_mode(
        org_row.tax_pricing_mode if org_row else None
    )
    # Line amount after line discount; tax extracted or added per org pricing mode.
    line_rows = []
    for i in data.items:
        gross = round(i.qty * i.price, 2)
        line_disc_amt = max(0.0, min(gross, round(i.line_discount_amount or 0, 2)))
        if line_disc_amt > 0:
            line_amount = round(gross - line_disc_amt, 2)
        else:
            line_amount = round(gross * (1 - i.line_discount / 100), 2)
        line_tax = line_tax_amount(line_amount, i.tax_rate, tax_mode)
        line_taxable = line_taxable_amount(line_amount, i.tax_rate, tax_mode)
        line_rows.append((i, line_amount, line_taxable, line_tax))
    subtotal  = sum(r[2] for r in line_rows)
    tax_total = sum(r[3] for r in line_rows)
    if tax_mode == "inclusive":
        total = round(sum(r[1] for r in line_rows) - data.discount, 2)
    else:
        total = round(subtotal + tax_total - data.discount, 2)
    is_paid_at_create = data.payment_mode is not None
    paid      = total if is_paid_at_create else 0.0
    status    = "paid" if paid >= total else "pending"

    await enforce_branch_access(data.branch_id, user=user, db=db)

    inv_num = await allocate_number(
        db, "sales_invoice", branch_id=data.branch_id
    )

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
        # Stored value is either None (no payment yet) or one of the
        # PaymentMode literals. Old rows with "credit" predate the
        # 2026-05-23 tightening and stay as-is — read paths still
        # tolerate them, but no new writes produce that value.
        payment_mode=data.payment_mode,
        status=status,
        notes=data.notes,
    )
    db.add(inv)

    for item, _line_amount, line_taxable, _line_tax in line_rows:
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, price=item.price,
            tax_rate=item.tax_rate,
            line_total=line_taxable,
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
    invalidate_dashboard_cache_for_user(user.id)
    await db.refresh(inv)
    return {"id": inv.id, "number": inv_num, "total": round(total, 2), "status": status}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/payment", dependencies=[Depends(require_perm("invoices.edit"))])
async def record_payment(invoice_id: str, data: PaymentIn, db: AsyncSession = Depends(get_db)):
    """Record a payment against an invoice.

    Sales Phase 1 (2026-05-23) behavior:
      • amount ≤ 0                              → 400 "amount must be > 0"
      • invoice not found                       → 404
      • invoice already fully paid              → 400 (no silent no-op)
      • amount ≤ balance                        → settle (paid or partial)
      • amount > balance + customer_id set      → settle + route excess to
        Customer.credit_balance + write AuditLog row
      • amount > balance + walk-in (no cust id) → 400 "reduce amount"
      • mode field always required (Pydantic enforces — see PaymentIn)

    The atomic helper returns `(paid, balance, credit_applied)`:
      credit_applied = max(0, amount - amount_actually_landed_on_invoice).
    We never let the invoice itself go over `total`; excess always becomes
    customer credit (or a 400 for walk-ins).
    """
    # Reject already-paid invoices BEFORE calling the atomic helper so the
    # error message is specific. Without this, the helper would just set
    # credit_applied = amount (since balance was already 0) and silently
    # credit the customer — surprising behavior.
    pre = await db.execute(
        select(SaleInvoice.id, SaleInvoice.total, SaleInvoice.paid_amount, SaleInvoice.customer_id, SaleInvoice.number)
        .where(SaleInvoice.id == invoice_id)
    )
    pre_row = pre.first()
    if not pre_row:
        raise HTTPException(404, "Invoice not found")
    pre_total = float(pre_row.total or 0)
    pre_paid = float(pre_row.paid_amount or 0)
    pre_balance = max(0.0, pre_total - pre_paid)
    if pre_balance <= 0:
        raise HTTPException(400, "Invoice already settled")

    # Pass `mode` down so the atomic UPDATE also sets sale_invoices.payment_mode
    # in the same statement (no risk of a partial update). Without this the
    # invoice's payment_mode would stay at whatever it was at create time
    # (None for pending invoices), making the UI Mode column lie / show "—".
    result = await add_payment_atomic(
        db,
        invoice_id=invoice_id,
        amount=data.amount,
        mode=data.mode,
    )
    if result is None:
        raise HTTPException(400, "amount must be > 0")
    paid, balance, credit_applied = result

    # Overpayment handling: route excess to customer credit OR reject for
    # walk-ins. The pre-check above guarantees pre_balance > 0; any excess
    # means the operator typed an amount larger than what was owed.
    customer_credit_after: Optional[float] = None
    if credit_applied > 0:
        if not pre_row.customer_id:
            # Walk-in overpayment — nothing to credit. Bail BEFORE commit so
            # the partial UPDATE rolls back cleanly. The atomic helper
            # already capped the invoice at `total`, so without this rollback
            # the invoice would settle correctly but the overpayment would
            # silently vanish.
            await db.rollback()
            raise HTTPException(
                400,
                f"Walk-in invoice — reduce amount to ₹{round(pre_balance, 2)} "
                f"or assign a customer first to capture the ₹{credit_applied} excess as credit",
            )
        # Customer set — bump credit_balance + audit log.
        from src.models import AuditLog, Customer
        cust_row = await db.execute(
            select(Customer).where(Customer.id == pre_row.customer_id)
        )
        cust = cust_row.scalar_one_or_none()
        if cust is not None:
            cur_credit = float(cust.credit_balance or 0)
            cust.credit_balance = round(cur_credit + credit_applied, 2)
            customer_credit_after = cust.credit_balance
            db.add(AuditLog(
                id=str(uuid.uuid4()),
                action="customer_credit",
                user_id=None,
                user_name=None,
                module="sales",
                ref=pre_row.number,
                detail=(
                    f"Overpayment on {pre_row.number}: +₹{credit_applied} "
                    f"credited to {cust.name} (was ₹{cur_credit:.2f}, "
                    f"now ₹{cust.credit_balance:.2f})"
                ),
                risk="low",
                ip_address=None,
            ))

    await db.commit()
    return {
        "status": "paid" if balance <= 0 else "partial",
        "paid_amount": paid,
        "balance": balance,
        "credit_applied": credit_applied,
        "customer_credit_balance": customer_credit_after,
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
        # 2026-05-24: added `itemId` here. Quote lines have always carried
        # `item_id` server-side (set by create_quotation), but the
        # serializer was dropping it on read — so the SalesPage edit flow
        # would hydrate every line as item_id=None and the new
        # InventoryItemPicker would render legacy "no id" state. _so_dict
        # and _return_dict already emit itemId; this brings _quote_dict
        # in line.
        d["items"] = [{
            "id": i.id, "itemId": i.item_id,
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
            "id": i.id,
            "itemId": i.item_id,
            "name": i.name, "qty": i.qty,
            "price": i.price, "taxRate": i.tax_rate,
            "lineTotal": i.line_total,
        } for i in items]
    return d


# ═════════════════════════════════════════════════════════════════════════════
# SALES PHASE 1 PR 2 — Sales Orders, Quotation→Order convert, Sales Returns
# ═════════════════════════════════════════════════════════════════════════════
# Three independent flows that share infrastructure:
#   • SalesOrder = intent to invoice. CRUD + convert→invoice.
#   • Quotation→Order convert = create an SO from an accepted quote.
#   • SalesReturn = post-sale return. Validates against original invoice
#     qty (cumulative across multiple returns), restocks via _atomic
#     helpers, optionally credits customer.credit_balance.
#
# All three reuse the spec at:
#   ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md

# ─── Schemas (PR 2) ──────────────────────────────────────────────────────────
class SalesOrderLineIn(BaseModel):
    """Same shape as quotation lines — kept separate so the two intents
    can evolve independently (e.g. SO might gain a per-line stock-reserve
    flag later)."""
    item_id: Optional[str] = None
    name: str
    qty: int = Field(..., gt=0)
    price: float
    tax_rate: float = 0
    discount: float = 0


class SalesOrderCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    created_by: str = "Staff"
    date: Optional[str] = None
    expected_date: Optional[str] = None
    items: List[SalesOrderLineIn]
    discount: float = 0
    notes: Optional[str] = None


class ConvertLineAllocation(BaseModel):
    """Per-line batch allocation passed to the SO→Invoice convert flow.

    The frontend (ConvertToInvoiceModal) lets the operator pick specific
    batches for each batch-tracked line. Lines that the operator skips
    (or untracked items) just aren't represented in the array, and the
    server falls back to auto FIFO/FEFO for those — same lenient behavior
    as before this field existed.

    `item_id` matches the SO line's item_id. `batch_allocation` reuses the
    same shape as POS LineItemIn.batch_allocation so the consume_batches_atomic
    helper can accept it unchanged.
    """
    item_id: str
    batch_allocation: List[BatchAllocationEntry]


class ConvertToInvoiceIn(BaseModel):
    """Payload for SO→Invoice convert (and reused for the quote→order→
    invoice double-hop). Mirrors the new POS payment UX:
      • payment_received=False (default) → invoice created pending
      • payment_received=True            → invoice created paid; method required

    2026-05-24: added optional `line_allocations` so the operator can
    pre-pick batches per tracked line at convert time. SO/Quote lines
    themselves stay batch-free (Option B from the user's plan choice);
    this is the single place the operator gets to say "use these batches"
    before stock is moved. Missing / empty → auto FIFO/FEFO (today's path).
    """
    payment_received: bool = False
    payment_mode: Optional[str] = None
    notes: Optional[str] = None
    line_allocations: Optional[List[ConvertLineAllocation]] = None


class SalesReturnLineIn(BaseModel):
    # invoice_line_id is preferred (lets the backend validate against the
    # exact original line); item_id+name are accepted as fallback for
    # legacy invoices where line ids weren't surfaced to the UI.
    invoice_line_id: Optional[str] = None
    item_id: Optional[str] = None
    name: str
    return_qty: int = Field(..., gt=0)


class SalesReturnCreate(BaseModel):
    invoice_id: str
    date: Optional[str] = None
    reason: Optional[str] = None
    # refund_method: cash | credit | adjustment
    #   • walk-in invoice → server forces to "cash" regardless of input
    #   • credit → bumps customer.credit_balance (only valid with customer)
    #   • adjustment → reduces invoice's outstanding balance (no money moves)
    refund_method: str = "cash"
    items: List[SalesReturnLineIn]
    notes: Optional[str] = None
    created_by: str = "Staff"


# ─── Sales Order helpers ─────────────────────────────────────────────────────
def _so_dict(so, items=None):
    d = {
        "id": so.id, "number": so.number,
        "customerId": so.customer_id,
        "customerName": so.customer_name or "Walk-in",
        "branchId": so.branch_id,
        "branchName": so.branch_name,
        "createdBy": so.created_by,
        "date": so.date,
        "expectedDate": so.expected_date,
        "subtotal": so.subtotal,
        "taxTotal": so.tax_total,
        "discount": so.discount,
        "total": so.total,
        "status": so.status.value if hasattr(so.status, "value") else str(so.status),
        "convertedInvoiceId": so.converted_invoice_id,
        "notes": so.notes,
        "createdAt": so.created_at.isoformat() if so.created_at else None,
    }
    if items is not None:
        d["items"] = [{
            "id": i.id, "itemId": i.item_id, "name": i.name,
            "qty": i.qty, "price": i.price, "taxRate": i.tax_rate,
            "discount": i.discount, "lineTotal": i.line_total,
        } for i in items]
    return d


def _calc_lines(lines):
    """Compute line totals + roll up subtotal/tax for SO + quote shapes.
    Returns (line_rows, subtotal, tax_total). Each row is (line, line_net,
    line_tax) so callers can populate the ORM objects without re-doing the
    math.
    """
    rows = []
    subtotal = 0.0
    tax_total = 0.0
    for i in lines:
        gross = round(i.qty * i.price, 2)
        line_net = round(gross * (1 - (i.discount or 0) / 100), 2)
        line_tax = round(line_net * ((i.tax_rate or 0) / 100), 2)
        rows.append((i, line_net, line_tax))
        subtotal += line_net
        tax_total += line_tax
    return rows, subtotal, tax_total


# ─── Sales Order: LIST ───────────────────────────────────────────────────────
@router.get("/orders/", dependencies=[Depends(require_perm("invoices.view"))])
async def list_orders(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(select(func.count(SalesOrder.id)))).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {
            "number": SalesOrder.number,
            "customer_name": SalesOrder.customer_name,
            "date": SalesOrder.date,
            "expected_date": SalesOrder.expected_date,
            "total": SalesOrder.total,
            "status": SalesOrder.status,
            "created_at": SalesOrder.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = (
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .order_by(sort_expr).offset(sk).limit(lim)
    )
    rows = (await db.execute(q)).unique().scalars().all()
    out = [_so_dict(so, so.line_items) for so in rows]
    return paged(out, total, sk, lim)


# ─── Sales Order: GET ONE ────────────────────────────────────────────────────
@router.get("/orders/{order_id}", dependencies=[Depends(require_perm("invoices.view"))])
async def get_order(order_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    return _so_dict(so, so.line_items)


# ─── Sales Order: CREATE ─────────────────────────────────────────────────────
@router.post("/orders/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_order(data: SalesOrderCreate, db: AsyncSession = Depends(get_db)):
    if not data.items:
        raise HTTPException(400, "Sales order must have at least one line item")

    line_rows, subtotal, tax_total = _calc_lines(data.items)
    total = round(subtotal + tax_total - (data.discount or 0), 2)
    today = datetime.now().strftime("%Y-%m-%d")
    count = (await db.execute(select(func.count(SalesOrder.id)))).scalar() or 0
    so_num = f"SO-{datetime.now().year}-{1000 + count}"

    so = SalesOrder(
        id=str(uuid.uuid4()), number=so_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        created_by=data.created_by,
        date=data.date or today,
        expected_date=data.expected_date,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount or 0, 2),
        total=total,
        status=SalesOrderStatus.confirmed,  # default to confirmed; "draft" reserved for future quick-save
        notes=data.notes,
    )
    db.add(so)
    for line, line_net, _line_tax in line_rows:
        db.add(SalesOrderLineItem(
            id=str(uuid.uuid4()), order_id=so.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate, discount=line.discount or 0,
            line_total=line_net,
        ))
    # NB: no stock side-effect at create. Stock moves only when the SO is
    # converted to an invoice (same code path as POS sales).
    await db.commit()
    return {"id": so.id, "number": so.number, "total": total, "status": so.status.value}


# ─── Sales Order: UPDATE (full replace of editable fields + items) ──────────
@router.put("/orders/{order_id}", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_order(order_id: str, data: SalesOrderCreate, db: AsyncSession = Depends(get_db)):
    """Full replace of an SO's editable fields. Status is NOT changed here
    (the convert flow + the dedicated `/status` PATCH handle that). Items
    are replaced wholesale — simpler than diffing and the SO has no stock
    side-effects until convert, so there's nothing in flight to reconcile.

    Editable iff status ∈ {draft, confirmed}. Converted / cancelled orders
    are locked — pretending to allow edits would orphan accounting state
    (the spawned invoice would no longer match the SO it came from)."""
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    if so.status in (SalesOrderStatus.converted, SalesOrderStatus.cancelled):
        raise HTTPException(400, f"Cannot edit a {so.status.value} sales order")
    if not data.items:
        raise HTTPException(400, "Sales order must have at least one line item")

    # Replace fields (status preserved). Recompute totals from new items.
    line_rows, subtotal, tax_total = _calc_lines(data.items)
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    so.customer_id = data.customer_id
    so.customer_name = data.customer_name
    so.branch_id = data.branch_id
    so.branch_name = data.branch_name or data.branch_id
    so.created_by = data.created_by
    so.date = data.date or so.date
    so.expected_date = data.expected_date
    so.subtotal = round(subtotal, 2)
    so.tax_total = round(tax_total, 2)
    so.discount = round(data.discount or 0, 2)
    so.total = total
    so.notes = data.notes

    # Wipe + reinsert line items. cascade='all, delete-orphan' on the
    # relationship would do it, but we clear via raw delete to keep the
    # behavior independent of session expire/refresh quirks under SQLite.
    from sqlalchemy import delete as sa_delete
    await db.execute(
        sa_delete(SalesOrderLineItem).where(SalesOrderLineItem.order_id == so.id)
    )
    for line, line_net, _line_tax in line_rows:
        db.add(SalesOrderLineItem(
            id=str(uuid.uuid4()), order_id=so.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate, discount=line.discount or 0,
            line_total=line_net,
        ))
    await db.commit()
    return {"id": so.id, "number": so.number, "total": total, "status": so.status.value}


# ─── Sales Order: UPDATE STATUS ──────────────────────────────────────────────
@router.patch("/orders/{order_id}/status", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_order_status(order_id: str, status: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(SalesOrder).where(SalesOrder.id == order_id))
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    try:
        target = SalesOrderStatus(status)
    except ValueError:
        raise HTTPException(400, f"Invalid status: {status}")
    # Once an SO is converted, the only legal next status is "cancelled" —
    # and only when there's no spawned invoice in a paid state (otherwise
    # cancelling the SO would orphan accounting state).
    if so.status == SalesOrderStatus.converted:
        raise HTTPException(400, "Cannot change status of a converted sales order (cancel the invoice first)")
    so.status = target
    await db.commit()
    return {"status": so.status.value}


# ─── Sales Order: CONVERT TO INVOICE ─────────────────────────────────────────
@router.post("/orders/{order_id}/convert", dependencies=[Depends(require_perm("invoices.create"))])
async def convert_order_to_invoice(
    order_id: str,
    data: ConvertToInvoiceIn,
    db: AsyncSession = Depends(get_db),
):
    """Spawn a SaleInvoice from an SO. The invoice walks the same stock
    side-effect path as a POS sale: tracked items consume via FIFO/FEFO
    (no operator allocation possible here — SOs don't carry batch picks),
    untracked items decrement aggregate. Insufficient stock clamps to zero
    (same lenient behavior as POS oversell).

    Payment status comes from `ConvertToInvoiceIn`:
      • payment_received=False → pending invoice
      • payment_received=True + payment_mode set → paid invoice
      • payment_received=True + payment_mode missing → 400
    """
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    if so.status == SalesOrderStatus.converted:
        raise HTTPException(400, "Sales order already converted")
    if so.status == SalesOrderStatus.cancelled:
        raise HTTPException(400, "Cannot convert a cancelled sales order")

    if data.payment_received and not (data.payment_mode or "").strip():
        raise HTTPException(400, "Pick a payment method (or uncheck Payment Received)")

    today = datetime.now().strftime("%Y-%m-%d")
    count = (await db.execute(select(func.count(SaleInvoice.id)))).scalar() or 0
    inv_num = f"INV-{datetime.now().year}-{2000 + count}"

    paid = so.total if data.payment_received else 0.0
    status = "paid" if paid >= so.total else "pending"
    payment_mode = data.payment_mode if data.payment_received else None

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=so.customer_id,
        customer_name=so.customer_name,
        branch_id=so.branch_id,
        branch_name=so.branch_name,
        cashier=so.created_by or "Staff",
        date=today,
        subtotal=so.subtotal,
        tax_total=so.tax_total,
        discount=so.discount,
        total=so.total,
        paid_amount=round(paid, 2),
        payment_mode=payment_mode,
        status=status,
        notes=data.notes or so.notes,
    )
    db.add(inv)

    # Index any operator-supplied per-line batch picks by item_id so we
    # can look them up cheaply inside the line loop. 2026-05-24 (Option B).
    alloc_by_item = {}
    if data.line_allocations:
        for a in data.line_allocations:
            alloc_by_item[a.item_id] = [e.model_dump() for e in a.batch_allocation]

    for line in so.line_items:
        db.add(SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate,
            line_total=line.line_total,
        ))
        # Stock side-effect — same FIFO/FEFO logic as POS, same lenient
        # oversell-to-zero. Could be hoisted into a helper shared with
        # create_invoice; left inline to avoid scope creep in this PR.
        if line.item_id:
            tracked, expiry_tracked = await is_tracked(db, line.item_id)
            if tracked:
                strategy = "fefo" if expiry_tracked else "fifo"
                # Operator-picked allocation (if any) takes precedence —
                # same precedence as POS LineItemIn (batch_allocation >
                # batch_id > auto). If the explicit allocation fails
                # (sum mismatch / drained batch / wrong branch), retry
                # once with auto before the destructive clamp — matches
                # POS's defense-in-depth.
                explicit = alloc_by_item.get(line.item_id)
                consumed_ok = False
                try:
                    await consume_batches_atomic(
                        db, item_id=line.item_id, branch_id=so.branch_id,
                        qty=line.qty, strategy=strategy,
                        explicit_allocation=explicit,
                    )
                    consumed_ok = True
                except ValueError:
                    if explicit:
                        try:
                            await consume_batches_atomic(
                                db, item_id=line.item_id, branch_id=so.branch_id,
                                qty=line.qty, strategy=strategy,
                                explicit_allocation=None,
                            )
                            consumed_ok = True
                        except ValueError:
                            pass
                if not consumed_ok:
                    # Short on batched stock — clamp ALL of this item's
                    # batches at this branch to zero and continue. Matches
                    # the create_invoice behavior.
                    await db.execute(
                        text(
                            "UPDATE item_batches SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": line.item_id, "b": so.branch_id},
                    )
                    await db.execute(
                        text(
                            "UPDATE item_stock SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": line.item_id, "b": so.branch_id},
                    )
            else:
                try:
                    await adjust_stock_atomic(
                        db, item_id=line.item_id, branch_id=so.branch_id,
                        delta=-line.qty,
                    )
                except ValueError:
                    await db.execute(
                        text(
                            "UPDATE item_stock SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": line.item_id, "b": so.branch_id},
                    )

    so.status = SalesOrderStatus.converted
    so.converted_invoice_id = inv.id
    await db.commit()
    return {
        "invoice_id": inv.id,
        "invoice_number": inv.number,
        "status": status,
        "total": inv.total,
    }


# ─── Quotation → Sales Order convert ─────────────────────────────────────────
@router.post("/quotations/{quote_id}/convert-to-order", dependencies=[Depends(require_perm("invoices.create"))])
async def convert_quote_to_order(quote_id: str, db: AsyncSession = Depends(get_db)):
    """Create a SalesOrder from a Quotation. Prices, taxes, discount, and
    line items are copied verbatim (the quote's commercial terms are the
    point of quoting — don't re-fetch current prices). Quote status flips
    to `accepted` if it isn't already terminal. Returns the new SO's id +
    number so the UI can navigate to it."""
    res = await db.execute(
        select(Quotation)
        .options(selectinload(Quotation.line_items))
        .where(Quotation.id == quote_id)
    )
    quote = res.scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    if quote.status in (QuotationStatus.converted, QuotationStatus.rejected):
        raise HTTPException(400, f"Quotation is {quote.status.value}; cannot convert")

    today = datetime.now().strftime("%Y-%m-%d")
    count = (await db.execute(select(func.count(SalesOrder.id)))).scalar() or 0
    so_num = f"SO-{datetime.now().year}-{1000 + count}"

    so = SalesOrder(
        id=str(uuid.uuid4()), number=so_num,
        customer_id=quote.customer_id,
        customer_name=quote.customer_name,
        branch_id=quote.branch_id,
        branch_name=quote.branch_name,
        created_by=quote.created_by or "Staff",
        date=today,
        subtotal=quote.subtotal,
        tax_total=quote.tax_total,
        discount=quote.discount,
        total=quote.total,
        status=SalesOrderStatus.confirmed,
        notes=f"From quotation {quote.number}" + (f": {quote.notes}" if quote.notes else ""),
    )
    db.add(so)
    for ql in quote.line_items:
        db.add(SalesOrderLineItem(
            id=str(uuid.uuid4()), order_id=so.id,
            item_id=ql.item_id, name=ql.name,
            qty=ql.qty, price=ql.price,
            tax_rate=ql.tax_rate, discount=ql.discount or 0,
            line_total=ql.line_total,
        ))

    quote.status = QuotationStatus.converted
    await db.commit()
    return {
        "order_id": so.id,
        "order_number": so.number,
        "total": so.total,
    }


# ─── Sales Returns: helpers ──────────────────────────────────────────────────
def _return_dict(ret, items=None):
    d = {
        "id": ret.id, "number": ret.number,
        "invoiceId": ret.invoice_id,
        "invoiceNumber": ret.invoice_number,
        "customerId": ret.customer_id,
        "customerName": ret.customer_name or "Walk-in",
        "branchId": ret.branch_id,
        "branchName": ret.branch_name,
        "date": ret.date,
        "reason": ret.reason,
        "refundMethod": ret.refund_method,
        "subtotal": ret.subtotal,
        "taxTotal": ret.tax_total,
        "total": ret.total,
        "creditedAmount": ret.credited_amount,
        "status": ret.status.value if hasattr(ret.status, "value") else str(ret.status),
        "notes": ret.notes,
        "createdBy": ret.created_by,
        "createdAt": ret.created_at.isoformat() if ret.created_at else None,
    }
    if items is not None:
        d["items"] = [{
            "id": i.id,
            "invoiceLineId": i.invoice_line_id,
            "itemId": i.item_id,
            "name": i.name,
            "originalQty": i.original_qty,
            "returnQty": i.return_qty,
            "price": i.price,
            "taxRate": i.tax_rate,
            "lineTotal": i.line_total,
        } for i in items]
    return d


async def _already_returned_for_invoice(
    db: AsyncSession, invoice_id: str
) -> dict[str, int]:
    """Sum of return_qty per invoice_line_id across all SalesReturns for
    this invoice. Used to validate that a new return's per-line qty plus
    the cumulative prior returns doesn't exceed the original line's qty.

    Returns {invoice_line_id: total_returned_qty}. invoice_line_id can
    be None for legacy returns; those entries are excluded from the
    per-line cap (caller falls back to name+item_id matching).
    """
    res = await db.execute(
        select(
            SalesReturnLineItem.invoice_line_id,
            func.coalesce(func.sum(SalesReturnLineItem.return_qty), 0),
        )
        .join(SalesReturn, SalesReturn.id == SalesReturnLineItem.return_id)
        .where(
            SalesReturn.invoice_id == invoice_id,
            SalesReturn.status == SalesReturnStatus.processed,
            SalesReturnLineItem.invoice_line_id.is_not(None),
        )
        .group_by(SalesReturnLineItem.invoice_line_id)
    )
    return {row[0]: int(row[1] or 0) for row in res.all()}


# ─── Sales Returns: LIST ─────────────────────────────────────────────────────
# 2026-05-24: trailing slash on /returns/ is LOAD-BEARING. Without it,
# the path `/returns` would be checked against the `/{invoice_id}` route
# (registered earlier in this file at line ~523) and matched there,
# routing to `get_invoice(invoice_id="returns")` → 404 "Invoice not
# found". The frontend's `salesAPI.returns.list` calls `/sales/returns/`
# with a trailing slash; matching that to `/returns/` here skips the
# /{invoice_id} fallback entirely. /orders/ already follows this pattern.
@router.get("/returns/", dependencies=[Depends(require_perm("invoices.view"))])
async def list_returns(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List sales returns. PR 2: backed by the new SalesReturn table —
    SAMPLE_RETURNS hardcoded list is gone."""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(select(func.count(SalesReturn.id)))).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {
            "number": SalesReturn.number,
            "invoice_number": SalesReturn.invoice_number,
            "customer_name": SalesReturn.customer_name,
            "date": SalesReturn.date,
            "total": SalesReturn.total,
            "status": SalesReturn.status,
            "created_at": SalesReturn.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = (
        select(SalesReturn)
        .options(selectinload(SalesReturn.line_items))
        .order_by(sort_expr).offset(sk).limit(lim)
    )
    rows = (await db.execute(q)).unique().scalars().all()
    out = [_return_dict(ret, ret.line_items) for ret in rows]
    return paged(out, total, sk, lim)


# ─── Sales Returns: GET ONE ──────────────────────────────────────────────────
@router.get("/returns/{return_id}", dependencies=[Depends(require_perm("invoices.view"))])
async def get_return(return_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(
        select(SalesReturn)
        .options(selectinload(SalesReturn.line_items))
        .where(SalesReturn.id == return_id)
    )
    ret = res.scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    return _return_dict(ret, ret.line_items)


# ─── Sales Returns: CREATE ───────────────────────────────────────────────────
# 2026-05-24: trailing slash matches the LIST route above for consistency
# (see list_returns for the full rationale). POST routes don't hit the
# same /{invoice_id} confusion as GET (`/{invoice_id}` is GET-only) but
# keeping the slash uniform avoids future drift if anyone adds POST
# `/{invoice_id}/*` routes later.
@router.post("/returns/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_return(data: SalesReturnCreate, db: AsyncSession = Depends(get_db)):
    """Process a customer return against an existing invoice.

    Flow:
      1. Validate invoice exists + isn't cancelled.
      2. For each return line: validate against original invoice line +
         cumulative prior returns (no over-returning).
      3. Determine refund_method (walk-ins forced to 'cash').
      4. Compute totals + credited_amount (capped at invoice.paid_amount
         for non-adjustment methods; full return total for adjustment).
      5. Restock at the invoice's branch (NOT the operator's current
         branch — returns are bound to where the sale happened).
         Tracked items → new "Returns" batch via add_batch_atomic.
         Untracked → adjust_stock_atomic +qty.
      6. For credit method: bump customer.credit_balance + AuditLog.
      7. For adjustment method: subtract from invoice.paid_amount only if
         that doesn't push balance negative; remainder treated as
         non-refundable (logged in notes).
    """
    if not data.items:
        raise HTTPException(400, "Return must have at least one line item")

    inv_res = await db.execute(
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.id == data.invoice_id)
    )
    inv = inv_res.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    # InvoiceStatus is a str-enum so direct equality works. Both
    # representations (enum member + raw "cancelled" string set by the
    # legacy cancel_invoice path) compare equal here.
    if inv.status == InvoiceStatus.cancelled or str(inv.status).endswith("cancelled"):
        raise HTTPException(400, "Cannot return against a cancelled invoice")

    # Index invoice lines by id for fast lookup. Also keep a (item_id, name)
    # secondary index for legacy lines where invoice_line_id wasn't carried
    # through the UI.
    inv_lines_by_id = {li.id: li for li in inv.line_items}
    inv_lines_by_item = {
        (li.item_id, li.name): li for li in inv.line_items if li.item_id
    }

    # How much has already been returned per invoice_line_id?
    already_returned = await _already_returned_for_invoice(db, data.invoice_id)

    # Validate every return line + compute totals.
    return_rows = []  # (return_line_in, matched_inv_line, line_net, line_tax)
    subtotal = 0.0
    tax_total = 0.0
    for r in data.items:
        # Resolve which invoice line we're returning against.
        inv_line = None
        if r.invoice_line_id and r.invoice_line_id in inv_lines_by_id:
            inv_line = inv_lines_by_id[r.invoice_line_id]
        elif r.item_id and (r.item_id, r.name) in inv_lines_by_item:
            inv_line = inv_lines_by_item[(r.item_id, r.name)]
        if not inv_line:
            raise HTTPException(
                400,
                f"Line '{r.name}' is not on invoice {inv.number} — cannot return",
            )

        prior = already_returned.get(inv_line.id, 0)
        remaining_qty = int(inv_line.qty or 0) - prior
        if r.return_qty > remaining_qty:
            raise HTTPException(
                400,
                f"Line '{r.name}': only {remaining_qty} unit(s) remaining returnable "
                f"(original {inv_line.qty}, already returned {prior})",
            )

        # Use the original sale's price + tax_rate (returns at sale price,
        # not current catalog price).
        line_gross = round(r.return_qty * (inv_line.price or 0), 2)
        line_tax = round(line_gross * ((inv_line.tax_rate or 0) / 100), 2)
        return_rows.append((r, inv_line, line_gross, line_tax))
        subtotal += line_gross
        tax_total += line_tax

    total = round(subtotal + tax_total, 2)

    # Refund method resolution.
    is_walkin = not inv.customer_id
    method = (data.refund_method or "cash").strip().lower()
    if method not in ("cash", "credit", "adjustment"):
        raise HTTPException(400, f"Invalid refund_method '{method}' — use cash | credit | adjustment")
    if is_walkin and method == "credit":
        # Quietly downgrade rather than 400 — the operator's intent is
        # clear ("give them their money back"); the customer just isn't
        # in the system to receive a credit balance entry.
        method = "cash"
    elif is_walkin and method == "adjustment":
        # Adjustment on a walk-in would orphan the balance reduction.
        # Force cash to keep the accounting clean.
        method = "cash"

    # Determine credited amount.
    #   • cash / credit: capped at invoice.paid_amount (you can't refund
    #     more than the customer actually paid). The excess return value
    #     reduces the outstanding balance via the invoice update below.
    #   • adjustment: no money moves. credited_amount = 0; instead we
    #     reduce invoice.paid_amount? No — paid_amount is what came in.
    #     We reduce the invoice.total to reflect that less is owed.
    paid_amount = float(inv.paid_amount or 0)
    if method in ("cash", "credit"):
        credited = round(min(total, paid_amount), 2)
    else:
        credited = 0.0

    today = datetime.now().strftime("%Y-%m-%d")
    count = (await db.execute(select(func.count(SalesReturn.id)))).scalar() or 0
    ret_num = f"CN-{datetime.now().year}-{1000 + count}"

    ret = SalesReturn(
        id=str(uuid.uuid4()), number=ret_num,
        invoice_id=inv.id, invoice_number=inv.number,
        customer_id=inv.customer_id,
        customer_name=inv.customer_name,
        branch_id=inv.branch_id,         # bound to where the sale happened
        branch_name=inv.branch_name,
        date=data.date or today,
        reason=data.reason,
        refund_method=method,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        total=total,
        credited_amount=credited,
        status=SalesReturnStatus.processed,
        notes=data.notes,
        created_by=data.created_by,
    )
    db.add(ret)
    await db.flush()  # need ret.id for the line FK

    for r, inv_line, line_net, _line_tax in return_rows:
        db.add(SalesReturnLineItem(
            id=str(uuid.uuid4()), return_id=ret.id,
            invoice_line_id=inv_line.id,
            item_id=inv_line.item_id,
            name=inv_line.name,
            original_qty=inv_line.qty,
            return_qty=r.return_qty,
            price=inv_line.price,
            tax_rate=inv_line.tax_rate,
            line_total=line_net,
        ))

        # ── Stock restock at the invoice's branch ──
        if inv_line.item_id:
            tracked, _expiry_tracked = await is_tracked(db, inv_line.item_id)
            if tracked:
                # Single "Returns" parcel per call — gives the auditor a
                # row with source_type='return' and source_ref=<return id>.
                # Operator can manually consolidate via Stock Adjustment if
                # multiple returns clutter the batches list.
                await add_batch_atomic(
                    db,
                    item_id=inv_line.item_id,
                    branch_id=inv.branch_id,
                    qty=r.return_qty,
                    cost_price=inv_line.price or 0,
                    source_type="return",
                    source_ref=ret.id,
                    notes=f"Return on {inv.number}: {data.reason or 'no reason given'}",
                )
            else:
                # Untracked items just bump aggregate stock.
                await adjust_stock_atomic(
                    db, item_id=inv_line.item_id, branch_id=inv.branch_id,
                    delta=r.return_qty,
                )

    # ── Money movements ──
    if method == "credit" and inv.customer_id and credited > 0:
        cust_res = await db.execute(
            select(Customer).where(Customer.id == inv.customer_id)
        )
        cust = cust_res.scalar_one_or_none()
        if cust is not None:
            cur_credit = float(cust.credit_balance or 0)
            cust.credit_balance = round(cur_credit + credited, 2)
            db.add(AuditLog(
                id=str(uuid.uuid4()),
                action="customer_credit",
                user_id=None,
                user_name=data.created_by,
                module="sales",
                ref=ret.number,
                detail=(
                    f"Return {ret.number} against {inv.number}: "
                    f"+₹{credited} credited to {cust.name} "
                    f"(was ₹{cur_credit:.2f}, now ₹{cust.credit_balance:.2f})"
                ),
                risk="low",
                ip_address=None,
            ))

    if method == "adjustment":
        # Reduce invoice.total by the return total (acts as a credit memo
        # against the invoice's outstanding balance). Floor at 0 so a
        # return larger than the open balance can't make the invoice
        # negative — that excess is simply unrecoverable via this route.
        new_total = round(max(0.0, (inv.total or 0) - total), 2)
        inv.total = new_total
        # Recompute status: if paid_amount now equals/exceeds the reduced
        # total, mark paid.
        if (inv.paid_amount or 0) >= new_total:
            inv.status = "paid"

    if method == "cash":
        # Reduce paid_amount by the credited amount so subsequent reports
        # show what the cash drawer actually has. The corresponding cash-
        # out entry is operator-managed for now (PR 3 could auto-create a
        # CashEntry of type='out' with category='Customer Refund').
        new_paid = round(max(0.0, (inv.paid_amount or 0) - credited), 2)
        inv.paid_amount = new_paid
        # Status: if any balance now exists, drop back to partial / pending.
        if new_paid <= 0:
            inv.status = "pending"
        elif new_paid < (inv.total or 0):
            inv.status = "partial"

    await db.commit()
    return {
        "id": ret.id,
        "number": ret.number,
        "total": total,
        "credited_amount": credited,
        "refund_method": method,
        "customer_credit_balance": (
            float(cust.credit_balance)
            if (method == "credit" and inv.customer_id and credited > 0)
            else None
        ),
    }

import json
import uuid
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, inspect as sa_inspect, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.document_numbering import allocate_number, resolve_number
from src.tax_calc import line_tax_amount, line_taxable_amount, rollup_inclusive_lines
from src.models import (
    AuditLog,
    Customer,
    CustomerPayment,
    CustomerPaymentAllocation,
    InvoiceStatus,
    Organisation,
    ItemBatch,
    Item,
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
from src.routes._lifecycle import (
    compute_due_date,
    recalc_invoice_after_cn,
    refresh_sale_overdue,
    reverse_customer_payment,
    sync_customer_outstanding,
    _recompute_invoice_status,
)
from src.routes._credit_ledger import adjust_customer_credit
from src.routes._payment_ledger import record_customer_payment, void_payment_record
from src.routes._cash_ledger import record_cash_in, record_cash_out, void_cash_entry as void_cash_for_payment
from src.routes._stock_ledger import (
    fulfil_reservations,
    get_allow_overselling,
    get_available_qty,
    refresh_so_reservations,
    release_reservations,
    reserve_for_sales_order,
)
from src.routes._atomic import (
    add_batch_atomic,
    add_payment_atomic,
    adjust_stock_atomic,
    clamp_stock_to_zero_with_ledger,
    consume_batches_atomic,
    is_tracked,
    set_batch_quantity_atomic,
)
from src.routes.dashboard import invalidate_dashboard_cache_for_user
from src.routes._serializers import _build_customer_code, get_user_branch_ids
from src.routes._approval import (
    assert_may_edit_document,
    can_direct_commit,
    can_direct_pos_bill,
)
from src.permissions import SALES_DOCUMENT_READ
from src.security import (
    current_user,
    enforce_branch_access,
    enforce_branch_access_optional,
    get_allowed_branch_ids,
    require_perm,
)
from src.services.audit_service import build_audit_entry

router = APIRouter()


def _snapshot_item_metadata(item):
    if item is None:
        return {}
    return {
        "sku": item.sku,
        "barcode": item.barcode,
        "brand": item.brand,
        "country_of_origin": item.country_of_origin,
        "unit": item.unit,
        "packaging_quantity": item.packaging_quantity,
        "is_packaging": item.is_packaging,
        "hsn_code": item.hsn_code,
    }

async def _load_items_by_id(db: AsyncSession, item_ids: set[str]) -> dict[str, Item]:
    if not item_ids:
        return {}
    res = await db.execute(select(Item).where(Item.id.in_(item_ids)))
    return {item.id: item for item in res.scalars().all()}

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
    unit: Optional[str] = None
    vat_identifier: Optional[str] = None
    allow_invoice_discount: Optional[bool] = None
    hsn_code: Optional[str] = None
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
pending". The `status='pending'` flag already carries that semantic.

2026-05-25: added `'credit'` as a first-class method. Different from
"legacy credit" (which used to mean "no payment"): the new `'credit'`
explicitly debits `customer.credit_balance` to settle the invoice.
Validations: customer_id required (walk-ins can't draw on credit they
don't have), customer.credit_balance >= invoice.total. Both create_invoice
and record_payment enforce; both atomically debit + AuditLog.
"""
PaymentMode = Literal["cash", "card", "upi", "bank_transfer", "credit"]


def _coerce_payment_mode_value(v):
    """Shared pre-validator body for PaymentMode-family Literals.

    Returns None for None / empty / legacy-no-payment strings. Lowercases
    + strips so case/whitespace noise doesn't trip the Literal.

    2026-05-25: `'credit'` is NO LONGER coerced to None — it's now a
    valid PaymentMode value. Legacy held bills that used 'credit' to
    mean "no payment yet" will now mistakenly try to debit credit_balance;
    that's caught + 422'd by the create_invoice validation when
    customer_id is missing (walk-in) or credit_balance is insufficient.
    """
    if v is None:
        return None
    if not isinstance(v, str):
        return v
    s = v.strip().lower()
    if s == "":
        return None
    return s


def _log_sales_invoice_history(
    db: AsyncSession,
    *,
    user: Optional[User] = None,
    invoice_id: str,
    invoice_number: str,
    event_type: str,
    detail: str,
    metadata: Optional[dict] = None,
    action: Optional[str] = None,
    risk: str = "low",
    branch_id: Optional[str] = None,
) -> None:
    """Shared sales_invoice activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="sales_invoice",
        record_id=invoice_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="sales",
        ref=invoice_number,
        detail=detail,
        risk=risk,
        ip_address=None,
        branch_id=branch_id,
    ))


def _log_sales_order_history(
    db: AsyncSession,
    *,
    user: Optional[User] = None,
    order_id: str,
    order_number: str,
    event_type: str,
    detail: str,
    metadata: Optional[dict] = None,
    action: Optional[str] = None,
    risk: str = "low",
) -> None:
    """Shared sales_order activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="sales_order",
        record_id=order_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="sales",
        ref=order_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


def _log_quotation_history(
    db: AsyncSession,
    *,
    user: Optional[User] = None,
    quote_id: str,
    quote_number: str,
    event_type: str,
    detail: str,
    metadata: Optional[dict] = None,
    action: Optional[str] = None,
    risk: str = "low",
) -> None:
    """Shared quotation activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="quotation",
        record_id=quote_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="sales",
        ref=quote_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


def _log_sales_return_history(
    db: AsyncSession,
    *,
    user: Optional[User] = None,
    return_id: str,
    return_number: str,
    event_type: str,
    detail: str,
    metadata: Optional[dict] = None,
    action: Optional[str] = None,
    risk: str = "low",
    branch_id: Optional[str] = None,
) -> None:
    """Shared sales_return activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="sales_return",
        record_id=return_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="sales",
        ref=return_number,
        detail=detail,
        risk=risk,
        ip_address=None,
        branch_id=branch_id,
    ))


async def _write_post_commit_audit(
    db: AsyncSession,
    *,
    action: str,
    module: str,
    reference_id: str,
    detail: str,
    user: Optional[User],
    request: Request = None,
    branch_id: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    role = "unknown"
    if user is not None:
        urole = getattr(user, "role", None)
        if urole is not None:
            role = urole.value if hasattr(urole, "value") else str(urole)
    payload = build_audit_entry(
        action=action,
        module=module,
        reference_id=reference_id,
        detail=detail,
        user_id=getattr(user, "id", "system"),
        user_name=getattr(user, "name", "System"),
        user_role=role,
        ip_address=(getattr(request.state, "ip_address", None) if request is not None else None),
        device_info=(getattr(request.state, "device_info", None) if request is not None else None),
        branch_id=branch_id,
        metadata=metadata,
    )
    db.add(AuditLog(id=str(uuid.uuid4()), **payload))
    await db.commit()


class SaleCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    cashier: str = "Staff"
    date: Optional[str] = None          # defaults to today
    items: List[LineItemIn]
    discount: float = 0
    number: Optional[str] = None
    # Strict allow-list (see PaymentMode docstring above). Legacy clients
    # that still send "credit" or "" get coerced to None by
    # `_coerce_payment_mode` below so the contract is forgiving on input
    # but strict on storage.
    payment_mode: Optional[PaymentMode] = None
    payment_ref: Optional[str] = None
    notes: Optional[str] = None
    # Phase 4: pos | invoice | sales_order | quotation (default invoice).
    origin: Optional[str] = None
    # Prefilled-form conversions: link the new invoice back to its source doc.
    quotation_id: Optional[str] = None
    sales_order_id: Optional[str] = None
    source_order_lines: Optional[List["SourceOrderLineIn"]] = None

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)


class InvoiceUpdate(BaseModel):
    """Editable fields for an unpaid invoice with no payments or credit notes."""
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    date: Optional[str] = None
    due_date: Optional[str] = None
    items: List[LineItemIn]
    discount: float = 0
    payment_mode: Optional[PaymentMode] = None
    payment_ref: Optional[str] = None
    notes: Optional[str] = None


class SourceOrderLineIn(BaseModel):
    """Qty invoiced from a specific SO line when saving via the invoice form."""
    order_line_id: str
    qty: int = Field(..., gt=0)

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
    shipment_date: Optional[str] = None
    payment_terms: Optional[str] = None
    shipment_method: Optional[str] = None
    prices_including_vat: bool = False
    payment_discount_on_vat: float = 0
    items: List[LineItemIn]
    discount: float = 0
    number: Optional[str] = None
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
    origin: Optional[str] = None,
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
    if origin:
        conds.append(SaleInvoice.origin == origin)
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


async def _resolve_branch_scope(user: User, db: AsyncSession, branch_id: Optional[str]) -> Optional[list[str]]:
    """Return allowed branch ids list for the user or raise 403 when an
    explicit branch_id is provided and not in the user's allowed list.

    This mirrors the pattern used in dashboard/reports/cash: return None
    when the user has all-branches access, an empty list when the user
    has no branches, or a list of allowed branch ids. If `branch_id` is
    supplied and not inside the allowed list, raise HTTPException(403).
    """
    if not getattr(user, "id", None):
        try:
            user = await current_user(authorization=None, db=db)
        except RuntimeError:
            # Running inside unit tests or without app startup config —
            # treat as unresolved and allow caller to proceed (test-mode).
            return None
    if getattr(user, "all_branches", False):
        return None
    branch_ids = await get_allowed_branch_ids(user, db)
    if branch_ids:
        if branch_id and branch_id not in branch_ids:
            raise HTTPException(403, "Branch is outside your sales scope")
        return branch_ids
    if getattr(user, "branch_id", None):
        if branch_id and branch_id != user.branch_id:
            raise HTTPException(403, "Branch is outside your sales scope")
        return [user.branch_id]
    if branch_id:
        # explicit branch requested but user has no branches
        raise HTTPException(403, "Branch is outside your sales scope")
    return []


# ─── LIST ─────────────────────────────────────────────────────────────────────
@router.get("/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_invoices(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    status: Optional[str] = None,
    payment_mode: Optional[str] = None,
    customer_id: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    origin: Optional[str] = None,
    category_id: Optional[str] = None,
    discount: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    await refresh_sale_overdue(db, branch_id)
    await db.commit()
    conds = _sale_invoice_filters(branch_id, status, customer_id, search, date_from, date_to, origin)
    # Payment method filter
    if payment_mode:
        conds.append(SaleInvoice.payment_mode == payment_mode)
    # Category filter: invoices that contain at least one line item in the category
    if category_id:
        subq = select(SaleLineItem.invoice_id).join(Item, SaleLineItem.item_id == Item.id).where(Item.category_id == category_id)
        conds.append(SaleInvoice.id.in_(subq))
    # Discount filter: 'with' => invoice.discount > 0 OR any line has discount > 0
    #                 'without' => invoice.discount == 0 AND no line has discount > 0
    if discount:
        if discount == 'with':
            subq = select(SaleLineItem.invoice_id).where(SaleLineItem.discount > 0)
            conds.append(or_(SaleInvoice.discount > 0, SaleInvoice.id.in_(subq)))
        elif discount == 'without':
            subq = select(SaleLineItem.invoice_id).where(SaleLineItem.discount > 0)
            conds.append(SaleInvoice.discount <= 0)
            conds.append(SaleInvoice.id.notin_(subq))
    if branch_id is None and not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
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
        .options(selectinload(SaleInvoice.line_items).selectinload(SaleLineItem.item), selectinload(SaleInvoice.customer))
    )
    if conds:
        q = q.where(and_(*conds))
    count_r = await db.execute(select(func.count(SaleInvoice.id)).where(and_(*conds)) if conds else select(func.count(SaleInvoice.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    invoices = result.unique().scalars().all()
    # Attach organisation profile as a fallback for branch-level metadata
    org_row = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    out = []
    for inv in invoices:
        sales_order_number = None
        if getattr(inv, "pending_order_id", None):
            so_res = await db.execute(select(SalesOrder.number).where(SalesOrder.id == inv.pending_order_id))
            sales_order_number = so_res.scalar_one_or_none()
        elif getattr(inv, "origin", None) == "sales_order":
            sales_order_number = inv.number
        else:
            so_res = await db.execute(select(SalesOrder.number).where(SalesOrder.converted_invoice_id == inv.id))
            sales_order_number = so_res.scalar_one_or_none()
        d = _inv_dict(inv, inv.line_items, sales_order_number=sales_order_number)
        if org_row:
            d.setdefault('organisation', {})
            d['organisation']['id'] = org_row.id
            d['organisation']['name'] = org_row.name
            d['organisation']['gstin'] = org_row.gstin or ''
            d['organisation']['email'] = org_row.email or ''
            d['organisation']['website'] = org_row.website or ''
        out.append(d)
    return paged(out, total, sk, lim)

# Legacy SAMPLE_RETURNS-backed /returns endpoint removed 2026-05-23 (PR 2).
# The real persisted version lives at "Sales Returns: LIST" below.

# ─── QUOTATIONS ───────────────────────────────────────────────────────────────
@router.get("/quotations/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_quotations(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    search: Optional[str] = None,
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """List all quotations"""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = []
    if search:
        conds.append(or_(Quotation.number.ilike(f"%{search}%"), Quotation.customer_name.ilike(f"%{search}%")))
    if status:
        conds.append(Quotation.status == status)
    if customer_id:
        conds.append(Quotation.customer_id == customer_id)
    if date_from:
        conds.append(Quotation.date >= date_from)
    if date_to:
        conds.append(Quotation.date <= date_to)
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
    q = select(Quotation).options(
        selectinload(Quotation.line_items).selectinload(QuotationLineItem.item),
        selectinload(Quotation.customer),
    )
    q_count = select(func.count(Quotation.id))
    if branch_id:
        conds.append(Quotation.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(Quotation.branch_id.in_(branch_ids))
    if conds:
        q = q.where(and_(*conds))
        q_count = q_count.where(and_(*conds))
    total = int((await db.execute(q_count)).scalar() or 0)
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    quotations = result.unique().scalars().all()
    items_out = [_quote_dict(qt, qt.line_items) for qt in quotations]
    return paged(items_out, total, sk, lim)

@router.get("/quotations/{quote_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_quotation(quote_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Get a specific quotation"""
    result = await db.execute(
        select(Quotation)
        .options(
            selectinload(Quotation.line_items).selectinload(QuotationLineItem.item),
            selectinload(Quotation.customer),
        )
        .where(Quotation.id == quote_id)
    )
    quote = result.unique().scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    await enforce_branch_access(quote.branch_id, user=user, db=db)
    return _quote_dict(quote, quote.line_items)

@router.post("/quotations/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_quotation(data: QuotationCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Create a new quotation"""
    # Validate items
    if not data.items or len(data.items) == 0:
        raise HTTPException(400, "Quotation must have at least one item")

    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have name and positive quantity")

    quote_num = await resolve_number(
        db,
        requested=data.number,
        model=Quotation,
        allocate=lambda: allocate_number(db, "quotation", branch_id=data.branch_id),
    )

    # Ensure user may create documents in the requested branch
    await _resolve_branch_scope(user, db, data.branch_id)

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
    # Line discount is always a percent (0-100). Frontend is the
    # source of conversion (it offers a %/MVR toggle and converts MVR → %
    # before POST). See OrderFormModal / QuoteFormModal.
    # Line discount first, then document discount, then GST extract.
    line_rows = []  # list[(item, line_net, line_tax)]
    inclusives = []
    rates = []
    for item in data.items:
        line_net = _inclusive_after_line_discount(item.qty, item.price, item.line_discount)
        line_rows.append((item, line_net, 0.0))
        inclusives.append(line_net)
        rates.append(item.tax_rate or 0)
    taxed, subtotal, tax_total, total = rollup_inclusive_lines(
        inclusives, rates, data.discount or 0,
    )
    line_rows = [
        (item, line_net, tax)
        for (item, line_net, _), (_, _, tax) in zip(line_rows, taxed)
    ]

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
        shipment_date=data.shipment_date,
        payment_terms=data.payment_terms,
        shipment_method=data.shipment_method,
        prices_including_vat=data.prices_including_vat,
        payment_discount_on_vat=data.payment_discount_on_vat,
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
            unit=item.unit or '',
            vat_identifier=item.vat_identifier or 'GST',
            allow_invoice_discount=item.allow_invoice_discount if item.allow_invoice_discount is not None else True,
            hsn_code=item.hsn_code or '',
            line_total=round(line_net, 2),
        )
        db.add(li)

    db.add(quote)
    _log_quotation_history(db, user=user,
        quote_id=quote.id,
        quote_number=quote.number,
        event_type="created",
        action="create_quotation",
        detail=f"Created quotation {quote.number}",
        metadata={
            "status": "draft",
            "total": round(float(total or 0), 2),
            "line_count": len(data.items or []),
        },
    )
    await db.commit()
    await db.refresh(quote)
    return {"id": quote.id, "number": quote.number, "total": round(total, 2), "status": "draft"}

@router.put("/quotations/{quote_id}", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_quotation(quote_id: str, data: QuotationCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
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

    # If branch is being changed, validate the target branch
    if data.branch_id and data.branch_id != quote.branch_id:
        await _resolve_branch_scope(user, db, data.branch_id)

    item_changes = _summarize_quotation_item_changes(list(quote.line_items or []), data.items)

    # Same line math as create. LineItemIn's `line_discount` is a percent
    # (matches the invoice/sales convention); QuotationLineItem stores
    # discount as a number too — we mirror what's already done in
    # create_quotation.
    line_rows = []
    inclusives = []
    rates = []
    for i in data.items:
        line_net = _inclusive_after_line_discount(i.qty, i.price, i.line_discount)
        line_rows.append((i, line_net, 0.0))
        inclusives.append(line_net)
        rates.append(i.tax_rate or 0)
    taxed, subtotal, tax_total, total = rollup_inclusive_lines(
        inclusives, rates, data.discount or 0,
    )
    line_rows = [
        (i, line_net, tax)
        for (i, line_net, _), (_, _, tax) in zip(line_rows, taxed)
    ]

    quote.customer_id = data.customer_id
    quote.customer_name = data.customer_name
    quote.branch_id = data.branch_id
    quote.branch_name = data.branch_name or data.branch_id
    quote.created_by = data.created_by
    quote.date = data.date or quote.date
    quote.valid_until = data.valid_until
    quote.shipment_date = data.shipment_date
    quote.payment_terms = data.payment_terms
    quote.shipment_method = data.shipment_method
    quote.prices_including_vat = data.prices_including_vat
    quote.payment_discount_on_vat = data.payment_discount_on_vat
    quote.subtotal = round(subtotal, 2)
    quote.tax_total = round(tax_total, 2)
    quote.discount = round(data.discount or 0, 2)
    quote.total = total
    quote.notes = data.notes

    from sqlalchemy import delete as sa_delete
    await db.execute(
        sa_delete(QuotationLineItem).where(QuotationLineItem.quotation_id == quote.id)
    )
    for line, line_net, line_tax in line_rows:
        db.add(QuotationLineItem(
            id=str(uuid.uuid4()), quotation_id=quote.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate,
            discount=line.line_discount or 0,
            unit=line.unit or '',
            vat_identifier=line.vat_identifier or 'GST',
            allow_invoice_discount=line.allow_invoice_discount if line.allow_invoice_discount is not None else True,
            hsn_code=line.hsn_code or '',
            line_total=round(line_net, 2),
        ))

    preview = item_changes[0]["detail"] if item_changes else f"Revised quotation {quote.number}"
    if len(item_changes) > 1:
        preview = f"{preview}; +{len(item_changes) - 1} more item change(s)"
    _log_quotation_history(db, user=user,
        quote_id=quote.id,
        quote_number=quote.number,
        event_type="revised",
        action="revise_quotation",
        detail=preview,
        metadata={"changes": item_changes[:20], "line_count": len(data.items or [])},
    )
    await db.commit()
    return {"id": quote.id, "number": quote.number, "total": total, "status": quote.status.value}


@router.patch("/quotations/{quote_id}/status", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_quotation_status(quote_id: str, status: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
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
    # Terminal statuses must not be rewound — e.g. flipping `converted` back
    # to `draft` would leave a live SO while the quote looks editable again.
    terminal = (QuotationStatus.converted, QuotationStatus.rejected, QuotationStatus.expired)
    if quote.status in terminal and new_status != quote.status:
        raise HTTPException(
            400,
            f"Cannot change status of a {quote.status.value} quotation to {new_status.value}",
        )
    prev_status = quote.status.value if hasattr(quote.status, "value") else str(quote.status)
    quote.status = new_status
    next_status = new_status.value if hasattr(new_status, "value") else str(new_status)
    if new_status == QuotationStatus.sent and prev_status != next_status:
        _log_quotation_history(db, user=user,
            quote_id=quote.id,
            quote_number=quote.number,
            event_type="sent",
            action="send_quotation",
            detail=f"Sent quotation {quote.number}",
            metadata={"from": prev_status, "to": next_status},
        )
    elif new_status == QuotationStatus.accepted and prev_status != next_status:
        _log_quotation_history(db, user=user,
            quote_id=quote.id,
            quote_number=quote.number,
            event_type="accepted",
            action="accept_quotation",
            detail=f"Accepted quotation {quote.number}",
            metadata={"from": prev_status, "to": next_status},
        )
    elif new_status == QuotationStatus.rejected and prev_status != next_status:
        _log_quotation_history(db, user=user,
            quote_id=quote.id,
            quote_number=quote.number,
            event_type="rejected",
            action="reject_quotation",
            detail=f"Rejected quotation {quote.number}",
            metadata={"from": prev_status, "to": next_status},
            risk="medium",
        )
    elif new_status == QuotationStatus.expired and prev_status != next_status:
        _log_quotation_history(db, user=user,
            quote_id=quote.id,
            quote_number=quote.number,
            event_type="expired",
            action="expire_quotation",
            detail=f"Expired quotation {quote.number}",
            metadata={"from": prev_status, "to": next_status},
            risk="medium",
        )
    await db.commit()
    return {"status": quote.status.value}

# ─── (REMOVED 2026-05-23) GET /credit/purchases ─────────────────────────────
# The "Credit Purchases" tab was dropped in Sales Phase 1. The list was just
# `SaleInvoice.payment_mode == "credit"` — same data is available via the
# main `GET /sales/` endpoint with a payment_mode filter if anyone needs it.
# See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md for the rationale.

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{invoice_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_invoice(invoice_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items).selectinload(SaleLineItem.item), selectinload(SaleInvoice.customer))
        .where(SaleInvoice.id == invoice_id)
    )
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await _resolve_branch_scope(user, db, inv.branch_id)
    sales_order_number = None
    if getattr(inv, "pending_order_id", None):
        so_res = await db.execute(select(SalesOrder.number).where(SalesOrder.id == inv.pending_order_id))
        sales_order_number = so_res.scalar_one_or_none()
    elif getattr(inv, "origin", None) == "sales_order":
        sales_order_number = inv.number
    else:
        so_res = await db.execute(select(SalesOrder.number).where(SalesOrder.converted_invoice_id == inv.id))
        sales_order_number = so_res.scalar_one_or_none()
    d = _inv_dict(inv, inv.line_items, sales_order_number=sales_order_number)
    d["payments"] = await _payments_for_invoice(db, inv.id)
    org_row = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    if org_row:
        d.setdefault('organisation', {})
        d['organisation']['id'] = org_row.id
        d['organisation']['name'] = org_row.name
        d['organisation']['gstin'] = org_row.gstin or ''
        d['organisation']['email'] = org_row.email or ''
        d['organisation']['website'] = org_row.website or ''
        d['gstNo'] = d.get('gstNo') or org_row.gstin or ''
        d['gst_no'] = d['gstNo']
        d['email'] = org_row.email or ''
        d['phoneNo'] = d.get('phoneNo') or getattr(org_row, 'phone', '') or ''
        d['phone_no'] = d['phoneNo']
    return d

# ─── UPDATE (EDIT) ────────────────────────────────────────────────────────────
@router.put("/{invoice_id}", dependencies=[Depends(require_perm("invoices.edit", "invoices.create"))])
async def update_invoice(
    invoice_id: str,
    data: InvoiceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Edit an unpaid invoice. Replaces line items, reverses then re-applies
    stock, and recalculates totals. Locked when payments, credit notes, or
    POS origin — use returns / cancel / refund flows instead.

    Create-only users may edit private `draft` invoices before submit.
    """
    from sqlalchemy import delete as sa_delete

    res = await db.execute(
        select(SaleInvoice)
        .options(
            selectinload(SaleInvoice.line_items),
            selectinload(SaleInvoice.customer),
        )
        .where(SaleInvoice.id == invoice_id)
    )
    inv = res.unique().scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await enforce_branch_access(inv.branch_id, user=user, db=db)
    await _assert_invoice_editable(db, inv)

    inv_status = inv.status.value if hasattr(inv.status, "value") else str(inv.status)
    is_approval_held = inv_status in (
        InvoiceStatus.draft.value,
        InvoiceStatus.pending_approval.value,
    )
    if inv_status == InvoiceStatus.pending_approval.value:
        raise HTTPException(
            400,
            "Invoice is awaiting approval and cannot be edited — reject it first or ask the creator to revise after rejection",
        )
    await assert_may_edit_document(
        user, db, status=inv_status,
        create_perm="invoices.create", edit_perm="invoices.edit",
    )

    if not data.items:
        raise HTTPException(400, "Invoice must have at least one line item")
    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have a name and positive quantity")

    line_rows, subtotal, tax_total, total = _invoice_line_rollups(data.items, data.discount)

    prev_customer_id = inv.customer_id
    if data.customer_id is not None:
        inv.customer_id = await _resolve_customer_id(db, data.customer_id)
    if data.customer_name is not None:
        inv.customer_name = data.customer_name
    if data.date:
        inv.date = data.date
    if data.due_date is not None:
        inv.due_date = data.due_date
    elif inv.status in (InvoiceStatus.pending, InvoiceStatus.partial, InvoiceStatus.overdue):
        inv.due_date = compute_due_date(inv.date, None)
    if data.payment_mode is not None:
        inv.payment_mode = data.payment_mode
    if data.payment_ref is not None:
        inv.payment_ref = data.payment_ref or None
    inv.subtotal = round(subtotal, 2)
    inv.tax_total = round(tax_total, 2)
    inv.discount = round(data.discount, 2)
    inv.total = round(total, 2)
    inv.notes = data.notes
    if not is_approval_held:
        _recompute_invoice_status(inv)

    # Draft / pending_approval never touch stock.
    if not is_approval_held:
        await _restock_invoice_lines(db, inv, inv.line_items)
    await db.execute(sa_delete(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id))

    item_ids = {item.item_id for item in data.items if item.item_id}
    item_map = await _load_items_by_id(db, item_ids)
    allow_oversell = await get_allow_overselling(db)
    for item, line_amount, _line_taxable, _line_tax in line_rows:
        item_obj = item_map.get(item.item_id) if item.item_id else None
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, price=item.price,
            tax_rate=item.tax_rate,
            discount=_stored_line_discount_pct(item),
            line_total=line_amount,
            **_snapshot_item_metadata(item_obj),
        )
        db.add(li)
        if item.item_id and not is_approval_held:
            await _consume_sale_line_stock(
                db,
                item=item,
                li=li,
                branch_id=inv.branch_id,
                invoice_id=inv.id,
                invoice_number=inv.number,
                allow_oversell=allow_oversell,
            )

    if not is_approval_held:
        if prev_customer_id:
            await sync_customer_outstanding(db, prev_customer_id)
        if inv.customer_id:
            await sync_customer_outstanding(db, inv.customer_id)

    await db.commit()
    result = await db.execute(
        select(SaleInvoice)
        .options(
            selectinload(SaleInvoice.line_items).selectinload(SaleLineItem.item),
            selectinload(SaleInvoice.customer),
        )
        .where(SaleInvoice.id == invoice_id)
    )
    inv = result.scalar_one()
    sales_order_number = None
    if getattr(inv, "pending_order_id", None):
        so_res = await db.execute(select(SalesOrder.number).where(SalesOrder.id == inv.pending_order_id))
        sales_order_number = so_res.scalar_one_or_none()
    elif getattr(inv, "origin", None) == "sales_order":
        sales_order_number = inv.number
    else:
        so_res = await db.execute(select(SalesOrder.number).where(SalesOrder.converted_invoice_id == inv.id))
        sales_order_number = so_res.scalar_one_or_none()
    return _inv_dict(inv, inv.line_items, sales_order_number=sales_order_number)

# ─── CREATE ───────────────────────────────────────────────────────────────────
@router.post("/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_invoice(
    data: SaleCreate,
    request: Request = None,
    user: User = Depends(require_perm("invoices.create")),
    db: AsyncSession = Depends(get_db),
):

    if not data.items:
        raise HTTPException(400, "Invoice must have at least one line item")
    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have a name and positive quantity")
    today = datetime.now().strftime("%Y-%m-%d")
    inv_origin_early = (data.origin or "invoice").strip().lower() or "invoice"
    if data.quotation_id:
        inv_origin_early = "quotation"
    elif data.sales_order_id:
        inv_origin_early = "sales_order"

    # POS live counter: direct commit via pos.use (not invoices.approve).
    # Regular invoices still require invoices.approve for direct commit.
    if inv_origin_early == "pos":
        direct = await can_direct_pos_bill(user, db)
        if not direct:
            raise HTTPException(
                403,
                "POS billing requires the pos.use permission — "
                "live counter sales cannot be saved as drafts",
            )
    else:
        direct = await can_direct_commit(user, db, "invoices.approve")
    # Line amount after line discount; document discount is applied next,
    # then GST is extracted from the remaining inclusive amount.
    line_rows, subtotal, tax_total, total = _invoice_line_rollups(data.items, data.discount)
    is_paid_at_create = data.payment_mode is not None
    if direct:
        paid   = total if is_paid_at_create else 0.0
        status = "paid" if paid >= total else "pending"
    else:
        # Pending approval — land as draft; stock + payment deferred to approve step.
        paid   = 0.0
        status = InvoiceStatus.draft.value
    due_date = None
    if status in ("pending", "partial"):
        due_date = compute_due_date(data.date or today, None)

    # 2026-05-25: 'credit' mode debits the customer's stored credit
    # balance. Validations:
    #   • customer_id required — walk-ins don't have a credit balance
    #     to draw from. 400.
    #   • customer.credit_balance >= total — partial-credit isn't
    #     supported in this flow (would need a split-payment UI). 400.
    # On success, the customer.credit_balance is debited atomically +
    # an AuditLog row is written. The debit happens BELOW after the
    # invoice is added, so it can be rolled back together with the
    # invoice insert if anything later in the txn fails.
    # Draft invoices skip the credit validation — the debit runs on approval.
    credit_customer = None
    if direct and data.payment_mode == "credit":
        if not data.customer_id:
            raise HTTPException(400, "Credit-mode sale requires a customer (walk-ins can't draw credit)")
        cust_row = await db.execute(
            select(Customer).where(Customer.id == data.customer_id)
        )
        credit_customer = cust_row.scalar_one_or_none()
        if not credit_customer:
            raise HTTPException(404, f"Customer {data.customer_id} not found")
        available = float(credit_customer.credit_balance or 0)
        if available < total:
            raise HTTPException(
                400,
                f"Insufficient credit — customer has MVR{round(available, 2)} available, sale total is MVR{total}",
            )

    await _resolve_branch_scope(user, db, data.branch_id)

    inv_origin = (data.origin or "invoice").strip().lower() or "invoice"
    if data.quotation_id:
        inv_origin = "quotation"
    elif data.sales_order_id:
        inv_origin = "sales_order"
    inv_doc_type = "pos_receipt" if inv_origin == "pos" else "sales_invoice"
    inv_num = await resolve_number(
        db,
        requested=data.number,
        model=SaleInvoice,
        allocate=lambda: allocate_number(
            db, inv_doc_type, branch_id=data.branch_id,
        ),
    )

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        cashier=(user.name if user is not None else data.cashier),
        created_by=(user.name if user is not None else data.cashier),
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
        payment_ref=(data.payment_ref or '').strip() or None,
        status=status,
        due_date=due_date,
        origin=inv_origin,
        notes=data.notes,
        # Draft invoices: remember SO/quotation link; applied on approval.
        pending_order_id=(data.sales_order_id if not direct else None),
        pending_quote_id=(data.quotation_id if not direct else None),
    )
    db.add(inv)

    item_ids = {item.item_id for item in data.items if item.item_id}
    item_map = await _load_items_by_id(db, item_ids)
    allow_oversell = await get_allow_overselling(db)

    for item, line_amount, _line_taxable, _line_tax in line_rows:
        item_obj = item_map.get(item.item_id) if item.item_id else None
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, price=item.price,
            tax_rate=item.tax_rate,
            discount=_stored_line_discount_pct(item),
            line_total=line_amount,
            **_snapshot_item_metadata(item_obj),
        )
        db.add(li)
        if direct and item.item_id:
            await _consume_sale_line_stock(
                db,
                item=item,
                li=li,
                branch_id=data.branch_id,
                invoice_id=inv.id,
                invoice_number=inv.number,
                allow_oversell=allow_oversell,
            )

    # 2026-05-25: debit customer.credit_balance for credit-mode sales.
    # The validation above already confirmed sufficient balance + a
    # real customer; this just commits the debit + writes the audit
    # trail. Same commit as the invoice insert so failure rolls back.
    # Draft invoices skip this — the debit runs on approval.
    if direct and data.payment_mode == "credit" and credit_customer is not None:
        prev_balance, new_balance = await adjust_customer_credit(
            db,
            credit_customer.id,
            -total,
            entry_type="sale_debit",
            source_type="sale_invoice",
            source_ref=inv.id,
            source_number=inv.number,
            created_by="POS",
        )
        db.add(AuditLog(
            id=str(uuid.uuid4()),
            action="customer_credit_debit",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
            module="sales",
            ref=inv.number,
            detail=(
                f"Credit-mode sale {inv.number}: −MVR{total} from "
                f"{credit_customer.name}'s credit (was MVR{prev_balance:.2f}, "
                f"now MVR{new_balance:.2f})"
            ),
            risk="low",
            ip_address=None,
            branch_id=data.branch_id,
        ))
        # Also write a CustomerPayment row so the Payments tab shows
        # this sale alongside cash/upi/etc payments. Parity with the
        # record_payment retrofit below.
        pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
        pay = CustomerPayment(
            id=str(uuid.uuid4()),
            number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
            customer_id=credit_customer.id,
            customer_name=credit_customer.name,
            branch_id=data.branch_id,
            branch_name=data.branch_name,
            date=today,
            total_amount=total,
            payment_mode="credit",
            payment_ref=data.payment_ref or "",
            notes="POS credit-mode sale",
            credit_applied=0.0,
            created_by="POS",
        )
        db.add(pay)
        db.add(CustomerPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=pay.id,
            invoice_id=inv.id,
            invoice_number=inv.number,
            amount=total,
        ))
        await record_customer_payment(db, pay)

    # 2026-05-31: record a CustomerPayment for EVERY paid-at-POS sale (cash /
    # card / upi / bank_transfer), not just credit-mode, so the Payments tab
    # is a complete ledger — parity with record_payment + multi-invoice
    # payments. Previously these settled the invoice but left no payment row,
    # so cash-paid POS invoices were missing from the Payments tab.
    # Draft invoices skip this — the payment runs on approval.
    if direct and is_paid_at_create and data.payment_mode != "credit":
        pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
        pos_pay = CustomerPayment(
            id=str(uuid.uuid4()),
            number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
            customer_id=inv.customer_id,
            customer_name=inv.customer_name or "Walk-in",
            branch_id=data.branch_id,
            branch_name=data.branch_name,
            date=today,
            total_amount=total,
            payment_mode=data.payment_mode,
            payment_ref=data.payment_ref or "",
            notes="POS sale",
            credit_applied=0.0,
            created_by="POS",
        )
        db.add(pos_pay)
        db.add(CustomerPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=pos_pay.id,
            invoice_id=inv.id,
            invoice_number=inv.number,
            amount=total,
        ))
        await record_customer_payment(db, pos_pay)
        if data.payment_mode == "cash":
            await record_cash_in(
                db,
                branch_id=data.branch_id,
                amount=total,
                date=today,
                description=f"Sale {inv.number}",
                category="Sale — Cash",
                source_type="sale_invoice",
                source_id=pos_pay.id,
                source_ref=inv.number,
                recorded_by=data.cashier or "POS",
            )

    if direct and data.customer_id and status in ("pending", "partial"):
        await sync_customer_outstanding(db, data.customer_id)

    # For direct-commit invoices, link to source document immediately.
    # Draft invoices store pending_order_id / pending_quote_id and apply the link on approval.
    if direct:
        if data.quotation_id:
            await _link_quotation_to_invoice(db, data.quotation_id, inv, user=user)
        elif data.sales_order_id:
            await _link_sales_order_to_invoice(
                db, data.sales_order_id, inv, data.source_order_lines, user=user,
            )

    # Draft create stays private — notification fires on submit, not create.
    await db.commit()

    # Record a lightweight `created` activity for catalogue expectations
    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id,
        invoice_number=inv.number,
        event_type="created",
        detail=f"Created sales invoice {inv.number}",
        metadata={"invoice_id": inv.id, "total": round(float(total or 0), 2), "status": status},
        branch_id=data.branch_id,
    )

    await _write_post_commit_audit(
        db,
        action="Invoice Created",
        module="Sales",
        reference_id=inv.number,
        detail=f"Created sales invoice {inv.number}",
        user=user,
        request=request,
        branch_id=data.branch_id,
        metadata={"invoice_id": inv.id, "total": round(float(total or 0), 2), "status": status},
    )
    if float(data.discount or 0) > 0:
        await _write_post_commit_audit(
            db,
            action="Discount Applied",
            module="Sales",
            reference_id=inv.number,
            detail=f"Discount of ₹{round(float(data.discount or 0), 2)} applied to {inv.number}",
            user=user,
            request=request,
            branch_id=data.branch_id,
            metadata={"invoice_id": inv.id, "discount": round(float(data.discount or 0), 2), "above_threshold": float(data.discount or 0) > 1000},
        )
    if is_paid_at_create and paid > 0:
        _log_sales_invoice_history(db, user=user,
            invoice_id=inv.id,
            invoice_number=inv.number,
            event_type="payment_recorded",
            action="record_payment",
            detail=f"Recorded payment of {round(float(paid), 2)} for {inv.number}",
            metadata={"invoice_id": inv.id, "amount": round(float(paid), 2), "payment_mode": data.payment_mode},
            branch_id=data.branch_id,
        )
        # Log a status change if the paid-at-create altered the invoice status
        prev_status = "pending"
        next_status = status
        if prev_status != next_status:
            _log_sales_invoice_history(db, user=user,
                invoice_id=inv.id,
                invoice_number=inv.number,
                event_type="status_changed",
                action="update_invoice_status",
                detail=f"Status changed: {prev_status} -> {next_status}",
                metadata={"from": prev_status, "to": next_status},
                branch_id=inv.branch_id,
            )
        await _write_post_commit_audit(
            db,
            action="Payment Recorded",
            module="Sales",
            reference_id=inv.number,
            detail=f"Recorded payment of ₹{round(float(paid), 2)} for {inv.number}",
            user=user,
            request=request,
            branch_id=data.branch_id,
            metadata={"invoice_id": inv.id, "amount": round(float(paid), 2), "payment_mode": data.payment_mode},
        )
    invalidate_dashboard_cache_for_user(user.id)
    await db.refresh(inv)
    return {"id": inv.id, "number": inv_num, "total": round(total, 2), "status": status}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/payment", dependencies=[Depends(require_perm("invoices.edit"))])
async def record_payment(
    invoice_id: str,
    data: PaymentIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
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
        select(SaleInvoice.id, SaleInvoice.total, SaleInvoice.paid_amount, SaleInvoice.customer_id, SaleInvoice.number, SaleInvoice.branch_id, SaleInvoice.status)
        .where(SaleInvoice.id == invoice_id)
    )
    pre_row = pre.first()
    if not pre_row:
        raise HTTPException(404, "Invoice not found")
    # Validate user may write payments for this invoice's branch
    await _resolve_branch_scope(user, db, pre_row.branch_id)
    if str(getattr(pre_row, "status", "")) in (
        InvoiceStatus.draft.value,
        InvoiceStatus.pending_approval.value,
    ):
        raise HTTPException(400, "Invoice is awaiting approval — payment cannot be recorded until approved")
    pre_total = float(pre_row.total or 0)
    pre_paid = float(pre_row.paid_amount or 0)
    pre_balance = max(0.0, pre_total - pre_paid)
    pre_status = "paid" if pre_paid >= pre_total else ("partial" if pre_paid > 0 else "pending")
    if pre_balance <= 0:
        raise HTTPException(400, "Invoice already settled")

    # 2026-05-25: credit-mode follow-up payment. Validate + debit
    # customer.credit_balance the same way create_invoice does.
    # Settling a pending invoice from existing credit is a common
    # workflow (operator records the payment AFTER the sale).
    credit_customer = None
    if data.mode == "credit":
        if not pre_row.customer_id:
            raise HTTPException(400, "Credit-mode payment requires a customer (walk-in invoice can't draw credit)")
        cust_row = await db.execute(
            select(Customer).where(Customer.id == pre_row.customer_id)
        )
        credit_customer = cust_row.scalar_one_or_none()
        if not credit_customer:
            raise HTTPException(404, f"Customer {pre_row.customer_id} not found")
        available = float(credit_customer.credit_balance or 0)
        if available < data.amount:
            raise HTTPException(
                400,
                f"Insufficient credit — customer has MVR{round(available, 2)} available, payment is MVR{data.amount}",
            )

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
                f"Walk-in invoice — reduce amount to MVR{round(pre_balance, 2)} "
                f"or assign a customer first to capture the MVR{credit_applied} excess as credit",
            )
        # Customer set — bump credit_balance + audit log.
        # 2026-05-25: NEVER re-import Customer / AuditLog here. Both are
        # already imported at the top of the file. A local import inside
        # this conditional branch makes `Customer` a LOCAL variable for
        # the entire function (Python scoping), so the retrofit code
        # below that uses `Customer` in the credit_applied=0 path hits
        # `UnboundLocalError` because the local was never assigned. The
        # bug looked like a generic 500 on every legacy single-invoice
        # payment without overpay. (Discovered 2026-05-25.)
        cust_row = await db.execute(
            select(Customer).where(Customer.id == pre_row.customer_id)
        )
        cust = cust_row.scalar_one_or_none()
        if cust is not None:
            cur_credit, new_credit = await adjust_customer_credit(
                db,
                pre_row.customer_id,
                credit_applied,
                entry_type="overpayment",
                source_type="sale_invoice",
                source_ref=invoice_id,
                source_number=pre_row.number,
            )
            customer_credit_after = new_credit
            db.add(AuditLog(
                id=str(uuid.uuid4()),
                action="customer_credit",
                user_id=getattr(user, "id", None),
                user_name=getattr(user, "name", None),
                module="sales",
                ref=pre_row.number,
                detail=(
                    f"Overpayment on {pre_row.number}: +MVR{credit_applied} "
                    f"credited to {cust.name} (was MVR{cur_credit:.2f}, "
                    f"now MVR{new_credit:.2f})"
                ),
                risk="low",
                ip_address=None,
                branch_id=getattr(pre_row, "branch_id", None),
            ))
    # (no customer_id) get "Walk-in" without a query.
    pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
    if pre_row.customer_id:
        cust_name_row = await db.execute(
            select(Customer.name).where(Customer.id == pre_row.customer_id)
        )
        resolved_customer_name = cust_name_row.scalar() or "—"
    else:
        resolved_customer_name = "Walk-in"

    pay = CustomerPayment(
        id=str(uuid.uuid4()),
        number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
        customer_id=pre_row.customer_id,  # nullable for walk-ins
        customer_name=resolved_customer_name,
        branch_id=None,                   # not surfaced in single-invoice payload
        branch_name=None,
        date=datetime.now().strftime("%Y-%m-%d"),
        total_amount=round(float(data.amount), 2),
        payment_mode=data.mode,
        payment_ref=data.ref or "",
        notes=None,
        credit_applied=round(credit_applied, 2),
        created_by="Staff",
    )
    db.add(pay)
    db.add(CustomerPaymentAllocation(
        id=str(uuid.uuid4()),
        payment_id=pay.id,
        invoice_id=invoice_id,
        invoice_number=pre_row.number,
        amount=round(float(data.amount), 2),
    ))
    await record_customer_payment(db, pay)
    if data.mode == "cash":
        await record_cash_in(
            db,
            branch_id=pay.branch_id or "",
            amount=float(data.amount),
            date=pay.date,
            description=f"Payment on {pre_row.number}",
            category="Sale — Cash",
            source_type="customer_payment",
            source_id=pay.id,
            source_ref=pay.number,
            recorded_by=pay.created_by or "Staff",
        )

    # 2026-05-25: debit credit balance for credit-mode payments. Same
    # pattern as create_invoice — the validation above guaranteed
    # sufficient balance; this commits the debit + writes audit.
    if data.mode == "credit" and credit_customer is not None:
        prev_balance, new_balance = await adjust_customer_credit(
            db,
            credit_customer.id,
            -data.amount,
            entry_type="payment_debit",
            source_type="sale_invoice",
            source_ref=invoice_id,
            source_number=pre_row.number,
        )
        db.add(AuditLog(
            id=str(uuid.uuid4()),
            action="customer_credit_debit",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
            module="sales",
            ref=pre_row.number,
            detail=(
                f"Credit-mode payment on {pre_row.number}: −MVR{data.amount} "
                f"from {credit_customer.name}'s credit (was MVR{prev_balance:.2f}, "
                f"now MVR{new_balance:.2f})"
            ),
            risk="low",
            ip_address=None,
            branch_id=getattr(pre_row, "branch_id", None),
        ))

    if pre_row.customer_id:
        await sync_customer_outstanding(db, pre_row.customer_id)

    next_status = "paid" if balance <= 0 else "partial"
    applied_amount = round(max(0.0, float(data.amount) - float(credit_applied or 0)), 2)
    await db.commit()
    await _write_post_commit_audit(
        db,
        action="Payment Recorded",
        module="Sales",
        reference_id=pre_row.number,
        detail=f"Recorded payment of ₹{round(float(data.amount), 2)} for {pre_row.number}",
        user=user,
        request=request,
        branch_id=getattr(pre_row, "branch_id", None),
        metadata={
            "invoice_id": invoice_id,
            "payment_id": pay.id,
            "payment_number": pay.number,
            "amount": round(float(data.amount), 2),
            "applied": applied_amount,
            "credit_applied": round(float(credit_applied or 0), 2),
            "payment_mode": data.mode,
            "payment_ref": data.ref or "",
            "status_from": pre_status,
            "status_to": next_status,
        },
    )
    return {
        "status": "paid" if balance <= 0 else "partial",
        "paid_amount": paid,
        "balance": balance,
        "credit_applied": credit_applied,
        "customer_credit_balance": customer_credit_after,
    }

# ─── INVOICE APPROVAL ─────────────────────────────────────────────────────────
class InvoiceApproveReject(BaseModel):
    notes: Optional[str] = None


@router.post("/{invoice_id}/submit", dependencies=[Depends(require_perm("invoices.create"))])
async def submit_invoice(
    invoice_id: str,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Creator submits a private draft for approval (no stock/credit yet)."""
    res = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = res.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await enforce_branch_access(inv.branch_id, user=user, db=db)
    inv_status = inv.status.value if hasattr(inv.status, "value") else str(inv.status)
    if inv_status == InvoiceStatus.pending_approval.value:
        return {"status": "pending_approval", "number": inv.number, "already_processed": True}
    if inv_status != InvoiceStatus.draft.value:
        raise HTTPException(400, f"Only draft invoices can be submitted (status={inv_status})")
    if inv.created_by and inv.created_by != user.name and not await can_direct_commit(user, db, "invoices.approve"):
        raise HTTPException(403, "Only the creator can submit this draft for approval")

    inv.status = InvoiceStatus.pending_approval
    from src.notifications.store import emit_invoice_pending, notify_refresh
    await emit_invoice_pending(db, inv)
    await db.commit()
    await notify_refresh()
    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id, invoice_number=inv.number,
        event_type="submitted", action="submit_invoice",
        detail=f"Invoice {inv.number} submitted for approval by {user.name}",
        metadata={"status": "pending_approval"},
        branch_id=inv.branch_id,
    )
    await _write_post_commit_audit(
        db, action="Invoice Submitted", module="Sales", reference_id=inv.number,
        detail=f"Invoice {inv.number} submitted for approval", user=user, request=request,
        branch_id=inv.branch_id,
        metadata={"invoice_id": inv.id, "status": "pending_approval"},
    )
    return {"status": "pending_approval", "number": inv.number}


@router.post("/{invoice_id}/approve", dependencies=[Depends(require_perm("invoices.approve"))])
async def approve_invoice(
    invoice_id: str,
    body: InvoiceApproveReject,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Approve a submitted invoice: apply stock, apply payment, update ledgers."""
    res = await db.execute(
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.id == invoice_id)
    )
    inv = res.unique().scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await enforce_branch_access(inv.branch_id, user=user, db=db)
    inv_status = inv.status.value if hasattr(inv.status, "value") else str(inv.status)
    # Legacy: treat pre-migration draft-as-queue rows as approvable too.
    if inv_status in (InvoiceStatus.pending_approval.value, InvoiceStatus.draft.value):
        pass  # proceed
    elif inv_status in ("paid", "pending", "partial"):
        return {"status": inv_status, "number": inv.number, "already_processed": True}
    else:
        raise HTTPException(
            400,
            f"Only pending-approval invoices can be approved (status={inv_status})",
        )
    if inv.created_by and inv.created_by == user.name:
        raise HTTPException(403, "You cannot approve your own invoice")

    allow_oversell = await get_allow_overselling(db)
    today_str = datetime.now().strftime("%Y-%m-%d")

    # Apply stock for each tracked line item
    for li in inv.line_items:
        if not li.item_id:
            continue
        tracked, expiry_tracked = await is_tracked(db, li.item_id)
        if tracked:
            strategy = "fefo" if expiry_tracked else "fifo"
            try:
                consumed_ledger = await consume_batches_atomic(
                    db, item_id=li.item_id, branch_id=inv.branch_id,
                    qty=li.qty, strategy=strategy,
                    movement_type="sale", source_type="sale_invoice", source_ref=inv.id,
                )
                if consumed_ledger:
                    li.batch_allocation = json.dumps([
                        {"batch_id": e["batch_id"], "batch_number": e.get("batch_number"),
                         "consumed": e["consumed"], "expiry_date": e.get("expiry_date")}
                        for e in consumed_ledger
                    ])
            except ValueError:
                if not allow_oversell:
                    raise HTTPException(400, f"Insufficient batch stock for {li.name}")
                await clamp_stock_to_zero_with_ledger(
                    db, item_id=li.item_id, branch_id=inv.branch_id,
                    movement_type="sale", source_type="sale_invoice", source_ref=inv.id,
                    notes=f"Oversell clamp on approval of {inv.number}",
                )
        else:
            try:
                await adjust_stock_atomic(
                    db, item_id=li.item_id, branch_id=inv.branch_id,
                    delta=-li.qty, movement_type="sale",
                    source_type="sale_invoice", source_ref=inv.id,
                )
            except ValueError:
                if not allow_oversell:
                    raise HTTPException(400, f"Insufficient stock for {li.name}")
                await clamp_stock_to_zero_with_ledger(
                    db, item_id=li.item_id, branch_id=inv.branch_id,
                    movement_type="sale", source_type="sale_invoice", source_ref=inv.id,
                    notes=f"Oversell clamp on approval of {inv.number}",
                )

    total = float(inv.total or 0)
    payment_mode = inv.payment_mode

    # Apply payment recorded at create time
    if payment_mode == "credit":
        if inv.customer_id:
            cust_res = await db.execute(select(Customer).where(Customer.id == inv.customer_id))
            cust = cust_res.scalar_one_or_none()
            if cust:
                available = float(cust.credit_balance or 0)
                if available < total:
                    raise HTTPException(
                        400,
                        f"Insufficient credit — customer has MVR{round(available, 2)} available, invoice total is MVR{total}",
                    )
                prev_bal, new_bal = await adjust_customer_credit(
                    db, cust.id, -total,
                    entry_type="sale_debit", source_type="sale_invoice",
                    source_ref=inv.id, source_number=inv.number, created_by=user.name,
                )
                db.add(AuditLog(
                    id=str(uuid.uuid4()), action="customer_credit_debit",
                    user_id=getattr(user, "id", None), user_name=getattr(user, "name", None),
                    module="sales", ref=inv.number,
                    detail=(f"Credit-mode invoice {inv.number} approved: −MVR{total} from "
                            f"{cust.name}'s credit (was MVR{prev_bal:.2f}, now MVR{new_bal:.2f})"),
                    risk="low", ip_address=None,
                    branch_id=inv.branch_id,
                ))
                pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
                pay = CustomerPayment(
                    id=str(uuid.uuid4()),
                    number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
                    customer_id=cust.id, customer_name=cust.name,
                    branch_id=inv.branch_id, branch_name=inv.branch_name,
                    date=today_str, total_amount=total, payment_mode="credit",
                    payment_ref="", notes="Approved credit-mode invoice", credit_applied=0.0,
                    created_by=user.name,
                )
                db.add(pay)
                db.add(CustomerPaymentAllocation(
                    id=str(uuid.uuid4()), payment_id=pay.id,
                    invoice_id=inv.id, invoice_number=inv.number, amount=total,
                ))
                await record_customer_payment(db, pay)
                inv.paid_amount = total
    elif payment_mode is not None:
        pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
        pay = CustomerPayment(
            id=str(uuid.uuid4()),
            number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
            customer_id=inv.customer_id, customer_name=inv.customer_name or "Walk-in",
            branch_id=inv.branch_id, branch_name=inv.branch_name,
            date=today_str, total_amount=total, payment_mode=payment_mode,
            payment_ref="", notes="Invoice approved", credit_applied=0.0,
            created_by=user.name,
        )
        db.add(pay)
        db.add(CustomerPaymentAllocation(
            id=str(uuid.uuid4()), payment_id=pay.id,
            invoice_id=inv.id, invoice_number=inv.number, amount=total,
        ))
        await record_customer_payment(db, pay)
        if payment_mode == "cash":
            await record_cash_in(
                db, branch_id=inv.branch_id, amount=total, date=today_str,
                description=f"Sale {inv.number}", category="Sale — Cash",
                source_type="sale_invoice", source_id=pay.id, source_ref=inv.number,
                recorded_by=user.name,
            )
        inv.paid_amount = total

    # Determine new status
    paid_amount = float(inv.paid_amount or 0)
    new_status = "paid" if paid_amount >= total else "pending"
    inv.status = new_status
    if new_status in ("pending", "partial") and not inv.due_date:
        inv.due_date = compute_due_date(inv.date, None)

    # Link to SO / quotation deferred from draft creation
    pending_order_id = getattr(inv, "pending_order_id", None)
    pending_quote_id = getattr(inv, "pending_quote_id", None)
    if pending_order_id:
        so_res = await db.execute(
            select(SalesOrder)
            .options(selectinload(SalesOrder.line_items))
            .where(SalesOrder.id == pending_order_id)
        )
        so = so_res.unique().scalar_one_or_none()
        if so and so.status not in (SalesOrderStatus.converted, SalesOrderStatus.cancelled):
            await _link_sales_order_to_invoice(db, pending_order_id, inv, None, user=user)
        inv.pending_order_id = None
    elif pending_quote_id:
        await _link_quotation_to_invoice(db, pending_quote_id, inv, user=user)
        inv.pending_quote_id = None

    if inv.customer_id and new_status in ("pending", "partial"):
        await sync_customer_outstanding(db, inv.customer_id)

    from src.notifications.store import notify_refresh, resolve_notification
    await resolve_notification(db, f"approval.invoice_pending:{inv.id}")
    await db.commit()
    await notify_refresh()
    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id, invoice_number=inv.number,
        event_type="approved", action="approve_invoice",
        detail=f"Invoice {inv.number} approved by {user.name}",
        metadata={"status": new_status, "approved_by": user.name},
        branch_id=inv.branch_id,
    )
    await _write_post_commit_audit(
        db, action="Invoice Approved", module="Sales", reference_id=inv.number,
        detail=f"Invoice {inv.number} approved", user=user, request=request,
        branch_id=inv.branch_id,
        metadata={"invoice_id": inv.id, "status": new_status, "total": total},
    )
    return {"status": new_status, "number": inv.number}


@router.post("/{invoice_id}/reject", dependencies=[Depends(require_perm("invoices.approve"))])
async def reject_invoice(
    invoice_id: str,
    body: InvoiceApproveReject,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Reject a submitted invoice — marks it cancelled, no side-effects applied."""
    res = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = res.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await enforce_branch_access(inv.branch_id, user=user, db=db)
    inv_status = inv.status.value if hasattr(inv.status, "value") else str(inv.status)
    if inv_status == InvoiceStatus.cancelled.value:
        return {"status": "cancelled", "number": inv.number, "already_processed": True}
    if inv_status not in (InvoiceStatus.pending_approval.value, InvoiceStatus.draft.value):
        raise HTTPException(
            400,
            f"Only pending-approval invoices can be rejected (status={inv_status})",
        )
    inv.status = InvoiceStatus.cancelled
    if body.notes:
        inv.notes = (inv.notes or "") + f"\n[Rejected by {user.name}] {body.notes}"
    from src.notifications.store import notify_refresh, resolve_notification
    await resolve_notification(db, f"approval.invoice_pending:{inv.id}")
    await db.commit()
    await notify_refresh()
    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id, invoice_number=inv.number,
        event_type="rejected", action="reject_invoice",
        detail=f"Invoice {inv.number} rejected by {user.name}",
        metadata={"rejected_by": user.name, "reason": body.notes or ""},
        branch_id=inv.branch_id,
    )
    await _write_post_commit_audit(
        db, action="Invoice Rejected", module="Sales", reference_id=inv.number,
        detail=f"Invoice {inv.number} rejected", user=user, request=request,
        branch_id=inv.branch_id,
        metadata={"invoice_id": inv.id, "reason": body.notes or ""},
    )
    return {"status": "cancelled", "number": inv.number}


# ═════════════════════════════════════════════════════════════════════════════
# MULTI-INVOICE PAYMENTS (2026-05-24)
# ═════════════════════════════════════════════════════════════════════════════
# Operator picks a customer → fetches their pending/partial invoices →
# selects 1+ and records ONE payment that allocates across them.
#
# Same Payment model + table backs BOTH this endpoint and the single-
# invoice path (POST /{invoice_id}/payment). The Payments tab in the
# Sales UI shows every payment regardless of entry point.
#
# IMPORTANT: trailing slash on /payments/ is load-bearing (mirrors
# /returns/ + /orders/ — see follow-up 11 in WORKSHEET.md). Without
# it, /payments would match /{invoice_id} and 404 as "Invoice not found".


class PaymentAllocationIn(BaseModel):
    invoice_id: str
    amount: float = Field(..., gt=0)


class CustomerPaymentCreate(BaseModel):
    customer_id: str           # required — picker is strict
    date: Optional[str] = None
    payment_mode: PaymentMode  # reuse the same Literal as SaleCreate
    payment_ref: Optional[str] = None
    notes: Optional[str] = None
    allocations: List[PaymentAllocationIn] = Field(..., min_length=1)
    branch_id: Optional[str] = None
    branch_name: Optional[str] = None
    created_by: Optional[str] = "Staff"

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)


def _payment_dict(p, allocations=None):
    d = {
        "id": p.id, "number": p.number,
        "customerId": p.customer_id,
        "customerName": p.customer_name or "Walk-in",
        "branchId": p.branch_id, "branchName": p.branch_name,
        "date": p.date,
        "totalAmount": p.total_amount,
        "paymentMode": p.payment_mode,
        "paymentRef": p.payment_ref,
        "notes": p.notes,
        "creditApplied": p.credit_applied or 0,
        "voided": bool(getattr(p, "voided", False)),
        "voidedAt": getattr(p, "voided_at", None),
        "createdBy": p.created_by,
    }
    if allocations is not None:
        d["allocations"] = [{
            "id": a.id,
            "invoiceId": a.invoice_id,
            "invoiceNumber": a.invoice_number,
            "amount": a.amount,
        } for a in allocations]
        d["invoiceCount"] = len(allocations)
    return d


async def _payments_for_invoice(db: AsyncSession, invoice_id: str):
    """Payments allocated to an invoice (for invoice detail drawer).

    Includes voided payments so operators can see the full settlement history.
    `amount` is the allocation applied to this invoice (not the payment total).
    """
    rows = (await db.execute(
        select(CustomerPaymentAllocation, CustomerPayment)
        .join(CustomerPayment, CustomerPaymentAllocation.payment_id == CustomerPayment.id)
        .where(CustomerPaymentAllocation.invoice_id == invoice_id)
        .order_by(CustomerPayment.date.asc(), CustomerPayment.created_at.asc())
    )).all()
    out = []
    for alloc, pay in rows:
        out.append({
            "id": pay.id,
            "allocationId": alloc.id,
            "number": pay.number,
            "date": pay.date,
            "paymentMode": pay.payment_mode,
            "paymentRef": pay.payment_ref,
            "amount": float(alloc.amount or 0),
            "totalAmount": float(pay.total_amount or 0),
            "creditApplied": float(pay.credit_applied or 0),
            "voided": bool(getattr(pay, "voided", False)),
            "voidedAt": getattr(pay, "voided_at", None),
            "createdBy": pay.created_by,
            "notes": pay.notes,
        })
    return out


# ─── PAYMENTS: LIST ──────────────────────────────────────────────────────────
@router.get("/payments/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_payments(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    customer_id: Optional[str] = None,
    payment_mode: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,           # match payment number or customer name
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    conds = []
    status_key = (status or "").strip().lower()
    if status_key == "voided":
        conds.append(CustomerPayment.voided == True)  # noqa: E712
    elif status_key == "recorded":
        conds.append(or_(CustomerPayment.voided == False, CustomerPayment.voided.is_(None)))  # noqa: E712
    if customer_id:
        conds.append(CustomerPayment.customer_id == customer_id)
    if payment_mode:
        conds.append(CustomerPayment.payment_mode == payment_mode)
    if date_from:
        conds.append(CustomerPayment.date >= date_from)
    if date_to:
        conds.append(CustomerPayment.date <= date_to)
    if search:
        s = f"%{search}%"
        conds.append(or_(
            CustomerPayment.number.ilike(s),
            CustomerPayment.customer_name.ilike(s),
        ))
    base = and_(*conds) if conds else True
    total = int((await db.execute(select(func.count(CustomerPayment.id)).where(base))).scalar() or 0)
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {
            "number": CustomerPayment.number,
            "customer_name": CustomerPayment.customer_name,
            "date": CustomerPayment.date,
            "total_amount": CustomerPayment.total_amount,
            "payment_mode": CustomerPayment.payment_mode,
            "created_at": CustomerPayment.created_at,
        },
        default_key="created_at", default_order="desc",
    )
    q = (
        select(CustomerPayment)
        .options(selectinload(CustomerPayment.allocations))
        .where(base)
        .order_by(sort_expr)
        .offset(sk)
        .limit(lim)
    )
    rows = (await db.execute(q)).scalars().all()
    out = [_payment_dict(p, p.allocations) for p in rows]
    return paged(out, total, sk, lim)


# ─── PAYMENTS: GET ───────────────────────────────────────────────────────────
@router.get("/payments/{payment_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_payment(payment_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(CustomerPayment)
        .options(selectinload(CustomerPayment.allocations))
        .where(CustomerPayment.id == payment_id)
    )
    p = res.scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Payment not found")
    return _payment_dict(p, p.allocations)


@router.post("/payments/{payment_id}/void", dependencies=[Depends(require_perm("invoices.edit"))])
async def void_payment(payment_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Soft-void a payment — reverses invoice allocations + credit effects but
    keeps the row for audit. Idempotent."""
    res = await db.execute(
        select(CustomerPayment)
        .options(selectinload(CustomerPayment.allocations))
        .where(CustomerPayment.id == payment_id)
    )
    pay = res.unique().scalar_one_or_none()
    if not pay:
        raise HTTPException(404, "Payment not found")
    if getattr(pay, "voided", False):
        return {"status": "voided", "number": pay.number}

    alloc_amount_by_invoice: dict[str, float] = {}
    status_before: dict[str, str] = {}
    for alloc in pay.allocations:
        alloc_amount_by_invoice[alloc.invoice_id] = round(
            alloc_amount_by_invoice.get(alloc.invoice_id, 0.0) + float(alloc.amount or 0),
            2,
        )
        inv = (await db.execute(select(SaleInvoice).where(SaleInvoice.id == alloc.invoice_id))).scalar_one_or_none()
        if inv is not None:
            status_before[inv.id] = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)

    credit_refunded = await reverse_customer_payment(db, pay)
    pay.voided = True
    pay.voided_at = datetime.now().strftime("%Y-%m-%d")
    await void_payment_record(
        db,
        source_document_type="customer_payment",
        source_document_id=pay.id,
        voided_at=pay.voided_at,
    )
    if pay.payment_mode == "cash":
        await void_cash_for_payment(
            db,
            source_type="customer_payment",
            source_id=pay.id,
            voided_by="Staff",
            reason=f"Payment {pay.number} voided",
        )
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        action="void_payment",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
        risk="medium",
        ip_address=None,
        branch_id=pay.branch_id,
    ))

    for invoice_id, amount in alloc_amount_by_invoice.items():
        inv = (await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))).scalar_one_or_none()
        if inv is None:
            continue
        _log_sales_invoice_history(db, user=user,
            invoice_id=inv.id,
            invoice_number=inv.number,
            event_type="payment_voided",
            action="void_customer_payment",
            detail=f"Voided payment {pay.number} allocation on {inv.number}",
            metadata={
                "payment_id": pay.id,
                "payment_number": pay.number,
                "amount": round(float(amount), 2),
            },
            risk="medium",
            branch_id=inv.branch_id,
        )
        prev_status = status_before.get(inv.id)
        next_status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
        if prev_status and prev_status != next_status:
            _log_sales_invoice_history(db, user=user,
                invoice_id=inv.id,
                invoice_number=inv.number,
                event_type="status_changed",
                action="update_invoice_status",
                detail=f"Status changed: {prev_status} -> {next_status}",
                metadata={"from": prev_status, "to": next_status},
                branch_id=inv.branch_id,
            )

    await db.commit()
    return {
        "status": "voided",
        "number": pay.number,
        "credit_refunded": round(credit_refunded, 2),
    }


# ─── PAYMENTS: CREATE (multi-invoice) ────────────────────────────────────────
@router.post("/payments/", status_code=201, dependencies=[Depends(require_perm("invoices.edit"))])
async def create_payment(data: CustomerPaymentCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Record a payment that may apply to MULTIPLE invoices in one go.

    Validation chain:
      1. Customer exists.
      2. Every referenced invoice exists.
      3. Every invoice belongs to this customer (rejects cross-customer
         allocations + walk-in invoices — those don't have customer_id).
      4. Every invoice has balance > 0 (no already-paid + no cancelled).
      5. Each allocation amount > 0 (Pydantic guards via Field(gt=0)).

    Allocation semantics:
      • allocation.amount > invoice.balance — the excess routes to
        customer.credit_balance + accumulates in the Payment's
        credit_applied. Inline UI warning preview ("Excess MVRX credited")
        keeps the operator informed before submit.
      • Per-invoice update: paid_amount += min(amount, balance);
        status = paid|partial; payment_mode = data.payment_mode.

    Returns: { id, number, total_amount, credit_applied, allocations_count }.
    """
    # 1. Customer must exist (UI's CustomerPicker is strict but defence
    #    in depth — direct API hits get rejected too).
    cust = (await db.execute(
        select(Customer).where(Customer.id == data.customer_id)
    )).scalar_one_or_none()
    if not cust:
        raise HTTPException(404, "Customer not found")

    # 2 + 3. Load all referenced invoices in one query.
    invoice_ids = [a.invoice_id for a in data.allocations]
    if len(set(invoice_ids)) != len(invoice_ids):
        raise HTTPException(400, "Duplicate invoice in allocations")
    inv_rows = (await db.execute(
        select(SaleInvoice).where(SaleInvoice.id.in_(invoice_ids))
    )).scalars().all()
    if len(inv_rows) != len(invoice_ids):
        raise HTTPException(400, "One or more invoices not found")
    inv_by_id = {inv.id: inv for inv in inv_rows}
    for inv in inv_rows:
        if inv.customer_id != data.customer_id:
            raise HTTPException(
                400,
                f"Invoice {inv.number} does not belong to {cust.name}",
            )
        # 4. Status check — skip cancelled + already-paid.
        st = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
        if st == "cancelled":
            raise HTTPException(400, f"Invoice {inv.number} is cancelled")
        balance = max(0.0, float(inv.total or 0) - float(inv.paid_amount or 0))
        if balance <= 0:
            raise HTTPException(400, f"Invoice {inv.number} already settled")

    # 4b. Credit-mode draw-down (2026-05-30). Settling invoices FROM the
    #     customer's stored credit_balance. Overpayment is nonsensical here
    #     (we'd debit credit then re-credit the excess), so each allocation
    #     must be <= its balance, and the customer must have enough credit
    #     to cover the full total. These invoices already belong to `cust`
    #     (validated in step 3), so walk-in can't reach this path.
    requested_total = sum(float(a.amount) for a in data.allocations)
    if data.payment_mode == "credit":
        for a in data.allocations:
            inv = inv_by_id[a.invoice_id]
            bal = max(0.0, float(inv.total or 0) - float(inv.paid_amount or 0))
            if float(a.amount) > bal + 0.001:
                raise HTTPException(
                    400,
                    f"Credit mode can't overpay — {inv.number} balance is MVR{round(bal, 2)}",
                )
        avail = float(cust.credit_balance or 0)
        if avail + 0.001 < requested_total:
            raise HTTPException(
                400,
                f"Insufficient credit — {cust.name} has MVR{round(avail, 2)} available, "
                f"payment totals MVR{round(requested_total, 2)}",
            )

    # 5. Apply allocations + accumulate credit. We update each invoice's
    #    paid_amount + payment_mode + status. The SQLAlchemy session
    #    commit at the end is atomic — partial failures roll back.
    total_credit = 0.0
    total_amount = 0.0
    today = datetime.now().strftime("%Y-%m-%d")
    status_before: dict[str, str] = {}
    for a in data.allocations:
        inv = inv_by_id[a.invoice_id]
        status_before[inv.id] = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
        inv_total = float(inv.total or 0)
        inv_paid = float(inv.paid_amount or 0)
        balance = max(0.0, inv_total - inv_paid)
        applied = min(float(a.amount), balance)
        excess = max(0.0, float(a.amount) - balance)
        new_paid = round(inv_paid + applied, 2)
        inv.paid_amount = new_paid
        inv.payment_mode = data.payment_mode
        inv.status = "paid" if new_paid >= inv_total else "partial"
        total_credit += excess
        total_amount += float(a.amount)

    count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
    pay_num = f"PAY-{datetime.now().year}-{1000 + count:04d}"

    # Bump customer.credit_balance + audit log if any excess.
    if total_credit > 0:
        cur_credit, new_credit = await adjust_customer_credit(
            db,
            data.customer_id,
            total_credit,
            entry_type="overpayment",
            source_type="customer_payment",
            source_number=pay_num,
        )
        db.add(AuditLog(
            id=str(uuid.uuid4()),
            action="customer_credit",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
            module="sales",
            ref=None,  # multi-invoice; specific invoice ref doesn't fit
            detail=(
                f"Multi-invoice payment overpayment: +MVR{round(total_credit, 2)} "
                f"credited to {cust.name} (was MVR{cur_credit:.2f}, "
                f"now MVR{new_credit:.2f})"
            ),
            risk="low",
            ip_address=None,
            branch_id=data.branch_id,
        ))

    # Create the Payment record + per-allocation rows.
    payment = CustomerPayment(
        id=str(uuid.uuid4()),
        number=pay_num,
        customer_id=data.customer_id,
        customer_name=cust.name,
        branch_id=data.branch_id,
        branch_name=data.branch_name,
        date=data.date or today,
        total_amount=round(total_amount, 2),
        payment_mode=data.payment_mode,
        payment_ref=data.payment_ref or "",
        notes=data.notes,
        credit_applied=round(total_credit, 2),
        created_by=data.created_by or "Staff",
    )
    db.add(payment)
    for a in data.allocations:
        inv = inv_by_id[a.invoice_id]
        db.add(CustomerPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=payment.id,
            invoice_id=inv.id,
            invoice_number=inv.number,
            amount=round(float(a.amount), 2),
        ))
    await record_customer_payment(db, payment)
    if data.payment_mode == "cash":
        await record_cash_in(
            db,
            branch_id=data.branch_id or "",
            amount=round(total_amount, 2),
            date=data.date or today,
            description=f"Payment {pay_num}",
            category="Sale — Cash",
            source_type="customer_payment",
            source_id=payment.id,
            source_ref=pay_num,
            recorded_by=data.created_by or "Staff",
        )

    # 2026-05-30: credit-mode debit. The settle loop above marked the
    # invoices paid; now draw the total down from credit_balance + audit.
    # Validated sufficient in step 4b; total_credit is 0 here (overpay was
    # rejected for credit mode) so the overpay-bump block above is skipped.
    if data.payment_mode == "credit":
        cur_credit, new_credit = await adjust_customer_credit(
            db,
            data.customer_id,
            -total_amount,
            entry_type="payment_debit",
            source_type="customer_payment",
            source_ref=payment.id,
            source_number=pay_num,
        )
        db.add(AuditLog(
            id=str(uuid.uuid4()),
            action="customer_credit_debit",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
            module="sales",
            ref=None,
            detail=(
                f"Multi-invoice credit settlement {pay_num}: −MVR{round(total_amount, 2)} "
                f"from {cust.name} (was MVR{cur_credit:.2f}, now MVR{new_credit:.2f})"
            ),
            risk="low",
            ip_address=None,
            branch_id=data.branch_id,
        ))

    for a in data.allocations:
        inv = inv_by_id[a.invoice_id]
        _log_sales_invoice_history(db, user=user,
            invoice_id=inv.id,
            invoice_number=inv.number,
            event_type="payment_recorded",
            action="record_customer_payment",
            detail=f"Recorded payment of {round(float(a.amount), 2)} for {inv.number}",
            metadata={
                "payment_id": payment.id,
                "payment_number": payment.number,
                "amount": round(float(a.amount), 2),
                "payment_mode": data.payment_mode,
                "payment_ref": data.payment_ref or "",
            },
            branch_id=inv.branch_id,
        )
        prev_status = status_before.get(inv.id)
        next_status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
        if prev_status and prev_status != next_status:
            _log_sales_invoice_history(db, user=user,
                invoice_id=inv.id,
                invoice_number=inv.number,
                event_type="status_changed",
                action="update_invoice_status",
                detail=f"Status changed: {prev_status} -> {next_status}",
                metadata={"from": prev_status, "to": next_status},
                branch_id=inv.branch_id,
            )

    await sync_customer_outstanding(db, data.customer_id)

    await db.commit()
    return {
        "id": payment.id,
        "number": pay_num,
        "total_amount": round(total_amount, 2),
        "credit_applied": round(total_credit, 2),
        "allocations_count": len(data.allocations),
    }


# ─── HELPER ───────────────────────────────────────────────────────────────────
async def _assert_invoice_editable(db: AsyncSession, inv: SaleInvoice) -> None:
    """Raise 400 when an invoice must not be edited in place."""
    status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
    if status == "cancelled":
        raise HTTPException(400, "Cannot edit a cancelled invoice")
    if (inv.paid_amount or 0) > 0:
        raise HTTPException(
            400,
            "Cannot edit an invoice with payments recorded. Void payments first.",
        )
    if (getattr(inv, "origin", None) or "").strip().lower() == "pos":
        raise HTTPException(400, "POS receipts cannot be edited — use the refund flow")
    return_count = int((await db.execute(
        select(func.count(SalesReturn.id)).where(SalesReturn.invoice_id == inv.id)
    )).scalar() or 0)
    if return_count > 0:
        raise HTTPException(
            400,
            f"Cannot edit invoice with {return_count} credit note(s). Void returns first.",
        )
    pay_count = int((await db.execute(
        select(func.count(CustomerPaymentAllocation.id))
        .join(CustomerPayment, CustomerPaymentAllocation.payment_id == CustomerPayment.id)
        .where(
            CustomerPaymentAllocation.invoice_id == inv.id,
            or_(CustomerPayment.voided == False, CustomerPayment.voided.is_(None)),  # noqa: E712
        )
    )).scalar() or 0)
    if pay_count > 0:
        raise HTTPException(
            400,
            "Cannot edit an invoice with active payment allocations. Void payments first.",
        )


async def _consume_sale_line_stock(
    db: AsyncSession,
    *,
    item: LineItemIn,
    li: SaleLineItem,
    branch_id: str,
    invoice_id: str,
    invoice_number: str,
    allow_oversell: bool,
) -> None:
    """Deduct stock for one invoice line and persist batch_allocation when known."""
    if not item.item_id:
        return
    if not allow_oversell:
        avail = await get_available_qty(
            db, item_id=item.item_id, branch_id=branch_id,
        )
        if int(item.qty) > avail:
            raise HTTPException(
                400,
                f"Insufficient stock for {item.name}: need {item.qty}, available {avail}",
            )
    tracked, expiry_tracked = await is_tracked(db, item.item_id)
    if tracked:
        strategy = "fefo" if expiry_tracked else "fifo"
        explicit = (
            [e.model_dump() for e in item.batch_allocation]
            if item.batch_allocation else None
        )
        consumed_ok = False
        consumed_ledger = None
        try:
            consumed_ledger = await consume_batches_atomic(
                db,
                item_id=item.item_id,
                branch_id=branch_id,
                qty=item.qty,
                strategy=strategy,
                preferred_batch_id=item.batch_id,
                explicit_allocation=explicit,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
            )
            consumed_ok = True
        except ValueError:
            if explicit:
                try:
                    consumed_ledger = await consume_batches_atomic(
                        db,
                        item_id=item.item_id,
                        branch_id=branch_id,
                        qty=item.qty,
                        strategy=strategy,
                        preferred_batch_id=item.batch_id,
                        explicit_allocation=None,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=invoice_id,
                    )
                    consumed_ok = True
                except ValueError:
                    pass
        if consumed_ledger:
            li.batch_allocation = json.dumps([
                {
                    "batch_id": e["batch_id"],
                    "batch_number": e.get("batch_number"),
                    "consumed": e["consumed"],
                    "expiry_date": e.get("expiry_date"),
                }
                for e in consumed_ledger
            ])
        if not consumed_ok:
            if not allow_oversell:
                raise HTTPException(
                    400,
                    f"Insufficient batch stock for {item.name}",
                )
            await db.execute(
                text(
                    "UPDATE item_batches SET quantity = 0 "
                    "WHERE item_id = :i AND branch_id = :b"
                ),
                {"i": item.item_id, "b": branch_id},
            )
            await clamp_stock_to_zero_with_ledger(
                db,
                item_id=item.item_id,
                branch_id=branch_id,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
                notes=f"Oversell clamp on {invoice_number}",
            )
    else:
        try:
            await adjust_stock_atomic(
                db,
                item_id=item.item_id,
                branch_id=branch_id,
                delta=-item.qty,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
            )
        except ValueError:
            if not allow_oversell:
                raise HTTPException(
                    400,
                    f"Insufficient stock for {item.name}",
                )
            await clamp_stock_to_zero_with_ledger(
                db,
                item_id=item.item_id,
                branch_id=branch_id,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
                notes=f"Oversell clamp on {invoice_number}",
            )


async def _restock_invoice_lines(db, inv, line_items) -> int:
    """Reverse stock deducted at invoice create/convert. Uses the per-line
    batch_allocation ledger when present; otherwise aggregate add-back."""
    restored = 0
    for li in line_items:
        if not li.item_id or not li.qty:
            continue
        if li.batch_allocation:
            try:
                ledger = json.loads(li.batch_allocation)
            except (ValueError, TypeError):
                ledger = []
            for entry in ledger:
                bid = entry.get("batch_id")
                qty = int(entry.get("consumed") or 0)
                if not bid or qty <= 0:
                    continue
                b = (await db.execute(
                    select(ItemBatch).where(ItemBatch.id == bid)
                )).scalar_one_or_none()
                if b is not None:
                    await set_batch_quantity_atomic(
                        db, batch_id=bid, new_qty=int(b.quantity or 0) + qty,
                    )
                else:
                    try:
                        await adjust_stock_atomic(
                            db, item_id=li.item_id, branch_id=inv.branch_id, delta=qty,
                            movement_type="sale_reversal",
                            source_type="sale_invoice",
                            source_ref=inv.id,
                        )
                    except ValueError:
                        pass
                restored += qty
        else:
            try:
                await adjust_stock_atomic(
                    db, item_id=li.item_id, branch_id=inv.branch_id, delta=int(li.qty),
                    movement_type="sale_reversal",
                    source_type="sale_invoice",
                    source_ref=inv.id,
                )
                restored += int(li.qty)
            except ValueError:
                pass
    return restored


# ─── Sales Returns: reverse effects (void / delete) ───────────────────────────
async def _reverse_sales_return_effects(db: AsyncSession, ret: SalesReturn) -> float:
    """Undo stock + invoice + customer-credit side-effects of a processed return.
    Returns credit_balance revoked (MVR). Caller sets status=void or deletes row."""
    credit_revoked = 0.0
    for rl in ret.line_items:
        if rl.batch_allocation:
            try:
                ledger = json.loads(rl.batch_allocation)
            except (ValueError, TypeError):
                ledger = []
            for entry in ledger:
                bid = entry.get("batch_id")
                qty = int(entry.get("restored") or 0)
                if not bid or qty <= 0:
                    continue
                b = (await db.execute(
                    select(ItemBatch).where(ItemBatch.id == bid)
                )).scalar_one_or_none()
                if b is not None:
                    await set_batch_quantity_atomic(
                        db, batch_id=bid, new_qty=max(0, int(b.quantity or 0) - qty),
                    )
                elif rl.item_id:
                    try:
                        await adjust_stock_atomic(
                            db, item_id=rl.item_id, branch_id=ret.branch_id, delta=-qty,
                            movement_type="return",
                            source_type="sales_return",
                            source_ref=ret.id,
                        )
                    except ValueError:
                        pass
        elif rl.item_id:
            try:
                await adjust_stock_atomic(
                    db, item_id=rl.item_id, branch_id=ret.branch_id,
                    delta=-int(rl.return_qty or 0),
                )
            except ValueError:
                pass

    inv = (await db.execute(
        select(SaleInvoice).where(SaleInvoice.id == ret.invoice_id)
    )).scalar_one_or_none()
    if inv is not None:
        _recompute_invoice_status(inv)

    if ret.refund_method == "credit" and ret.customer_id and (ret.credited_amount or 0) > 0:
        cust = (await db.execute(
            select(Customer).where(Customer.id == ret.customer_id)
        )).scalar_one_or_none()
        if cust:
            refund_amt = float(ret.credited_amount or 0)
            await adjust_customer_credit(
                db,
                ret.customer_id,
                -refund_amt,
                entry_type="return_void_revoke",
                source_type="sales_return",
                source_ref=ret.id,
                source_number=ret.number,
            )
            credit_revoked = refund_amt

    return credit_revoked


# ─── CANCEL ───────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/cancel", dependencies=[Depends(require_perm("invoices.cancel"))])
async def cancel_invoice(
    invoice_id: str,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    res = await db.execute(
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.id == invoice_id)
    )
    inv = res.unique().scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.status == InvoiceStatus.cancelled or str(inv.status).endswith("cancelled"):
        return {"status": "cancelled"}
    if (inv.paid_amount or 0) > 0:
        raise HTTPException(
            400,
            "Cannot cancel an invoice with payments recorded. Delete payment records first.",
        )
    return_count = int((await db.execute(
        select(func.count(SalesReturn.id)).where(SalesReturn.invoice_id == invoice_id)
    )).scalar() or 0)
    if return_count > 0:
        raise HTTPException(
            400,
            f"Cannot cancel invoice with {return_count} credit note(s). Delete returns first.",
        )
    pay_count = int((await db.execute(
        select(func.count(CustomerPaymentAllocation.id))
        .join(CustomerPayment, CustomerPaymentAllocation.payment_id == CustomerPayment.id)
        .where(
            CustomerPaymentAllocation.invoice_id == invoice_id,
            or_(CustomerPayment.voided == False, CustomerPayment.voided.is_(None)),  # noqa: E712
        )
    )).scalar() or 0)
    if pay_count > 0:
        raise HTTPException(
            400,
            "Cannot cancel an invoice with active payment allocations. Void or delete payments first.",
        )
    stock_restored = await _restock_invoice_lines(db, inv, inv.line_items)
    prev_status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
    inv.status = "cancelled"
    if inv.customer_id:
        await sync_customer_outstanding(db, inv.customer_id)
    await db.commit()

    # Write activity rows expected by catalogue tests
    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id,
        invoice_number=inv.number,
        event_type="voided",
        action="cancel_invoice",
        detail=f"Voided invoice {inv.number}",
        metadata={"invoice_id": inv.id, "stock_restored": stock_restored},
        risk="high",
        branch_id=inv.branch_id,
    )
    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id,
        invoice_number=inv.number,
        event_type="status_changed",
        action="update_invoice_status",
        detail=f"Status changed: {prev_status} -> cancelled",
        metadata={"from": prev_status, "to": "cancelled"},
        branch_id=inv.branch_id,
    )

    await _write_post_commit_audit(
        db,
        action="Invoice Cancelled",
        module="Sales",
        reference_id=inv.number,
        detail=f"Cancelled sales invoice {inv.number}",
        user=user,
        request=request,
        branch_id=inv.branch_id,
        metadata={"invoice_id": inv.id, "status_from": prev_status, "status_to": "cancelled", "stock_restored": stock_restored},
    )
    return {"status": "cancelled", "stock_restored": stock_restored}

def _loaded_rel(obj, name):
    """Return a relationship if already loaded; never trigger async lazy-load."""
    if obj is None:
        return None
    state = sa_inspect(obj)
    if name in state.unloaded:
        return None
    return getattr(obj, name, None)


def _quote_dict(quote, items=None):
    customer = _loaded_rel(quote, "customer")
    customer_code = None
    if customer is not None:
        customer_code = getattr(customer, "customer_code", None) or None
    if not customer_code and quote.customer_id:
        try:
            customer_code = _build_customer_code(quote.customer_id)
        except Exception:
            customer_code = None

    d = {
        "id": quote.id, "number": quote.number,
        "customerId": quote.customer_id,
        "customerCode": customer_code,
        "customerName": quote.customer_name or "Walk-in",
        "customerAddress": customer.address if customer else None,
        "customer_address": customer.address if customer else None,
        "customerStreet1": customer.street1 if customer else None,
        "customer_street1": customer.street1 if customer else None,
        "customerStreet2": customer.street2 if customer else None,
        "customer_street2": customer.street2 if customer else None,
        "customerStreet3": customer.street3 if customer else None,
        "customer_street3": customer.street3 if customer else None,
        "customerCity": customer.city if customer else None,
        "customer_city": customer.city if customer else None,
        "customerStateProvince": customer.state_province if customer else None,
        "customer_state_province": customer.state_province if customer else None,
        "customerCountry": customer.country if customer else None,
        "customer_country": customer.country if customer else None,
        "customerPostalCode": customer.postal_code if customer else None,
        "customer_postal_code": customer.postal_code if customer else None,
        "customerGstin": customer.gstin if customer else None,
        "customer_gstin": customer.gstin if customer else None,
        "branchId": quote.branch_id,
        "branchName": quote.branch_name,
        "createdBy": quote.created_by,
        "date": quote.date,
        "validUntil": quote.valid_until,
        "shipmentDate": quote.shipment_date,
        "paymentTerms": quote.payment_terms,
        "shipmentMethod": quote.shipment_method,
        "pricesIncludingVat": quote.prices_including_vat,
        "paymentDiscountOnVat": quote.payment_discount_on_vat,
        "subtotal": quote.subtotal,
        "taxTotal": quote.tax_total,
        "discount": quote.discount,
        "total": quote.total,
        "status": str(quote.status.value) if hasattr(quote.status, "value") else str(quote.status),
        "convertedOrderId": quote.converted_order_id,
        "convertedInvoiceId": getattr(quote, "converted_invoice_id", None),
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
            "id": i.id,
            "itemId": i.item_id,
            "sku": getattr(_loaded_rel(i, "item"), "sku", None),
            "packing": getattr(_loaded_rel(i, "item"), "packaging_quantity", None),
            "name": i.name,
            "qty": i.qty,
            "price": i.price,
            "taxRate": i.tax_rate,
            "discount": i.discount,
            "lineTotal": i.line_total,
            "unit": i.unit,
            "vatIdentifier": i.vat_identifier,
            "allowInvoiceDiscount": i.allow_invoice_discount,
            "hsnCode": i.hsn_code,
        } for i in items]
    return d

def _inv_dict(inv, items=None, sales_order_number=None):
    customer = _loaded_rel(inv, "customer")
    customer_code = None
    if customer is not None:
        customer_code = getattr(customer, "customer_code", None) or None
    if not customer_code and inv.customer_id:
        try:
            customer_code = _build_customer_code(inv.customer_id)
        except Exception:
            customer_code = None

    d = {
        "id": inv.id, "number": inv.number,
        "customerId": inv.customer_id,
        "customerCode": customer_code,
        "customerName": inv.customer_name or "Walk-in",
        "customerAddress": customer.address if customer else None,
        "customer_address": customer.address if customer else None,
        "customerStreet1": customer.street1 if customer else None,
        "customer_street1": customer.street1 if customer else None,
        "customerStreet2": customer.street2 if customer else None,
        "customer_street2": customer.street2 if customer else None,
        "customerStreet3": customer.street3 if customer else None,
        "customer_street3": customer.street3 if customer else None,
        "customerCity": customer.city if customer else None,
        "customer_city": customer.city if customer else None,
        "customerStateProvince": customer.state_province if customer else None,
        "customer_state_province": customer.state_province if customer else None,
        "customerCountry": customer.country if customer else None,
        "customer_country": customer.country if customer else None,
        "customerPostalCode": customer.postal_code if customer else None,
        "customer_postal_code": customer.postal_code if customer else None,
        "gstNo": customer.gstin if customer else None,
        "gst_no": customer.gstin if customer else None,
        "phoneNo": customer.phone if customer else None,
        "phone_no": customer.phone if customer else None,
        "email": customer.email if customer else None,
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
        "paymentRef": getattr(inv, "payment_ref", None),
        "status": str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status),
        "dueDate": getattr(inv, "due_date", None),
        "creditedAmount": float(getattr(inv, "credited_amount", 0) or 0),
        "returnStatus": getattr(inv, "return_status", None) or "none",
        "origin": getattr(inv, "origin", None) or "invoice",
        "notes": inv.notes,
        "salesOrderId": getattr(inv, "pending_order_id", None) or None,
        "salesOrderNumber": sales_order_number or None,
    }
    if items is not None:
        out_lines = []
        for i in items:
            item_obj = _loaded_rel(i, "item")
            def _snapshot_field(field_name):
                value = getattr(i, field_name, None)
                if value is not None:
                    return value
                return getattr(item_obj, field_name, None) if item_obj is not None else None

            out_line = {
                "id": i.id,
                "itemId": i.item_id,
                "name": i.name,
                "qty": i.qty,
                "price": i.price,
                "taxRate": i.tax_rate,
                "discount": _display_line_discount_pct(
                    i.qty, i.price, i.tax_rate, i.discount, i.line_total, inv.discount,
                ),
                "lineTotal": _inclusive_from_stored_line_total(
                    i.qty, i.price, i.tax_rate, i.line_total,
                ),
                "batchAllocation": (
                    json.loads(i.batch_allocation) if getattr(i, "batch_allocation", None) else None
                ),
                "sku": _snapshot_field("sku"),
                "barcode": _snapshot_field("barcode"),
                "brand": _snapshot_field("brand"),
                "hsn_code": _snapshot_field("hsn_code"),
                "packing": _snapshot_field("packaging_quantity"),
                "packaging_quantity": _snapshot_field("packaging_quantity"),
                "is_packaging": _snapshot_field("is_packaging"),
                "origin": _snapshot_field("country_of_origin"),
                "country_of_origin": _snapshot_field("country_of_origin"),
                "unit": _snapshot_field("unit"),
                "units": _snapshot_field("unit"),
            }
            out_lines.append(out_line)
        d["items"] = out_lines
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
    number: Optional[str] = None
    notes: Optional[str] = None
    quotation_id: Optional[str] = None


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


class ConvertLineQtyIn(BaseModel):
    """Partial SO→Invoice: which order line and how many units to invoice."""
    order_line_id: str
    qty: int = Field(..., gt=0)


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

    Phase 2: optional `lines` converts a subset of SO line qty. Omitted →
    full convert (all lines at remaining qty). Quote direct-convert ignores
    this field.
    """
    payment_received: bool = False
    payment_mode: Optional[str] = None
    notes: Optional[str] = None
    line_allocations: Optional[List[ConvertLineAllocation]] = None
    lines: Optional[List[ConvertLineQtyIn]] = None


class ReturnBatchAlloc(BaseModel):
    """One entry of an explicit per-batch restore split for a return line:
    put `qty` units back into lot `batch_id`. Sum across a line's entries
    must equal that line's return_qty."""
    batch_id: str
    qty: int = Field(..., gt=0)


class SalesReturnLineIn(BaseModel):
    # invoice_line_id is preferred (lets the backend validate against the
    # exact original line); item_id+name are accepted as fallback for
    # legacy invoices where line ids weren't surfaced to the UI.
    invoice_line_id: Optional[str] = None
    item_id: Optional[str] = None
    name: str
    return_qty: int = Field(..., gt=0)
    # 2026-05-31: optional explicit per-batch restore split. When omitted,
    # the backend distributes the return across the invoice line's source
    # lots FEFO (nearest-expiry refilled first), capped per lot by what the
    # invoice took from it. When present, each entry's lot must be one the
    # invoice consumed + within its remaining cap.
    batch_allocation: Optional[List[ReturnBatchAlloc]] = None


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


async def _get_org_tax_mode(db: AsyncSession) -> str:
    """Always inclusive — org pricing-mode preference removed."""
    return "inclusive"


async def _resolve_customer_id(db: AsyncSession, customer_ref: Optional[str]) -> Optional[str]:
    """Map a customer UUID or display code to customers.id. Empty → walk-in."""
    ref = (customer_ref or "").strip()
    if not ref:
        return None
    row = (await db.execute(select(Customer).where(Customer.id == ref))).scalar_one_or_none()
    if row:
        return row.id
    row = (
        await db.execute(select(Customer).where(Customer.customer_code == ref))
    ).scalar_one_or_none()
    if row:
        return row.id
    raise HTTPException(400, f"Customer {ref} not found")


def _inclusive_after_line_discount(qty, unit, discount_pct) -> float:
    """GST-inclusive line amount after a percent line discount."""
    gross = round(float(qty or 0) * float(unit or 0), 2)
    return round(gross * (1 - (float(discount_pct or 0) / 100)), 2)


def _invoice_line_amount(item) -> float:
    """Inclusive line amount after line-item discount (percent or flat)."""
    gross = round(item.qty * item.price, 2)
    line_disc_amt = max(0.0, min(gross, round(item.line_discount_amount or 0, 2)))
    if line_disc_amt > 0:
        return round(gross - line_disc_amt, 2)
    return round(gross * (1 - (item.line_discount or 0) / 100), 2)


def _stored_line_discount_pct(item) -> float:
    """Percent (0-100) persisted on sale_line_items.discount."""
    gross = round(float(getattr(item, "qty", 0) or 0) * float(getattr(item, "price", 0) or 0), 2)
    amt = max(0.0, min(gross, round(float(getattr(item, "line_discount_amount", 0) or 0), 2)))
    if amt > 0 and gross > 0:
        return round(min(100.0, (amt / gross) * 100), 4)
    return round(float(getattr(item, "line_discount", 0) or 0), 4)


def _inclusive_from_stored_line_total(qty, price, tax_rate, line_total) -> float:
    """Normalize stored line_total to GST-inclusive (taxable writes inflate)."""
    lt = float(line_total or 0)
    rate = float(tax_rate or 0)
    gross = round(float(qty or 0) * float(price or 0), 2)
    if lt <= 0:
        return lt
    if rate > 0:
        inflated = round(lt * (1 + rate / 100.0), 2)
        if inflated <= gross + 0.05:
            return inflated
    return round(lt, 2)


def _display_line_discount_pct(
    qty, price, tax_rate, stored_discount, line_total, header_discount=0.0,
) -> float:
    """Line discount % for API/UI. Recovers wiped rows when header discount is 0."""
    stored = float(stored_discount or 0)
    if stored > 0:
        return stored
    if float(header_discount or 0) > 0:
        return 0.0
    gross = round(float(qty or 0) * float(price or 0), 2)
    inclusive = _inclusive_from_stored_line_total(qty, price, tax_rate, line_total)
    if gross <= 0 or inclusive <= 0 or inclusive >= gross - 0.005:
        return 0.0
    return round(max(0.0, min(100.0, (1.0 - inclusive / gross) * 100.0)), 2)


def _invoice_line_rollups(items, entity_discount: float = 0.0):
    """Line rows + header totals with discounts applied before GST extract.

    Each row is (item, inclusive_after_all_discounts, taxable, tax).
    """
    prepared = [(i, _invoice_line_amount(i), i.tax_rate or 0) for i in items]
    taxed, subtotal, tax_total, total = rollup_inclusive_lines(
        [p[1] for p in prepared],
        [p[2] for p in prepared],
        entity_discount or 0,
    )
    line_rows = [
        (i, after, taxable, tax)
        for (i, _amt, _), (after, taxable, tax) in zip(prepared, taxed)
    ]
    return line_rows, subtotal, tax_total, total


def _calc_lines(lines, tax_mode: str = "inclusive", entity_discount: float = 0.0):
    """Compute line totals + roll up subtotal/tax for SO + quote shapes.

    Line discount is applied first, then document discount, then GST is
    extracted from the remaining inclusive amount. Returns
    (line_rows, subtotal, tax_total). Each row is (line, line_net, line_tax)
    where line_net is inclusive after the line discount only (stored on the
    line); header tax already reflects the document discount.
    """
    prepared = []
    for i in lines:
        line_net = _inclusive_after_line_discount(i.qty, i.price, i.discount)
        prepared.append((i, line_net, i.tax_rate or 0))
    taxed, subtotal, tax_total, _total = rollup_inclusive_lines(
        [p[1] for p in prepared],
        [p[2] for p in prepared],
        entity_discount or 0,
    )
    rows = [
        (i, line_net, tax)
        for (i, line_net, _), (_, _, tax) in zip(prepared, taxed)
    ]
    return rows, subtotal, tax_total


def _summarize_sales_order_item_changes(old_lines, new_items) -> list[dict]:
    """Compute item-level diffs for sales order edits."""
    old_by_key: dict[tuple[str, str], list] = {}
    for line in old_lines or []:
        key = (str(line.item_id or ""), str(line.name or "").strip().lower())
        old_by_key.setdefault(key, []).append(line)

    new_counts: dict[tuple[str, str], int] = {}
    consumed: dict[tuple[str, str], int] = {}
    changes: list[dict] = []

    for item in new_items or []:
        key = (str(item.item_id or ""), str(item.name or "").strip().lower())
        new_counts[key] = new_counts.get(key, 0) + 1
        idx = consumed.get(key, 0)
        consumed[key] = idx + 1
        existing = old_by_key.get(key, [])
        prev = existing[idx] if idx < len(existing) else None
        item_name = str(item.name or "Item")

        if prev is None:
            structured = [
                {"field": "qty", "old": None, "new": int(item.qty or 0)},
                {"field": "price", "old": None, "new": round(float(item.price or 0), 2)},
                {"field": "tax_rate", "old": None, "new": round(float(item.tax_rate or 0), 2)},
                {"field": "discount", "old": None, "new": round(float(item.discount or 0), 2)},
            ]
            changes.append(
                {
                    "item_id": str(item.item_id) if item.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["added"],
                    "changes": structured,
                    "detail": f"{item_name}: added (qty {item.qty}, price {round(float(item.price or 0), 2)})",
                }
            )
            continue

        field_changes: list[str] = []
        fields: list[str] = []
        structured: list[dict] = []
        if int(prev.qty or 0) != int(item.qty or 0):
            fields.append("qty")
            field_changes.append(f"qty {int(prev.qty or 0)} -> {int(item.qty or 0)}")
            structured.append({"field": "qty", "old": int(prev.qty or 0), "new": int(item.qty or 0)})
        if round(float(prev.price or 0), 2) != round(float(item.price or 0), 2):
            fields.append("price")
            field_changes.append(f"price {round(float(prev.price or 0), 2)} -> {round(float(item.price or 0), 2)}")
            structured.append(
                {
                    "field": "price",
                    "old": round(float(prev.price or 0), 2),
                    "new": round(float(item.price or 0), 2),
                }
            )
        if round(float(prev.tax_rate or 0), 2) != round(float(item.tax_rate or 0), 2):
            fields.append("tax_rate")
            field_changes.append(
                f"tax {round(float(prev.tax_rate or 0), 2)} -> {round(float(item.tax_rate or 0), 2)}"
            )
            structured.append(
                {
                    "field": "tax_rate",
                    "old": round(float(prev.tax_rate or 0), 2),
                    "new": round(float(item.tax_rate or 0), 2),
                }
            )
        if round(float(prev.discount or 0), 2) != round(float(item.discount or 0), 2):
            fields.append("discount")
            field_changes.append(
                f"discount {round(float(prev.discount or 0), 2)} -> {round(float(item.discount or 0), 2)}"
            )
            structured.append(
                {
                    "field": "discount",
                    "old": round(float(prev.discount or 0), 2),
                    "new": round(float(item.discount or 0), 2),
                }
            )

        if field_changes:
            changes.append(
                {
                    "item_id": str(item.item_id) if item.item_id is not None else None,
                    "item_name": item_name,
                    "fields": fields,
                    "changes": structured,
                    "detail": f"{item_name}: " + ", ".join(field_changes),
                }
            )

    for key, rows in old_by_key.items():
        new_count = new_counts.get(key, 0)
        if len(rows) <= new_count:
            continue
        for row in rows[new_count:]:
            item_name = str(row.name or "Item")
            structured = [
                {"field": "qty", "old": int(row.qty or 0), "new": None},
                {"field": "price", "old": round(float(row.price or 0), 2), "new": None},
                {"field": "tax_rate", "old": round(float(row.tax_rate or 0), 2), "new": None},
                {"field": "discount", "old": round(float(row.discount or 0), 2), "new": None},
            ]
            changes.append(
                {
                    "item_id": str(row.item_id) if row.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["removed"],
                    "changes": structured,
                    "detail": f"{item_name}: removed (qty {int(row.qty or 0)}, price {round(float(row.price or 0), 2)})",
                }
            )

    return changes


def _summarize_quotation_item_changes(old_lines, new_items) -> list[dict]:
    """Compute item-level diffs for quotation revisions."""
    old_by_key: dict[tuple[str, str], list] = {}
    for line in old_lines or []:
        key = (str(line.item_id or ""), str(line.name or "").strip().lower())
        old_by_key.setdefault(key, []).append(line)

    new_counts: dict[tuple[str, str], int] = {}
    consumed: dict[tuple[str, str], int] = {}
    changes: list[dict] = []

    for item in new_items or []:
        key = (str(item.item_id or ""), str(item.name or "").strip().lower())
        new_counts[key] = new_counts.get(key, 0) + 1
        idx = consumed.get(key, 0)
        consumed[key] = idx + 1
        existing = old_by_key.get(key, [])
        prev = existing[idx] if idx < len(existing) else None
        item_name = str(item.name or "Item")

        if prev is None:
            structured = [
                {"field": "qty", "old": None, "new": int(item.qty or 0)},
                {"field": "price", "old": None, "new": round(float(item.price or 0), 2)},
                {"field": "tax_rate", "old": None, "new": round(float(item.tax_rate or 0), 2)},
                {"field": "discount", "old": None, "new": round(float(item.line_discount or 0), 2)},
            ]
            changes.append(
                {
                    "item_id": str(item.item_id) if item.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["added"],
                    "changes": structured,
                    "detail": f"{item_name}: added (qty {item.qty}, price {round(float(item.price or 0), 2)})",
                }
            )
            continue

        field_changes: list[str] = []
        fields: list[str] = []
        structured: list[dict] = []
        if int(prev.qty or 0) != int(item.qty or 0):
            fields.append("qty")
            field_changes.append(f"qty {int(prev.qty or 0)} -> {int(item.qty or 0)}")
            structured.append({"field": "qty", "old": int(prev.qty or 0), "new": int(item.qty or 0)})
        if round(float(prev.price or 0), 2) != round(float(item.price or 0), 2):
            fields.append("price")
            field_changes.append(f"price {round(float(prev.price or 0), 2)} -> {round(float(item.price or 0), 2)}")
            structured.append(
                {
                    "field": "price",
                    "old": round(float(prev.price or 0), 2),
                    "new": round(float(item.price or 0), 2),
                }
            )
        if round(float(prev.tax_rate or 0), 2) != round(float(item.tax_rate or 0), 2):
            fields.append("tax_rate")
            field_changes.append(
                f"tax {round(float(prev.tax_rate or 0), 2)} -> {round(float(item.tax_rate or 0), 2)}"
            )
            structured.append(
                {
                    "field": "tax_rate",
                    "old": round(float(prev.tax_rate or 0), 2),
                    "new": round(float(item.tax_rate or 0), 2),
                }
            )
        if round(float(prev.discount or 0), 2) != round(float(item.line_discount or 0), 2):
            fields.append("discount")
            field_changes.append(
                f"discount {round(float(prev.discount or 0), 2)} -> {round(float(item.line_discount or 0), 2)}"
            )
            structured.append(
                {
                    "field": "discount",
                    "old": round(float(prev.discount or 0), 2),
                    "new": round(float(item.line_discount or 0), 2),
                }
            )

        if field_changes:
            changes.append(
                {
                    "item_id": str(item.item_id) if item.item_id is not None else None,
                    "item_name": item_name,
                    "fields": fields,
                    "changes": structured,
                    "detail": f"{item_name}: " + ", ".join(field_changes),
                }
            )

    for key, rows in old_by_key.items():
        new_count = new_counts.get(key, 0)
        if len(rows) <= new_count:
            continue
        for row in rows[new_count:]:
            item_name = str(row.name or "Item")
            structured = [
                {"field": "qty", "old": int(row.qty or 0), "new": None},
                {"field": "price", "old": round(float(row.price or 0), 2), "new": None},
                {"field": "tax_rate", "old": round(float(row.tax_rate or 0), 2), "new": None},
                {"field": "discount", "old": round(float(row.discount or 0), 2), "new": None},
            ]
            changes.append(
                {
                    "item_id": str(row.item_id) if row.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["removed"],
                    "changes": structured,
                    "detail": f"{item_name}: removed (qty {int(row.qty or 0)}, price {round(float(row.price or 0), 2)})",
                }
            )

    return changes


def _line_amounts(qty: int, price: float, discount: float, tax_rate: float, tax_mode: str = "inclusive") -> tuple[float, float, float]:
    """Return (line_taxable, line_tax, line_total) for one SO/quote-style line."""
    gross = round(qty * price, 2)
    line_net = round(gross * (1 - (discount or 0) / 100), 2)
    line_tax = line_tax_amount(line_net, tax_rate or 0, tax_mode)
    line_taxable = line_taxable_amount(line_net, tax_rate or 0, tax_mode)
    return line_taxable, line_tax, round(line_taxable + line_tax, 2)


def _recalc_so_header(so: SalesOrder, lines: list, tax_mode: str = "inclusive") -> None:
    """Recompute SO subtotal/tax/total from remaining line rows."""
    inclusives = []
    rates = []
    for li in lines:
        line_net = _inclusive_after_line_discount(
            int(li.qty), float(li.price or 0), float(li.discount or 0),
        )
        li.line_total = line_net
        inclusives.append(line_net)
        rates.append(float(li.tax_rate or 0))
    _taxed, subtotal, tax_total, total = rollup_inclusive_lines(
        inclusives, rates, float(so.discount or 0),
    )
    so.subtotal = subtotal
    so.tax_total = tax_total
    so.total = total


async def _link_quotation_to_order(db: AsyncSession, quote_id: str, so: SalesOrder, user: Optional[User] = None) -> None:
    res = await db.execute(
        select(Quotation).where(Quotation.id == quote_id)
    )
    quote = res.scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    if quote.status in (QuotationStatus.converted, QuotationStatus.rejected):
        raise HTTPException(400, f"Quotation is {quote.status.value}; cannot convert")
    # Ensure the referenced sales order row exists before setting the FK pointer.
    await db.flush()
    quote.status = QuotationStatus.converted
    quote.converted_order_id = so.id
    _log_quotation_history(db, user=user,
        quote_id=quote.id,
        quote_number=quote.number,
        event_type="converted",
        action="convert_quotation",
        detail=f"Converted quotation {quote.number} to sales order {so.number}",
        metadata={
            "target_record_type": "sales_order",
            "target_record_id": so.id,
            "target_record_number": so.number,
        },
    )


async def _link_quotation_to_invoice(db: AsyncSession, quote_id: str, inv: SaleInvoice, user: Optional[User] = None) -> None:
    res = await db.execute(
        select(Quotation).where(Quotation.id == quote_id)
    )
    quote = res.scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    if quote.status in (QuotationStatus.converted, QuotationStatus.rejected):
        raise HTTPException(400, f"Quotation is {quote.status.value}; cannot convert")
    if quote.converted_order_id:
        live_so = (await db.execute(
            select(SalesOrder.id).where(SalesOrder.id == quote.converted_order_id)
        )).scalar_one_or_none()
        if live_so:
            raise HTTPException(
                400,
                "Quotation has a live sales order — delete the SO first or convert it to invoice",
            )
    if quote.converted_invoice_id:
        live_inv = (await db.execute(
            select(SaleInvoice.id).where(SaleInvoice.id == quote.converted_invoice_id)
        )).scalar_one_or_none()
        if live_inv:
            raise HTTPException(400, "Quotation already spawned an invoice")
    # Ensure the referenced invoice row exists before setting the FK pointer.
    await db.flush()
    quote.status = QuotationStatus.converted
    quote.converted_invoice_id = inv.id
    # Log the quotation -> invoice conversion event when applicable.
    _log_quotation_history(db, user=user,
        quote_id=quote.id,
        quote_number=quote.number,
        event_type="converted",
        action="convert_quotation",
        detail=f"Converted quotation {quote.number} to invoice {inv.number}",
        metadata={
            "target_record_type": "sales_invoice",
            "target_record_id": inv.id,
            "target_record_number": inv.number,
        },
    )


async def _link_sales_order_to_invoice(
    db: AsyncSession,
    order_id: str,
    inv: SaleInvoice,
    source_order_lines: Optional[list],
    user: Optional[User] = None,
) -> None:
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.unique().scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    if so.status == SalesOrderStatus.converted:
        raise HTTPException(400, "Sales order already converted")
    if so.status == SalesOrderStatus.cancelled:
        raise HTTPException(400, "Cannot convert a cancelled sales order")

    line_by_id = {li.id: li for li in so.line_items}
    entries = source_order_lines or []
    if not entries:
        raise HTTPException(400, "source_order_lines required when sales_order_id is set")

    tax_mode = await _get_org_tax_mode(db)
    orig_inclusive = 0.0
    for li in so.line_items:
        orig_inclusive += _inclusive_after_line_discount(
            int(li.qty), float(li.price or 0), float(li.discount or 0),
        )
    inv_inclusive = 0.0
    for entry in entries:
        so_line = line_by_id.get(entry.order_line_id)
        if not so_line:
            raise HTTPException(400, f"Order line {entry.order_line_id} not found on this SO")
        if entry.qty > int(so_line.qty):
            raise HTTPException(
                400,
                f"Cannot invoice {entry.qty} of {so_line.name} — only {so_line.qty} remaining on the order",
            )
        inv_inclusive += _inclusive_after_line_discount(
            entry.qty, float(so_line.price or 0), float(so_line.discount or 0),
        )

    inv_discount = 0.0
    if orig_inclusive > 0 and float(so.discount or 0) > 0:
        inv_discount = round(float(so.discount) * (inv_inclusive / orig_inclusive), 2)

    for entry in entries:
        so_line = line_by_id[entry.order_line_id]
        convert_qty = int(entry.qty)
        remaining_qty = int(so_line.qty) - convert_qty
        if remaining_qty <= 0:
            await db.delete(so_line)
        else:
            so_line.qty = remaining_qty
            _, _, so_line.line_total = _line_amounts(
                remaining_qty,
                float(so_line.price or 0),
                float(so_line.discount or 0),
                float(so_line.tax_rate or 0),
                tax_mode,
            )

    if inv_discount > 0:
        so.discount = round(max(0.0, float(so.discount or 0) - inv_discount), 2)

    await db.flush()
    remaining_res = await db.execute(
        select(SalesOrderLineItem).where(
            SalesOrderLineItem.order_id == so.id,
            SalesOrderLineItem.qty > 0,
        )
    )
    remaining_lines = remaining_res.scalars().all()
    fully_converted = len(remaining_lines) == 0

    if fully_converted:
        so.subtotal = 0.0
        so.tax_total = 0.0
        so.total = 0.0
        so.discount = 0.0
        so.status = SalesOrderStatus.converted
        await fulfil_reservations(db, source_type="sales_order", source_ref=so.id)
    else:
        _recalc_so_header(so, remaining_lines, tax_mode)
        so.status = SalesOrderStatus.partially_invoiced
        await refresh_so_reservations(
            db, order_id=so.id, branch_id=so.branch_id, lines=remaining_lines,
        )

    so.converted_invoice_id = inv.id
    # Log the sales-order converted event when an invoice spawns from an SO.
    _log_sales_order_history(db, user=user,
        order_id=so.id,
        order_number=so.number,
        event_type="converted",
        action="convert_sales_order",
        detail=f"Converted sales order {so.number} to invoice {inv.number}",
        metadata={
            "target_record_type": "sales_invoice",
            "target_record_id": inv.id,
            "target_record_number": inv.number,
            "fully_converted": fully_converted,
        },
    )
    if so.customer_id:
        await sync_customer_outstanding(db, so.customer_id)


# ─── Sales Order: LIST ───────────────────────────────────────────────────────
@router.get("/orders/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_orders(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    search: Optional[str] = None,
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = []
    if search:
        conds.append(or_(SalesOrder.number.ilike(f"%{search}%"), SalesOrder.customer_name.ilike(f"%{search}%")))
    if status:
        conds.append(SalesOrder.status == status)
    if customer_id:
        conds.append(SalesOrder.customer_id == customer_id)
    if date_from:
        conds.append(SalesOrder.date >= date_from)
    if date_to:
        conds.append(SalesOrder.date <= date_to)
    if branch_id is not None:
        conds.append(SalesOrder.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(SalesOrder.branch_id.in_(branch_ids))
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
    q = select(SalesOrder).options(selectinload(SalesOrder.line_items))
    q_count = select(func.count(SalesOrder.id))
    if conds:
        q = q.where(and_(*conds))
        q_count = q_count.where(and_(*conds))
    total = int((await db.execute(q_count)).scalar() or 0)
    rows = (await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))).unique().scalars().all()
    out = [_so_dict(so, so.line_items) for so in rows]
    return paged(out, total, sk, lim)


# ─── Sales Order: GET ONE ────────────────────────────────────────────────────
@router.get("/orders/{order_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_order(order_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):

    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    await _resolve_branch_scope(user, db, so.branch_id)
    return _so_dict(so, so.line_items)


# ─── Sales Order: CREATE ─────────────────────────────────────────────────────
@router.post("/orders/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_order(data: SalesOrderCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    if not data.items:
        raise HTTPException(400, "Sales order must have at least one line item")

    direct = await can_direct_commit(user, db, "invoices.approve")
    tax_mode = await _get_org_tax_mode(db)
    line_rows, subtotal, tax_total = _calc_lines(data.items, tax_mode, data.discount or 0)
    total = round(subtotal + tax_total, 2)
    today = datetime.now().strftime("%Y-%m-%d")

    async def _alloc_so() -> str:
        count = (await db.execute(select(func.count(SalesOrder.id)))).scalar() or 0
        return f"SO-{datetime.now().year}-{1000 + count}"

    # Ensure user may create orders in the requested branch
    await _resolve_branch_scope(user, db, data.branch_id)

    so_num = await resolve_number(
        db,
        requested=data.number,
        model=SalesOrder,
        allocate=_alloc_so,
    )

    so_status = SalesOrderStatus.confirmed if direct else SalesOrderStatus.draft
    so = SalesOrder(
        id=str(uuid.uuid4()), number=so_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        created_by=data.created_by or (user.name if user else None),
        date=data.date or today,
        expected_date=data.expected_date,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount or 0, 2),
        total=total,
        status=so_status,
        notes=data.notes,
    )
    db.add(so)
    created_lines = []
    for line, line_net, _line_tax in line_rows:
        li = SalesOrderLineItem(
            id=str(uuid.uuid4()), order_id=so.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate, discount=line.discount or 0,
            line_total=line_net,
        )
        db.add(li)
        created_lines.append(li)
    # Stock reservation only for confirmed SOs; draft SOs reserve on approval.
    if direct and not await get_allow_overselling(db):
        try:
            await reserve_for_sales_order(
                db, order_id=so.id, branch_id=so.branch_id, lines=created_lines,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
    if direct and data.quotation_id:
        await _link_quotation_to_order(db, data.quotation_id, so, user=user)
    _log_sales_order_history(db, user=user,
        order_id=so.id,
        order_number=so.number,
        event_type="created",
        action="create_sales_order",
        detail=f"Created sales order {so.number}",
        metadata={
            "status": so.status.value if hasattr(so.status, "value") else str(so.status),
            "total": float(so.total or 0),
            "line_count": len(data.items or []),
        },
    )
    if direct:
        _log_sales_order_history(db, user=user,
            order_id=so.id,
            order_number=so.number,
            event_type="confirmed",
            action="confirm_sales_order",
            detail=f"Sales order {so.number} confirmed",
            metadata={"from": "draft", "to": "confirmed"},
        )
    # NB: no stock side-effect at create. Stock moves only when the SO is
    # converted to an invoice (same code path as POS sales).
    # Draft stays private — notification fires on submit.
    await db.commit()
    return {"id": so.id, "number": so.number, "total": total, "status": so.status.value}


# ─── Sales Order: UPDATE (full replace of editable fields + items) ──────────
@router.put("/orders/{order_id}", dependencies=[Depends(require_perm("invoices.edit", "invoices.create"))])
async def update_order(order_id: str, data: SalesOrderCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Full replace of an SO's editable fields. Status is NOT changed here
    (the convert flow + the dedicated `/status` PATCH handle that). Items
    are replaced wholesale — simpler than diffing and the SO has no stock
    side-effects until convert, so there's nothing in flight to reconcile.

    Editable iff status ∈ {draft, confirmed}. Converted / cancelled orders
    are locked — pretending to allow edits would orphan accounting state
    (the spawned invoice would no longer match the SO it came from).
    Create-only users may edit private drafts before submit.
    """
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    await _resolve_branch_scope(user, db, so.branch_id)
    if so.status in (
        SalesOrderStatus.converted,
        SalesOrderStatus.cancelled,
        SalesOrderStatus.partially_invoiced,
        SalesOrderStatus.pending_approval,
    ):
        raise HTTPException(400, f"Cannot edit a {so.status.value} sales order")
    await assert_may_edit_document(
        user, db, status=so.status,
        create_perm="invoices.create", edit_perm="invoices.edit",
    )
    if not data.items:
        raise HTTPException(400, "Sales order must have at least one line item")

    item_changes = _summarize_sales_order_item_changes(list(so.line_items or []), data.items)

    # Replace fields (status preserved). Recompute totals from new items.
    tax_mode = await _get_org_tax_mode(db)
    line_rows, subtotal, tax_total = _calc_lines(data.items, tax_mode, data.discount or 0)
    total = round(subtotal + tax_total, 2)

    # If branch is being changed, validate the target branch
    if data.branch_id and data.branch_id != so.branch_id:
        await _resolve_branch_scope(user, db, data.branch_id)

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
    created_lines = []
    for line, line_net, _line_tax in line_rows:
        li = SalesOrderLineItem(
            id=str(uuid.uuid4()), order_id=so.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate, discount=line.discount or 0,
            line_total=line_net,
        )
        db.add(li)
        created_lines.append(li)
    await release_reservations(db, source_type="sales_order", source_ref=so.id)
    if so.status == SalesOrderStatus.confirmed and not await get_allow_overselling(db):
        try:
            await reserve_for_sales_order(
                db, order_id=so.id, branch_id=so.branch_id, lines=created_lines,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))

    preview = item_changes[0]["detail"] if item_changes else f"Updated line items for {so.number}"
    if len(item_changes) > 1:
        preview = f"{preview}; +{len(item_changes) - 1} more item change(s)"
    _log_sales_order_history(db, user=user,
        order_id=so.id,
        order_number=so.number,
        event_type="item_changed",
        action="update_sales_order_items",
        detail=preview,
        metadata={"changes": item_changes[:20], "line_count": len(data.items or [])},
    )

    await db.commit()
    return {"id": so.id, "number": so.number, "total": total, "status": so.status.value}


# ─── Sales Order: UPDATE STATUS ──────────────────────────────────────────────
@router.patch("/orders/{order_id}/status", dependencies=[Depends(require_perm("invoices.edit"))])
async def update_order_status(order_id: str, status: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    await _resolve_branch_scope(user, db, so.branch_id)
    try:
        target = SalesOrderStatus(status)
    except ValueError:
        raise HTTPException(400, f"Invalid status: {status}")
    # Once an SO is converted, the only legal next status is "cancelled" —
    # and only when there's no spawned invoice in a paid state (otherwise
    # cancelling the SO would orphan accounting state).
    if so.status == SalesOrderStatus.converted:
        raise HTTPException(400, "Cannot change status of a converted sales order (cancel the invoice first)")
    if so.status == SalesOrderStatus.partially_invoiced and target != SalesOrderStatus.cancelled:
        raise HTTPException(
            400,
            "Partially invoiced orders can only be cancelled — finish converting or cancel the order",
        )
    prev = so.status
    prev_status = prev.value if hasattr(prev, "value") else str(prev)
    if target == SalesOrderStatus.cancelled:
        await release_reservations(db, source_type="sales_order", source_ref=so.id)
    elif target == SalesOrderStatus.confirmed and prev == SalesOrderStatus.draft:
        if not await get_allow_overselling(db):
            try:
                await reserve_for_sales_order(
                    db, order_id=so.id, branch_id=so.branch_id, lines=so.line_items,
                )
            except ValueError as e:
                raise HTTPException(400, str(e))
    so.status = target
    next_status = target.value if hasattr(target, "value") else str(target)
    if target == SalesOrderStatus.confirmed and prev_status != next_status:
        _log_sales_order_history(db, user=user,
            order_id=so.id,
            order_number=so.number,
            event_type="confirmed",
            action="confirm_sales_order",
            detail=f"Sales order {so.number} confirmed",
            metadata={"from": prev_status, "to": next_status},
        )
    elif target == SalesOrderStatus.cancelled and prev_status != next_status:
        _log_sales_order_history(db, user=user,
            order_id=so.id,
            order_number=so.number,
            event_type="cancelled",
            action="cancel_sales_order",
            detail=f"Sales order {so.number} cancelled",
            metadata={"from": prev_status, "to": next_status},
            risk="medium",
        )
    await db.commit()
    return {"status": so.status.value}


# ─── Sales Order: APPROVAL ────────────────────────────────────────────────────
class SOApproveReject(BaseModel):
    notes: Optional[str] = None


@router.post("/orders/{order_id}/submit", dependencies=[Depends(require_perm("invoices.create"))])
async def submit_sales_order(
    order_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Creator submits a private draft SO for approval."""
    res = await db.execute(select(SalesOrder).where(SalesOrder.id == order_id))
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    await _resolve_branch_scope(user, db, so.branch_id)
    so_status = so.status.value if hasattr(so.status, "value") else str(so.status)
    if so_status == SalesOrderStatus.pending_approval.value:
        return {"status": "pending_approval", "number": so.number, "already_processed": True}
    if so_status != SalesOrderStatus.draft.value:
        raise HTTPException(400, f"Only draft sales orders can be submitted (status={so_status})")
    if so.created_by and so.created_by != user.name and not await can_direct_commit(user, db, "invoices.approve"):
        raise HTTPException(403, "Only the creator can submit this draft for approval")
    so.status = SalesOrderStatus.pending_approval
    from src.notifications.store import emit_sales_order_pending, notify_refresh
    await emit_sales_order_pending(db, so)
    _log_sales_order_history(db, user=user,
        order_id=so.id, order_number=so.number,
        event_type="submitted", action="submit_sales_order",
        detail=f"Sales order {so.number} submitted for approval",
        metadata={"from": "draft", "to": "pending_approval"},
    )
    await db.commit()
    await notify_refresh()
    return {"status": "pending_approval", "number": so.number}


@router.post("/orders/{order_id}/approve", dependencies=[Depends(require_perm("invoices.approve"))])
async def approve_sales_order(
    order_id: str,
    body: SOApproveReject,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Approve a submitted sales order — moves it to confirmed, creates stock reservation."""
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.unique().scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    await _resolve_branch_scope(user, db, so.branch_id)
    so_status = so.status.value if hasattr(so.status, "value") else str(so.status)
    if so_status == SalesOrderStatus.confirmed.value:
        return {"status": "confirmed", "number": so.number, "already_processed": True}
    if so_status not in (SalesOrderStatus.pending_approval.value, SalesOrderStatus.draft.value):
        raise HTTPException(400, f"Only pending-approval sales orders can be approved (status={so_status})")
    if so.created_by and so.created_by == user.name:
        raise HTTPException(403, "You cannot approve your own sales order")
    # Create stock reservation for confirmed SO
    if not await get_allow_overselling(db):
        try:
            await reserve_for_sales_order(db, order_id=so.id, branch_id=so.branch_id, lines=so.line_items)
        except ValueError as e:
            raise HTTPException(400, str(e))
    so.status = SalesOrderStatus.confirmed
    if body.notes:
        so.notes = (so.notes or "") + f"\n[Approved by {user.name}] {body.notes}"
    from src.notifications.store import notify_refresh, resolve_notification
    await resolve_notification(db, f"approval.sales_order_pending:{so.id}")
    _log_sales_order_history(db, user=user,
        order_id=so.id, order_number=so.number,
        event_type="confirmed", action="approve_sales_order",
        detail=f"Sales order {so.number} approved by {user.name}",
        metadata={"from": so_status, "to": "confirmed", "approved_by": user.name},
    )
    await db.commit()
    await notify_refresh()
    return {"status": "confirmed", "number": so.number}


@router.post("/orders/{order_id}/reject", dependencies=[Depends(require_perm("invoices.approve"))])
async def reject_sales_order(
    order_id: str,
    body: SOApproveReject,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Reject a submitted sales order — marks it cancelled."""
    res = await db.execute(select(SalesOrder).where(SalesOrder.id == order_id))
    so = res.scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    await _resolve_branch_scope(user, db, so.branch_id)
    so_status = so.status.value if hasattr(so.status, "value") else str(so.status)
    if so_status == SalesOrderStatus.cancelled.value:
        return {"status": "cancelled", "number": so.number, "already_processed": True}
    if so_status not in (SalesOrderStatus.pending_approval.value, SalesOrderStatus.draft.value):
        raise HTTPException(400, f"Only pending-approval sales orders can be rejected (status={so_status})")
    so.status = SalesOrderStatus.cancelled
    if body.notes:
        so.notes = (so.notes or "") + f"\n[Rejected by {user.name}] {body.notes}"
    from src.notifications.store import notify_refresh, resolve_notification
    await resolve_notification(db, f"approval.sales_order_pending:{so.id}")
    _log_sales_order_history(db, user=user,
        order_id=so.id, order_number=so.number,
        event_type="cancelled", action="reject_sales_order",
        detail=f"Sales order {so.number} rejected by {user.name}",
        metadata={"reason": body.notes or "", "rejected_by": user.name},
    )
    await db.commit()
    await notify_refresh()
    return {"status": "cancelled", "number": so.number}


# ─── Sales Order: CONVERT TO INVOICE ─────────────────────────────────────────
@router.post("/orders/{order_id}/convert", dependencies=[Depends(require_perm("invoices.create"))])
async def convert_order_to_invoice(
    order_id: str,
    data: ConvertToInvoiceIn,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    """Spawn a SaleInvoice from an SO (full or partial).

    Phase 2 partial convert: pass `lines: [{order_line_id, qty}, …]` to
    invoice a subset. The SO stays open at `partially_invoiced` until every
    line is fully invoiced, then flips to `converted`.

    Payment status comes from `ConvertToInvoiceIn`:
      • payment_received=False → pending invoice
      • payment_received=True + payment_mode set → paid invoice
    """
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id == order_id)
    )
    so = res.unique().scalar_one_or_none()
    if not so:
        raise HTTPException(404, "Sales order not found")
    if so.status == SalesOrderStatus.converted:
        raise HTTPException(400, "Sales order already converted")
    if so.status == SalesOrderStatus.cancelled:
        raise HTTPException(400, "Cannot convert a cancelled sales order")
    so_status = so.status.value if hasattr(so.status, "value") else str(so.status)
    if so_status in (SalesOrderStatus.draft.value, SalesOrderStatus.pending_approval.value):
        raise HTTPException(400, "Sales order must be approved before converting to an invoice")
    if not so.line_items:
        raise HTTPException(400, "Sales order has no line items")

    await _resolve_branch_scope(user, db, so.branch_id)
    # Convert posts stock + AR immediately — create-only users create a draft invoice instead.
    if not await can_direct_commit(user, db, "invoices.approve"):
        raise HTTPException(
            403,
            "Converting a sales order requires invoices.approve (stock and AR post immediately). "
            "Create a draft invoice from the order, then submit it for approval.",
        )

    if data.payment_received and not (data.payment_mode or "").strip():
        raise HTTPException(400, "Pick a payment method (or uncheck Payment Received)")

    line_by_id = {li.id: li for li in so.line_items}
    convert_plan: list[tuple] = []
    if data.lines:
        for entry in data.lines:
            so_line = line_by_id.get(entry.order_line_id)
            if not so_line:
                raise HTTPException(400, f"Order line {entry.order_line_id} not found on this SO")
            if entry.qty > int(so_line.qty):
                raise HTTPException(
                    400,
                    f"Cannot invoice {entry.qty} of {so_line.name} — only {so_line.qty} remaining on the order",
                )
            convert_plan.append((so_line, int(entry.qty)))
    else:
        convert_plan = [(li, int(li.qty)) for li in so.line_items if int(li.qty) > 0]

    convert_plan = [(ln, q) for ln, q in convert_plan if q > 0]
    if not convert_plan:
        raise HTTPException(400, "Select at least one line with quantity > 0")

    allow_oversell = await get_allow_overselling(db)
    tax_mode = await _get_org_tax_mode(db)
    orig_inclusive = 0.0
    for li in so.line_items:
        orig_inclusive += _inclusive_after_line_discount(
            int(li.qty), float(li.price or 0), float(li.discount or 0),
        )
    convert_inclusives = []
    convert_rates = []
    for so_line, convert_qty in convert_plan:
        convert_inclusives.append(_inclusive_after_line_discount(
            convert_qty, float(so_line.price or 0), float(so_line.discount or 0),
        ))
        convert_rates.append(float(so_line.tax_rate or 0))
    inv_inclusive = round(sum(convert_inclusives), 2)
    inv_discount = 0.0
    if orig_inclusive > 0 and float(so.discount or 0) > 0:
        inv_discount = round(float(so.discount) * (inv_inclusive / orig_inclusive), 2)
    convert_taxed, inv_subtotal, inv_tax_total, inv_total = rollup_inclusive_lines(
        convert_inclusives, convert_rates, inv_discount,
    )

    today = datetime.now().strftime("%Y-%m-%d")
    inv_num = await allocate_number(db, "sales_invoice", branch_id=so.branch_id)

    paid = inv_total if data.payment_received else 0.0
    status = "paid" if paid >= inv_total and inv_total > 0 else "pending"
    payment_mode = data.payment_mode if data.payment_received else None

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=so.customer_id,
        customer_name=so.customer_name,
        branch_id=so.branch_id,
        branch_name=so.branch_name,
        cashier=(user.name if user is not None else so.created_by) or "Staff",
        date=today,
        subtotal=inv_subtotal,
        tax_total=inv_tax_total,
        discount=inv_discount,
        total=inv_total,
        paid_amount=round(paid, 2),
        payment_mode=payment_mode,
        status=status,
        origin="sales_order",
        notes=data.notes or so.notes,
    )
    db.add(inv)

    item_ids = {so_line.item_id for so_line, _ in convert_plan if so_line.item_id}
    item_map = await _load_items_by_id(db, item_ids)
    alloc_by_item: dict = {}
    if data.line_allocations:
        for a in data.line_allocations:
            alloc_by_item[a.item_id] = [e.model_dump() for e in a.batch_allocation]

    for (so_line, convert_qty), (after, _taxable, _tax) in zip(convert_plan, convert_taxed):
        item_obj = item_map.get(so_line.item_id) if so_line.item_id else None
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=so_line.item_id, name=so_line.name,
            qty=convert_qty, price=so_line.price,
            tax_rate=so_line.tax_rate,
            discount=so_line.discount or 0,
            line_total=after,
            **_snapshot_item_metadata(item_obj),
        )
        db.add(li)
        if so_line.item_id:
            if not allow_oversell:
                avail = await get_available_qty(
                    db, item_id=so_line.item_id, branch_id=so.branch_id,
                    exclude_source_ref=so.id,
                )
                if convert_qty > avail:
                    raise HTTPException(
                        400,
                        f"Insufficient stock for {so_line.name}: need {convert_qty}, available {avail}",
                    )
            tracked, expiry_tracked = await is_tracked(db, so_line.item_id)
            if tracked:
                strategy = "fefo" if expiry_tracked else "fifo"
                explicit = alloc_by_item.get(so_line.item_id)
                consumed_ok = False
                consumed_ledger = None
                try:
                    consumed_ledger = await consume_batches_atomic(
                        db, item_id=so_line.item_id, branch_id=so.branch_id,
                        qty=convert_qty, strategy=strategy,
                        explicit_allocation=explicit,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                    )
                    consumed_ok = True
                except ValueError:
                    if explicit:
                        try:
                            consumed_ledger = await consume_batches_atomic(
                                db, item_id=so_line.item_id, branch_id=so.branch_id,
                                qty=convert_qty, strategy=strategy,
                                explicit_allocation=None,
                                movement_type="sale",
                                source_type="sale_invoice",
                                source_ref=inv.id,
                            )
                            consumed_ok = True
                        except ValueError:
                            pass
                if consumed_ledger:
                    li.batch_allocation = json.dumps([
                        {
                            "batch_id": e["batch_id"],
                            "batch_number": e.get("batch_number"),
                            "consumed": e["consumed"],
                            "expiry_date": e.get("expiry_date"),
                        }
                        for e in consumed_ledger
                    ])
                if not consumed_ok:
                    if not allow_oversell:
                        raise HTTPException(
                            400,
                            f"Insufficient batch stock for {so_line.name}",
                        )
                    await db.execute(
                        text(
                            "UPDATE item_batches SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": so_line.item_id, "b": so.branch_id},
                    )
                    await clamp_stock_to_zero_with_ledger(
                        db,
                        item_id=so_line.item_id,
                        branch_id=so.branch_id,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                        notes=f"Oversell clamp on SO convert {inv.number}",
                    )
            else:
                try:
                    await adjust_stock_atomic(
                        db, item_id=so_line.item_id, branch_id=so.branch_id,
                        delta=-convert_qty,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                    )
                except ValueError:
                    if not allow_oversell:
                        raise HTTPException(
                            400,
                            f"Insufficient stock for {so_line.name}",
                        )
                    await clamp_stock_to_zero_with_ledger(
                        db,
                        item_id=so_line.item_id,
                        branch_id=so.branch_id,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                        notes=f"Oversell clamp on SO convert {inv.number}",
                    )

        remaining_qty = int(so_line.qty) - convert_qty
        if remaining_qty <= 0:
            await db.delete(so_line)
        else:
            so_line.qty = remaining_qty
            _, _, so_line.line_total = _line_amounts(
                remaining_qty,
                float(so_line.price or 0),
                float(so_line.discount or 0),
                float(so_line.tax_rate or 0),
                tax_mode,
            )

    if inv_discount > 0:
        so.discount = round(max(0.0, float(so.discount or 0) - inv_discount), 2)

    await db.flush()
    remaining_res = await db.execute(
        select(SalesOrderLineItem).where(
            SalesOrderLineItem.order_id == so.id,
            SalesOrderLineItem.qty > 0,
        )
    )
    remaining_lines = remaining_res.scalars().all()
    fully_converted = len(remaining_lines) == 0

    if fully_converted:
        so.subtotal = 0.0
        so.tax_total = 0.0
        so.total = 0.0
        so.discount = 0.0
        so.status = SalesOrderStatus.converted
        await fulfil_reservations(db, source_type="sales_order", source_ref=so.id)
    else:
        _recalc_so_header(so, remaining_lines, tax_mode)
        so.status = SalesOrderStatus.partially_invoiced
        await refresh_so_reservations(
            db, order_id=so.id, branch_id=so.branch_id, lines=remaining_lines,
        )

    so.converted_invoice_id = inv.id
    _log_sales_order_history(db, user=user,
        order_id=so.id,
        order_number=so.number,
        event_type="converted",
        action="convert_sales_order",
        detail=f"Converted sales order {so.number} to invoice {inv.number}",
        metadata={
            "target_record_type": "sales_invoice",
            "target_record_id": inv.id,
            "target_record_number": inv.number,
            "fully_converted": fully_converted,
        },
    )

    if data.payment_received and paid > 0:
        pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
        conv_pay = CustomerPayment(
            id=str(uuid.uuid4()),
            number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
            customer_id=inv.customer_id,
            customer_name=inv.customer_name or "Walk-in",
            branch_id=inv.branch_id,
            branch_name=inv.branch_name,
            date=today,
            total_amount=round(paid, 2),
            payment_mode=payment_mode,
            payment_ref="",
            notes="Invoice paid at SO conversion",
            credit_applied=0.0,
            created_by="Staff",
        )
        db.add(conv_pay)
        db.add(CustomerPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=conv_pay.id,
            invoice_id=inv.id,
            invoice_number=inv.number,
            amount=round(paid, 2),
        ))
        await record_customer_payment(db, conv_pay)

    if so.customer_id:
        await sync_customer_outstanding(db, so.customer_id)
    await db.commit()
    return {
        "invoice_id": inv.id,
        "invoice_number": inv.number,
        "status": status,
        "total": inv.total,
        "order_status": so.status.value if hasattr(so.status, "value") else str(so.status),
        "order_remaining_total": round(float(so.total or 0), 2),
        "fully_converted": fully_converted,
    }


# ─── Quotation → Sales Order convert ─────────────────────────────────────────
@router.post("/quotations/{quote_id}/convert-to-order", dependencies=[Depends(require_perm("invoices.create"))])
async def convert_quote_to_order(quote_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
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

    # Flush inserts for SO + lines so quotation FK back-pointer passes immediately.
    await db.flush()
    quote.status = QuotationStatus.converted
    quote.converted_order_id = so.id
    _log_quotation_history(db, user=user,
        quote_id=quote.id,
        quote_number=quote.number,
        event_type="converted",
        action="convert_quotation",
        detail=f"Converted quotation {quote.number} to sales order {so.number}",
        metadata={
            "target_record_type": "sales_order",
            "target_record_id": so.id,
            "target_record_number": so.number,
        },
    )
    await db.commit()
    return {
        "order_id": so.id,
        "order_number": so.number,
        "total": so.total,
    }


@router.post("/quotations/{quote_id}/convert-to-invoice", dependencies=[Depends(require_perm("invoices.create"))])
async def convert_quote_to_invoice(
    quote_id: str,
    data: ConvertToInvoiceIn,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    """Spawn a SaleInvoice directly from a Quotation (skip SO). Mirrors
    convert_order_to_invoice stock + payment semantics."""
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
    if quote.converted_order_id:
        live_so = (await db.execute(
            select(SalesOrder.id).where(SalesOrder.id == quote.converted_order_id)
        )).scalar_one_or_none()
        if live_so:
            raise HTTPException(
                400,
                "Quotation has a live sales order — delete the SO first or convert it to invoice",
            )
    if quote.converted_invoice_id:
        live_inv = (await db.execute(
            select(SaleInvoice.id).where(SaleInvoice.id == quote.converted_invoice_id)
        )).scalar_one_or_none()
        if live_inv:
            raise HTTPException(400, "Quotation already spawned an invoice")

    if data.payment_received and not (data.payment_mode or "").strip():
        raise HTTPException(400, "Pick a payment method (or uncheck Payment Received)")

    today = datetime.now().strftime("%Y-%m-%d")
    inv_num = await allocate_number(db, "sales_invoice", branch_id=quote.branch_id)
    paid = quote.total if data.payment_received else 0.0
    status = "paid" if paid >= quote.total else "pending"
    payment_mode = data.payment_mode if data.payment_received else None
    due_date = None
    if status in ("pending", "partial"):
        due_date = compute_due_date(today, None)

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=quote.customer_id,
        customer_name=quote.customer_name,
        branch_id=quote.branch_id,
        branch_name=quote.branch_name,
        cashier=(user.name if user is not None else quote.created_by) or "Staff",
        date=today,
        subtotal=quote.subtotal,
        tax_total=quote.tax_total,
        discount=quote.discount,
        total=quote.total,
        paid_amount=round(paid, 2),
        payment_mode=payment_mode,
        status=status,
        due_date=due_date,
        origin="quotation",
        notes=data.notes or quote.notes,
    )
    db.add(inv)

    item_ids = {line.item_id for line in quote.line_items if line.item_id}
    item_map = await _load_items_by_id(db, item_ids)
    alloc_by_item = {}
    if data.line_allocations:
        for a in data.line_allocations:
            alloc_by_item[a.item_id] = [e.model_dump() for e in a.batch_allocation]

    for line in quote.line_items:
        item_obj = item_map.get(line.item_id) if line.item_id else None
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=line.item_id, name=line.name,
            qty=line.qty, price=line.price,
            tax_rate=line.tax_rate,
            discount=line.discount or 0,
            line_total=line.line_total,
            **_snapshot_item_metadata(item_obj),
        )
        db.add(li)
        if line.item_id:
            tracked, expiry_tracked = await is_tracked(db, line.item_id)
            if tracked:
                strategy = "fefo" if expiry_tracked else "fifo"
                explicit = alloc_by_item.get(line.item_id)
                consumed_ok = False
                consumed_ledger = None
                try:
                    consumed_ledger = await consume_batches_atomic(
                        db, item_id=line.item_id, branch_id=quote.branch_id,
                        qty=line.qty, strategy=strategy,
                        explicit_allocation=explicit,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                    )
                    consumed_ok = True
                except ValueError:
                    if explicit:
                        try:
                            consumed_ledger = await consume_batches_atomic(
                                db, item_id=line.item_id, branch_id=quote.branch_id,
                                qty=line.qty, strategy=strategy,
                                explicit_allocation=None,
                                movement_type="sale",
                                source_type="sale_invoice",
                                source_ref=inv.id,
                            )
                            consumed_ok = True
                        except ValueError:
                            pass
                if consumed_ledger:
                    li.batch_allocation = json.dumps([
                        {
                            "batch_id": e["batch_id"],
                            "batch_number": e.get("batch_number"),
                            "consumed": e["consumed"],
                            "expiry_date": e.get("expiry_date"),
                        }
                        for e in consumed_ledger
                    ])
                if not consumed_ok:
                    await db.execute(
                        text("UPDATE item_batches SET quantity = 0 WHERE item_id = :i AND branch_id = :b"),
                        {"i": line.item_id, "b": quote.branch_id},
                    )
                    await clamp_stock_to_zero_with_ledger(
                        db,
                        item_id=line.item_id,
                        branch_id=quote.branch_id,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                        notes=f"Oversell clamp on quote convert {inv.number}",
                    )
            else:
                try:
                    await adjust_stock_atomic(
                        db, item_id=line.item_id, branch_id=quote.branch_id, delta=-line.qty,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                    )
                except ValueError:
                    await clamp_stock_to_zero_with_ledger(
                        db,
                        item_id=line.item_id,
                        branch_id=quote.branch_id,
                        movement_type="sale",
                        source_type="sale_invoice",
                        source_ref=inv.id,
                        notes=f"Oversell clamp on quote convert {inv.number}",
                    )

    if data.payment_received and paid > 0:
        pay_count = (await db.execute(select(func.count(CustomerPayment.id)))).scalar() or 0
        conv_pay = CustomerPayment(
            id=str(uuid.uuid4()),
            number=f"PAY-{datetime.now().year}-{1000 + pay_count:04d}",
            customer_id=inv.customer_id,
            customer_name=inv.customer_name or "Walk-in",
            branch_id=inv.branch_id,
            branch_name=inv.branch_name,
            date=today,
            total_amount=round(paid, 2),
            payment_mode=payment_mode,
            payment_ref="",
            notes=f"Invoice paid at quote {quote.number} conversion",
            credit_applied=0.0,
            created_by="Staff",
        )
        db.add(conv_pay)
        db.add(CustomerPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=conv_pay.id,
            invoice_id=inv.id,
            invoice_number=inv.number,
            amount=round(paid, 2),
        ))
        await record_customer_payment(db, conv_pay)

    # Flush invoice/lines/payment inserts before quotation FK back-pointer update.
    await db.flush()
    quote.status = QuotationStatus.converted
    quote.converted_invoice_id = inv.id
    _log_quotation_history(db, user=user,
        quote_id=quote.id,
        quote_number=quote.number,
        event_type="converted",
        action="convert_quotation",
        detail=f"Converted quotation {quote.number} to invoice {inv.number}",
        metadata={
            "target_record_type": "sales_invoice",
            "target_record_id": inv.id,
            "target_record_number": inv.number,
        },
    )
    if quote.customer_id:
        await sync_customer_outstanding(db, quote.customer_id)
    await db.commit()
    return {
        "invoice_id": inv.id,
        "invoice_number": inv.number,
        "status": status,
        "total": inv.total,
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


async def _restored_per_batch_for_invoice_line(
    db: AsyncSession, invoice_line_id: str
) -> dict[str, int]:
    """Sum of qty already restored per source batch across processed returns
    for a given invoice line. Drives the per-batch cap so cumulative restores
    to any one lot can't exceed what the invoice took from it. Reads the
    `batch_allocation` ledger stored on each SalesReturnLineItem."""
    rows = (await db.execute(
        select(SalesReturnLineItem.batch_allocation)
        .join(SalesReturn, SalesReturn.id == SalesReturnLineItem.return_id)
        .where(
            SalesReturnLineItem.invoice_line_id == invoice_line_id,
            SalesReturn.status == SalesReturnStatus.processed,
            SalesReturnLineItem.batch_allocation.is_not(None),
        )
    )).scalars().all()
    out: dict[str, int] = {}
    for raw in rows:
        try:
            for e in json.loads(raw):
                bid = e.get("batch_id")
                if bid:
                    out[bid] = out.get(bid, 0) + int(e.get("restored") or 0)
        except (ValueError, TypeError):
            continue
    return out


# ─── Sales Returns: LIST ─────────────────────────────────────────────────────
# 2026-05-24: trailing slash on /returns/ is LOAD-BEARING. Without it,
# the path `/returns` would be checked against the `/{invoice_id}` route
# (registered earlier in this file at line ~523) and matched there,
# routing to `get_invoice(invoice_id="returns")` → 404 "Invoice not
# found". The frontend's `salesAPI.returns.list` calls `/sales/returns/`
# with a trailing slash; matching that to `/returns/` here skips the
# /{invoice_id} fallback entirely. /orders/ already follows this pattern.
@router.get("/returns/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_returns(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    search: Optional[str] = None,
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    branch_id: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    """List sales returns."""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = []
    if search:
        conds.append(or_(SalesReturn.number.ilike(f"%{search}%"), SalesReturn.customer_name.ilike(f"%{search}%")))
    if status:
        conds.append(SalesReturn.status == status)
    if customer_id:
        conds.append(SalesReturn.customer_id == customer_id)
    if date_from:
        conds.append(SalesReturn.date >= date_from)
    if date_to:
        conds.append(SalesReturn.date <= date_to)
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
    q = select(SalesReturn).options(selectinload(SalesReturn.line_items))
    q_count = select(func.count(SalesReturn.id))
    if branch_id is not None:
        conds.append(SalesReturn.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(SalesReturn.branch_id.in_(branch_ids))
    if conds:
        q = q.where(and_(*conds))
        q_count = q_count.where(and_(*conds))
    total = int((await db.execute(q_count)).scalar() or 0)
    rows = (await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))).unique().scalars().all()
    out = [_return_dict(ret, ret.line_items) for ret in rows]
    return paged(out, total, sk, lim)


# ─── Sales Returns: GET ONE ──────────────────────────────────────────────────
@router.get("/returns/{return_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(SalesReturn)
        .options(selectinload(SalesReturn.line_items))
        .where(SalesReturn.id == return_id)
    )
    ret = res.scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    await _resolve_branch_scope(user, db, ret.branch_id)
    return _return_dict(ret, ret.line_items)


@router.post("/returns/{return_id}/void", dependencies=[Depends(require_perm("invoices.edit"))])
async def void_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Soft-void a credit note — reverses stock + invoice adjustments but keeps the row."""
    res = await db.execute(
        select(SalesReturn)
        .options(selectinload(SalesReturn.line_items))
        .where(SalesReturn.id == return_id)
    )
    ret = res.unique().scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    if ret.status == SalesReturnStatus.void:
        return {"status": "void", "number": ret.number}

    prev_status = ret.status.value if hasattr(ret.status, "value") else str(ret.status)
    credit_revoked = await _reverse_sales_return_effects(db, ret)
    ret.status = SalesReturnStatus.void
    await db.flush()
    await recalc_invoice_after_cn(db, ret.invoice_id)
    customer_ids: set[str] = set()
    if ret.customer_id:
        customer_ids.add(ret.customer_id)
    inv = (await db.execute(
        select(SaleInvoice.customer_id).where(SaleInvoice.id == ret.invoice_id)
    )).scalar_one_or_none()
    if inv:
        customer_ids.add(inv)
    for cid in customer_ids:
        await sync_customer_outstanding(db, cid)

    _log_sales_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="voided",
        action="void_sales_return",
        detail=f"Voided sales return {ret.number}",
        metadata={
            "from": prev_status,
            "to": "void",
            "credit_revoked": round(float(credit_revoked or 0), 2),
            "target_record_type": "sales_invoice",
            "target_record_id": ret.invoice_id,
            "target_record_number": ret.invoice_number,
        },
        risk="medium",
        branch_id=ret.branch_id,
    )

    await db.commit()
    return {
        "status": "void",
        "number": ret.number,
        "credit_revoked": round(credit_revoked, 2),
    }


@router.post("/returns/{return_id}/undo-void", dependencies=[Depends(require_perm("invoices.edit"))])
async def undo_void_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Restore a voided credit note to 'processed' — re-applies stock + invoice adjustments.

    Blocked if another active credit note has already consumed the same line
    quantities or reduced the invoice balance to the point where re-applying
    this one would push it negative (double-entry prevention).
    """
    res = await db.execute(
        select(SalesReturn)
        .options(selectinload(SalesReturn.line_items))
        .where(SalesReturn.id == return_id)
    )
    ret = res.unique().scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    await _resolve_branch_scope(user, db, ret.branch_id)
    if ret.status != SalesReturnStatus.void:
        return {"status": str(ret.status.value if hasattr(ret.status, "value") else ret.status), "number": ret.number}

    # ── Pre-flight: check for conflicts BEFORE mutating anything ──────────────
    inv = (await db.execute(
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.id == ret.invoice_id)
    )).unique().scalar_one_or_none()
    if inv is None:
        raise HTTPException(404, "Original invoice not found")

    # Guard 1: total active credit notes (after undo) must not exceed the invoice total.
    new_credited = round(float(getattr(inv, "credited_amount", 0) or 0) + float(ret.total or 0), 2)
    if new_credited > float(inv.total or 0) + 0.01:
        raise HTTPException(
            400,
            f"Cannot undo void: re-activating {ret.number} (MVR{round(float(ret.total or 0), 2)}) "
            f"would push total credits (MVR{new_credited}) above the invoice total "
            f"(MVR{round(float(inv.total or 0), 2)}). Another active credit note has already "
            f"consumed the same amount. Void that credit note first, then undo this one."
        )

    # Guard 2: per-line quantity check — no item can be returned more times
    # than it was originally sold.
    already_returned = await _already_returned_for_invoice(db, ret.invoice_id)
    inv_lines_by_id = {li.id: li for li in inv.line_items}
    conflicts = []
    for rl in ret.line_items:
        if not rl.invoice_line_id:
            continue
        existing = already_returned.get(rl.invoice_line_id, 0)
        inv_line = inv_lines_by_id.get(rl.invoice_line_id)
        original_qty = int(inv_line.qty or 0) if inv_line else 0
        if existing + int(rl.return_qty or 0) > original_qty:
            conflicts.append(rl.name or rl.invoice_line_id)
    if conflicts:
        items_str = ", ".join(f"'{n}'" for n in conflicts[:3])
        raise HTTPException(
            400,
            f"Cannot undo void: line(s) {items_str} have already been fully returned by "
            f"another active credit note. Void that credit note first, then undo this one."
        )
    # ── End pre-flight ─────────────────────────────────────────────────────────

    # Re-apply stock effects (inverse of void's _reverse_sales_return_effects).
    for rl in ret.line_items:
        if rl.batch_allocation:
            try:
                ledger = json.loads(rl.batch_allocation)
            except (ValueError, TypeError):
                ledger = []
            for entry in ledger:
                bid = entry.get("batch_id")
                qty = int(entry.get("restored") or 0)
                if not bid or qty <= 0:
                    continue
                b = (await db.execute(
                    select(ItemBatch).where(ItemBatch.id == bid)
                )).scalar_one_or_none()
                if b is not None:
                    await set_batch_quantity_atomic(db, batch_id=bid, new_qty=int(b.quantity or 0) + qty)
                elif rl.item_id:
                    try:
                        await adjust_stock_atomic(
                            db, item_id=rl.item_id, branch_id=ret.branch_id, delta=qty,
                            movement_type="return", source_type="sales_return", source_ref=ret.id,
                        )
                    except ValueError:
                        pass
        elif rl.item_id:
            try:
                await adjust_stock_atomic(
                    db, item_id=rl.item_id, branch_id=ret.branch_id,
                    delta=int(rl.return_qty or 0),
                )
            except ValueError:
                pass

    # recalc_invoice_after_cn (called below) will update credited_amount,
    # return_status, and recompute invoice status — no direct mutations needed.
    _recompute_invoice_status(inv)

    # Re-credit the customer for credit-method returns.
    if ret.refund_method == "credit" and ret.customer_id and (ret.credited_amount or 0) > 0:
        cust = (await db.execute(
            select(Customer).where(Customer.id == ret.customer_id)
        )).scalar_one_or_none()
        if cust:
            await adjust_customer_credit(
                db, ret.customer_id, float(ret.credited_amount or 0),
                entry_type="return_undo_void",
                source_type="sales_return", source_ref=ret.id, source_number=ret.number,
            )

    ret.status = SalesReturnStatus.processed
    await db.flush()
    await recalc_invoice_after_cn(db, ret.invoice_id)
    customer_ids: set[str] = set()
    if ret.customer_id:
        customer_ids.add(ret.customer_id)
    inv_cid = (await db.execute(
        select(SaleInvoice.customer_id).where(SaleInvoice.id == ret.invoice_id)
    )).scalar_one_or_none()
    if inv_cid:
        customer_ids.add(inv_cid)
    for cid in customer_ids:
        await sync_customer_outstanding(db, cid)

    _log_sales_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="unvoided",
        action="undo_void_sales_return",
        detail=f"Unvoided sales return {ret.number}",
        metadata={
            "from": "void",
            "to": "processed",
            "target_record_type": "sales_invoice",
            "target_record_id": ret.invoice_id,
            "target_record_number": ret.invoice_number,
        },
        risk="medium",
        branch_id=ret.branch_id,
    )

    await db.commit()
    return {"status": "processed", "number": ret.number}


# ─── GET ONE INVOICE (after /orders/, /returns/, /payments/ static paths) ───
@router.get("/{invoice_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_invoice(invoice_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):

    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    await _resolve_branch_scope(user, db, inv.branch_id)
    li_res = await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id))
    d = _inv_dict(inv, li_res.scalars().all())
    d["payments"] = await _payments_for_invoice(db, inv.id)
    org_row = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    if org_row:
        d.setdefault('organisation', {})
        d['organisation']['id'] = org_row.id
        d['organisation']['name'] = org_row.name
        d['organisation']['gstin'] = org_row.gstin or ''
        d['organisation']['email'] = org_row.email or ''
        d['organisation']['website'] = org_row.website or ''
        d['email'] = org_row.email or ''
        d['gstNo'] = d.get('gstNo') or org_row.gstin or ''
        d['gst_no'] = d['gstNo']
        d['phoneNo'] = d.get('phoneNo') or getattr(org_row, 'phone', '') or ''
        d['phone_no'] = d['phoneNo']
    return d


# ─── Sales Returns: CREATE ───────────────────────────────────────────────────
# 2026-05-24: trailing slash matches the LIST route above for consistency
# (see list_returns for the full rationale). POST routes don't hit the
# same /{invoice_id} confusion as GET (`/{invoice_id}` is GET-only) but
# keeping the slash uniform avoids future drift if anyone adds POST
# `/{invoice_id}/*` routes later.
@router.post("/returns/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_return(data: SalesReturnCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
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
    # Ensure user may operate on the invoice's branch
    await _resolve_branch_scope(user, db, inv.branch_id)
    # InvoiceStatus is a str-enum so direct equality works. Both
    # representations (enum member + raw "cancelled" string set by the
    # legacy cancel_invoice path) compare equal here.
    if inv.status == InvoiceStatus.cancelled or str(inv.status).endswith("cancelled"):
        raise HTTPException(400, "Cannot return against a cancelled invoice")
    prev_invoice_status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)

    # Index invoice lines by id for fast lookup. Also keep a (item_id, name)
    # secondary index for legacy lines where invoice_line_id wasn't carried
    # through the UI.
    inv_lines_by_id = {li.id: li for li in inv.line_items}
    inv_lines_by_item = {
        (li.item_id, li.name): li for li in inv.line_items if li.item_id
    }

    # How much has already been returned per invoice_line_id?
    already_returned = await _already_returned_for_invoice(db, data.invoice_id)

    tax_mode = await _get_org_tax_mode(db)

    # Validate every return line + compute totals.
    return_rows = []  # (return_line_in, matched_inv_line, line_gross, line_tax)
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
        # not current catalog price). Apply the org's tax mode so inclusive
        # prices don't get taxed a second time.
        line_gross = round(r.return_qty * (inv_line.price or 0), 2)
        line_tax = line_tax_amount(line_gross, inv_line.tax_rate or 0, tax_mode)
        line_taxable = line_taxable_amount(line_gross, inv_line.tax_rate or 0, tax_mode)
        return_rows.append((r, inv_line, line_gross, line_tax))
        subtotal += line_taxable
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

    total_return_qty = int(sum(int(getattr(r, "return_qty", 0) or 0) for r in (data.items or [])))

    for r, inv_line, line_net, _line_tax in return_rows:
        # 2026-05-31: batch-aware restock. Restore stock to the SAME lots the
        # invoice line consumed (preserving original expiry), capped per lot
        # by what the invoice took, cumulative across returns. Default split
        # is FEFO (nearest-expiry lot refilled first); operator can override
        # via r.batch_allocation. Stored as a ledger on the return line.
        restore_ledger = None
        if inv_line.item_id:
            tracked, _expiry_tracked = await is_tracked(db, inv_line.item_id)
            if not tracked:
                # Untracked items just bump aggregate stock.
                await adjust_stock_atomic(
                    db, item_id=inv_line.item_id, branch_id=inv.branch_id,
                    delta=r.return_qty,
                    movement_type="return",
                    source_type="sales_return",
                    source_ref=ret.id,
                )
            else:
                src = []
                if getattr(inv_line, "batch_allocation", None):
                    try:
                        src = json.loads(inv_line.batch_allocation)
                    except (ValueError, TypeError):
                        src = []
                if not src:
                    # No source manifest (legacy / oversold sale) — fall back
                    # to a fresh "Returns" lot so the count still moves.
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
                    # Per-lot cap = consumed − already restored (cumulative).
                    prior = await _restored_per_batch_for_invoice_line(db, inv_line.id)
                    caps: dict[str, int] = {}
                    fefo_order: list[tuple[str, str]] = []  # (expiry, batch_id)
                    for e in src:
                        bid = e.get("batch_id")
                        if not bid:
                            continue
                        cap = int(e.get("consumed") or 0) - int(prior.get(bid, 0))
                        if cap <= 0:
                            continue
                        caps[bid] = cap
                        fefo_order.append((e.get("expiry_date") or "9999-12-31", bid))

                    plan: dict[str, int] = {}
                    if r.batch_allocation:
                        # Explicit operator split — validate against caps.
                        total = 0
                        for a in r.batch_allocation:
                            if a.batch_id not in caps:
                                raise HTTPException(
                                    400,
                                    f"{inv_line.name}: batch {a.batch_id} is not a source lot for this line",
                                )
                            if a.qty > caps[a.batch_id]:
                                raise HTTPException(
                                    400,
                                    f"{inv_line.name}: batch {a.batch_id} can take at most {caps[a.batch_id]} more",
                                )
                            plan[a.batch_id] = plan.get(a.batch_id, 0) + a.qty
                            total += a.qty
                        if total != r.return_qty:
                            raise HTTPException(
                                400,
                                f"{inv_line.name}: per-batch split ({total}) must equal return qty ({r.return_qty})",
                            )
                    else:
                        # Default FEFO across source lots, capped per lot.
                        remaining = r.return_qty
                        for _exp, bid in sorted(fefo_order):
                            if remaining <= 0:
                                break
                            take = min(caps[bid], remaining)
                            if take > 0:
                                plan[bid] = take
                                remaining -= take
                        if remaining > 0:
                            raise HTTPException(
                                400,
                                f"{inv_line.name}: only {r.return_qty - remaining} unit(s) can be "
                                f"restored to the invoice's source batches (rest already returned)",
                            )

                    applied = []
                    for bid, qty in plan.items():
                        b = (await db.execute(
                            select(ItemBatch).where(ItemBatch.id == bid)
                        )).scalar_one_or_none()
                        if b is not None:
                            await set_batch_quantity_atomic(
                                db, batch_id=bid, new_qty=int(b.quantity or 0) + qty,
                            )
                        else:
                            # Source lot since deleted — keep the count correct.
                            await adjust_stock_atomic(
                                db, item_id=inv_line.item_id, branch_id=inv.branch_id, delta=qty,
                                movement_type="return",
                                source_type="sales_return",
                                source_ref=ret.id,
                            )
                        applied.append({"batch_id": bid, "restored": qty})
                    restore_ledger = json.dumps(applied)

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
            batch_allocation=restore_ledger,
        ))

    # ── Money movements ──
    if method == "credit" and inv.customer_id and credited > 0:
        cust_res = await db.execute(
            select(Customer).where(Customer.id == inv.customer_id)
        )
        cust = cust_res.scalar_one_or_none()
        if cust is not None:
            cur_credit, new_credit = await adjust_customer_credit(
                db,
                inv.customer_id,
                credited,
                entry_type="return_credit",
                source_type="sales_return",
                source_ref=ret.id,
                source_number=ret.number,
                created_by=data.created_by,
            )
            db.add(AuditLog(
                id=str(uuid.uuid4()),
                action="customer_credit",
                user_id=getattr(user, "id", None),
                user_name=getattr(user, "name", None) if getattr(user, "name", None) is not None else data.created_by,
                module="sales",
                ref=ret.number,
                detail=(
                    f"Return {ret.number} against {inv.number}: "
                    f"+MVR{credited} credited to {cust.name} "
                    f"(was MVR{cur_credit:.2f}, now MVR{new_credit:.2f})"
                ),
                risk="low",
                ip_address=None,
                branch_id=inv.branch_id,
                record_type="sale_return",
                record_id=ret.id,
            ))

    _recompute_invoice_status(inv)

    await recalc_invoice_after_cn(db, inv.id)

    if inv.customer_id:
        await sync_customer_outstanding(db, inv.customer_id)

    _log_sales_invoice_history(db, user=user,
        invoice_id=inv.id,
        invoice_number=inv.number,
        event_type="return_linked",
        action="link_sales_return",
        detail=f"Linked sales return {ret.number} to invoice {inv.number}",
        metadata={
            "target_record_type": "sales_return",
            "target_record_id": ret.id,
            "target_record_number": ret.number,
            "credited_amount": round(float(credited or 0), 2),
        },
        branch_id=inv.branch_id,
    )
    next_invoice_status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
    if prev_invoice_status != next_invoice_status:
        _log_sales_invoice_history(db, user=user,
            invoice_id=inv.id,
            invoice_number=inv.number,
            event_type="status_changed",
            action="update_invoice_status",
            detail=f"Status changed: {prev_invoice_status} -> {next_invoice_status}",
            metadata={"from": prev_invoice_status, "to": next_invoice_status},
            branch_id=inv.branch_id,
        )

    _log_sales_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="created",
        action="create_sales_return",
        detail=f"Created sales return {ret.number}",
        metadata={
            "total": round(float(ret.total or 0), 2),
            "credited_amount": round(float(ret.credited_amount or 0), 2),
            "refund_method": ret.refund_method,
            "target_record_type": "sales_invoice",
            "target_record_id": ret.invoice_id,
            "target_record_number": ret.invoice_number,
        },
        branch_id=ret.branch_id,
    )
    _log_sales_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="reason_set",
        action="set_sales_return_reason",
        detail=f"Set reason for sales return {ret.number}",
        metadata={"reason": ret.reason or ""},
        branch_id=ret.branch_id,
    )
    _log_sales_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="stock_returned",
        action="restock_sales_return_items",
        detail=f"Restocked {total_return_qty} unit(s) for sales return {ret.number}",
        metadata={
            "line_count": len(data.items or []),
            "total_qty": total_return_qty,
            "target_record_type": "sales_invoice",
            "target_record_id": ret.invoice_id,
            "target_record_number": ret.invoice_number,
        },
        branch_id=ret.branch_id,
    )
    if method in ("cash", "credit") and credited > 0:
        _log_sales_return_history(db, user=user,
            return_id=ret.id,
            return_number=ret.number,
            event_type="refund_issued",
            action="issue_sales_return_refund",
            detail=f"Issued {method} refund of {round(float(credited), 2)} for {ret.number}",
            metadata={
                "refund_method": method,
                "credited_amount": round(float(credited), 2),
            },
            branch_id=ret.branch_id,
        )

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


# ═════════════════════════════════════════════════════════════════════════════
# BULK DELETE (2026-05-25)
# ═════════════════════════════════════════════════════════════════════════════
# All-or-nothing semantics: every id must pass its guard, else the whole
# batch is rejected with per-row reasons. Each delete writes an AuditLog
# snapshot of the row before removal — hard delete + audit trail.
#
# Permission: `invoices.delete` for all sales-side entities. Coarse but
# matches existing convention (no `quotes.delete` / `payments.delete`
# in the catalog).
#
# Guards (per user spec):
#   Quotation     → has Sales Order (status='converted')
#   Sales Order   → has Invoice (status='converted')
#   Invoice       → has any SalesReturn OR CustomerPaymentAllocation
#                   referencing it. INCLUDING cancelled/void ones — user
#                   chose strict (cancelled blocks too).
#   SalesReturn   → no guards.
#   CustomerPayment → no guards.
#
# Reversal effects:
#   Invoice delete → restore stock per line (aggregate add-back for
#                    untracked; aggregate for tracked too since we don't
#                    track which specific batch was consumed at sale time).
#   SalesReturn delete → if refund_method='credit', debit customer.credit_balance.
#                        Stock-on-return reversal is N/A (not implemented today).
#   CustomerPayment delete → per allocation: invoice.paid_amount -=
#                            amount, status flipped. Credit-mode payments
#                            refund customer.credit_balance += total. Overpay
#                            credit_applied is revoked.


class BulkDeleteIn(BaseModel):
    """Body for every bulk-delete endpoint. List of ids to remove."""
    ids: List[str] = Field(..., min_length=1)


def _audit_delete(db: AsyncSession, *, action: str, ref: str, snapshot: dict, user: Optional[User] = None):
    """Write a delete audit-log row capturing the row's pre-delete state.

    `snapshot` is JSON-serializable; we json.dumps it inline so the
    AuditLog.detail column stays a single string (per existing schema).
    """
    import json as _json
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        action=action,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="sales",
        ref=ref,
        detail=_json.dumps(snapshot, default=str),
        risk="medium",  # delete is irreversible — bump above the default 'low'
        ip_address=None,
    ))


# ─── BULK DELETE: QUOTATIONS ─────────────────────────────────────────────────
@router.post("/quotations/bulk-delete", dependencies=[Depends(require_perm("invoices.delete"))])
async def bulk_delete_quotations(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(Quotation)
        .options(selectinload(Quotation.line_items))
        .where(Quotation.id.in_(data.ids))
    )
    quotes = res.unique().scalars().all()
    found_ids = {q.id for q in quotes}
    blocked = []
    for qid in data.ids:
        if qid not in found_ids:
            blocked.append({"id": qid, "number": "?", "reason": "Quotation not found"})

    # Guard by LIVE dependency, not by the `status` flag. A quote is only
    # blocked if the sales order it spawned still exists. The status flag
    # never resets, so keying off it falsely blocked quotes whose SO had
    # already been deleted. We resolve the back-pointers in one query, then
    # confirm those SO rows still exist.
    order_ptr_ids = {q.converted_order_id for q in quotes if q.converted_order_id}
    inv_ptr_ids = {q.converted_invoice_id for q in quotes if getattr(q, "converted_invoice_id", None)}
    live_order_ids = set()
    live_inv_ids = set()
    if order_ptr_ids:
        live_order_ids = set((await db.execute(
            select(SalesOrder.id).where(SalesOrder.id.in_(order_ptr_ids))
        )).scalars().all())
    if inv_ptr_ids:
        live_inv_ids = set((await db.execute(
            select(SaleInvoice.id).where(SaleInvoice.id.in_(inv_ptr_ids))
        )).scalars().all())
    for q in quotes:
        if q.converted_order_id and q.converted_order_id in live_order_ids:
            blocked.append({
                "id": q.id, "number": q.number,
                "reason": f"Quote {q.number} has a live Sales Order — delete the SO first",
            })
        inv_ptr = getattr(q, "converted_invoice_id", None)
        if inv_ptr and inv_ptr in live_inv_ids:
            blocked.append({
                "id": q.id, "number": q.number,
                "reason": f"Quote {q.number} has a live Invoice — delete the invoice first",
            })
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some quotations can't be deleted"})

    deleted = []
    for q in quotes:
        snapshot = {
            "id": q.id, "number": q.number, "customer_id": q.customer_id,
            "customer_name": q.customer_name, "total": q.total,
            "status": str(q.status.value) if hasattr(q.status, "value") else str(q.status),
            "items": [{"id": li.id, "name": li.name, "qty": li.qty, "price": li.price} for li in q.line_items],
        }
        _audit_delete(db, action="delete_quotation", ref=q.number, snapshot=snapshot, user=user)
        _log_quotation_history(db, user=user,
            quote_id=q.id,
            quote_number=q.number,
            event_type="cancelled",
            action="cancel_quotation",
            detail=f"Cancelled quotation {q.number} via bulk delete",
            metadata={"reason": "bulk_delete"},
            risk="medium",
        )
        await db.delete(q)
        deleted.append({"id": q.id, "number": q.number})
    await db.commit()
    return {"deleted": deleted, "blocked": [], "count": len(deleted)}


# ─── BULK DELETE: SALES ORDERS ───────────────────────────────────────────────
@router.post("/orders/bulk-delete", dependencies=[Depends(require_perm("invoices.delete"))])
async def bulk_delete_orders(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(SalesOrder)
        .options(selectinload(SalesOrder.line_items))
        .where(SalesOrder.id.in_(data.ids))
    )
    orders = res.unique().scalars().all()
    found_ids = {o.id for o in orders}
    blocked = []
    for oid in data.ids:
        if oid not in found_ids:
            blocked.append({"id": oid, "number": "?", "reason": "Sales order not found"})

    # Guard by LIVE invoice, not the `status` flag (see quotation guard).
    inv_ptr_ids = {o.converted_invoice_id for o in orders if o.converted_invoice_id}
    live_inv_ids = set()
    if inv_ptr_ids:
        live_inv_ids = set((await db.execute(
            select(SaleInvoice.id).where(SaleInvoice.id.in_(inv_ptr_ids))
        )).scalars().all())
    for o in orders:
        if o.converted_invoice_id and o.converted_invoice_id in live_inv_ids:
            blocked.append({
                "id": o.id, "number": o.number,
                "reason": f"SO {o.number} has a live Invoice — delete the invoice first",
            })
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some sales orders can't be deleted"})

    deleted = []
    for o in orders:
        snapshot = {
            "id": o.id, "number": o.number, "customer_id": o.customer_id,
            "customer_name": o.customer_name, "total": o.total,
            "status": str(o.status.value) if hasattr(o.status, "value") else str(o.status),
            "items": [{"id": li.id, "name": li.name, "qty": li.qty, "price": li.price} for li in o.line_items],
        }
        _log_sales_order_history(db, user=user,
            order_id=o.id,
            order_number=o.number,
            event_type="cancelled",
            action="delete_sales_order",
            detail=f"Sales order {o.number} deleted",
            metadata={"reason": "bulk_delete"},
            risk="medium",
        )
        _audit_delete(db, action="delete_sales_order", ref=o.number, snapshot=snapshot, user=user)
        # Orphan the parent quote: clear its dangling back-pointer so it
        # becomes deletable + no "View SO" link 404s. Do NOT revert status
        # — a quote that was ever converted stays locked from editing /
        # re-converting even after its SO is deleted (2026-05-31 rule,
        # mirrors PO→bill). Status stays `converted`.
        parent_quote = (await db.execute(
            select(Quotation).where(Quotation.converted_order_id == o.id)
        )).scalar_one_or_none()
        if parent_quote is not None:
            parent_quote.converted_order_id = None
        await db.delete(o)
        deleted.append({"id": o.id, "number": o.number})
    await db.commit()
    return {"deleted": deleted, "blocked": [], "count": len(deleted)}


# ─── BULK DELETE: INVOICES ───────────────────────────────────────────────────
@router.post("/bulk-delete", dependencies=[Depends(require_perm("invoices.delete"))])
async def bulk_delete_invoices(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.id.in_(data.ids))
    )
    invoices = res.unique().scalars().all()
    found_ids = {i.id for i in invoices}
    blocked = []
    for iid in data.ids:
        if iid not in found_ids:
            blocked.append({"id": iid, "number": "?", "reason": "Invoice not found"})

    # Bulk guard checks: any return or payment-allocation referencing
    # these invoices blocks the whole batch.
    return_counts = dict((await db.execute(
        select(SalesReturn.invoice_id, func.count(SalesReturn.id))
        .where(SalesReturn.invoice_id.in_(found_ids))
        .group_by(SalesReturn.invoice_id)
    )).all()) if found_ids else {}
    payment_counts = dict((await db.execute(
        select(CustomerPaymentAllocation.invoice_id, func.count(CustomerPaymentAllocation.id))
        .where(CustomerPaymentAllocation.invoice_id.in_(found_ids))
        .group_by(CustomerPaymentAllocation.invoice_id)
    )).all()) if found_ids else {}

    for inv in invoices:
        if return_counts.get(inv.id):
            blocked.append({
                "id": inv.id, "number": inv.number,
                "reason": f"Invoice {inv.number} has {return_counts[inv.id]} return(s) — delete those first",
            })
        if payment_counts.get(inv.id):
            blocked.append({
                "id": inv.id, "number": inv.number,
                "reason": "Cannot delete invoice with linked payment record(s). Delete the payment(s) first.",
            })
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some invoices can't be deleted"})

    # Reversal: restock per line. Aggregate add-back (we don't track which
    # specific batch each sale line consumed). For tracked items, the
    # operator can manually rebalance batches via the Items page if needed.
    deleted = []
    stock_restored = 0
    customer_ids: set[str] = set()
    for inv in invoices:
        snapshot = {
            "id": inv.id, "number": inv.number, "customer_id": inv.customer_id,
            "customer_name": inv.customer_name, "total": inv.total,
            "paid_amount": inv.paid_amount, "payment_mode": inv.payment_mode,
            "status": str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status),
            "items": [{"id": li.id, "item_id": li.item_id, "name": li.name, "qty": li.qty, "price": li.price} for li in inv.line_items],
        }
        for li in inv.line_items:
            if li.item_id and li.qty:
                restored = await _restock_invoice_lines(db, inv, [li])
                stock_restored += restored
        # Orphan the parent SO (if this invoice was spawned from one): clear
        # its dangling pointer so it becomes deletable + no "View invoice"
        # link 404s. Do NOT revert status — an SO that was ever converted
        # stays locked from editing / re-converting even after its invoice
        # is deleted (2026-05-31 rule, mirrors PO→bill). Status stays
        # `converted` (which _is_ the edit-blocking terminal state).
        parent_so = (await db.execute(
            select(SalesOrder).where(SalesOrder.converted_invoice_id == inv.id)
        )).scalar_one_or_none()
        if parent_so is not None:
            parent_so.converted_invoice_id = None
        _log_sales_invoice_history(db, user=user,
            invoice_id=inv.id,
            invoice_number=inv.number,
            event_type="voided",
            action="delete_invoice",
            detail=f"Deleted sales invoice {inv.number}",
            metadata={"reason": "bulk_delete"},
            risk="medium",
            branch_id=inv.branch_id,
        )
        _audit_delete(db, action="delete_invoice", ref=inv.number, snapshot=snapshot, user=user)
        await db.delete(inv)
        deleted.append({"id": inv.id, "number": inv.number})
        if inv.customer_id:
            customer_ids.add(inv.customer_id)
    for cid in customer_ids:
        await sync_customer_outstanding(db, cid)
    await db.commit()
    return {
        "deleted": deleted, "blocked": [], "count": len(deleted),
        "stock_restored": stock_restored,
    }


# ─── BULK DELETE: SALES RETURNS ──────────────────────────────────────────────
@router.post("/returns/bulk-delete", dependencies=[Depends(require_perm("invoices.delete"))])
async def bulk_delete_returns(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(SalesReturn)
        .options(selectinload(SalesReturn.line_items))
        .where(SalesReturn.id.in_(data.ids))
    )
    returns = res.unique().scalars().all()
    found_ids = {r.id for r in returns}
    blocked = []
    for rid in data.ids:
        if rid not in found_ids:
            blocked.append({"id": rid, "number": "?", "reason": "Return not found"})
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some returns can't be deleted"})

    deleted = []
    credit_refunded = 0.0
    customer_ids: set[str] = set()
    invoice_ids_to_recalc: set[str] = set()
    for ret in returns:
        if ret.status == SalesReturnStatus.void:
            snapshot = {
                "id": ret.id, "number": ret.number, "status": "void",
            }
            _log_sales_return_history(db, user=user,
                return_id=ret.id,
                return_number=ret.number,
                event_type="cancelled",
                action="delete_sales_return",
                detail=f"Deleted sales return {ret.number}",
                metadata={"reason": "bulk_delete"},
                risk="medium",
                branch_id=ret.branch_id,
            )
            _audit_delete(db, action="delete_sales_return", ref=ret.number, snapshot=snapshot, user=user)
            await db.delete(ret)
            deleted.append({"id": ret.id, "number": ret.number})
            continue
        snapshot = {
            "id": ret.id, "number": ret.number, "invoice_id": ret.invoice_id,
            "invoice_number": ret.invoice_number, "customer_id": ret.customer_id,
            "refund_method": ret.refund_method, "credited_amount": ret.credited_amount,
            "total": ret.total,
        }
        credit_refunded += await _reverse_sales_return_effects(db, ret)
        if ret.customer_id:
            customer_ids.add(ret.customer_id)
        inv_cid = (await db.execute(
            select(SaleInvoice.customer_id).where(SaleInvoice.id == ret.invoice_id)
        )).scalar_one_or_none()
        if inv_cid:
            customer_ids.add(inv_cid)
        _log_sales_return_history(db, user=user,
            return_id=ret.id,
            return_number=ret.number,
            event_type="cancelled",
            action="delete_sales_return",
            detail=f"Deleted sales return {ret.number}",
            metadata={
                "reason": "bulk_delete",
                "target_record_type": "sales_invoice",
                "target_record_id": ret.invoice_id,
                "target_record_number": ret.invoice_number,
            },
            risk="medium",
            branch_id=ret.branch_id,
        )
        _audit_delete(db, action="delete_sales_return", ref=ret.number, snapshot=snapshot, user=user)
        invoice_ids_to_recalc.add(ret.invoice_id)
        await db.delete(ret)
        deleted.append({"id": ret.id, "number": ret.number})
    await db.flush()
    for inv_id in invoice_ids_to_recalc:
        await recalc_invoice_after_cn(db, inv_id)
    for cid in customer_ids:
        await sync_customer_outstanding(db, cid)
    await db.commit()
    return {
        "deleted": deleted, "blocked": [], "count": len(deleted),
        "credit_refunded": round(credit_refunded, 2),
    }


# ─── BULK DELETE: CUSTOMER PAYMENTS ──────────────────────────────────────────
@router.post("/payments/bulk-delete", dependencies=[Depends(require_perm("invoices.delete"))])
async def bulk_delete_payments(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(CustomerPayment)
        .options(selectinload(CustomerPayment.allocations))
        .where(CustomerPayment.id.in_(data.ids))
    )
    payments = res.unique().scalars().all()
    found_ids = {p.id for p in payments}
    blocked = []
    for pid in data.ids:
        if pid not in found_ids:
            blocked.append({"id": pid, "number": "?", "reason": "Payment not found"})
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some payments can't be deleted"})

    deleted = []
    credit_refunded = 0.0
    customer_ids: set[str] = set()
    for pay in payments:
        snapshot = {
            "id": pay.id, "number": pay.number, "customer_id": pay.customer_id,
            "customer_name": pay.customer_name, "total_amount": pay.total_amount,
            "payment_mode": pay.payment_mode, "credit_applied": pay.credit_applied,
            "allocations": [{"invoice_id": a.invoice_id, "invoice_number": a.invoice_number, "amount": a.amount} for a in pay.allocations],
        }
        status_before: dict[str, str] = {}
        # Reversal #1: per allocation, decrement invoice.paid_amount + reset status.
        for alloc in pay.allocations:
            inv = (await db.execute(
                select(SaleInvoice).where(SaleInvoice.id == alloc.invoice_id)
            )).scalar_one_or_none()
            if inv is not None:
                status_before[inv.id] = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
                new_paid = round(max(0.0, float(inv.paid_amount or 0) - float(alloc.amount or 0)), 2)
                inv.paid_amount = new_paid
                if new_paid <= 0:
                    inv.status = "pending"
                elif new_paid < float(inv.total or 0):
                    inv.status = "partial"
                _log_sales_invoice_history(db, user=user,
                    invoice_id=inv.id,
                    invoice_number=inv.number,
                    event_type="payment_deleted",
                    action="delete_customer_payment",
                    detail=f"Deleted payment {pay.number} allocation on {inv.number}",
                    metadata={
                        "payment_id": pay.id,
                        "payment_number": pay.number,
                        "amount": round(float(alloc.amount or 0), 2),
                    },
                    risk="medium",
                    branch_id=inv.branch_id,
                )
                next_status = str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status)
                prev_status = status_before.get(inv.id)
                if prev_status and prev_status != next_status:
                    _log_sales_invoice_history(db, user=user,
                        invoice_id=inv.id,
                        invoice_number=inv.number,
                        event_type="status_changed",
                        action="update_invoice_status",
                        detail=f"Status changed: {prev_status} -> {next_status}",
                        metadata={"from": prev_status, "to": next_status},
                        branch_id=inv.branch_id,
                    )
        # Reversal #2: credit-mode payment → refund the credit balance.
        if pay.payment_mode == "credit" and pay.customer_id and (pay.total_amount or 0) > 0:
            cust = (await db.execute(
                select(Customer).where(Customer.id == pay.customer_id)
            )).scalar_one_or_none()
            if cust:
                refund = float(pay.total_amount or 0)
                await adjust_customer_credit(
                    db,
                    pay.customer_id,
                    refund,
                    entry_type="void_restore",
                    source_type="customer_payment",
                    source_ref=pay.id,
                    source_number=pay.number,
                )
                credit_refunded += refund
        # Reversal #3: payments that overpaid → revoke the credit_applied bump.
        if pay.customer_id and (pay.credit_applied or 0) > 0:
            cust = (await db.execute(
                select(Customer).where(Customer.id == pay.customer_id)
            )).scalar_one_or_none()
            if cust:
                revoke = float(pay.credit_applied or 0)
                await adjust_customer_credit(
                    db,
                    pay.customer_id,
                    -revoke,
                    entry_type="void_revoke",
                    source_type="customer_payment",
                    source_ref=pay.id,
                    source_number=pay.number,
                )
        _audit_delete(db, action="delete_payment", ref=pay.number, snapshot=snapshot, user=user)
        await db.delete(pay)
        deleted.append({"id": pay.id, "number": pay.number})
        if pay.customer_id:
            customer_ids.add(pay.customer_id)
        for alloc in pay.allocations:
            inv = (await db.execute(
                select(SaleInvoice.customer_id).where(SaleInvoice.id == alloc.invoice_id)
            )).scalar_one_or_none()
            if inv:
                customer_ids.add(inv)
    for cid in customer_ids:
        await sync_customer_outstanding(db, cid)
    await db.commit()
    return {
        "deleted": deleted, "blocked": [], "count": len(deleted),
        "credit_refunded": round(credit_refunded, 2),
    }
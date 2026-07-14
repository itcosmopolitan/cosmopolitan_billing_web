import json
import uuid
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.batch_dates import validate_batch_dates
from src.database import get_db
from src.document_numbering import allocate_number, resolve_number
from src.tax_calc import line_tax_amount, line_taxable_amount, normalize_tax_pricing_mode
from src.models import (
    AuditLog,
    GRNLineItem,
    GRNStatus,
    GoodsReceiptNote,
    ItemBatch,
    Organisation,
    PurchaseBill,
    PurchaseLineItem,
    PurchaseOrder,
    PurchaseOrderLineItem,
    PurchaseOrderStatus,
    ReturnLineItem,
    User,
    Vendor,
    VendorPayment,
    VendorPaymentAllocation,
    VendorReturn,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._grn_stock import (
    ReceiptLine,
    grn_batches_consumed,
    receive_lines_to_stock,
    reverse_grn_stock,
)
from src.routes._lifecycle import (
    compute_due_date,
    recalc_bill_after_vendor_credit,
    refresh_purchase_overdue,
    reverse_vendor_payment,
    sync_vendor_outstanding,
)
from src.routes._payment_ledger import record_vendor_payment, void_payment_record
from src.routes._cash_ledger import record_cash_out, void_cash_entry as void_cash_for_payment
from src.routes._vendor_credit_ledger import adjust_vendor_credit
from src.routes._atomic import (
    add_batch_atomic,
    adjust_stock_atomic,
    consume_batches_atomic,
    is_tracked,
    set_batch_quantity_atomic,
)
from src.routes._serializers import get_user_branch_ids
from src.routes._approval import can_direct_commit
from src.permissions import PURCHASE_DOCUMENT_READ
from src.security import (
    current_user,
    enforce_branch_access,
    enforce_branch_access_optional,
    get_allowed_branch_ids,
    require_perm,
)
from src.services.audit_service import build_audit_entry

router = APIRouter()

# ─── Schemas ─────────────────────────────────────────────────────────────────
# 2026-05-24: same allow-list as routes/sales.py PaymentMode. Single source
# of truth across the app — POS, Record Payment on invoices, AND Record
# Payment on purchase bills all offer the same 4 methods. Mirror the SO
# `RecordedPaymentMode` decision: cheque NOT included even though vendor
# settlements often use it, because parity with the POS dropdown won out.
PaymentMode = Literal["cash", "card", "upi", "bank_transfer", "credit"]


async def _write_post_commit_audit(
    db: AsyncSession,
    *,
    action: str,
    reference_id: str,
    detail: str,
    user: User,
    request: Request = None,
    branch_id: Optional[str],
    metadata: Optional[dict] = None,
) -> None:
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    payload = build_audit_entry(
        action=action,
        module="Purchases",
        reference_id=reference_id,
        detail=detail,
        user_id=user.id,
        user_name=user.name,
        user_role=role,
        ip_address=(getattr(request.state, "ip_address", None) if request is not None else None),
        device_info=(getattr(request.state, "device_info", None) if request is not None else None),
        branch_id=branch_id,
        metadata=metadata,
    )
    db.add(AuditLog(id=str(uuid.uuid4()), **payload))
    await db.commit()


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


def _audit_log_user_role(user: Optional[User]) -> str:
    if user is None:
        return "unknown"
    role = getattr(user, "role", None)
    if role is None:
        return "unknown"
    if hasattr(role, "value"):
        return str(role.value)
    return str(role)


def _log_purchase_bill_history(
    db: AsyncSession,
    *,
    user: Optional[User] = None,
    bill_id: str,
    bill_number: str,
    event_type: str,
    detail: str,
    metadata: Optional[dict] = None,
    action: Optional[str] = None,
    risk: str = "low",
) -> None:
    """Shared purchase_bill activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="purchase_bill",
        record_id=bill_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        user_role=_audit_log_user_role(user),
        module="purchases",
        ref=bill_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


def _summarize_purchase_bill_item_changes(old_lines, new_items) -> list[dict]:
    """Compute human-friendly item diffs for purchase bill edits."""
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
                {"field": "rate", "old": None, "new": round(float(item.cost or 0), 2)},
                {"field": "tax_rate", "old": None, "new": round(float(item.tax_rate or 0), 2)},
                {"field": "discount", "old": None, "new": round(float(item.discount or 0), 2)},
            ]
            changes.append(
                {
                    "item_id": str(item.item_id) if item.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["added"],
                    "changes": structured,
                    "detail": f"{item_name}: added (qty {item.qty}, rate {round(float(item.cost or 0), 2)})",
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
        if round(float(prev.cost or 0), 2) != round(float(item.cost or 0), 2):
            fields.append("rate")
            field_changes.append(f"rate {round(float(prev.cost or 0), 2)} -> {round(float(item.cost or 0), 2)}")
            structured.append(
                {"field": "rate", "old": round(float(prev.cost or 0), 2), "new": round(float(item.cost or 0), 2)}
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
                {"field": "rate", "old": round(float(row.cost or 0), 2), "new": None},
                {"field": "tax_rate", "old": round(float(row.tax_rate or 0), 2), "new": None},
                {"field": "discount", "old": round(float(row.discount or 0), 2), "new": None},
            ]
            changes.append(
                {
                    "item_id": str(row.item_id) if row.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["removed"],
                    "changes": structured,
                    "detail": f"{item_name}: removed (qty {int(row.qty or 0)}, rate {round(float(row.cost or 0), 2)})",
                }
            )

    return changes


def _log_purchase_order_history(
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
    """Shared purchase_order activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="purchase_order",
        record_id=order_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="purchases",
        ref=order_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


def _summarize_purchase_order_item_changes(old_lines, new_items) -> list[dict]:
    """Compute item-level diffs for purchase order edits."""
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
                {"field": "rate", "old": None, "new": round(float(item.cost or 0), 2)},
                {"field": "tax_rate", "old": None, "new": round(float(item.tax_rate or 0), 2)},
                {"field": "discount", "old": None, "new": round(float(item.discount or 0), 2)},
            ]
            changes.append(
                {
                    "item_id": str(item.item_id) if item.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["added"],
                    "changes": structured,
                    "detail": f"{item_name}: added (qty {item.qty}, rate {round(float(item.cost or 0), 2)})",
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
        if round(float(prev.cost or 0), 2) != round(float(item.cost or 0), 2):
            fields.append("rate")
            field_changes.append(f"rate {round(float(prev.cost or 0), 2)} -> {round(float(item.cost or 0), 2)}")
            structured.append(
                {"field": "rate", "old": round(float(prev.cost or 0), 2), "new": round(float(item.cost or 0), 2)}
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
                {"field": "rate", "old": round(float(row.cost or 0), 2), "new": None},
                {"field": "tax_rate", "old": round(float(row.tax_rate or 0), 2), "new": None},
                {"field": "discount", "old": round(float(row.discount or 0), 2), "new": None},
            ]
            changes.append(
                {
                    "item_id": str(row.item_id) if row.item_id is not None else None,
                    "item_name": item_name,
                    "fields": ["removed"],
                    "changes": structured,
                    "detail": f"{item_name}: removed (qty {int(row.qty or 0)}, rate {round(float(row.cost or 0), 2)})",
                }
            )

    return changes


def _log_grn_history(
    db: AsyncSession,
    *,
    user: Optional[User] = None,
    grn_id: str,
    grn_number: str,
    event_type: str,
    detail: str,
    metadata: Optional[dict] = None,
    action: Optional[str] = None,
    risk: str = "low",
) -> None:
    """Shared GRN activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="grn",
        record_id=grn_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="purchases",
        ref=grn_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


def _log_vendor_return_history(
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
) -> None:
    """Shared vendor_return activity logger (Phase D incremental rollout)."""
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="vendor_return",
        record_id=return_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action or event_type,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="purchases",
        ref=return_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


class PurchaseLine(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    cost: float
    tax_rate: float = 0
    # 2026-05-24: per-line discount in PERCENT (parity with SO/Quote).
    # Frontend BillFormModal accepts % or MVR via toggle and converts to
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
    number: Optional[str] = None
    notes: Optional[str] = None
    # 2026-05-24: parallel to SaleCreate.payment_mode. When set at create
    # time, the bill is created `paid`; when None, `pending`. Frontend
    # BillFormModal's "Payment received?" checkbox drives this.
    payment_mode: Optional[PaymentMode] = None
    payment_ref: Optional[str] = None
    purchase_order_id: Optional[str] = None
    grn_id: Optional[str] = None

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)


class BillLineUpdate(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int = Field(..., gt=0)
    cost: float
    tax_rate: float = 0
    discount: float = 0


class BillUpdate(BaseModel):
    vendor_id: Optional[str] = None
    vendor_name: Optional[str] = None
    date: Optional[str] = None
    due_date: Optional[str] = None
    items: List[BillLineUpdate]
    discount: float = 0
    notes: Optional[str] = None


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


# ─── LIST ─────────────────────────────────────────────────────────────────────
@router.get("/", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
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
    await refresh_purchase_overdue(db, branch_id)
    await db.commit()
    conds = _purchase_bill_filters(branch_id, vendor_id, status, search, date_from, date_to)
    if branch_id is None and not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
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
    return paged(out, total, sk, lim)

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{bill_id}", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
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
async def create_bill(
    data: PurchaseCreate,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
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
    tax_mode = await _get_org_tax_mode(db)
    line_rows = []  # list[(item, line_net, line_tax)]
    subtotal = 0.0
    tax_total = 0.0
    for item in data.items:
        gross = round(item.qty * item.cost, 2)
        line_net = round(gross * (1 - (item.discount or 0) / 100), 2)
        line_tax = line_tax_amount(line_net, item.tax_rate or 0, tax_mode)
        line_rows.append((item, line_net, line_tax))
        subtotal += line_taxable_amount(line_net, item.tax_rate or 0, tax_mode)
        tax_total += line_tax
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    bill_num = await resolve_number(
        db,
        requested=data.number,
        model=PurchaseBill,
        allocate=lambda: allocate_number(db, "purchase_bill", branch_id=data.branch_id),
    )

    await enforce_branch_access(data.branch_id, user=user, db=db)

    # If operator marked "payment received" at create time, settle the
    # bill in-line — parity with POS create_invoice. Otherwise the bill
    # lands as pending and gets settled later via record_payment.
    paid_at_create = data.payment_mode is not None
    paid_amount = total if paid_at_create else 0.0

    due_date = data.due_date
    bill_status = "paid" if paid_amount >= total else "pending"
    if not due_date and bill_status in ("pending", "partial"):
        vendor_row = (await db.execute(
            select(Vendor).where(Vendor.id == data.vendor_id)
        )).scalar_one_or_none()
        payment_terms = vendor_row.payment_terms if vendor_row else None
        due_date = compute_due_date(data.date or today, payment_terms)

    if data.grn_id and data.purchase_order_id:
        raise HTTPException(400, "Specify grn_id or purchase_order_id, not both")

    po = None
    if data.purchase_order_id:
        po_res = await db.execute(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.line_items))
            .where(PurchaseOrder.id == data.purchase_order_id)
        )
        po = po_res.scalar_one_or_none()
        if not po:
            raise HTTPException(404, "Purchase order not found")
        if po.status == PurchaseOrderStatus.converted:
            raise HTTPException(400, "Purchase order already converted")
        if po.status == PurchaseOrderStatus.partially_received:
            raise HTTPException(
                400,
                "PO already has a goods receipt — open the GRN tab and create a bill from the pending receipt",
            )
        if po.status == PurchaseOrderStatus.cancelled:
            raise HTTPException(400, "Cannot convert a cancelled purchase order")

    if data.grn_id:
        grn_res = await db.execute(
            select(GoodsReceiptNote)
            .options(selectinload(GoodsReceiptNote.line_items))
            .where(GoodsReceiptNote.id == data.grn_id)
        )
        grn = grn_res.scalar_one_or_none()
        if not grn:
            raise HTTPException(404, "GRN not found")
        grn_status = str(grn.status.value) if hasattr(grn.status, "value") else str(grn.status)
        if grn_status != "received":
            raise HTTPException(400, "Only received GRNs can be billed")
        if grn.converted_bill_id:
            raise HTTPException(400, "GRN already has a linked bill")
        grn_total = float(grn.total or 0)
        paid_amount = grn_total if paid_at_create else 0.0
        bill_status = "paid" if paid_amount >= grn_total else "pending"
        bill = await _create_bill_for_grn(
            db,
            grn,
            due_date=due_date,
            payment_mode=data.payment_mode,
            payment_ref=data.payment_ref or "",
            notes=data.notes,
            paid_amount=paid_amount,
        )
        _log_grn_history(db, user=user,
            grn_id=grn.id,
            grn_number=grn.number,
            event_type="verified",
            action="verify_grn_for_billing",
            detail=f"Verified GRN {grn.number} and created bill {bill.number}",
            metadata={
                "target_record_type": "purchase_bill",
                "target_record_id": bill.id,
                "target_record_number": bill.number,
            },
        )
        _log_grn_history(db, user=user,
            grn_id=grn.id,
            grn_number=grn.number,
            event_type="linked_to_source",
            action="link_grn_source",
            detail=f"Linked GRN {grn.number} to purchase bill {bill.number}",
            metadata={
                "target_record_type": "purchase_bill",
                "target_record_id": bill.id,
                "target_record_number": bill.number,
            },
        )
        # Propagate any batch metadata corrections the user made on the bill
        # form (expiry_date, mfg_date) back to the ItemBatch and GRNLineItem
        # records so they stay in sync.
        if data.items:
            for item_in in data.items:
                if not item_in.item_id:
                    continue
                if not (item_in.expiry_date is not None or item_in.mfg_date is not None):
                    continue
                batch_q = select(ItemBatch).where(
                    ItemBatch.item_id == item_in.item_id,
                    ItemBatch.source_ref == grn.id,
                )
                if item_in.batch_number:
                    batch_q = batch_q.where(ItemBatch.batch_number == item_in.batch_number)
                batch = (await db.execute(batch_q)).scalar_one_or_none()
                if batch:
                    if item_in.expiry_date is not None:
                        batch.expiry_date = item_in.expiry_date or None
                    if item_in.mfg_date is not None:
                        batch.mfg_date = item_in.mfg_date or None
                grn_line_q = select(GRNLineItem).where(
                    GRNLineItem.grn_id == grn.id,
                    GRNLineItem.item_id == item_in.item_id,
                )
                grn_line = (await db.execute(grn_line_q)).scalar_one_or_none()
                if grn_line:
                    if item_in.expiry_date is not None:
                        grn_line.expiry_date = item_in.expiry_date or None
                    if item_in.mfg_date is not None:
                        grn_line.mfg_date = item_in.mfg_date or None
        if grn.purchase_order_id:
            po = (await db.execute(
                select(PurchaseOrder).where(PurchaseOrder.id == grn.purchase_order_id)
            )).scalar_one_or_none()
            if po is not None:
                po.status = PurchaseOrderStatus.converted
                po.converted_bill_id = bill.id
                _log_purchase_order_history(db, user=user,
                    order_id=po.id,
                    order_number=po.number,
                    event_type="converted",
                    action="convert_purchase_order",
                    detail=f"Converted purchase order {po.number} to bill {bill.number}",
                    metadata={
                        "target_record_type": "purchase_bill",
                        "target_record_id": bill.id,
                        "target_record_number": bill.number,
                    },
                )
    else:
        # Phase 3: stock on GRN, bill is financial only (auto-GRN for direct bill).
        grn = await _create_grn_received(
            db,
            vendor_id=data.vendor_id,
            vendor_name=data.vendor_name,
            branch_id=data.branch_id,
            branch_name=data.branch_name or data.branch_id,
            date=data.date or today,
            line_rows=line_rows,
            discount=data.discount or 0,
            notes=data.notes,
            purchase_order_id=po.id if po else None,
            po_number=po.number if po else None,
            number=data.number,
            tax_mode=tax_mode,
        )
        bill = await _create_bill_for_grn(
            db,
            grn,
            due_date=due_date,
            payment_mode=data.payment_mode,
            payment_ref=data.payment_ref or "",
            notes=data.notes,
            paid_amount=paid_amount,
        )
        if po is not None:
            po.status = PurchaseOrderStatus.converted
            po.converted_bill_id = bill.id
            _log_purchase_order_history(db, user=user,
                order_id=po.id,
                order_number=po.number,
                event_type="converted",
                action="convert_purchase_order",
                detail=f"Converted purchase order {po.number} to bill {bill.number}",
                metadata={
                    "target_record_type": "purchase_bill",
                    "target_record_id": bill.id,
                    "target_record_number": bill.number,
                },
            )
    bill_num = bill.number
    total = float(bill.total or 0)

    # 2026-05-31: record a VendorPayment for a bill paid at creation, so the
    # Purchases > Payments tab is a complete ledger — parity with the sales
    # POS fix + record_payment. Previously a paid-at-create bill settled but
    # left no payment row, so it was missing from the Payments tab.
    if paid_at_create:
        pay_count = (await db.execute(select(func.count(VendorPayment.id)))).scalar() or 0
        bpay = VendorPayment(
            id=str(uuid.uuid4()),
            number=f"VPAY-{datetime.now().year}-{1000 + pay_count:04d}",
            vendor_id=bill.vendor_id,
            vendor_name=bill.vendor_name,
            branch_id=bill.branch_id,
            branch_name=bill.branch_name,
            date=data.date or today,
            total_amount=round(paid_amount, 2),
            payment_mode=data.payment_mode,
            payment_ref=data.payment_ref or "",
            notes="Bill paid at creation",
            created_by="Staff",
        )
        db.add(bpay)
        db.add(VendorPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=bpay.id,
            bill_id=bill.id,
            bill_number=bill.number,
            amount=round(paid_amount, 2),
        ))
        await record_vendor_payment(db, bpay)
        if data.payment_mode == "cash":
            await record_cash_out(
                db,
                branch_id=bill.branch_id or "",
                amount=round(paid_amount, 2),
                date=data.date or today,
                description=f"Bill payment {bill_num}",
                category="Purchase — Cash Payment",
                source_type="purchase_payment",
                source_id=bpay.id,
                source_ref=bill_num,
                recorded_by="Staff",
            )

    if bill.vendor_id and bill_status in ("pending", "partial"):
        await sync_vendor_outstanding(db, bill.vendor_id)

    await db.commit()
    await _write_post_commit_audit(
        db,
        action="Purchase Bill Created",
        reference_id=bill.number,
        detail=f"Created purchase bill {bill.number}",
        user=user,
        request=request,
        branch_id=bill.branch_id,
        metadata={
            "bill_id": bill.id,
            "source": "grn" if data.grn_id else ("purchase_order" if data.purchase_order_id else "direct"),
            "status": str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status),
            "total": float(bill.total or 0),
        },
    )
    if float(data.discount or 0) > 0:
        await _write_post_commit_audit(
            db,
            action="Discount Applied",
            reference_id=bill.number,
            detail=f"Discount of ₹{round(float(data.discount or 0), 2)} applied to {bill.number}",
            user=user,
            request=request,
            branch_id=bill.branch_id,
            metadata={"bill_id": bill.id, "discount": round(float(data.discount or 0), 2), "above_threshold": float(data.discount or 0) > 1000},
        )
    return {"id": bill.id, "number": bill_num, "total": round(total, 2)}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{bill_id}/payment", dependencies=[Depends(require_perm("purchases.edit"))])
async def record_payment(bill_id: str, data: PaymentIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Record a payment against a purchase bill.

    Overpayment (amount > balance) routes excess to vendor.credit_balance.
    Credit mode debits vendor.credit_balance instead of cash.
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
    prev_status = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
    prev_paid_amount = float(b.paid_amount or 0)
    balance = max(0.0, float(b.total or 0) - float(b.paid_amount or 0))
    if balance <= 0:
        raise HTTPException(400, "Bill already settled")

    if data.mode == "credit":
        if not b.vendor_id:
            raise HTTPException(400, "Credit-mode payment requires a vendor")
        vendor_row = (await db.execute(
            select(Vendor).where(Vendor.id == b.vendor_id)
        )).scalar_one_or_none()
        if not vendor_row:
            raise HTTPException(404, "Vendor not found")
        avail = float(vendor_row.credit_balance or 0)
        if avail + 0.001 < data.amount:
            raise HTTPException(
                400,
                f"Insufficient vendor credit — MVR{round(avail, 2)} available, "
                f"payment is MVR{data.amount}",
            )
        if data.amount > balance + 0.001:
            raise HTTPException(
                400,
                f"Credit mode can't overpay — balance is MVR{round(balance, 2)}",
            )

    applied = min(balance, data.amount)
    credit_applied = round(max(0.0, data.amount - balance), 2)
    b.paid_amount = round(float(b.paid_amount or 0) + applied, 2)
    b.payment_ref = data.ref or b.payment_ref
    b.payment_mode = data.mode
    b.status = "paid" if b.paid_amount >= b.total else "partial"

    pay_count = (await db.execute(select(func.count(VendorPayment.id)))).scalar() or 0
    pay = VendorPayment(
        id=str(uuid.uuid4()),
        number=f"VPAY-{datetime.now().year}-{1000 + pay_count:04d}",
        vendor_id=b.vendor_id,
        vendor_name=b.vendor_name,
        branch_id=b.branch_id,
        branch_name=b.branch_name,
        date=datetime.now().strftime("%Y-%m-%d"),
        total_amount=round(data.amount, 2),
        payment_mode=data.mode,
        payment_ref=data.ref or "",
        notes=None,
        credit_applied=credit_applied,
        created_by="Staff",
    )
    db.add(pay)
    db.add(VendorPaymentAllocation(
        id=str(uuid.uuid4()),
        payment_id=pay.id,
        bill_id=b.id,
        bill_number=b.number,
        amount=round(data.amount, 2),
    ))

    if credit_applied > 0 and b.vendor_id:
        await adjust_vendor_credit(
            db,
            b.vendor_id,
            credit_applied,
            entry_type="overpayment",
            source_type="vendor_payment",
            source_ref=pay.id,
            source_number=pay.number,
        )
    elif data.mode == "credit" and b.vendor_id:
        await adjust_vendor_credit(
            db,
            b.vendor_id,
            -round(data.amount, 2),
            entry_type="payment_debit",
            source_type="vendor_payment",
            source_ref=pay.id,
            source_number=pay.number,
        )

    await record_vendor_payment(db, pay)
    if data.mode == "cash":
        await record_cash_out(
            db,
            branch_id=pay.branch_id or "",
            amount=float(data.amount),
            date=pay.date,
            description=f"Payment on {b.number}",
            category="Purchase — Cash Payment",
            source_type="purchase_payment",
            source_id=pay.id,
            source_ref=pay.number,
            recorded_by=pay.created_by or "Staff",
        )
    await sync_vendor_outstanding(db, b.vendor_id)

    _log_purchase_bill_history(db, user=user,
        bill_id=b.id,
        bill_number=b.number,
        event_type="payment_recorded",
        action="record_purchase_payment",
        detail=f"Recorded payment of {round(float(data.amount), 2)} for {b.number}",
        metadata={
            "payment_id": pay.id,
            "payment_number": pay.number,
            "amount": round(float(data.amount), 2),
            "applied": round(float(applied), 2),
            "paid_before": round(prev_paid_amount, 2),
            "paid_after": round(float(b.paid_amount or 0), 2),
            "payment_mode": data.mode,
            "payment_ref": data.ref or "",
        },
    )
    next_status = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
    if prev_status != next_status:
        _log_purchase_bill_history(db, user=user,
            bill_id=b.id,
            bill_number=b.number,
            event_type="status_changed",
            action="update_purchase_bill_status",
            detail=f"Status changed: {prev_status} -> {next_status}",
            metadata={"from": prev_status, "to": next_status},
        )

    await db.commit()
    return {
        "status": b.status,
        "paid_amount": b.paid_amount,
        "balance": round(float(b.total or 0) - float(b.paid_amount or 0), 2),
        "credit_applied": credit_applied,
    }


# ─── CANCEL ───────────────────────────────────────────────────────────────────
@router.post("/{bill_id}/cancel", dependencies=[Depends(require_perm("purchases.edit"))])
async def cancel_bill(bill_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
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
    if bill_status == "cancelled":
        return {"status": "cancelled"}
    if (b.paid_amount or 0) > 0:
        raise HTTPException(
            400,
            "Cannot cancel a bill with payments recorded. Delete payment records first.",
        )
    return_count = int((await db.execute(
        select(func.count(VendorReturn.id)).where(VendorReturn.bill_id == bill_id)
    )).scalar() or 0)
    if return_count > 0:
        raise HTTPException(
            400,
            f"Cannot cancel bill with {return_count} vendor return(s). Delete returns first.",
        )
    pay_count = int((await db.execute(
        select(func.count(VendorPaymentAllocation.id))
        .join(VendorPayment, VendorPaymentAllocation.payment_id == VendorPayment.id)
        .where(
            VendorPaymentAllocation.bill_id == bill_id,
            or_(VendorPayment.voided == False, VendorPayment.voided.is_(None)),  # noqa: E712
        )
    )).scalar() or 0)
    if pay_count > 0:
        raise HTTPException(
            400,
            "Cannot cancel a bill with active payment allocations. Void or delete payments first.",
        )
    prev_status = bill_status
    b.status = "cancelled"
    await sync_vendor_outstanding(db, b.vendor_id)
    _log_purchase_bill_history(db, user=user,
        bill_id=b.id,
        bill_number=b.number,
        event_type="status_changed",
        action="update_purchase_bill_status",
        detail=f"Status changed: {prev_status} -> cancelled",
        metadata={"from": prev_status, "to": "cancelled"},
    )
    await db.commit()
    return {"status": "cancelled"}


# ─── UPDATE (EDIT) ────────────────────────────────────────────────────────────
@router.put("/{bill_id}", dependencies=[Depends(require_perm("purchases.edit"))])
async def update_bill(
    bill_id: str,
    data: BillUpdate,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Edit a pending or partial bill. Replaces line items and recalculates
    totals. Paid and cancelled bills are locked — use vendor returns or
    Record Payment to adjust settled bills."""
    from sqlalchemy import delete as sa_delete
    result = await db.execute(
        select(PurchaseBill)
        .options(selectinload(PurchaseBill.line_items))
        .where(PurchaseBill.id == bill_id)
    )
    bill = result.scalar_one_or_none()
    if not bill:
        raise HTTPException(404, "Bill not found")
    await enforce_branch_access(bill.branch_id, user=user, db=db)
    bill_status = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
    if bill_status in ("paid", "cancelled"):
        raise HTTPException(400, f"Cannot edit a {bill_status} bill")
    if (bill.paid_amount or 0) > 0:
        raise HTTPException(
            400,
            "Cannot edit a bill with payments recorded. Void payments first.",
        )
    return_count = int((await db.execute(
        select(func.count(VendorReturn.id)).where(VendorReturn.bill_id == bill_id)
    )).scalar() or 0)
    if return_count > 0:
        raise HTTPException(
            400,
            f"Cannot edit bill with {return_count} vendor return(s). Void returns first.",
        )
    pay_count = int((await db.execute(
        select(func.count(VendorPaymentAllocation.id))
        .join(VendorPayment, VendorPaymentAllocation.payment_id == VendorPayment.id)
        .where(
            VendorPaymentAllocation.bill_id == bill_id,
            or_(VendorPayment.voided == False, VendorPayment.voided.is_(None)),  # noqa: E712
        )
    )).scalar() or 0)
    if pay_count > 0:
        raise HTTPException(
            400,
            "Cannot edit a bill with active payment allocations. Void payments first.",
        )
    if not data.items:
        raise HTTPException(400, "Bill must have at least one line item")

    prev_total = float(bill.total or 0)
    prev_due_date = bill.due_date
    item_changes = _summarize_purchase_bill_item_changes(list(bill.line_items or []), data.items)

    tax_mode = await _get_org_tax_mode(db)
    subtotal = 0.0
    tax_total_val = 0.0
    line_rows = []
    for item in data.items:
        gross = round(item.qty * item.cost, 2)
        line_net = round(gross * (1 - (item.discount or 0) / 100), 2)
        line_tax = line_tax_amount(line_net, item.tax_rate or 0, tax_mode)
        line_rows.append((item, line_net, line_tax))
        subtotal += line_taxable_amount(line_net, item.tax_rate or 0, tax_mode)
        tax_total_val += line_tax
    total = round(subtotal + tax_total_val - (data.discount or 0), 2)

    if data.vendor_id:
        bill.vendor_id = data.vendor_id
    if data.vendor_name is not None:
        bill.vendor_name = data.vendor_name
    if data.date:
        bill.date = data.date
    bill.due_date = data.due_date
    bill.subtotal = round(subtotal, 2)
    bill.tax_total = round(tax_total_val, 2)
    bill.discount = round(data.discount or 0, 2)
    bill.total = total
    bill.notes = data.notes

    await db.execute(sa_delete(PurchaseLineItem).where(PurchaseLineItem.bill_id == bill_id))
    for item, line_net, line_tax in line_rows:
        line_taxable = line_taxable_amount(line_net, item.tax_rate or 0, tax_mode)
        db.add(PurchaseLineItem(
            id=str(uuid.uuid4()),
            bill_id=bill_id,
            item_id=item.item_id,
            name=item.name,
            qty=item.qty,
            cost=item.cost,
            tax_rate=item.tax_rate,
            discount=item.discount or 0,
            line_total=round(line_taxable + line_tax, 2),
        ))

    if bill.vendor_id:
        await sync_vendor_outstanding(db, bill.vendor_id)
    await db.commit()
    preview = item_changes[0]["detail"] if item_changes else f"Updated line items for {bill.number}"
    if len(item_changes) > 1:
        preview = f"{preview}; +{len(item_changes) - 1} more item change(s)"
    # Record an explicit `item_changed` activity for audit catalogue expectations
    _log_purchase_bill_history(db, user=user,
        bill_id=bill.id,
        bill_number=bill.number,
        event_type="item_changed",
        action="update_purchase_bill_items",
        detail=preview,
        metadata={"changes": item_changes[:20], "line_count": len(data.items)},
    )

    await _write_post_commit_audit(
        db,
        action="Purchase Bill Edited",
        reference_id=bill.number,
        detail=preview,
        user=user,
        request=request,
        branch_id=bill.branch_id,
        metadata={
            "bill_id": bill.id,
            "line_count": len(data.items),
            "changes": item_changes[:20],
            "due_date_from": prev_due_date,
            "due_date_to": bill.due_date,
            "total_from": round(prev_total, 2),
            "total_to": round(float(bill.total or 0), 2),
        },
    )
    if float(data.discount or 0) > 0:
        await _write_post_commit_audit(
            db,
            action="Discount Applied",
            reference_id=bill.number,
            detail=f"Discount of ₹{round(float(data.discount or 0), 2)} applied to {bill.number}",
            user=user,
            request=request,
            branch_id=bill.branch_id,
            metadata={"bill_id": bill.id, "discount": round(float(data.discount or 0), 2), "above_threshold": float(data.discount or 0) > 1000},
        )
    li_res = await db.execute(select(PurchaseLineItem).where(PurchaseLineItem.bill_id == bill_id))
    return _bill_dict(bill, li_res.scalars().all())


# ═════════════════════════════════════════════════════════════════════════════
# MULTI-BILL PAYMENTS (2026-05-24)
# ═════════════════════════════════════════════════════════════════════════════
# Mirror of sales /payments/ flow. Overpayment routes to vendor.credit_balance;
# credit mode debits stored advance to settle bills.


class PaymentAllocationIn(BaseModel):
    bill_id: str
    amount: float = Field(..., gt=0)


class VendorPaymentCreate(BaseModel):
    vendor_id: str
    date: Optional[str] = None
    payment_mode: PaymentMode
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


def _vendor_payment_dict(p, allocations=None):
    d = {
        "id": p.id, "number": p.number,
        "vendorId": p.vendor_id, "vendorName": p.vendor_name,
        "branchId": p.branch_id, "branchName": p.branch_name,
        "date": p.date,
        "totalAmount": p.total_amount,
        "paymentMode": p.payment_mode,
        "paymentRef": p.payment_ref,
        "notes": p.notes,
        "voided": bool(getattr(p, "voided", False)),
        "voidedAt": getattr(p, "voided_at", None),
        "creditApplied": p.credit_applied or 0,
        "createdBy": p.created_by,
    }
    if allocations is not None:
        d["allocations"] = [{
            "id": a.id,
            "billId": a.bill_id,
            "billNumber": a.bill_number,
            "amount": a.amount,
        } for a in allocations]
        d["billCount"] = len(allocations)
    return d


# ─── PAYMENTS: LIST ─────────────────────────────────────────────────────────
@router.get("/payments/", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def list_payments(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    payment_mode: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    conds = [or_(VendorPayment.voided == False, VendorPayment.voided.is_(None))]  # noqa: E712
    if vendor_id:
        conds.append(VendorPayment.vendor_id == vendor_id)
    if payment_mode:
        conds.append(VendorPayment.payment_mode == payment_mode)
    if date_from:
        conds.append(VendorPayment.date >= date_from)
    if date_to:
        conds.append(VendorPayment.date <= date_to)
    if branch_id is not None:
        conds.append(VendorPayment.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, normalize_skip(skip), normalize_limit(limit))
        conds.append(VendorPayment.branch_id.in_(branch_ids))
    if search:
        s = f"%{search}%"
        conds.append(or_(
            VendorPayment.number.ilike(s),
            VendorPayment.vendor_name.ilike(s),
        ))
    base = and_(*conds) if conds else True
    total = int((await db.execute(select(func.count(VendorPayment.id)).where(base))).scalar() or 0)
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {
            "number": VendorPayment.number,
            "vendor_name": VendorPayment.vendor_name,
            "date": VendorPayment.date,
            "total_amount": VendorPayment.total_amount,
            "payment_mode": VendorPayment.payment_mode,
            "created_at": VendorPayment.created_at,
        },
        default_key="created_at", default_order="desc",
    )
    q = (
        select(VendorPayment)
        .options(selectinload(VendorPayment.allocations))
        .where(base)
        .order_by(sort_expr)
        .offset(sk)
        .limit(lim)
    )
    rows = (await db.execute(q)).scalars().all()
    out = [_vendor_payment_dict(p, p.allocations) for p in rows]
    return paged(out, total, sk, lim)


# ─── PAYMENTS: GET ──────────────────────────────────────────────────────────
@router.get("/payments/{payment_id}", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def get_payment(payment_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(VendorPayment)
        .options(selectinload(VendorPayment.allocations))
        .where(VendorPayment.id == payment_id)
    )
    p = res.scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Payment not found")
    await enforce_branch_access(p.branch_id, user=user, db=db)
    return _vendor_payment_dict(p, p.allocations)


@router.post("/payments/{payment_id}/void", dependencies=[Depends(require_perm("purchases.edit"))])
async def void_payment(payment_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Soft-void a vendor payment — reverses bill allocations but keeps the row."""
    res = await db.execute(
        select(VendorPayment)
        .options(selectinload(VendorPayment.allocations))
        .where(VendorPayment.id == payment_id)
    )
    pay = res.unique().scalar_one_or_none()
    if not pay:
        raise HTTPException(404, "Payment not found")
    await enforce_branch_access(pay.branch_id, user=user, db=db)
    if getattr(pay, "voided", False):
        return {"status": "voided", "number": pay.number}

    alloc_by_bill: dict[str, float] = {}
    status_before: dict[str, str] = {}
    bill_number_by_id: dict[str, str] = {}
    for alloc in pay.allocations:
        alloc_by_bill[alloc.bill_id] = round(alloc_by_bill.get(alloc.bill_id, 0.0) + float(alloc.amount or 0), 2)
        bill = (await db.execute(select(PurchaseBill).where(PurchaseBill.id == alloc.bill_id))).scalar_one_or_none()
        if bill is not None:
            status_before[bill.id] = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
            bill_number_by_id[bill.id] = bill.number

    await reverse_vendor_payment(db, pay)
    pay.voided = True
    pay.voided_at = datetime.now().strftime("%Y-%m-%d")
    await void_payment_record(
        db,
        source_document_type="vendor_payment",
        source_document_id=pay.id,
        voided_at=pay.voided_at,
    )
    if pay.payment_mode == "cash":
        await void_cash_for_payment(
            db,
            source_type="purchase_payment",
            source_id=pay.id,
            voided_by="Staff",
            reason=f"Vendor payment {pay.number} voided",
        )

    for bill_id, amount in alloc_by_bill.items():
        bill = (await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))).scalar_one_or_none()
        if bill is None:
            continue
        _log_purchase_bill_history(db, user=user,
            bill_id=bill.id,
            bill_number=bill.number,
            event_type="payment_voided",
            action="void_purchase_payment",
            detail=f"Voided payment {pay.number} allocation on {bill.number}",
            metadata={
                "payment_id": pay.id,
                "payment_number": pay.number,
                "amount": round(float(amount), 2),
            },
            risk="medium",
        )
        prev_status = status_before.get(bill.id)
        next_status = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
        if prev_status and prev_status != next_status:
            _log_purchase_bill_history(db, user=user,
                bill_id=bill.id,
                bill_number=bill.number,
                event_type="status_changed",
                action="update_purchase_bill_status",
                detail=f"Status changed: {prev_status} -> {next_status}",
                metadata={"from": prev_status, "to": next_status},
            )

    db.add(AuditLog(
        id=str(uuid.uuid4()),
        action="void_vendor_payment",
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="purchases",
        ref=pay.number,
        detail=f"Voided vendor payment {pay.number} (MVR{pay.total_amount})",
        risk="medium",
        ip_address=None,
    ))
    await db.commit()
    return {"status": "voided", "number": pay.number}


# ─── PAYMENTS: CREATE (multi-bill) ──────────────────────────────────────────
@router.post("/payments/", status_code=201, dependencies=[Depends(require_perm("purchases.edit"))])
async def create_payment(data: VendorPaymentCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Record a payment to a vendor across one or more bills.

    Allocation amount may exceed bill balance — excess accumulates in
    credit_applied and bumps vendor.credit_balance. Credit mode debits
    vendor advance instead of cash.
    """
    vendor = (await db.execute(
        select(Vendor).where(Vendor.id == data.vendor_id)
    )).scalar_one_or_none()
    if not vendor:
        raise HTTPException(404, "Vendor not found")

    bill_ids = [a.bill_id for a in data.allocations]
    if len(set(bill_ids)) != len(bill_ids):
        raise HTTPException(400, "Duplicate bill in allocations")
    bill_rows = (await db.execute(
        select(PurchaseBill).where(PurchaseBill.id.in_(bill_ids))
    )).scalars().all()
    if len(bill_rows) != len(bill_ids):
        raise HTTPException(400, "One or more bills not found")
    bill_by_id = {b.id: b for b in bill_rows}
    branch_ids = {b.branch_id for b in bill_rows if b.branch_id}
    for branch_id in branch_ids:
        await enforce_branch_access(branch_id, user=user, db=db)
    if data.branch_id is not None:
        await enforce_branch_access(data.branch_id, user=user, db=db)
    for b in bill_rows:
        if b.vendor_id != data.vendor_id:
            raise HTTPException(
                400,
                f"Bill {b.number} does not belong to {vendor.name}",
            )
        st = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
        if st == "cancelled":
            raise HTTPException(400, f"Bill {b.number} is cancelled")
        balance = max(0.0, float(b.total or 0) - float(b.paid_amount or 0))
        if balance <= 0:
            raise HTTPException(400, f"Bill {b.number} already settled")

    requested_total = sum(float(a.amount) for a in data.allocations)
    if data.payment_mode == "credit":
        for a in data.allocations:
            b = bill_by_id[a.bill_id]
            balance = max(0.0, float(b.total or 0) - float(b.paid_amount or 0))
            if float(a.amount) > balance + 0.001:
                raise HTTPException(
                    400,
                    f"Credit mode can't overpay — {b.number} balance is MVR{round(balance, 2)}",
                )
        avail = float(vendor.credit_balance or 0)
        if avail + 0.001 < requested_total:
            raise HTTPException(
                400,
                f"Insufficient vendor credit — {vendor.name} has MVR{round(avail, 2)} available, "
                f"payment totals MVR{round(requested_total, 2)}",
            )

    total_credit = 0.0
    total_amount = 0.0
    today = datetime.now().strftime("%Y-%m-%d")
    bill_status_before: dict[str, str] = {}
    for a in data.allocations:
        b = bill_by_id[a.bill_id]
        bill_status_before[b.id] = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
        balance = max(0.0, float(b.total or 0) - float(b.paid_amount or 0))
        applied = min(float(a.amount), balance)
        excess = max(0.0, float(a.amount) - balance)
        b.paid_amount = round(float(b.paid_amount or 0) + applied, 2)
        b.payment_mode = data.payment_mode
        b.status = "paid" if b.paid_amount >= float(b.total or 0) else "partial"
        total_credit += excess
        total_amount += float(a.amount)

    count = (await db.execute(select(func.count(VendorPayment.id)))).scalar() or 0
    pay_num = f"VPAY-{datetime.now().year}-{1000 + count:04d}"

    if total_credit > 0:
        await adjust_vendor_credit(
            db,
            data.vendor_id,
            total_credit,
            entry_type="overpayment",
            source_type="vendor_payment",
            source_number=pay_num,
        )
        db.add(AuditLog(
            id=str(uuid.uuid4()),
            action="vendor_credit",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
            module="purchases",
            ref=None,
            detail=(
                f"Multi-bill payment overpayment: +MVR{round(total_credit, 2)} "
                f"credited to {vendor.name}"
            ),
            risk="low",
            ip_address=None,
        ))

    payment = VendorPayment(
        id=str(uuid.uuid4()),
        number=pay_num,
        vendor_id=data.vendor_id,
        vendor_name=vendor.name,
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
        b = bill_by_id[a.bill_id]
        db.add(VendorPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=payment.id,
            bill_id=b.id,
            bill_number=b.number,
            amount=round(float(a.amount), 2),
        ))

    if data.payment_mode == "credit":
        await adjust_vendor_credit(
            db,
            data.vendor_id,
            -round(total_amount, 2),
            entry_type="payment_debit",
            source_type="vendor_payment",
            source_ref=payment.id,
            source_number=pay_num,
        )

    await record_vendor_payment(db, payment)
    if data.payment_mode == "cash":
        await record_cash_out(
            db,
            branch_id=data.branch_id or "",
            amount=round(total_amount, 2),
            date=data.date or today,
            description=f"Vendor payment {pay_num}",
            category="Purchase — Cash Payment",
            source_type="purchase_payment",
            source_id=payment.id,
            source_ref=pay_num,
            recorded_by=data.created_by or "Staff",
        )
    await sync_vendor_outstanding(db, data.vendor_id)

    for a in data.allocations:
        b = bill_by_id[a.bill_id]
        _log_purchase_bill_history(db, user=user,
            bill_id=b.id,
            bill_number=b.number,
            event_type="payment_recorded",
            action="record_purchase_payment",
            detail=f"Recorded payment of {round(float(a.amount), 2)} for {b.number}",
            metadata={
                "payment_id": payment.id,
                "payment_number": payment.number,
                "amount": round(float(a.amount), 2),
                "payment_mode": data.payment_mode,
                "payment_ref": data.payment_ref or "",
            },
        )
        prev_status = bill_status_before.get(b.id)
        next_status = str(b.status.value) if hasattr(b.status, "value") else str(b.status)
        if prev_status and prev_status != next_status:
            _log_purchase_bill_history(db, user=user,
                bill_id=b.id,
                bill_number=b.number,
                event_type="status_changed",
                action="update_purchase_bill_status",
                detail=f"Status changed: {prev_status} -> {next_status}",
                metadata={"from": prev_status, "to": next_status},
            )

    await db.commit()
    return {
        "id": payment.id,
        "number": pay_num,
        "total_amount": round(total_amount, 2),
        "credit_applied": round(total_credit, 2),
        "allocations_count": len(data.allocations),
    }


# ─── VENDOR RETURNS ────────────────────────────────────────────────────────────
class ReturnLine(BaseModel):
    # 2026-05-25: bill_line_id is the preferred matcher when the
    # frontend has it (always for fresh returns; absent on legacy /
    # API-only callers). Backend falls back to (item_id, name) lookup.
    bill_line_id: Optional[str] = None
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


async def _already_returned_for_bill(
    db: AsyncSession, bill_id: str
) -> dict[str, int]:
    """Sum return_qty per bill_line_id across active VendorReturns for this bill."""
    res = await db.execute(
        select(
            ReturnLineItem.bill_line_id,
            func.coalesce(func.sum(ReturnLineItem.return_qty), 0),
        )
        .join(VendorReturn, ReturnLineItem.return_id == VendorReturn.id)
        .where(
            VendorReturn.bill_id == bill_id,
            or_(VendorReturn.voided == False, VendorReturn.voided.is_(None)),  # noqa: E712
        )
        .group_by(ReturnLineItem.bill_line_id)
    )
    return {row[0]: int(row[1]) for row in res.all() if row[0]}


async def _reverse_vendor_return_effects(db: AsyncSession, ret: VendorReturn) -> None:
    """Undo stock + bill adjustments from a processed vendor return."""
    for rl in ret.line_items:
        if not rl.batch_allocation:
            continue
        try:
            ledger = json.loads(rl.batch_allocation)
        except (ValueError, TypeError):
            ledger = []
        for entry in ledger:
            qty = int(entry.get("consumed") or 0)
            if qty <= 0:
                continue
            batch_id = entry.get("batch_id")
            restored = False
            if batch_id:
                b = (await db.execute(
                    select(ItemBatch).where(ItemBatch.id == batch_id)
                )).scalar_one_or_none()
                if b is not None:
                    await set_batch_quantity_atomic(
                        db, batch_id=batch_id, new_qty=int(b.quantity or 0) + qty,
                    )
                    restored = True
            if not restored and rl.item_id:
                try:
                    await adjust_stock_atomic(
                        db, item_id=rl.item_id, branch_id=ret.branch_id, delta=qty,
                        movement_type="vendor_return_void",
                        source_type="vendor_return",
                        source_ref=ret.id,
                    )
                except ValueError:
                    pass

    bill = (await db.execute(
        select(PurchaseBill).where(PurchaseBill.id == ret.bill_id)
    )).scalar_one_or_none()
    if bill is not None:
        bill.total = round(float(bill.total or 0) + float(ret.total or 0), 2)
        bill.paid_amount = round(
            float(bill.paid_amount or 0) + float(ret.credited_amount or 0), 2,
        )
        if bill.paid_amount >= bill.total:
            bill.status = "paid"
        elif bill.paid_amount > 0:
            bill.status = "partial"
        else:
            bill.status = "pending"

@router.get("/returns/", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def list_returns(
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    status: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = []
    if vendor_id:
        conds.append(VendorReturn.vendor_id == vendor_id)
    if status:
        conds.append(VendorReturn.status == status)
    if search:
        conds.append(or_(VendorReturn.number.ilike(f"%{search}%"), VendorReturn.vendor_name.ilike(f"%{search}%")))
    if date_from:
        conds.append(VendorReturn.date >= date_from)
    if date_to:
        conds.append(VendorReturn.date <= date_to)
    if branch_id is not None:
        conds.append(VendorReturn.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(VendorReturn.branch_id.in_(branch_ids))
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

@router.get("/returns/{return_id}", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def get_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):

    result = await db.execute(select(VendorReturn).where(VendorReturn.id == return_id))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(404, "Return not found")
    await enforce_branch_access(r.branch_id, user=user, db=db)
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == return_id))
    return _return_dict(r, li_res.scalars().all())

@router.post("/returns/", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def create_return(data: VendorReturnCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Process a vendor return against an existing bill.

    2026-05-25 changes:
      • Per-line cumulative cap — matches sales returns. Rejects when
        new return_qty + already-returned-from-prior-returns > bill
        line's original qty. Was previously possible to return the same
        bill twice with the full qty (over-return).
      • Status defaults to `paid` (terminal / processed). The legacy
        `pending → approve` workflow was artificial — a vendor return
        is a recorded event, not a 2-step approval. Existing pending
        rows in the DB can still be approved via /returns/{id}/approve
        for backwards compat, but new rows skip that step.
      • Per-line resolution prefers `bill_line_id` (sent by the new
        VendorReturnFormModal); falls back to (item_id, name) matching
        for legacy / API-only callers.
    """
    bill_result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == data.bill_id))
    bill = bill_result.scalar_one_or_none()
    if not bill:
        raise HTTPException(404, "Bill not found")
    await enforce_branch_access(bill.branch_id, user=user, db=db)
    bill_status = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
    if bill_status == "cancelled":
        raise HTTPException(400, "Bill is cancelled — cannot return against it")

    # Load the bill's line items so we can resolve each return line to
    # a specific bill_line + enforce the per-line cap.
    bill_li_res = await db.execute(
        select(PurchaseLineItem).where(PurchaseLineItem.bill_id == data.bill_id)
    )
    bill_lines = bill_li_res.scalars().all()
    bill_line_by_id = {bl.id: bl for bl in bill_lines}
    # (item_id, name) is the fallback key for legacy callers that don't
    # carry bill_line_id. Skip lines with no item_id (free-typed legacy
    # bill lines can't be reliably matched).
    bill_line_by_item = {
        (bl.item_id, bl.name): bl
        for bl in bill_lines
        if bl.item_id
    }

    # Cumulative prior returns per bill line, summed across every
    # existing vendor return for THIS bill.
    already_returned = await _already_returned_for_bill(db, data.bill_id)

    # Validate every requested return line + collect the resolved
    # (return_line_in, bill_line, line_net, line_tax) tuples so we
    # don't have to re-resolve in the persistence loop below.
    tax_mode = await _get_org_tax_mode(db)
    return_rows = []
    subtotal = 0.0
    tax_total = 0.0
    for r in data.items:
        if r.return_qty <= 0:
            raise HTTPException(400, f"{r.name}: return qty must be > 0")
        # Resolve which bill line we're returning against.
        bill_line = None
        if r.bill_line_id and r.bill_line_id in bill_line_by_id:
            bill_line = bill_line_by_id[r.bill_line_id]
        elif r.item_id and (r.item_id, r.name) in bill_line_by_item:
            bill_line = bill_line_by_item[(r.item_id, r.name)]
        if not bill_line:
            raise HTTPException(
                400,
                f"{r.name}: no matching line on bill {bill.number}",
            )
        prior = already_returned.get(bill_line.id, 0)
        remaining = max(0, int(bill_line.qty or 0) - prior)
        if r.return_qty > remaining:
            raise HTTPException(
                400,
                f"{r.name}: only {remaining} returnable "
                f"({bill_line.qty} received, {prior} already returned)",
            )
        line_net = round(r.return_qty * r.cost, 2)
        line_tax = line_tax_amount(line_net, r.tax_rate or 0, tax_mode)
        return_rows.append((r, bill_line, line_net, line_tax))
        subtotal += line_taxable_amount(line_net, r.tax_rate or 0, tax_mode)
        tax_total += line_tax

    today = datetime.now().strftime("%Y-%m-%d")
    count_res = await db.execute(select(func.count(VendorReturn.id)))
    count = count_res.scalar() or 0
    return_num = f"RET-{datetime.now().year}-{300 + count:04d}"

    vendor_result = await db.execute(select(Vendor).where(Vendor.id == data.vendor_id))
    vendor = vendor_result.scalar_one_or_none()

    return_total = round(subtotal + tax_total, 2)
    bill_paid = float(bill.paid_amount or 0)
    # Mirror sales returns: full return value reduces bill.total; any
    # payment already made is reduced by up to the return total.
    credited = round(min(return_total, bill_paid), 2)

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
        total=return_total,
        credited_amount=credited,
        # 2026-05-25: vendor returns now land as `paid` (= processed /
        # terminal). The /returns/{id}/approve endpoint stays for legacy
        # data but isn't used by the new UI.
        status="paid",
        notes=data.notes,
    )
    db.add(ret)

    for r, bill_line, _ln, _lt in return_rows:
        # 2026-05-31: a vendor return SENDS GOODS BACK to the vendor, so it
        # must DECREMENT stock at the bill's branch (previously this was a
        # no-op — returns recorded paperwork but never moved stock).
        #   • Tracked items → consume FEFO (expiry) / FIFO via
        #     consume_batches_atomic; capture the ledger so deletion can
        #     reverse the exact lots.
        #   • Untracked items → aggregate decrement; store a sentinel ledger.
        # Insufficient on-hand → ValueError → 400 (block). Nothing commits,
        # so the session rolls back cleanly.
        allocation_json = None
        if r.item_id:
            tracked, _expiry_tracked = await is_tracked(db, r.item_id)
            if not tracked:
                # Untracked: aggregate decrement, blocked if it would go < 0.
                try:
                    await adjust_stock_atomic(
                        db, item_id=r.item_id, branch_id=bill.branch_id,
                        delta=-int(r.return_qty),
                        movement_type="vendor_return",
                        source_type="vendor_return",
                        source_ref=ret.id,
                    )
                except ValueError:
                    raise HTTPException(
                        400,
                        f"{r.name}: not enough stock on hand to return {r.return_qty} unit(s)",
                    )
                allocation_json = json.dumps([{"batch_id": None, "consumed": int(r.return_qty)}])
            else:
                # 2026-05-31: subtract from THIS BILL's own lot(s) only — the
                # batch(es) this receipt created (GRN id, or legacy bill id).
                stock_ref = bill.grn_id or bill.id
                bill_batches = (await db.execute(
                    select(ItemBatch).where(
                        ItemBatch.source_ref == stock_ref,
                        ItemBatch.item_id == r.item_id,
                        ItemBatch.branch_id == bill.branch_id,
                    ).order_by(ItemBatch.expiry_date.asc())
                )).scalars().all()
                available = sum(int(b.quantity or 0) for b in bill_batches)
                if int(r.return_qty) > available:
                    raise HTTPException(
                        400,
                        f"{r.name}: only {available} unit(s) from this bill's batch remain on "
                        f"hand (the rest were already sold or moved)",
                    )
                # Build an explicit FEFO split across the bill's lots, then
                # consume exactly those — keeps batch + aggregate atomic.
                remaining = int(r.return_qty)
                split = []
                for b in bill_batches:
                    if remaining <= 0:
                        break
                    take = min(int(b.quantity or 0), remaining)
                    if take > 0:
                        split.append({"batch_id": b.id, "qty": take})
                        remaining -= take
                try:
                    ledger = await consume_batches_atomic(
                        db,
                        item_id=r.item_id,
                        branch_id=bill.branch_id,
                        qty=int(r.return_qty),
                        explicit_allocation=split,
                        movement_type="vendor_return",
                        source_type="vendor_return",
                        source_ref=ret.id,
                    )
                except ValueError:
                    raise HTTPException(
                        400,
                        f"{r.name}: could not subtract {r.return_qty} unit(s) from this bill's batch",
                    )
                allocation_json = json.dumps(
                    [{"batch_id": e["batch_id"], "consumed": e["consumed"]} for e in ledger]
                )
        db.add(ReturnLineItem(
            id=str(uuid.uuid4()),
            return_id=ret.id,
            bill_line_id=bill_line.id,
            item_id=r.item_id,
            name=r.name,
            original_qty=r.original_qty,
            return_qty=r.return_qty,
            cost=r.cost,
            tax_rate=r.tax_rate,
            line_total=round(r.return_qty * r.cost, 2),
            batch_allocation=allocation_json,
        ))

    bill.total = round(max(0.0, float(bill.total or 0) - return_total), 2)
    bill.paid_amount = round(max(0.0, bill_paid - credited), 2)
    if bill.paid_amount >= bill.total:
        bill.status = "paid"
    elif bill.paid_amount > 0:
        bill.status = "partial"
    else:
        bill.status = "pending"

    await recalc_bill_after_vendor_credit(db, bill.id)

    await sync_vendor_outstanding(db, bill.vendor_id)

    _log_vendor_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="created",
        action="create_vendor_return",
        detail=f"Created vendor return {ret.number}",
        metadata={
            "total": round(float(ret.total or 0), 2),
            "credited_amount": round(float(ret.credited_amount or 0), 2),
            "item_count": len(return_rows),
            "reason": ret.reason,
            "target_record_type": "purchase_bill",
            "target_record_id": ret.bill_id,
            "target_record_number": ret.bill_number,
        },
    )

    await db.commit()
    await db.refresh(ret)
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == ret.id))
    return _return_dict(ret, li_res.scalars().all())

@router.post("/returns/{return_id}/approve", dependencies=[Depends(require_perm("purchases.edit"))])
async def approve_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(select(VendorReturn).where(VendorReturn.id == return_id))
    ret = result.scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    await enforce_branch_access(ret.branch_id, user=user, db=db)
    ret.status = "paid"
    await db.commit()
    li_res = await db.execute(select(ReturnLineItem).where(ReturnLineItem.return_id == return_id))
    return _return_dict(ret, li_res.scalars().all())


@router.post("/returns/{return_id}/void", dependencies=[Depends(require_perm("purchases.edit"))])
async def void_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Soft-void a vendor return — reverses stock + bill adjustments but keeps the row."""
    res = await db.execute(
        select(VendorReturn)
        .options(selectinload(VendorReturn.line_items))
        .where(VendorReturn.id == return_id)
    )
    ret = res.unique().scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    await enforce_branch_access(ret.branch_id, user=user, db=db)
    if getattr(ret, "voided", False):
        return {"status": "void", "number": ret.number}

    await _reverse_vendor_return_effects(db, ret)
    ret.voided = True
    ret.voided_at = datetime.now().strftime("%Y-%m-%d")
    await db.flush()
    await recalc_bill_after_vendor_credit(db, ret.bill_id)
    if ret.vendor_id:
        await sync_vendor_outstanding(db, ret.vendor_id)

    _log_vendor_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="voided",
        action="void_vendor_return",
        detail=f"Voided vendor return {ret.number}",
        metadata={
            "target_record_type": "purchase_bill",
            "target_record_id": ret.bill_id,
            "target_record_number": ret.bill_number,
        },
        risk="medium",
    )

    await db.commit()
    return {"status": "void", "number": ret.number}


@router.post("/returns/{return_id}/undo-void", dependencies=[Depends(require_perm("purchases.edit"))])
async def undo_void_vendor_return(return_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Restore a voided vendor return — re-applies stock + bill adjustments.

    Blocked if another active return has already consumed the same line
    quantities or reduced the bill balance to the point where re-applying
    this one would push it negative (double-entry prevention).
    """
    res = await db.execute(
        select(VendorReturn)
        .options(selectinload(VendorReturn.line_items))
        .where(VendorReturn.id == return_id)
    )
    ret = res.unique().scalar_one_or_none()
    if not ret:
        raise HTTPException(404, "Return not found")
    await enforce_branch_access(ret.branch_id, user=user, db=db)
    if not getattr(ret, "voided", False):
        return {"status": "active", "number": ret.number}

    # ── Pre-flight: check for conflicts BEFORE mutating anything ──────────────
    bill = (await db.execute(
        select(PurchaseBill).where(PurchaseBill.id == ret.bill_id)
    )).scalar_one_or_none()
    if bill is None:
        raise HTTPException(404, "Original bill not found")

    # Guard 1: bill total must not go negative after re-applying this return.
    new_bill_total = round(float(bill.total or 0) - float(ret.total or 0), 2)
    if new_bill_total < -0.01:
        raise HTTPException(
            400,
            f"Cannot undo void: the bill balance is already MVR{round(float(bill.total or 0), 2)} "
            f"and re-applying {ret.number} (MVR{round(float(ret.total or 0), 2)}) would make it "
            f"negative. Another active vendor return has likely consumed the same amount. "
            f"Void that return first, then undo this one."
        )

    # Guard 2: per-line quantity — no item returned more times than received.
    already_returned = await _already_returned_for_bill(db, ret.bill_id)
    bill_lines = (await db.execute(
        select(PurchaseLineItem).where(PurchaseLineItem.bill_id == ret.bill_id)
    )).scalars().all()
    bill_lines_by_id = {li.id: li for li in bill_lines}
    conflicts = []
    for rl in ret.line_items:
        if not rl.bill_line_id:
            continue
        existing = already_returned.get(rl.bill_line_id, 0)
        bill_line = bill_lines_by_id.get(rl.bill_line_id)
        original_qty = int(bill_line.qty or 0) if bill_line else 0
        if existing + int(rl.return_qty or 0) > original_qty:
            conflicts.append(rl.name or rl.bill_line_id)
    if conflicts:
        items_str = ", ".join(f"'{n}'" for n in conflicts[:3])
        raise HTTPException(
            400,
            f"Cannot undo void: line(s) {items_str} have already been fully returned by "
            f"another active vendor return. Void that return first, then undo this one."
        )
    # ── End pre-flight ─────────────────────────────────────────────────────────

    # Re-apply original stock effects (re-remove from batches — inverse of void's restore).
    for rl in ret.line_items:
        if not rl.batch_allocation:
            continue
        try:
            ledger = json.loads(rl.batch_allocation)
        except (ValueError, TypeError):
            ledger = []
        for entry in ledger:
            qty = int(entry.get("consumed") or 0)
            if qty <= 0:
                continue
            batch_id = entry.get("batch_id")
            applied = False
            if batch_id:
                b = (await db.execute(
                    select(ItemBatch).where(ItemBatch.id == batch_id)
                )).scalar_one_or_none()
                if b is not None:
                    await set_batch_quantity_atomic(
                        db, batch_id=batch_id, new_qty=max(0, int(b.quantity or 0) - qty),
                    )
                    applied = True
            if not applied and rl.item_id:
                try:
                    await adjust_stock_atomic(
                        db, item_id=rl.item_id, branch_id=ret.branch_id, delta=-qty,
                        movement_type="vendor_return_undo_void",
                        source_type="vendor_return", source_ref=ret.id,
                    )
                except ValueError:
                    pass

    # Reverse bill-side effects of the void (bill already loaded above).
    bill.total = round(float(bill.total or 0) - float(ret.total or 0), 2)
    bill.paid_amount = round(float(bill.paid_amount or 0) - float(ret.credited_amount or 0), 2)
    if bill.paid_amount >= bill.total:
        bill.status = "paid"
    elif bill.paid_amount > 0:
        bill.status = "partial"
    else:
        bill.status = "pending"

    ret.voided = False
    ret.voided_at = None
    await db.flush()
    await recalc_bill_after_vendor_credit(db, ret.bill_id)
    if ret.vendor_id:
        await sync_vendor_outstanding(db, ret.vendor_id)

    _log_vendor_return_history(db, user=user,
        return_id=ret.id,
        return_number=ret.number,
        event_type="unvoided",
        action="undo_void_vendor_return",
        detail=f"Unvoided vendor return {ret.number}",
        metadata={
            "target_record_type": "purchase_bill",
            "target_record_id": ret.bill_id,
            "target_record_number": ret.bill_number,
        },
        risk="medium",
    )

    await db.commit()
    return {"status": "active", "number": ret.number}


# ─── HELPER ───────────────────────────────────────────────────────────────────
def _return_dict(r, items=None):
    voided = bool(getattr(r, "voided", False))
    d = {
        "id": r.id, "number": r.number,
        "billId": r.bill_id, "billNumber": r.bill_number,
        "vendorId": r.vendor_id, "vendorName": r.vendor_name,
        "branchId": r.branch_id, "branchName": r.branch_name,
        "date": r.date, "reason": r.reason,
        "subtotal": r.subtotal, "taxTotal": r.tax_total,
        "total": r.total, "creditedAmount": r.credited_amount,
        "status": "void" if voided else (
            str(r.status.value) if hasattr(r.status, "value") else str(r.status)
        ),
        "voided": voided,
        "voidedAt": getattr(r, "voided_at", None),
        "notes": r.notes,
    }
    if items is not None:
        if len(items) > 0 and isinstance(items[0], dict):
            d["items"] = items
        else:
            d["items"] = [{
                "id": i.id,
                # 2026-05-25: billLineId + itemId added so the frontend's
                # VendorReturnFormModal.loadBill can sum prior returns
                # per bill line and cap the Returnable cell correctly.
                "billLineId": getattr(i, "bill_line_id", None),
                "itemId": i.item_id,
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
        "creditedAmount": float(getattr(b, "credited_amount", 0) or 0),
        "returnStatus": getattr(b, "return_status", None) or "none",
        "grnId": getattr(b, "grn_id", None),
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
    discount: float = 0
    number: Optional[str] = None
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


async def _get_org_tax_mode(db: AsyncSession) -> str:
    org_row = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    return normalize_tax_pricing_mode(org_row.tax_pricing_mode if org_row else None)


def _calc_po_lines(lines, tax_mode: str = "inclusive"):
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
        line_tax = line_tax_amount(line_net, i.tax_rate or 0, tax_mode)
        rows.append((i, line_net, line_tax))
        subtotal += line_taxable_amount(line_net, i.tax_rate or 0, tax_mode)
        tax_total += line_tax
    return rows, subtotal, tax_total


def _po_terminal(po) -> bool:
    s = str(po.status.value) if hasattr(po.status, "value") else str(po.status)
    return s in ("converted", "cancelled")


async def _next_grn_number(db: AsyncSession) -> str:
    count = (await db.execute(select(func.count(GoodsReceiptNote.id)))).scalar() or 0
    return f"GRN-{datetime.now().year}-{500 + count:04d}"


async def _next_bill_number(db: AsyncSession) -> str:
    count = (await db.execute(select(func.count(PurchaseBill.id)))).scalar() or 0
    return f"PUR-{datetime.now().year}-{400 + count:04d}"


async def _create_grn_received(
    db: AsyncSession,
    *,
    vendor_id: str,
    vendor_name: str,
    branch_id: str,
    branch_name: str,
    date: Optional[str] = None,
    request: Request = None,
    line_rows: list,
    discount: float = 0,
    notes: Optional[str] = None,
    created_by: str = "Staff",
    purchase_order_id: Optional[str] = None,
    po_number: Optional[str] = None,
    number: Optional[str] = None,
    tax_mode: str = "inclusive",
) -> GoodsReceiptNote:
    """Create a received GRN and move stock. `line_rows` is
    [(line, line_net, line_tax), ...] where line has item_id, name, qty,
    cost, tax_rate, discount, batch_number, mfg_date, expiry_date."""
    if tax_mode == "inclusive":
        subtotal = sum(ln - lt for _, ln, lt in line_rows)
    else:
        subtotal = sum(ln for _, ln, _ in line_rows)
    tax_total = sum(lt for _, _, lt in line_rows)
    total = round(subtotal + tax_total - (discount or 0), 2)

    async def _alloc_grn() -> str:
        return await _next_grn_number(db)

    grn_number = await resolve_number(
        db,
        requested=number,
        model=GoodsReceiptNote,
        allocate=_alloc_grn,
    )
    grn = GoodsReceiptNote(
        id=str(uuid.uuid4()),
        number=grn_number,
        vendor_id=vendor_id,
        vendor_name=vendor_name,
        branch_id=branch_id,
        branch_name=branch_name or branch_id,
        purchase_order_id=purchase_order_id,
        po_number=po_number,
        date=date,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(discount or 0, 2),
        total=total,
        status=GRNStatus.received,
        notes=notes,
        created_by=created_by,
    )
    db.add(grn)
    receipt_lines: list[ReceiptLine] = []
    for line, line_net, line_tax in line_rows:
        qty = int(getattr(line, "received_qty", None) or getattr(line, "qty", 0) or 0)
        db.add(GRNLineItem(
            id=str(uuid.uuid4()),
            grn_id=grn.id,
            po_line_id=getattr(line, "po_line_id", None) or getattr(line, "id", None),
            item_id=line.item_id,
            name=line.name,
            ordered_qty=getattr(line, "ordered_qty", None),
            received_qty=qty,
            cost=line.cost,
            tax_rate=getattr(line, "tax_rate", 0) or 0,
            discount=getattr(line, "discount", 0) or 0,
            line_total=round(line_net + line_tax if tax_mode == "exclusive" else line_net, 2),
            batch_number=getattr(line, "batch_number", None),
            mfg_date=getattr(line, "mfg_date", None),
            expiry_date=getattr(line, "expiry_date", None),
        ))
        receipt_lines.append(ReceiptLine(
            item_id=line.item_id,
            name=line.name,
            qty=qty,
            cost=line.cost,
            batch_number=getattr(line, "batch_number", None),
            mfg_date=getattr(line, "mfg_date", None),
            expiry_date=getattr(line, "expiry_date", None),
        ))
    try:
        await receive_lines_to_stock(
            db,
            grn_id=grn.id,
            branch_id=branch_id,
            vendor_id=vendor_id,
            received_date=date,
            lines=receipt_lines,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    await db.flush()
    await db.refresh(grn, attribute_names=["line_items"])
    return grn


async def _create_bill_for_grn(
    db: AsyncSession,
    grn: GoodsReceiptNote,
    *,
    due_date: Optional[str] = None,
    payment_mode: Optional[str] = None,
    payment_ref: str = "",
    notes: Optional[str] = None,
    paid_amount: float = 0.0,
) -> PurchaseBill:
    """Financial bill from an already-received GRN — no stock side-effect."""
    bill_status = "paid" if paid_amount >= grn.total else "pending"
    bill = PurchaseBill(
        id=str(uuid.uuid4()),
        number=await _next_bill_number(db),
        vendor_id=grn.vendor_id,
        vendor_name=grn.vendor_name,
        branch_id=grn.branch_id,
        branch_name=grn.branch_name,
        date=grn.date,
        due_date=due_date,
        subtotal=grn.subtotal,
        tax_total=grn.tax_total,
        discount=grn.discount,
        total=grn.total,
        paid_amount=round(paid_amount, 2),
        payment_mode=payment_mode,
        payment_ref=payment_ref or "",
        status=bill_status,
        grn_id=grn.id,
        notes=notes or grn.notes,
    )
    db.add(bill)
    for gli in grn.line_items:
        db.add(PurchaseLineItem(
            id=str(uuid.uuid4()),
            bill_id=bill.id,
            item_id=gli.item_id,
            name=gli.name,
            qty=gli.received_qty,
            cost=gli.cost,
            tax_rate=gli.tax_rate,
            discount=gli.discount or 0,
            line_total=gli.line_total,
        ))
    # Bill must be flushed before back-linking — GRN.converted_bill_id FK
    # points at purchase_bills.id and PostgreSQL rejects the UPDATE otherwise.
    await db.flush()
    grn.converted_bill_id = bill.id
    return bill


def _grn_dict(g, items=None):
    d = {
        "id": g.id,
        "number": g.number,
        "vendorId": g.vendor_id,
        "vendorName": g.vendor_name,
        "branchId": g.branch_id,
        "branchName": g.branch_name,
        "purchaseOrderId": g.purchase_order_id,
        "poNumber": g.po_number,
        "date": g.date,
        "subtotal": g.subtotal,
        "taxTotal": g.tax_total,
        "discount": g.discount,
        "total": g.total,
        "status": str(g.status.value) if hasattr(g.status, "value") else str(g.status),
        "convertedBillId": g.converted_bill_id,
        "notes": g.notes,
    }
    if items is not None:
        d["items"] = [{
            "id": i.id,
            "itemId": i.item_id,
            "name": i.name,
            "orderedQty": i.ordered_qty,
            "receivedQty": i.received_qty,
            "cost": i.cost,
            "taxRate": i.tax_rate,
            "discount": i.discount or 0,
            "lineTotal": i.line_total,
            "batchNumber": i.batch_number,
            "mfgDate": i.mfg_date,
            "expiryDate": i.expiry_date,
        } for i in items]
    return d


# ─── PO: LIST ─────────────────────────────────────────────────────────────────
@router.get("/orders/", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def list_orders(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    status: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    conds = []
    if vendor_id:
        conds.append(PurchaseOrder.vendor_id == vendor_id)
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
    if branch_id is not None:
        conds.append(PurchaseOrder.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, normalize_skip(skip), normalize_limit(limit))
        conds.append(PurchaseOrder.branch_id.in_(branch_ids))
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
@router.get("/orders/{order_id}", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def get_order(order_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(PurchaseOrder.id == order_id)
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    await enforce_branch_access(po.branch_id, user=user, db=db)
    return _po_dict(po, po.line_items)


# ─── PO: CREATE ───────────────────────────────────────────────────────────────
@router.post("/orders/", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def create_order(
    data: PurchaseOrderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    if not data.items:
        raise HTTPException(400, "Purchase order must have at least one line item")
    today = datetime.now().strftime("%Y-%m-%d")
    direct = await can_direct_commit(user, db, "purchases.approve")

    async def _alloc_po() -> str:
        count = (await db.execute(select(func.count(PurchaseOrder.id)))).scalar() or 0
        return f"PO-{datetime.now().year}-{1000 + count:04d}"

    po_num = await resolve_number(
        db,
        requested=data.number,
        model=PurchaseOrder,
        allocate=_alloc_po,
    )

    tax_mode = await _get_org_tax_mode(db)
    line_rows, subtotal, tax_total = _calc_po_lines(data.items, tax_mode)
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    # Enforce operator may create POs for this branch
    await enforce_branch_access(data.branch_id, user=user, db=db)

    po = PurchaseOrder(
        id=str(uuid.uuid4()), number=po_num,
        vendor_id=data.vendor_id,
        vendor_name=data.vendor_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        created_by=data.created_by or user.name,
        date=data.date or today,
        expected_date=data.expected_date,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount or 0, 2),
        total=total,
        status=(
            PurchaseOrderStatus.confirmed
            if direct
            else PurchaseOrderStatus.pending_approval
        ),
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
            line_total=round(line_taxable_amount(line_net, line.tax_rate or 0, tax_mode) + line_tax, 2),
        ))
    _log_purchase_order_history(db, user=user,
        order_id=po.id,
        order_number=po.number,
        event_type="created",
        action="create_purchase_order",
        detail=f"Created purchase order {po.number}",
        metadata={
            "status": str(po.status.value) if hasattr(po.status, "value") else str(po.status),
            "total": float(po.total or 0),
            "line_count": len(data.items),
        },
    )
    if not direct:
        from src.notifications.store import emit_po_pending, notify_refresh

        await emit_po_pending(db, po)
    await db.commit()
    if not direct:
        await notify_refresh()
    return {"id": po.id, "number": po_num, "total": total, "status": po.status.value}


# ─── PO: UPDATE ───────────────────────────────────────────────────────────────
@router.put("/orders/{order_id}", dependencies=[Depends(require_perm("purchases.edit"))])
async def update_order(order_id: str, data: PurchaseOrderCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
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

    item_changes = _summarize_purchase_order_item_changes(list(po.line_items or []), data.items)

    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(PurchaseOrderLineItem).where(PurchaseOrderLineItem.order_id == po.id))

    tax_mode = await _get_org_tax_mode(db)
    line_rows, subtotal, tax_total = _calc_po_lines(data.items, tax_mode)
    total = round(subtotal + tax_total - (data.discount or 0), 2)

    po.vendor_id = data.vendor_id
    po.vendor_name = data.vendor_name
    # Enforce operator may assign this branch
    await enforce_branch_access(data.branch_id, user=user, db=db)
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
            line_total=round(line_taxable_amount(line_net, line.tax_rate or 0, tax_mode) + line_tax, 2),
        ))

    preview = item_changes[0]["detail"] if item_changes else f"Updated line items for {po.number}"
    if len(item_changes) > 1:
        preview = f"{preview}; +{len(item_changes) - 1} more item change(s)"
    _log_purchase_order_history(db, user=user,
        order_id=po.id,
        order_number=po.number,
        event_type="item_changed",
        action="update_purchase_order_items",
        detail=preview,
        metadata={"changes": item_changes[:20], "line_count": len(data.items)},
    )
    await db.commit()
    return {"id": po.id, "number": po.number, "total": total, "status": po.status.value}


# ─── PO: STATUS ───────────────────────────────────────────────────────────────
class POApprove(BaseModel):
    notes: Optional[str] = None


@router.post("/orders/{order_id}/approve", dependencies=[Depends(require_perm("purchases.approve"))])
async def approve_order(
    order_id: str,
    body: POApprove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    res = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == order_id))
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.created_by and po.created_by == user.name and po.status == PurchaseOrderStatus.pending_approval:
        raise HTTPException(403, "You cannot approve your own purchase order")
    if po.status == PurchaseOrderStatus.confirmed:
        return {"status": "confirmed", "number": po.number, "already_processed": True}
    if po.status != PurchaseOrderStatus.pending_approval:
        raise HTTPException(400, f"PO is not pending approval (status={po.status.value})")
    po.status = PurchaseOrderStatus.confirmed
    if body.notes:
        po.notes = (po.notes or "") + f"\n[Approved by {user.name}] {body.notes}"
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.purchase_order_pending:{order_id}")
    await db.commit()
    await notify_refresh()
    return {"status": "confirmed", "number": po.number}


class POReject(BaseModel):
    notes: Optional[str] = None


@router.post("/orders/{order_id}/reject", dependencies=[Depends(require_perm("purchases.approve"))])
async def reject_order(
    order_id: str,
    body: POReject,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    res = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == order_id))
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status == PurchaseOrderStatus.cancelled:
        return {"status": "cancelled", "number": po.number, "already_processed": True}
    if po.status != PurchaseOrderStatus.pending_approval:
        raise HTTPException(400, f"Only pending-approval POs can be rejected (status={po.status.value})")
    po.status = PurchaseOrderStatus.cancelled
    if body.notes:
        po.notes = (po.notes or "") + f"\n[Rejected by {user.name}] {body.notes}"
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.purchase_order_pending:{order_id}")
    await db.commit()
    await notify_refresh()
    return {"status": "cancelled", "number": po.number}


@router.patch("/orders/{order_id}/status", dependencies=[Depends(require_perm("purchases.edit"))])
async def update_order_status(order_id: str, body: PurchaseOrderStatusIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Confirm / cancel a PO. `converted` cannot be set manually — only
    the /convert endpoint sets it (atomically with bill creation)."""
    target = (body.status or "").strip().lower()
    if target not in ("draft", "confirmed", "cancelled", "pending_approval"):
        raise HTTPException(400, "Invalid status — only draft / confirmed / cancelled / pending_approval allowed")
    res = await db.execute(select(PurchaseOrder).where(PurchaseOrder.id == order_id))
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if _po_terminal(po):
        raise HTTPException(400, "Cannot change status of a terminal-status purchase order")
    if po.status == PurchaseOrderStatus.partially_received:
        raise HTTPException(
            400,
            "Cannot cancel a PO with a pending goods receipt — bill or cancel the GRN first",
        )
    prev_status = str(po.status.value) if hasattr(po.status, "value") else str(po.status)
    po.status = target
    next_status = str(po.status.value) if hasattr(po.status, "value") else str(po.status)
    if target == "confirmed" and prev_status != "confirmed":
        _log_purchase_order_history(db, user=user,
            order_id=po.id,
            order_number=po.number,
            event_type="approved",
            action="approve_purchase_order",
            detail=f"Purchase order {po.number} approved",
            metadata={"from": prev_status, "to": next_status},
        )
    elif target == "cancelled" and prev_status != "cancelled":
        _log_purchase_order_history(db, user=user,
            order_id=po.id,
            order_number=po.number,
            event_type="cancelled",
            action="cancel_purchase_order",
            detail=f"Purchase order {po.number} cancelled",
            metadata={"from": prev_status, "to": next_status},
            risk="medium",
        )
    await db.commit()
    return {"status": po.status.value if hasattr(po.status, "value") else str(po.status)}


# ─── PO: CONVERT TO BILL ──────────────────────────────────────────────────────
@router.post("/orders/{order_id}/convert", dependencies=[Depends(require_perm("purchases.create"))])
async def convert_order_to_bill(
    order_id: str,
    data: ConvertPOToBillIn,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    """Spawn GRN (stock) + PurchaseBill (financial) from a PO.

    Per-line batch metadata via `line_receipts` — captured at physical delivery.
    Payment fields parallel SO→Invoice convert.
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
    if po.status == PurchaseOrderStatus.partially_received:
        raise HTTPException(
            400,
            "PO already has a goods receipt — open the GRN tab and create a bill from the pending receipt",
        )
    if po.status == PurchaseOrderStatus.cancelled:
        raise HTTPException(400, "Cannot convert a cancelled purchase order")
    if po.status == PurchaseOrderStatus.pending_approval:
        raise HTTPException(400, "Purchase order must be approved before converting to a bill")

    if data.payment_received and not (data.payment_mode or "").strip():
        raise HTTPException(400, "Pick a payment method (or uncheck Payment Received)")

    today = datetime.now().strftime("%Y-%m-%d")
    paid = po.total if data.payment_received else 0.0
    payment_mode = data.payment_mode if data.payment_received else None
    bill_status = "paid" if paid >= po.total else "pending"

    receipts_by_item = {}
    if data.line_receipts:
        for r in data.line_receipts:
            receipts_by_item[r.item_id] = r

    tax_mode = await _get_org_tax_mode(db)
    line_rows = []
    for line in po.line_items:
        recv = receipts_by_item.get(line.item_id)
        wrapper = type("Line", (), {
            "item_id": line.item_id,
            "name": line.name,
            "qty": line.qty,
            "cost": line.cost,
            "tax_rate": line.tax_rate,
            "discount": line.discount or 0,
            "id": line.id,
            "ordered_qty": line.qty,
            "batch_number": recv.batch_number if recv else None,
            "mfg_date": recv.mfg_date if recv else None,
            "expiry_date": recv.expiry_date if recv else None,
        })()
        gross = round(line.qty * line.cost, 2)
        line_net = round(gross * (1 - (line.discount or 0) / 100), 2)
        line_tax = line_tax_amount(line_net, line.tax_rate or 0, tax_mode)
        line_rows.append((wrapper, line_net, line_tax))

    grn = await _create_grn_received(
        db,
        vendor_id=po.vendor_id,
        vendor_name=po.vendor_name or "",
        branch_id=po.branch_id,
        branch_name=po.branch_name or po.branch_id,
        date=today,
        line_rows=line_rows,
        discount=po.discount or 0,
        notes=data.notes or po.notes,
        purchase_order_id=po.id,
        po_number=po.number,
        tax_mode=tax_mode,
    )
    bill = await _create_bill_for_grn(
        db,
        grn,
        due_date=data.due_date,
        payment_mode=payment_mode,
        payment_ref=data.payment_ref or "",
        notes=data.notes or po.notes,
        paid_amount=round(paid, 2),
    )

    if data.payment_received and paid > 0:
        pay_count = (await db.execute(select(func.count(VendorPayment.id)))).scalar() or 0
        bpay = VendorPayment(
            id=str(uuid.uuid4()),
            number=f"VPAY-{datetime.now().year}-{1000 + pay_count:04d}",
            vendor_id=bill.vendor_id,
            vendor_name=bill.vendor_name,
            branch_id=bill.branch_id,
            branch_name=bill.branch_name,
            date=today,
            total_amount=round(paid, 2),
            payment_mode=payment_mode,
            payment_ref=data.payment_ref or "",
            notes="Bill paid at PO conversion",
            created_by="Staff",
        )
        db.add(bpay)
        db.add(VendorPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=bpay.id,
            bill_id=bill.id,
            bill_number=bill.number,
            amount=round(paid, 2),
        ))
        await record_vendor_payment(db, bpay)

    _log_purchase_bill_history(db, user=user,
        bill_id=bill.id,
        bill_number=bill.number,
        event_type="created",
        action="create_purchase_bill",
        detail=f"Created purchase bill {bill.number} from purchase order {po.number}",
        metadata={
            "source": "purchase_order",
            "source_record_id": po.id,
            "source_record_number": po.number,
            "total": float(bill.total or 0),
        },
    )
    _log_purchase_bill_history(db, user=user,
        bill_id=bill.id,
        bill_number=bill.number,
        event_type="grn_linked",
        action="link_bill_grn",
        detail=f"Linked bill {bill.number} to GRN {grn.number}",
        metadata={
            "target_record_type": "grn",
            "target_record_id": grn.id,
            "target_record_number": grn.number,
        },
    )
    if data.payment_received and paid > 0:
        _log_purchase_bill_history(db, user=user,
            bill_id=bill.id,
            bill_number=bill.number,
            event_type="payment_recorded",
            action="record_purchase_payment",
            detail=f"Recorded payment of {round(float(paid), 2)} for {bill.number}",
            metadata={
                "amount": round(float(paid), 2),
                "payment_mode": payment_mode,
                "payment_ref": data.payment_ref or "",
            },
        )
        _log_purchase_bill_history(db, user=user,
            bill_id=bill.id,
            bill_number=bill.number,
            event_type="status_changed",
            action="update_purchase_bill_status",
            detail="Status changed: pending -> paid",
            metadata={"from": "pending", "to": "paid"},
        )

    po.status = PurchaseOrderStatus.converted
    po.converted_bill_id = bill.id
    _log_purchase_order_history(db, user=user,
        order_id=po.id,
        order_number=po.number,
        event_type="converted",
        action="convert_purchase_order",
        detail=f"Converted purchase order {po.number} to bill {bill.number}",
        metadata={
            "target_record_type": "purchase_bill",
            "target_record_id": bill.id,
            "target_record_number": bill.number,
        },
    )
    await db.commit()
    return {
        "grn_id": grn.id,
        "grn_number": grn.number,
        "bill_id": bill.id,
        "bill_number": bill.number,
        "status": bill_status,
        "total": bill.total,
    }


# ═════════════════════════════════════════════════════════════════════════════
# GRN (Goods Receipt Notes) — Phase 3
# ═════════════════════════════════════════════════════════════════════════════

class GRNLineIn(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int = Field(..., gt=0)
    cost: float
    tax_rate: float = 0
    discount: float = 0
    batch_number: Optional[str] = None
    mfg_date: Optional[str] = None
    expiry_date: Optional[str] = None


class GRNCreate(BaseModel):
    vendor_id: str
    vendor_name: str = ""
    branch_id: str
    branch_name: str = ""
    date: Optional[str] = None
    items: List[GRNLineIn]
    discount: float = 0
    number: Optional[str] = None
    notes: Optional[str] = None
    created_by: str = "Staff"
    purchase_order_id: Optional[str] = None


class GRNFromPOIn(BaseModel):
    """Receive goods from a PO — optional per-line receipt metadata."""
    line_receipts: Optional[List[ConvertPOToBillLine]] = None
    notes: Optional[str] = None
    created_by: str = "Staff"


class BillFromGRNIn(BaseModel):
    due_date: Optional[str] = None
    payment_received: bool = False
    payment_mode: Optional[PaymentMode] = None
    payment_ref: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("payment_mode", mode="before")
    @classmethod
    def _coerce_payment_mode(cls, v):
        return _coerce_payment_mode_value(v)


@router.get("/grns/", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def list_grns(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    vendor_id: Optional[str] = None,
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    status: Optional[str] = None,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    conds = []
    if vendor_id:
        conds.append(GoodsReceiptNote.vendor_id == vendor_id)
    if status:
        conds.append(GoodsReceiptNote.status == status)
    if search:
        conds.append(
            or_(
                GoodsReceiptNote.number.ilike(f"%{search}%"),
                GoodsReceiptNote.vendor_name.ilike(f"%{search}%"),
                GoodsReceiptNote.po_number.ilike(f"%{search}%"),
            )
        )
    if branch_id is not None:
        conds.append(GoodsReceiptNote.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, normalize_skip(skip), normalize_limit(limit))
        conds.append(GoodsReceiptNote.branch_id.in_(branch_ids))
    where = and_(*conds) if conds else True
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(
        select(func.count(GoodsReceiptNote.id)).where(where)
    )).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {
            "number": GoodsReceiptNote.number,
            "vendor_name": GoodsReceiptNote.vendor_name,
            "date": GoodsReceiptNote.date,
            "total": GoodsReceiptNote.total,
            "created_at": GoodsReceiptNote.created_at,
            "status": GoodsReceiptNote.status,
        },
        default_key="created_at",
        default_order="desc",
    )
    rows = (await db.execute(
        select(GoodsReceiptNote).where(where).order_by(sort_expr).offset(sk).limit(lim)
    )).scalars().all()
    return paged([_grn_dict(g) for g in rows], total, sk, lim)


@router.get("/grns/{grn_id}", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def get_grn(grn_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.id == grn_id))
    grn = res.scalar_one_or_none()
    if not grn:
        raise HTTPException(404, "GRN not found")
    await enforce_branch_access(grn.branch_id, user=user, db=db)
    li = (await db.execute(
        select(GRNLineItem).where(GRNLineItem.grn_id == grn_id)
    )).scalars().all()
    return _grn_dict(grn, li)


@router.post("/grns/", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def create_grn(data: GRNCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Direct goods receipt (no PO). Stock moves immediately."""
    if not data.items:
        raise HTTPException(400, "GRN must have at least one line")
    await enforce_branch_access(data.branch_id, user=user, db=db)
    today = datetime.now().strftime("%Y-%m-%d")

    po = None
    if data.purchase_order_id:
        po_res = await db.execute(
            select(PurchaseOrder)
            .options(selectinload(PurchaseOrder.line_items))
            .where(PurchaseOrder.id == data.purchase_order_id)
        )
        po = po_res.scalar_one_or_none()
        if not po:
            raise HTTPException(404, "Purchase order not found")
        if po.status == PurchaseOrderStatus.cancelled:
            raise HTTPException(400, "Cannot receive against a cancelled PO")
        if po.status == PurchaseOrderStatus.pending_approval:
            raise HTTPException(400, "Purchase order must be approved before receiving stock")
        if po.status == PurchaseOrderStatus.converted:
            raise HTTPException(400, "PO already fully converted — use a new PO for additional receipts")
        if po.status == PurchaseOrderStatus.partially_received:
            raise HTTPException(
                400,
                "PO already has a pending goods receipt — bill the existing GRN or cancel the PO",
            )

    tax_mode = await _get_org_tax_mode(db)
    line_rows, _, _ = _calc_po_lines(data.items, tax_mode)
    grn = await _create_grn_received(
        db,
        vendor_id=data.vendor_id,
        vendor_name=data.vendor_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        date=data.date or today,
        line_rows=line_rows,
        discount=data.discount or 0,
        notes=data.notes,
        created_by=data.created_by,
        purchase_order_id=po.id if po else None,
        po_number=po.number if po else None,
        number=data.number,
        tax_mode=tax_mode,
    )
    if po is not None:
        po.status = PurchaseOrderStatus.partially_received

    total_qty = int(sum(int(getattr(i, "qty", 0) or 0) for i in (data.items or [])))
    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="created",
        action="create_grn",
        detail=f"Created GRN {grn.number}",
        metadata={
            "source": "purchase_order" if po is not None else "direct",
            "line_count": len(data.items or []),
            "total_qty": total_qty,
            "total": float(grn.total or 0),
        },
    )
    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="qty_received_recorded",
        action="record_grn_quantity",
        detail=f"Recorded received quantity for {grn.number}: {total_qty}",
        metadata={
            "line_count": len(data.items or []),
            "total_qty": total_qty,
        },
    )
    if po is not None:
        _log_grn_history(db, user=user,
            grn_id=grn.id,
            grn_number=grn.number,
            event_type="linked_to_source",
            action="link_grn_source",
            detail=f"Linked GRN {grn.number} to purchase order {po.number}",
            metadata={
                "target_record_type": "purchase_order",
                "target_record_id": po.id,
                "target_record_number": po.number,
            },
        )
    await db.commit()
    return {"id": grn.id, "number": grn.number, "total": grn.total, "status": grn.status.value}


@router.post("/grns/from-po/{order_id}", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def receive_from_po(
    order_id: str,
    data: GRNFromPOIn,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    """Receive goods against a PO without creating a bill yet."""
    res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(PurchaseOrder.id == order_id)
    )
    po = res.scalar_one_or_none()
    if not po:
        raise HTTPException(404, "Purchase order not found")
    if po.status == PurchaseOrderStatus.cancelled:
        raise HTTPException(400, "Cannot receive against a cancelled PO")
    if po.status == PurchaseOrderStatus.pending_approval:
        raise HTTPException(400, "Purchase order must be approved before receiving stock")
    if po.status == PurchaseOrderStatus.converted:
        raise HTTPException(400, "PO already fully converted — use a new PO for additional receipts")
    if po.status == PurchaseOrderStatus.partially_received:
        raise HTTPException(
            400,
            "PO already has a pending goods receipt — bill the existing GRN or cancel the PO",
        )

    today = datetime.now().strftime("%Y-%m-%d")
    tax_mode = await _get_org_tax_mode(db)
    receipts_by_item = {}
    if data.line_receipts:
        for r in data.line_receipts:
            receipts_by_item[r.item_id] = r

    line_rows = []
    for line in po.line_items:
        recv = receipts_by_item.get(line.item_id)
        wrapper = type("Line", (), {
            "item_id": line.item_id,
            "name": line.name,
            "qty": line.qty,
            "cost": line.cost,
            "tax_rate": line.tax_rate,
            "discount": line.discount or 0,
            "id": line.id,
            "ordered_qty": line.qty,
            "batch_number": recv.batch_number if recv else None,
            "mfg_date": recv.mfg_date if recv else None,
            "expiry_date": recv.expiry_date if recv else None,
        })()
        gross = round(line.qty * line.cost, 2)
        line_net = round(gross * (1 - (line.discount or 0) / 100), 2)
        line_tax = line_tax_amount(line_net, line.tax_rate or 0, tax_mode)
        line_rows.append((wrapper, line_net, line_tax))

    grn = await _create_grn_received(
        db,
        vendor_id=po.vendor_id,
        vendor_name=po.vendor_name or "",
        branch_id=po.branch_id,
        branch_name=po.branch_name or po.branch_id,
        date=today,
        line_rows=line_rows,
        discount=po.discount or 0,
        notes=data.notes or po.notes,
        purchase_order_id=po.id,
        po_number=po.number,
        created_by=data.created_by,
        tax_mode=tax_mode,
    )
    po.status = PurchaseOrderStatus.partially_received

    total_qty = int(sum(int(getattr(li, "qty", 0) or 0) for li in (po.line_items or [])))
    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="created",
        action="create_grn_from_po",
        detail=f"Created GRN {grn.number} from purchase order {po.number}",
        metadata={
            "source": "purchase_order",
            "line_count": len(po.line_items or []),
            "total_qty": total_qty,
            "total": float(grn.total or 0),
        },
    )
    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="qty_received_recorded",
        action="record_grn_quantity",
        detail=f"Recorded received quantity for {grn.number}: {total_qty}",
        metadata={
            "line_count": len(po.line_items or []),
            "total_qty": total_qty,
        },
    )
    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="linked_to_source",
        action="link_grn_source",
        detail=f"Linked GRN {grn.number} to purchase order {po.number}",
        metadata={
            "target_record_type": "purchase_order",
            "target_record_id": po.id,
            "target_record_number": po.number,
        },
    )
    await db.commit()
    return {"id": grn.id, "number": grn.number, "total": grn.total}


@router.post("/grns/{grn_id}/bill", status_code=201, dependencies=[Depends(require_perm("purchases.create"))])
async def create_bill_from_grn(
    grn_id: str,
    data: BillFromGRNIn,
    db: AsyncSession = Depends(get_db), user: User = Depends(current_user),
):
    """Create a financial bill from a received GRN (no stock movement)."""
    res = await db.execute(
        select(GoodsReceiptNote)
        .options(selectinload(GoodsReceiptNote.line_items))
        .where(GoodsReceiptNote.id == grn_id)
    )
    grn = res.scalar_one_or_none()
    if not grn:
        raise HTTPException(404, "GRN not found")
    grn_status = str(grn.status.value) if hasattr(grn.status, "value") else str(grn.status)
    if grn_status != "received":
        raise HTTPException(400, "Only received GRNs can be billed")
    if grn.converted_bill_id:
        raise HTTPException(400, "GRN already has a linked bill")

    if data.payment_received and not (data.payment_mode or "").strip():
        raise HTTPException(400, "Pick a payment method (or uncheck Payment Received)")

    paid = grn.total if data.payment_received else 0.0
    payment_mode = data.payment_mode if data.payment_received else None
    due_date = data.due_date
    if not due_date and not data.payment_received:
        vendor_row = (await db.execute(
            select(Vendor).where(Vendor.id == grn.vendor_id)
        )).scalar_one_or_none()
        due_date = compute_due_date(grn.date, vendor_row.payment_terms if vendor_row else None)

    bill = await _create_bill_for_grn(
        db,
        grn,
        due_date=due_date,
        payment_mode=payment_mode,
        payment_ref=data.payment_ref or "",
        notes=data.notes,
        paid_amount=round(paid, 2),
    )

    if grn.purchase_order_id:
        po = (await db.execute(
            select(PurchaseOrder).where(PurchaseOrder.id == grn.purchase_order_id)
        )).scalar_one_or_none()
        if po is not None:
            po.status = PurchaseOrderStatus.converted
            po.converted_bill_id = bill.id

    if data.payment_received and paid > 0:
        pay_count = (await db.execute(select(func.count(VendorPayment.id)))).scalar() or 0
        bpay = VendorPayment(
            id=str(uuid.uuid4()),
            number=f"VPAY-{datetime.now().year}-{1000 + pay_count:04d}",
            vendor_id=bill.vendor_id,
            vendor_name=bill.vendor_name,
            branch_id=bill.branch_id,
            branch_name=bill.branch_name,
            date=grn.date,
            total_amount=round(paid, 2),
            payment_mode=payment_mode,
            payment_ref=data.payment_ref or "",
            notes=f"Bill from GRN {grn.number}",
            created_by="Staff",
        )
        db.add(bpay)
        db.add(VendorPaymentAllocation(
            id=str(uuid.uuid4()),
            payment_id=bpay.id,
            bill_id=bill.id,
            bill_number=bill.number,
            amount=round(paid, 2),
        ))
        await record_vendor_payment(db, bpay)

    _log_purchase_bill_history(db, user=user,
        bill_id=bill.id,
        bill_number=bill.number,
        event_type="created",
        action="create_purchase_bill",
        detail=f"Created purchase bill {bill.number} from GRN {grn.number}",
        metadata={
            "source": "grn",
            "source_record_id": grn.id,
            "source_record_number": grn.number,
            "total": float(bill.total or 0),
        },
    )
    _log_purchase_bill_history(db, user=user,
        bill_id=bill.id,
        bill_number=bill.number,
        event_type="grn_linked",
        action="link_bill_grn",
        detail=f"Linked bill {bill.number} to GRN {grn.number}",
        metadata={
            "target_record_type": "grn",
            "target_record_id": grn.id,
            "target_record_number": grn.number,
        },
    )
    if data.payment_received and paid > 0:
        _log_purchase_bill_history(db, user=user,
            bill_id=bill.id,
            bill_number=bill.number,
            event_type="payment_recorded",
            action="record_purchase_payment",
            detail=f"Recorded payment of {round(float(paid), 2)} for {bill.number}",
            metadata={
                "amount": round(float(paid), 2),
                "payment_mode": payment_mode,
                "payment_ref": data.payment_ref or "",
            },
        )
        _log_purchase_bill_history(db, user=user,
            bill_id=bill.id,
            bill_number=bill.number,
            event_type="status_changed",
            action="update_purchase_bill_status",
            detail="Status changed: pending -> paid",
            metadata={"from": "pending", "to": "paid"},
        )

    bill_st = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
    if bill.vendor_id and bill_st in ("pending", "partial"):
        await sync_vendor_outstanding(db, bill.vendor_id)

    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="verified",
        action="verify_grn_for_billing",
        detail=f"Verified GRN {grn.number} and created bill {bill.number}",
        metadata={
            "target_record_type": "purchase_bill",
            "target_record_id": bill.id,
            "target_record_number": bill.number,
        },
    )
    _log_grn_history(db, user=user,
        grn_id=grn.id,
        grn_number=grn.number,
        event_type="linked_to_source",
        action="link_grn_source",
        detail=f"Linked GRN {grn.number} to purchase bill {bill.number}",
        metadata={
            "target_record_type": "purchase_bill",
            "target_record_id": bill.id,
            "target_record_number": bill.number,
        },
    )

    await db.commit()
    return {
        "bill_id": bill.id,
        "bill_number": bill.number,
        "grn_id": grn.id,
        "total": bill.total,
    }


@router.post("/grns/{grn_id}/cancel", dependencies=[Depends(require_perm("purchases.edit"))])
async def cancel_grn(grn_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    """Cancel a received GRN — reverses stock. Blocked if billed or consumed."""
    res = await db.execute(
        select(GoodsReceiptNote)
        .options(selectinload(GoodsReceiptNote.line_items))
        .where(GoodsReceiptNote.id == grn_id)
    )
    grn = res.scalar_one_or_none()
    if not grn:
        raise HTTPException(404, "GRN not found")
    await enforce_branch_access(grn.branch_id, user=user, db=db)
    grn_status = str(grn.status.value) if hasattr(grn.status, "value") else str(grn.status)
    if grn_status == "cancelled":
        return {"status": "cancelled"}
    if grn.converted_bill_id:
        live = (await db.execute(
            select(PurchaseBill.id).where(PurchaseBill.id == grn.converted_bill_id)
        )).scalar_one_or_none()
        if live:
            raise HTTPException(400, "Cannot cancel GRN with a live linked bill — cancel the bill first")
    if grn_status == "received" and await grn_batches_consumed(db, grn.id):
        raise HTTPException(400, "Cannot cancel GRN — stock from this receipt has already been consumed")
    if grn_status == "received":
        await reverse_grn_stock(db, grn_id=grn.id, branch_id=grn.branch_id, line_items=grn.line_items)
    grn.status = GRNStatus.cancelled
    await db.commit()
    return {"status": "cancelled"}


# ─── GET ONE BILL (after /orders/, /returns/, /payments/ static paths) ───────
@router.get("/{bill_id}", dependencies=[Depends(require_perm(*PURCHASE_DOCUMENT_READ))])
async def get_bill(bill_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):

    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Bill not found")
    await enforce_branch_access(b.branch_id, user=user, db=db)
    li_res = await db.execute(select(PurchaseLineItem).where(PurchaseLineItem.bill_id == bill_id))
    return _bill_dict(b, li_res.scalars().all())


# ═════════════════════════════════════════════════════════════════════════════
# BULK DELETE (2026-05-25)
# ═════════════════════════════════════════════════════════════════════════════
# Mirror of sales bulk-delete. All-or-nothing + audit-log snapshot.
# Permission: `purchases.delete`.
#
# Guards:
#   PurchaseOrder → has Bill (status='converted'). Cancelled still blocks
#                   if linked to a bill (user chose strict).
#   PurchaseBill  → has VendorReturn OR VendorPaymentAllocation.
#                 → has batch with quantity < initial_qty (consumed). The
#                   bill created those batches via add_batch_atomic; if
#                   anything's been sold/transferred from them, the bill
#                   can't be safely removed.
#   VendorReturn  → no guards (stock-on-return is N/A today).
#   VendorPayment → no guards.
#
# Reversal effects:
#   Bill delete → remove batches the bill created (only if untouched),
#                 decrement aggregate stock for untracked items.
#   VendorReturn delete → no money / stock movement (vendor returns don't
#                         currently affect either).
#   VendorPayment delete → per allocation: bill.paid_amount -= amount,
#                          status flipped back.


class BulkDeleteIn(BaseModel):
    ids: List[str] = Field(..., min_length=1)


def _audit_delete(db: AsyncSession, *, action: str, ref: str, snapshot: dict, user: Optional[User] = None):
    """Audit-log snapshot for bulk-delete operations. Mirror of the sales-
    side helper. `snapshot` is JSON-serialised inline."""
    import json as _json
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        action=action,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="purchases",
        ref=ref,
        detail=_json.dumps(snapshot, default=str),
        risk="medium",
        ip_address=None,
    ))


# ─── BULK DELETE: PURCHASE ORDERS ────────────────────────────────────────────
@router.post("/orders/bulk-delete", dependencies=[Depends(require_perm("purchases.delete"))])
async def bulk_delete_orders(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(PurchaseOrder)
        .options(selectinload(PurchaseOrder.line_items))
        .where(PurchaseOrder.id.in_(data.ids))
    )
    orders = res.unique().scalars().all()
    found_ids = {o.id for o in orders}
    blocked = []
    for oid in data.ids:
        if oid not in found_ids:
            blocked.append({"id": oid, "number": "?", "reason": "Purchase order not found"})

    # Guard by LIVE bill via converted_bill_id, not the `status` flag —
    # the flag never resets, so a PO whose bill was already deleted would
    # otherwise stay permanently blocked. Mirror of the sales-side fix.
    bill_ptr_ids = {o.converted_bill_id for o in orders if o.converted_bill_id}
    live_bill_ids = set()
    if bill_ptr_ids:
        live_bill_ids = set((await db.execute(
            select(PurchaseBill.id).where(PurchaseBill.id.in_(bill_ptr_ids))
        )).scalars().all())
    for o in orders:
        if o.converted_bill_id and o.converted_bill_id in live_bill_ids:
            blocked.append({
                "id": o.id, "number": o.number,
                "reason": f"PO {o.number} has a live Bill — delete the bill first",
            })
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some purchase orders can't be deleted"})

    deleted = []
    for o in orders:
        snapshot = {
            "id": o.id, "number": o.number, "vendor_id": o.vendor_id,
            "vendor_name": o.vendor_name, "total": o.total,
            "status": str(o.status.value) if hasattr(o.status, "value") else str(o.status),
            "items": [{"id": li.id, "name": li.name, "qty": li.qty, "cost": li.cost} for li in o.line_items],
        }
        _log_purchase_order_history(db, user=user,
            order_id=o.id,
            order_number=o.number,
            event_type="cancelled",
            action="delete_purchase_order",
            detail=f"Purchase order {o.number} deleted",
            metadata={"reason": "bulk_delete"},
            risk="medium",
        )
        _audit_delete(db, action="delete_purchase_order", ref=o.number, snapshot=snapshot, user=user)
        await db.delete(o)
        deleted.append({"id": o.id, "number": o.number})
    await db.commit()
    return {"deleted": deleted, "blocked": [], "count": len(deleted)}


# ─── BULK DELETE: BILLS ──────────────────────────────────────────────────────
@router.post("/bulk-delete", dependencies=[Depends(require_perm("purchases.delete"))])
async def bulk_delete_bills(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(PurchaseBill)
        .options(selectinload(PurchaseBill.line_items))
        .where(PurchaseBill.id.in_(data.ids))
    )
    bills = res.unique().scalars().all()
    if bills:
        branch_ids = {b.branch_id for b in bills if b.branch_id}
        for branch_id in branch_ids:
            await enforce_branch_access(branch_id, user=user, db=db)
    found_ids = {b.id for b in bills}
    blocked = []
    for bid in data.ids:
        if bid not in found_ids:
            blocked.append({"id": bid, "number": "?", "reason": "Bill not found"})

    # Downstream-row guards: any return or payment-allocation blocks.
    return_counts = dict((await db.execute(
        select(VendorReturn.bill_id, func.count(VendorReturn.id))
        .where(VendorReturn.bill_id.in_(found_ids))
        .group_by(VendorReturn.bill_id)
    )).all()) if found_ids else {}
    payment_counts = dict((await db.execute(
        select(VendorPaymentAllocation.bill_id, func.count(VendorPaymentAllocation.id))
        .join(VendorPayment, VendorPaymentAllocation.payment_id == VendorPayment.id)
        .where(
            VendorPaymentAllocation.bill_id.in_(found_ids),
            or_(VendorPayment.voided == False, VendorPayment.voided.is_(None)),  # noqa: E712
        )
        .group_by(VendorPaymentAllocation.bill_id)
    )).all()) if found_ids else {}

    # Batch-consumption guard: batches keyed on GRN id (Phase 3) or legacy bill id.
    stock_ref_by_bill = {b.id: (getattr(b, "grn_id", None) or b.id) for b in bills}
    stock_refs = set(stock_ref_by_bill.values())
    bill_batches = (await db.execute(
        select(ItemBatch).where(ItemBatch.source_ref.in_(stock_refs))
    )).scalars().all() if stock_refs else []
    ref_to_bill = {v: k for k, v in stock_ref_by_bill.items()}
    consumed_bill_ids = set()
    for b in bill_batches:
        if (b.quantity or 0) < (b.initial_qty or 0):
            bid = ref_to_bill.get(b.source_ref)
            if bid:
                consumed_bill_ids.add(bid)

    for bill in bills:
        if return_counts.get(bill.id):
            blocked.append({
                "id": bill.id, "number": bill.number,
                "reason": f"Bill {bill.number} has {return_counts[bill.id]} vendor return(s) — delete those first",
            })
        if payment_counts.get(bill.id):
            blocked.append({
                "id": bill.id, "number": bill.number,
                "reason": f"Bill {bill.number} has {payment_counts[bill.id]} payment(s) — delete those first",
            })
        if bill.id in consumed_bill_ids:
            blocked.append({
                "id": bill.id, "number": bill.number,
                "reason": f"Bill {bill.number} has batches with consumed stock — can't safely remove",
            })
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some bills can't be deleted"})

    # Reversal: for each bill, remove the batches it created (only the
    # ones with full initial qty) + decrement aggregate stock.
    deleted = []
    stock_removed = 0
    vendor_ids: set[str] = set()
    for bill in bills:
        snapshot = {
            "id": bill.id, "number": bill.number, "vendor_id": bill.vendor_id,
            "vendor_name": bill.vendor_name, "total": bill.total,
            "paid_amount": bill.paid_amount, "payment_mode": bill.payment_mode,
            "status": str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status),
            "items": [{"id": li.id, "item_id": li.item_id, "name": li.name, "qty": li.qty, "cost": li.cost} for li in bill.line_items],
        }
        # Remove this bill's batches from item_batches AND decrement the
        # aggregate item_stock by each batch's quantity. (2026-05-31 fix:
        # previously the batch row was deleted but the aggregate was left
        # untouched for tracked items — only untracked items adjusted the
        # aggregate below — so deleting a bill removed its lots from the
        # batches view while the stock count stayed inflated.)
        stock_ref = getattr(bill, "grn_id", None) or bill.id
        bbatches = [b for b in bill_batches if b.source_ref == stock_ref]
        for b in bbatches:
            qty = int(b.quantity or 0)
            if qty > 0:
                try:
                    await adjust_stock_atomic(
                        db, item_id=b.item_id, branch_id=b.branch_id, delta=-qty,
                    )
                    stock_removed += qty
                except ValueError:
                    pass  # aggregate already at/below 0 — nothing to remove
            await db.delete(b)
        # For untracked items on the bill (no batch row), decrement
        # aggregate item_stock directly.
        for li in bill.line_items:
            if not li.item_id or not li.qty:
                continue
            # Was this line's item batch-tracked? Cheap check: if there
            # was a batch in bbatches for this item_id, we already
            # handled it via the batch delete above.
            had_batch = any(b.item_id == li.item_id for b in bbatches)
            if not had_batch:
                try:
                    await adjust_stock_atomic(
                        db, item_id=li.item_id, branch_id=bill.branch_id,
                        delta=-int(li.qty),
                    )
                    stock_removed += int(li.qty)
                except ValueError:
                    pass  # missing stock row — no-op
        # Orphan the parent PO (if this bill was spawned from one). We clear
        # the dangling bill pointer so the "View bill" link doesn't 404 and
        # the PO delete guard (which checks for a LIVE bill) lets the PO be
        # removed. We deliberately do NOT revert status to `confirmed`:
        # 2026-05-31 rule — a PO that was ever converted must stay locked
        # from editing / re-converting even after its bill is deleted. The
        # status stays `converted`, so _po_terminal() keeps blocking edits
        # and the UI keeps showing View (not Edit / Convert).
        parent_po = (await db.execute(
            select(PurchaseOrder).where(PurchaseOrder.converted_bill_id == bill.id)
        )).scalar_one_or_none()
        if parent_po is not None:
            parent_po.converted_bill_id = None
        if getattr(bill, "grn_id", None):
            linked_grn = (await db.execute(
                select(GoodsReceiptNote).where(GoodsReceiptNote.id == bill.grn_id)
            )).scalar_one_or_none()
            if linked_grn is not None:
                linked_grn.converted_bill_id = None
                linked_grn.status = GRNStatus.cancelled
        _log_purchase_bill_history(db, user=user,
            bill_id=bill.id,
            bill_number=bill.number,
            event_type="voided",
            action="delete_purchase_bill",
            detail=f"Deleted purchase bill {bill.number}",
            metadata={"reason": "bulk_delete"},
            risk="medium",
        )
        _audit_delete(db, action="delete_purchase_bill", ref=bill.number, snapshot=snapshot, user=user)
        await db.delete(bill)
        deleted.append({"id": bill.id, "number": bill.number})
        if bill.vendor_id:
            vendor_ids.add(bill.vendor_id)
    for vid in vendor_ids:
        await sync_vendor_outstanding(db, vid)
    await db.commit()
    return {
        "deleted": deleted, "blocked": [], "count": len(deleted),
        "stock_removed": stock_removed,
    }


# ─── BULK DELETE: VENDOR RETURNS ─────────────────────────────────────────────
@router.post("/returns/bulk-delete", dependencies=[Depends(require_perm("purchases.delete"))])
async def bulk_delete_returns(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(VendorReturn)
        .options(selectinload(VendorReturn.line_items))
        .where(VendorReturn.id.in_(data.ids))
    )
    returns = res.unique().scalars().all()
    if returns:
        branch_ids = {r.branch_id for r in returns if r.branch_id}
        for branch_id in branch_ids:
            await enforce_branch_access(branch_id, user=user, db=db)
    found_ids = {r.id for r in returns}
    blocked = []
    for rid in data.ids:
        if rid not in found_ids:
            blocked.append({"id": rid, "number": "?", "reason": "Return not found"})
    if blocked:
        raise HTTPException(400, {"blocked": blocked, "message": "Some returns can't be deleted"})

    deleted = []
    stock_restored = 0
    vendor_ids: set[str] = set()
    for ret in returns:
        snapshot = {
            "id": ret.id, "number": ret.number, "bill_id": ret.bill_id,
            "bill_number": ret.bill_number, "vendor_id": ret.vendor_id,
            "total": ret.total, "credited_amount": ret.credited_amount,
        }
        # 2026-05-31: reverse the stock the return removed. Each line carries
        # a `batch_allocation` ledger (see create_return). NULL = legacy
        # return that never moved stock → skip (don't inflate stock).
        for rl in ret.line_items:
            if not rl.batch_allocation:
                continue
            try:
                ledger = json.loads(rl.batch_allocation)
            except (ValueError, TypeError):
                ledger = []
            for entry in ledger:
                qty = int(entry.get("consumed") or 0)
                if qty <= 0:
                    continue
                batch_id = entry.get("batch_id")
                restored = False
                if batch_id:
                    # Add the qty back to the exact lot it was drained from.
                    b = (await db.execute(
                        select(ItemBatch).where(ItemBatch.id == batch_id)
                    )).scalar_one_or_none()
                    if b is not None:
                        await set_batch_quantity_atomic(
                            db, batch_id=batch_id, new_qty=int(b.quantity or 0) + qty,
                        )
                        restored = True
                if not restored and rl.item_id:
                    # Batch was deleted (or untracked sentinel) → restore the
                    # aggregate count so totals stay correct.
                    try:
                        await adjust_stock_atomic(
                            db, item_id=rl.item_id, branch_id=ret.branch_id, delta=qty,
                        )
                    except ValueError:
                        pass
                stock_restored += qty
        # Reverse bill financial adjustments made at return create.
        bill = (await db.execute(
            select(PurchaseBill).where(PurchaseBill.id == ret.bill_id)
        )).scalar_one_or_none()
        if bill is not None:
            bill.total = round(float(bill.total or 0) + float(ret.total or 0), 2)
            bill.paid_amount = round(
                float(bill.paid_amount or 0) + float(ret.credited_amount or 0), 2,
            )
            if bill.paid_amount >= bill.total:
                bill.status = "paid"
            elif bill.paid_amount > 0:
                bill.status = "partial"
            else:
                bill.status = "pending"
            await recalc_bill_after_vendor_credit(db, bill.id)
            if bill.vendor_id:
                vendor_ids.add(bill.vendor_id)
        _log_vendor_return_history(db, user=user,
            return_id=ret.id,
            return_number=ret.number,
            event_type="cancelled",
            action="delete_vendor_return",
            detail=f"Deleted vendor return {ret.number}",
            metadata={
                "reason": "bulk_delete",
                "target_record_type": "purchase_bill",
                "target_record_id": ret.bill_id,
                "target_record_number": ret.bill_number,
            },
            risk="medium",
        )
        _audit_delete(db, action="delete_vendor_return", ref=ret.number, snapshot=snapshot, user=user)
        await db.delete(ret)
        deleted.append({"id": ret.id, "number": ret.number})
        if ret.vendor_id:
            vendor_ids.add(ret.vendor_id)
    for vid in vendor_ids:
        await sync_vendor_outstanding(db, vid)
    await db.commit()
    return {
        "deleted": deleted, "blocked": [], "count": len(deleted),
        "stock_restored": stock_restored,
    }


# ─── BULK DELETE: VENDOR PAYMENTS ────────────────────────────────────────────
@router.post("/payments/bulk-delete", dependencies=[Depends(require_perm("purchases.delete"))])
async def bulk_delete_payments(data: BulkDeleteIn, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    res = await db.execute(
        select(VendorPayment)
        .options(selectinload(VendorPayment.allocations))
        .where(VendorPayment.id.in_(data.ids))
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
    vendor_ids: set[str] = set()
    for pay in payments:
        snapshot = {
            "id": pay.id, "number": pay.number, "vendor_id": pay.vendor_id,
            "vendor_name": pay.vendor_name, "total_amount": pay.total_amount,
            "payment_mode": pay.payment_mode,
            "allocations": [{"bill_id": a.bill_id, "bill_number": a.bill_number, "amount": a.amount} for a in pay.allocations],
        }
        # Per allocation: decrement bill.paid_amount + reset status.
        for alloc in pay.allocations:
            bill = (await db.execute(
                select(PurchaseBill).where(PurchaseBill.id == alloc.bill_id)
            )).scalar_one_or_none()
            if bill is not None:
                prev_status = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
                new_paid = round(max(0.0, float(bill.paid_amount or 0) - float(alloc.amount or 0)), 2)
                bill.paid_amount = new_paid
                if new_paid <= 0:
                    bill.status = "pending"
                elif new_paid < float(bill.total or 0):
                    bill.status = "partial"
                _log_purchase_bill_history(db, user=user,
                    bill_id=bill.id,
                    bill_number=bill.number,
                    event_type="payment_voided",
                    action="delete_vendor_payment",
                    detail=f"Removed payment {pay.number} from {bill.number}",
                    metadata={
                        "payment_id": pay.id,
                        "payment_number": pay.number,
                        "amount": round(float(alloc.amount or 0), 2),
                    },
                    risk="medium",
                )
                next_status = str(bill.status.value) if hasattr(bill.status, "value") else str(bill.status)
                if prev_status != next_status:
                    _log_purchase_bill_history(db, user=user,
                        bill_id=bill.id,
                        bill_number=bill.number,
                        event_type="status_changed",
                        action="update_purchase_bill_status",
                        detail=f"Status changed: {prev_status} -> {next_status}",
                        metadata={"from": prev_status, "to": next_status},
                    )
                if bill.vendor_id:
                    vendor_ids.add(bill.vendor_id)
        _audit_delete(db, action="delete_vendor_payment", ref=pay.number, snapshot=snapshot, user=user)
        await db.delete(pay)
        deleted.append({"id": pay.id, "number": pay.number})
        if pay.vendor_id:
            vendor_ids.add(pay.vendor_id)
    for vid in vendor_ids:
        await sync_vendor_outstanding(db, vid)
    await db.commit()
    return {"deleted": deleted, "blocked": [], "count": len(deleted)}

"""Evaluate live notification candidates for the authenticated user."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import (
    AdjustmentRequest,
    AdjustmentStatus,
    Branch,
    InvoiceStatus,
    Item,
    ItemApprovalStatus,
    ItemBatch,
    ItemBranchConfig,
    ItemStock,
    PurchaseBill,
    PurchaseOrder,
    PurchaseOrderStatus,
    SaleInvoice,
    StockTransfer,
    TransferStatus,
    User,
)
from src.notifications.kinds import KIND_PERMS, can_see_any, can_see_kind
from src.routes._approval import user_grants
from src.routes._serializers import get_user_branch_ids

_SEVERITY_RANK = {"danger": 0, "warning": 1, "info": 2}
_MAX_PER_KIND = 15
_MAX_TOTAL = 50
_DEFAULT_EXPIRY_DAYS = 30
_CACHE_TTL_SEC = 45.0
_BRANCH_NAMES_TTL_SEC = 300.0

# Per-user result cache: (user_id, branch_key, within_days) → (expires_at, items)
_result_cache: dict[tuple[str, str, int], tuple[float, list[dict]]] = {}
_branch_names_cache: tuple[float, dict[str, str]] | None = None

# kind → any one of these permissions grants visibility (see kinds.py)
_KIND_PERMS = KIND_PERMS


@dataclass
class NotificationCandidate:
    id: str
    kind: str
    severity: str
    title: str
    body: Optional[str] = None
    branch_id: Optional[str] = None
    branch_name: Optional[str] = None
    href: str = "/"
    created_at: datetime = field(default_factory=datetime.utcnow)
    exclude_user_name: Optional[str] = None


def _can_see_kind(grants: set[str], kind: str) -> bool:
    return can_see_kind(grants, kind)


def _can_see_any(grants: set[str], *kinds: str) -> bool:
    return can_see_any(grants, *kinds)


def invalidate_notification_cache() -> None:
    """Clear cached results (call after stock/approval mutations in Phase 6d)."""
    _result_cache.clear()
    global _branch_names_cache
    _branch_names_cache = None


def _sort_key(n: NotificationCandidate) -> tuple:
    return (_SEVERITY_RANK.get(n.severity, 9), n.title.lower())


async def _accessible_branch_ids(
    db: AsyncSession,
    user: User,
    branch_id: Optional[str],
) -> list[str]:
    if branch_id:
        if getattr(user, "all_branches", False):
            return [branch_id]
        allowed = await get_user_branch_ids(db, user.id)
        return [branch_id] if branch_id in allowed else []

    if getattr(user, "all_branches", False):
        rows = (
            await db.execute(select(Branch.id).where(Branch.active == True))  # noqa: E712
        ).scalars().all()
        return list(rows)

    return await get_user_branch_ids(db, user.id)


async def _branch_name_map(db: AsyncSession) -> dict[str, str]:
    global _branch_names_cache
    now = time.monotonic()
    if _branch_names_cache and now < _branch_names_cache[0]:
        return _branch_names_cache[1]
    rows = (await db.execute(select(Branch.id, Branch.name))).all()
    names = {bid: name for bid, name in rows}
    _branch_names_cache = (now + _BRANCH_NAMES_TTL_SEC, names)
    return names


def _open_overdue_invoice_conds(today: str):
    """Read-only overdue detection — no status UPDATE on poll."""
    return (
        SaleInvoice.status.in_(
            [InvoiceStatus.pending, InvoiceStatus.partial, InvoiceStatus.overdue]
        ),
        SaleInvoice.due_date.isnot(None),
        SaleInvoice.due_date < today,
        SaleInvoice.paid_amount < SaleInvoice.total,
    )


def _open_overdue_bill_conds(today: str):
    return (
        PurchaseBill.status.in_(
            [InvoiceStatus.pending, InvoiceStatus.partial, InvoiceStatus.overdue]
        ),
        PurchaseBill.due_date.isnot(None),
        PurchaseBill.due_date < today,
        PurchaseBill.paid_amount < PurchaseBill.total,
    )


async def _scan_low_stock(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    if not branch_ids:
        return []

    reorder = func.coalesce(ItemBranchConfig.reorder_level, Item.reorder_level)
    q = (
        select(
            ItemStock.item_id,
            ItemStock.branch_id,
            ItemStock.quantity,
            Item.name,
            reorder.label("reorder_level"),
        )
        .join(Item, ItemStock.item_id == Item.id)
        .outerjoin(
            ItemBranchConfig,
            and_(
                ItemBranchConfig.item_id == ItemStock.item_id,
                ItemBranchConfig.branch_id == ItemStock.branch_id,
            ),
        )
        .where(
            Item.active == True,  # noqa: E712
            ItemStock.branch_id.in_(branch_ids),
            ItemStock.quantity > 0,
            ItemStock.quantity <= reorder,
        )
        .order_by(ItemStock.quantity.asc(), Item.name.asc())
        .limit(_MAX_PER_KIND)
    )
    rows = (await db.execute(q)).all()
    out: list[NotificationCandidate] = []
    for row in rows:
        bname = branch_names.get(row.branch_id, "")
        label = f"{row.name} low stock"
        if bname:
            label += f" at {bname}"
        out.append(
            NotificationCandidate(
                id=f"inventory.low_stock:{row.item_id}:{row.branch_id}",
                kind="inventory.low_stock",
                severity="warning",
                title=label,
                body=f"Qty {int(row.quantity or 0)} · Reorder {int(row.reorder_level or 0)}",
                branch_id=row.branch_id,
                branch_name=bname or None,
                href=f"/items?search={row.name}",
            )
        )
    return out


async def _scan_out_of_stock(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    if not branch_ids:
        return []

    q = (
        select(ItemStock.item_id, ItemStock.branch_id, Item.name)
        .join(Item, ItemStock.item_id == Item.id)
        .where(
            Item.active == True,  # noqa: E712
            ItemStock.branch_id.in_(branch_ids),
            ItemStock.quantity <= 0,
        )
        .order_by(Item.name.asc())
        .limit(_MAX_PER_KIND)
    )
    out: list[NotificationCandidate] = []
    for row in (await db.execute(q)).all():
        bname = branch_names.get(row.branch_id, "")
        label = f"{row.name} out of stock"
        if bname:
            label += f" at {bname}"
        out.append(
            NotificationCandidate(
                id=f"inventory.out_of_stock:{row.item_id}:{row.branch_id}",
                kind="inventory.out_of_stock",
                severity="danger",
                title=label,
                branch_id=row.branch_id,
                branch_name=bname or None,
                href=f"/items?search={row.name}",
            )
        )
    return out


async def _scan_batch_expiry(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
    *,
    within_days: int = _DEFAULT_EXPIRY_DAYS,
) -> list[NotificationCandidate]:
    if not branch_ids:
        return []

    today_str = date.today().isoformat()
    horizon_str = (date.today() + timedelta(days=within_days)).isoformat()

    q = (
        select(
            ItemBatch.id,
            ItemBatch.item_id,
            ItemBatch.branch_id,
            ItemBatch.batch_number,
            ItemBatch.expiry_date,
            ItemBatch.quantity,
            Item.name,
        )
        .join(Item, Item.id == ItemBatch.item_id)
        .where(
            ItemBatch.quantity > 0,
            ItemBatch.active == True,  # noqa: E712
            ItemBatch.branch_id.in_(branch_ids),
            ItemBatch.expiry_date.isnot(None),
            ItemBatch.expiry_date <= horizon_str,
        )
        .order_by(ItemBatch.expiry_date.asc())
        .limit(_MAX_PER_KIND * 2)
    )
    near: list[NotificationCandidate] = []
    expired: list[NotificationCandidate] = []
    for row in (await db.execute(q)).all():
        bname = branch_names.get(row.branch_id, "")
        is_expired = bool(row.expiry_date and row.expiry_date < today_str)
        batch_label = row.batch_number or row.id[:8]
        if is_expired:
            title = f"{row.name} batch {batch_label} expired"
            if bname:
                title += f" ({bname})"
            expired.append(
                NotificationCandidate(
                    id=f"batch.expired:{row.id}",
                    kind="batch.expired",
                    severity="danger",
                    title=title,
                    body=f"Expiry {row.expiry_date} · Qty {int(row.quantity or 0)}",
                    branch_id=row.branch_id,
                    branch_name=bname or None,
                    href="/items",
                )
            )
        else:
            title = f"{row.name} batch {batch_label} expiring {row.expiry_date}"
            if bname:
                title += f" ({bname})"
            near.append(
                NotificationCandidate(
                    id=f"batch.near_expiry:{row.id}",
                    kind="batch.near_expiry",
                    severity="warning",
                    title=title,
                    body=f"Qty {int(row.quantity or 0)}",
                    branch_id=row.branch_id,
                    branch_name=bname or None,
                    href="/items",
                )
            )
    return expired[:_MAX_PER_KIND] + near[:_MAX_PER_KIND]


async def _scan_pending_adjustments(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    q = (
        select(AdjustmentRequest)
        .where(AdjustmentRequest.status == AdjustmentStatus.pending)
        .order_by(AdjustmentRequest.created_at.desc())
        .limit(_MAX_PER_KIND)
    )
    if branch_ids:
        q = q.where(AdjustmentRequest.branch_id.in_(branch_ids))
    out: list[NotificationCandidate] = []
    for ar in (await db.execute(q)).scalars().all():
        bname = branch_names.get(ar.branch_id, ar.branch_name or "")
        out.append(
            NotificationCandidate(
                id=f"approval.adjustment_pending:{ar.id}",
                kind="approval.adjustment_pending",
                severity="info",
                title=f"Adjustment {ar.ref_number} awaiting approval",
                body=ar.item_name,
                branch_id=ar.branch_id,
                branch_name=bname or None,
                href="/adjustments",
                created_at=ar.created_at or datetime.utcnow(),
                exclude_user_name=ar.requested_by,
            )
        )
    return out


async def _scan_pending_transfers(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    q = (
        select(StockTransfer)
        .where(StockTransfer.status == TransferStatus.pending)
        .order_by(StockTransfer.created_at.desc())
        .limit(_MAX_PER_KIND)
    )
    if branch_ids:
        q = q.where(
            or_(
                StockTransfer.from_branch_id.in_(branch_ids),
                StockTransfer.to_branch_id.in_(branch_ids),
            )
        )
    out: list[NotificationCandidate] = []
    for tr in (await db.execute(q)).scalars().all():
        bname = branch_names.get(tr.from_branch_id, tr.from_branch_name or "")
        out.append(
            NotificationCandidate(
                id=f"approval.transfer_pending:{tr.id}",
                kind="approval.transfer_pending",
                severity="info",
                title=f"Transfer {tr.ref_number} awaiting approval",
                body=f"{tr.from_branch_name or bname} → {tr.to_branch_name or ''}",
                branch_id=tr.from_branch_id,
                branch_name=bname or None,
                href="/transfers",
                created_at=tr.created_at or datetime.utcnow(),
                exclude_user_name=tr.requested_by,
            )
        )
    return out


async def _scan_transfers_in_transit(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    q = (
        select(StockTransfer)
        .where(StockTransfer.status == TransferStatus.transit)
        .order_by(StockTransfer.created_at.desc())
        .limit(_MAX_PER_KIND)
    )
    if branch_ids:
        q = q.where(StockTransfer.to_branch_id.in_(branch_ids))
    out: list[NotificationCandidate] = []
    for tr in (await db.execute(q)).scalars().all():
        bname = branch_names.get(tr.to_branch_id, tr.to_branch_name or "")
        out.append(
            NotificationCandidate(
                id=f"ops.transfer_in_transit:{tr.id}",
                kind="ops.transfer_in_transit",
                severity="info",
                title=f"Transfer {tr.ref_number} ready to receive",
                body=f"From {tr.from_branch_name or ''}",
                branch_id=tr.to_branch_id,
                branch_name=bname or None,
                href="/transfers",
                created_at=tr.created_at or datetime.utcnow(),
            )
        )
    return out


async def _scan_pending_purchase_orders(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    q = (
        select(PurchaseOrder)
        .where(PurchaseOrder.status == PurchaseOrderStatus.pending_approval)
        .order_by(PurchaseOrder.created_at.desc())
        .limit(_MAX_PER_KIND)
    )
    if branch_ids:
        q = q.where(PurchaseOrder.branch_id.in_(branch_ids))
    out: list[NotificationCandidate] = []
    for po in (await db.execute(q)).scalars().all():
        bname = branch_names.get(po.branch_id, po.branch_name or "")
        out.append(
            NotificationCandidate(
                id=f"approval.purchase_order_pending:{po.id}",
                kind="approval.purchase_order_pending",
                severity="info",
                title=f"PO {po.number} awaiting approval",
                body=po.vendor_name,
                branch_id=po.branch_id,
                branch_name=bname or None,
                href="/purchases",
                created_at=po.created_at or datetime.utcnow(),
                exclude_user_name=po.created_by,
            )
        )
    return out


async def _scan_pending_items(
    db: AsyncSession,
) -> list[NotificationCandidate]:
    q = (
        select(Item)
        .where(Item.approval_status == ItemApprovalStatus.pending)
        .order_by(Item.created_at.desc())
        .limit(_MAX_PER_KIND)
    )
    out: list[NotificationCandidate] = []
    for item in (await db.execute(q)).scalars().all():
        out.append(
            NotificationCandidate(
                id=f"approval.item_master_pending:{item.id}",
                kind="approval.item_master_pending",
                severity="info",
                title=f"Item “{item.name}” awaiting approval",
                body=item.sku,
                href="/item-master",
                created_at=item.created_at or datetime.utcnow(),
                exclude_user_name=item.created_by,
            )
        )
    return out


async def _scan_overdue_invoices(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    today_str = date.today().isoformat()
    conds = list(_open_overdue_invoice_conds(today_str))
    if branch_ids:
        conds.append(SaleInvoice.branch_id.in_(branch_ids))
    q = (
        select(SaleInvoice)
        .where(and_(*conds))
        .order_by(SaleInvoice.due_date.asc())
        .limit(_MAX_PER_KIND)
    )
    out: list[NotificationCandidate] = []
    today = date.today()
    for inv in (await db.execute(q)).scalars().all():
        bname = branch_names.get(inv.branch_id, inv.branch_name or "")
        days_over = 0
        if inv.due_date:
            try:
                due = datetime.strptime(str(inv.due_date)[:10], "%Y-%m-%d").date()
                days_over = max(0, (today - due).days)
            except ValueError:
                pass
        title = f"Invoice {inv.number} overdue"
        if days_over:
            title += f" by {days_over} day{'s' if days_over != 1 else ''}"
        out.append(
            NotificationCandidate(
                id=f"finance.invoice_overdue:{inv.id}",
                kind="finance.invoice_overdue",
                severity="danger",
                title=title,
                body=inv.customer_name,
                branch_id=inv.branch_id,
                branch_name=bname or None,
                href="/sales",
                created_at=inv.created_at or datetime.utcnow(),
            )
        )
    return out


async def _scan_overdue_bills(
    db: AsyncSession,
    branch_ids: list[str],
    branch_names: dict[str, str],
) -> list[NotificationCandidate]:
    today_str = date.today().isoformat()
    conds = list(_open_overdue_bill_conds(today_str))
    if branch_ids:
        conds.append(PurchaseBill.branch_id.in_(branch_ids))
    q = (
        select(PurchaseBill)
        .where(and_(*conds))
        .order_by(PurchaseBill.due_date.asc())
        .limit(_MAX_PER_KIND)
    )
    out: list[NotificationCandidate] = []
    today = date.today()
    for bill in (await db.execute(q)).scalars().all():
        bname = branch_names.get(bill.branch_id, bill.branch_name or "")
        days_over = 0
        if bill.due_date:
            try:
                due = datetime.strptime(str(bill.due_date)[:10], "%Y-%m-%d").date()
                days_over = max(0, (today - due).days)
            except ValueError:
                pass
        title = f"Bill {bill.number} overdue"
        if days_over:
            title += f" by {days_over} day{'s' if days_over != 1 else ''}"
        out.append(
            NotificationCandidate(
                id=f"finance.bill_overdue:{bill.id}",
                kind="finance.bill_overdue",
                severity="warning",
                title=title,
                body=bill.vendor_name,
                branch_id=bill.branch_id,
                branch_name=bname or None,
                href="/purchases",
                created_at=bill.created_at or datetime.utcnow(),
            )
        )
    return out


def _filter_for_user(
    candidates: list[NotificationCandidate],
    grants: set[str],
    user: User,
) -> list[NotificationCandidate]:
    visible: list[NotificationCandidate] = []
    for c in candidates:
        if not _can_see_kind(grants, c.kind):
            continue
        if c.exclude_user_name and c.exclude_user_name == user.name:
            continue
        visible.append(c)
    visible.sort(key=_sort_key)
    return visible[:_MAX_TOTAL]


def _serialize(n: NotificationCandidate) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "severity": n.severity,
        "title": n.title,
        "body": n.body,
        "branch_id": n.branch_id,
        "branch_name": n.branch_name,
        "href": n.href,
        "created_at": (n.created_at or datetime.utcnow()).isoformat() + "Z",
    }


async def _compute_notifications(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
    within_days: int = _DEFAULT_EXPIRY_DAYS,
) -> list[dict]:
    """Run gated scans and return serialized items (uncached)."""
    branch_ids = await _accessible_branch_ids(db, user, branch_id)
    if branch_id and not branch_ids:
        return []

    grants = await user_grants(user, db)
    needs_branch_names = (
        branch_ids
        and _can_see_any(
            grants,
            "inventory.low_stock",
            "inventory.out_of_stock",
            "batch.near_expiry",
            "batch.expired",
            "approval.adjustment_pending",
            "approval.transfer_pending",
            "approval.purchase_order_pending",
            "finance.invoice_overdue",
            "finance.bill_overdue",
            "ops.transfer_in_transit",
        )
    )
    branch_names = await _branch_name_map(db) if needs_branch_names else {}

    candidates: list[NotificationCandidate] = []

    if branch_ids and _can_see_kind(grants, "inventory.low_stock"):
        candidates.extend(await _scan_low_stock(db, branch_ids, branch_names))
    if branch_ids and _can_see_kind(grants, "inventory.out_of_stock"):
        candidates.extend(await _scan_out_of_stock(db, branch_ids, branch_names))
    if branch_ids and _can_see_any(grants, "batch.near_expiry", "batch.expired"):
        candidates.extend(
            await _scan_batch_expiry(db, branch_ids, branch_names, within_days=within_days)
        )
    if _can_see_kind(grants, "approval.adjustment_pending"):
        candidates.extend(await _scan_pending_adjustments(db, branch_ids, branch_names))
    if _can_see_kind(grants, "approval.transfer_pending"):
        candidates.extend(await _scan_pending_transfers(db, branch_ids, branch_names))
    if branch_ids and _can_see_any(grants, "ops.transfer_in_transit"):
        candidates.extend(await _scan_transfers_in_transit(db, branch_ids, branch_names))
    if _can_see_kind(grants, "approval.purchase_order_pending"):
        candidates.extend(await _scan_pending_purchase_orders(db, branch_ids, branch_names))
    if _can_see_kind(grants, "approval.item_master_pending"):
        candidates.extend(await _scan_pending_items(db))
    if branch_ids and _can_see_kind(grants, "finance.invoice_overdue"):
        candidates.extend(await _scan_overdue_invoices(db, branch_ids, branch_names))
    if branch_ids and _can_see_kind(grants, "finance.bill_overdue"):
        candidates.extend(await _scan_overdue_bills(db, branch_ids, branch_names))

    filtered = _filter_for_user(candidates, grants, user)
    return [_serialize(n) for n in filtered]


async def gather_scan_candidates(
    db: AsyncSession,
    *,
    branch_ids: list[str],
    within_days: int = _DEFAULT_EXPIRY_DAYS,
) -> list[NotificationCandidate]:
    """Collect all alert candidates for the scanner (no per-user filter)."""
    if not branch_ids:
        return []
    branch_names = await _branch_name_map(db)
    candidates: list[NotificationCandidate] = []
    candidates.extend(await _scan_low_stock(db, branch_ids, branch_names))
    candidates.extend(await _scan_out_of_stock(db, branch_ids, branch_names))
    candidates.extend(await _scan_batch_expiry(db, branch_ids, branch_names, within_days=within_days))
    candidates.extend(await _scan_pending_adjustments(db, branch_ids, branch_names))
    candidates.extend(await _scan_pending_transfers(db, branch_ids, branch_names))
    candidates.extend(await _scan_transfers_in_transit(db, branch_ids, branch_names))
    candidates.extend(await _scan_pending_purchase_orders(db, branch_ids, branch_names))
    candidates.extend(await _scan_pending_items(db))
    candidates.extend(await _scan_overdue_invoices(db, branch_ids, branch_names))
    candidates.extend(await _scan_overdue_bills(db, branch_ids, branch_names))
    return candidates


async def evaluate_notifications(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
    within_days: int = _DEFAULT_EXPIRY_DAYS,
) -> list[dict]:
    """Return notification dicts visible to `user` (cached, permission-gated)."""
    cache_key = (user.id, branch_id or "", within_days)
    now = time.monotonic()
    cached = _result_cache.get(cache_key)
    if cached and now < cached[0]:
        return cached[1]

    items = await _compute_notifications(
        db, user, branch_id=branch_id, within_days=within_days,
    )
    _result_cache[cache_key] = (now + _CACHE_TTL_SEC, items)
    return items


async def evaluate_notification_ids(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
    within_days: int = _DEFAULT_EXPIRY_DAYS,
) -> list[str]:
    """Lightweight id list for badge polling (shares result cache with list)."""
    items = await evaluate_notifications(
        db, user, branch_id=branch_id, within_days=within_days,
    )
    return [item["id"] for item in items]

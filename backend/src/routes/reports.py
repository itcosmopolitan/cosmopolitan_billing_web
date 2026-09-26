
import logging
from datetime import date, datetime, time, timedelta
from collections import defaultdict
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, and_, case, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified
from pydantic import BaseModel, ConfigDict, Field
from src import config
from src.database import get_db
from src.date_utils import MAX_REPORT_DATE_RANGE_DAYS, parse_date_range
from src.models import (
    AdjustmentRequest,
    Branch,
    Category,
    CashEntry,
    Customer,
    DailySalesSummary,
    InventorySnapshot,
    InvoiceStatus,
    Item,
    ItemBatch,
    ItemStock,
    PaymentSummary,
    ProductSalesSummary,
    PurchaseBill,
    PurchaseLineItem,
    ReturnLineItem,
    SaleInvoice,
    SaleLineItem,
    SalesReturn,
    SalesReturnLineItem,
    SalesReturnStatus,
    StockAdjustment,
    StockMovement,
    StockTransfer,
    TaxRate,
    TransferLineItem,
    User,
    UserReportFavorites,
    Vendor,
    VendorReturn,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.report_catalog import build_catalog_payload, normalize_favorite_ids
from src.security import current_user, get_allowed_branch_ids, require_perm

router = APIRouter()
logger = logging.getLogger("cosmopolitan.reports")


class ReportCatalogUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    favorites: list[str] = Field(default_factory=list)


@router.get("/catalog", dependencies=[Depends(require_perm("reports.view"))])
async def get_report_catalog(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reports Center categories + the current user's favorite report ids.

    Org-level catalog — not scoped by branch.
    """
    row = (
        await db.execute(select(UserReportFavorites).where(UserReportFavorites.user_id == user.id))
    ).scalar_one_or_none()
    favorite_ids = row.report_ids if row and isinstance(row.report_ids, list) else []
    return build_catalog_payload(favorite_ids)


@router.put("/catalog", dependencies=[Depends(require_perm("reports.view"))])
async def put_report_catalog(
    body: ReportCatalogUpdate,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's favorite report list; returns full catalog payload."""
    favorite_ids = normalize_favorite_ids(body.favorites)
    row = (
        await db.execute(select(UserReportFavorites).where(UserReportFavorites.user_id == user.id))
    ).scalar_one_or_none()
    if row is None:
        row = UserReportFavorites(user_id=user.id, report_ids=[])
        db.add(row)
    row.report_ids = favorite_ids
    flag_modified(row, "report_ids")
    row.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(row)
    return build_catalog_payload(row.report_ids)


async def _resolve_branch_scope(user, db: AsyncSession, branch_id: Optional[str]) -> Optional[list[str]]:
    if not getattr(user, "id", None):
        try:
            user = await current_user(authorization=None, db=db)
        except RuntimeError:
            return None
    if getattr(user, "all_branches", False):
        return None
    branch_ids = await get_allowed_branch_ids(user, db)
    if branch_ids:
        return branch_ids
    if getattr(user, "branch_id", None):
        return [user.branch_id]
    return []


def _normalize_date_range(
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[date, date]:
    """Return start and end as date objects for safe DB comparisons."""
    start, end = parse_date_range(
        date_from,
        date_to,
        date.today() - timedelta(days=30),
        date.today(),
        MAX_REPORT_DATE_RANGE_DAYS,
    )
    return start, end


def _parse_selected_branch_ids(branch_id: Optional[str]) -> list[str]:
    """Accept a single id or comma-separated multi-select (`id1,id2`)."""
    if not branch_id:
        return []
    return [part.strip() for part in str(branch_id).split(",") if part.strip()]


def _eq_or_in(column, branch_id: Optional[str]):
    selected = _parse_selected_branch_ids(branch_id)
    if not selected:
        return None
    if len(selected) == 1:
        return column == selected[0]
    return column.in_(selected)


def _transfer_branch_predicate(branch_id: Optional[str]):
    selected = _parse_selected_branch_ids(branch_id)
    if not selected:
        return None
    if len(selected) == 1:
        bid = selected[0]
        return (StockTransfer.from_branch_id == bid) | (StockTransfer.to_branch_id == bid)
    return StockTransfer.from_branch_id.in_(selected) | StockTransfer.to_branch_id.in_(selected)


def _branch_condition(column, branch_id: Optional[str], allowed_branch_ids: Optional[list[str]]):
    selected = _parse_selected_branch_ids(branch_id)
    if selected:
        if allowed_branch_ids is not None:
            if any(bid not in allowed_branch_ids for bid in selected):
                raise HTTPException(403, "Branch is outside your report scope")
        if len(selected) == 1:
            return column == selected[0]
        return column.in_(selected)
    if allowed_branch_ids is not None:
        if not allowed_branch_ids:
            return column == "__no_branch_access__"
        return column.in_(allowed_branch_ids)
    return None


def _use_materialized_read_models(db: AsyncSession) -> bool:
    dialect = db.bind.dialect.name if getattr(db, "bind", None) is not None else "sqlite"
    try:
        use_read_models = bool(config.get().dashboard_use_materialized_views)
    except RuntimeError:
        use_read_models = False
    return use_read_models and dialect == "postgresql"


def _sale_filters(
    branch_id: Optional[str],
    search: Optional[str],
    date_from: Optional,
    date_to: Optional,
    allowed_branch_ids: Optional[list[str]] = None,
    payment_mode: Optional[str] = None,
    cashier_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    item_id: Optional[str] = None,
    category_id: Optional[str] = None,
):
    conds = [SaleInvoice.status != InvoiceStatus.cancelled]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if date_from:
        conds.append(SaleInvoice.date >= (date_from.isoformat() if hasattr(date_from, 'isoformat') else date_from))
    if date_to:
        conds.append(SaleInvoice.date <= (date_to.isoformat() if hasattr(date_to, 'isoformat') else date_to))
    if search:
        conds.append(
            SaleInvoice.number.ilike(f"%{search}%")
            | SaleInvoice.customer_name.ilike(f"%{search}%")
        )
    if payment_mode is not None and str(payment_mode).strip() != "":
        raw = str(payment_mode).strip()
        if raw.lower() in ("unrecorded", "__none__"):
            conds.append(SaleInvoice.payment_mode.is_(None))
        else:
            conds.append(func.lower(SaleInvoice.payment_mode) == raw.lower())
    if cashier_id is not None and str(cashier_id).strip() != "":
        raw_cashier = str(cashier_id).strip()
        if raw_cashier in ("__none__",):
            conds.append(SaleInvoice.cashier.is_(None) | (SaleInvoice.cashier == ""))
        else:
            # Invoices store cashier display name; resolve unique user id → name.
            conds.append(
                SaleInvoice.cashier.in_(select(User.name).where(User.id == raw_cashier))
            )
    if customer_id is not None and str(customer_id).strip() != "":
        raw_customer = str(customer_id).strip()
        if raw_customer in ("__none__",):
            conds.append(SaleInvoice.customer_id.is_(None))
        else:
            conds.append(SaleInvoice.customer_id == raw_customer)
    if item_id:
        conds.append(
            SaleInvoice.id.in_(
                select(SaleLineItem.invoice_id).where(SaleLineItem.item_id == item_id)
            )
        )
    if category_id:
        if category_id in ("__none__", "__uncategorized__"):
            conds.append(
                SaleInvoice.id.in_(
                    select(SaleLineItem.invoice_id)
                    .outerjoin(Item, Item.id == SaleLineItem.item_id)
                    .where(Item.category_id.is_(None))
                )
            )
        else:
            conds.append(
                SaleInvoice.id.in_(
                    select(SaleLineItem.invoice_id)
                    .join(Item, Item.id == SaleLineItem.item_id)
                    .where(Item.category_id == category_id)
                )
            )
    return conds


def _iso_date(value) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else value


def _null_str():
    return cast(literal(None), String)


_TXN_TYPE_ALIASES = {
    "invoice": "Invoice",
    "credit_note": "Credit Note",
    "creditnote": "Credit Note",
    "bill": "Bill",
    "debit_note": "Debit Note",
    "debitnote": "Debit Note",
    "vendor_return": "Debit Note",
    "vendorreturn": "Debit Note",
}


def _canonical_transaction_types(raw: Optional[str]) -> Optional[list[str]]:
    """Canonical labels to include, or None for all types.

    Empty / ``__none__`` means match nothing.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if text == "":
        return None
    if text.lower() in ("__none__", "__empty__"):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for part in text.split(","):
        token = part.strip()
        if not token:
            continue
        key = token.lower().replace("-", "_").replace(" ", "_")
        compact = key.replace("_", "")
        label = _TXN_TYPE_ALIASES.get(key) or _TXN_TYPE_ALIASES.get(compact)
        if label is None:
            for canon in ("Invoice", "Credit Note", "Bill", "Debit Note"):
                if canon.lower() == token.lower():
                    label = canon
                    break
        if not label or label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out


def _restrict_transaction_types(query, column, raw: Optional[str]):
    types = _canonical_transaction_types(raw)
    if types is None:
        return query
    if not types:
        return query.where(literal(False))
    return query.where(column.in_(types))


def _wants_transaction_type(raw: Optional[str], label: str) -> bool:
    types = _canonical_transaction_types(raw)
    if types is None:
        return True
    return label in types


def _invoice_outstanding_expr():
    """AR remaining after cash collections and active credit notes. Never below 0."""
    raw = (
        func.coalesce(SaleInvoice.total, 0)
        - func.coalesce(SaleInvoice.paid_amount, 0)
        - func.coalesce(SaleInvoice.credited_amount, 0)
    )
    return case((raw < 0, literal(0.0)), else_=raw)


def _cn_filters(
    branch_id: Optional[str],
    search: Optional[str],
    date_from: Optional,
    date_to: Optional,
    allowed_branch_ids: Optional[list[str]] = None,
    payment_mode: Optional[str] = None,
    cashier_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    item_id: Optional[str] = None,
    category_id: Optional[str] = None,
):
    """Filters for active credit notes. Cashier / payment_mode follow the source invoice
    so parent aggregations and sales-register drilldowns stay aligned.
    """
    conds = [SalesReturn.status != SalesReturnStatus.void]
    branch_cond = _branch_condition(SalesReturn.branch_id, branch_id, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if date_from:
        conds.append(SalesReturn.date >= _iso_date(date_from))
    if date_to:
        conds.append(SalesReturn.date <= _iso_date(date_to))
    if search:
        conds.append(
            SalesReturn.number.ilike(f"%{search}%")
            | SalesReturn.customer_name.ilike(f"%{search}%")
        )
    if payment_mode is not None and str(payment_mode).strip() != "":
        raw = str(payment_mode).strip()
        if raw.lower() in ("unrecorded", "__none__"):
            conds.append(SaleInvoice.payment_mode.is_(None))
        else:
            conds.append(func.lower(SaleInvoice.payment_mode) == raw.lower())
    if cashier_id is not None and str(cashier_id).strip() != "":
        raw_cashier = str(cashier_id).strip()
        if raw_cashier in ("__none__",):
            conds.append(SaleInvoice.cashier.is_(None) | (SaleInvoice.cashier == ""))
        else:
            conds.append(
                SaleInvoice.cashier.in_(select(User.name).where(User.id == raw_cashier))
            )
    if customer_id is not None and str(customer_id).strip() != "":
        raw_customer = str(customer_id).strip()
        if raw_customer in ("__none__",):
            conds.append(SalesReturn.customer_id.is_(None))
        else:
            conds.append(SalesReturn.customer_id == raw_customer)
    if item_id:
        conds.append(
            SalesReturn.id.in_(
                select(SalesReturnLineItem.return_id).where(SalesReturnLineItem.item_id == item_id)
            )
        )
    if category_id:
        if category_id in ("__none__", "__uncategorized__"):
            conds.append(
                SalesReturn.id.in_(
                    select(SalesReturnLineItem.return_id)
                    .outerjoin(Item, Item.id == SalesReturnLineItem.item_id)
                    .where(Item.category_id.is_(None))
                )
            )
        else:
            conds.append(
                SalesReturn.id.in_(
                    select(SalesReturnLineItem.return_id)
                    .join(Item, Item.id == SalesReturnLineItem.item_id)
                    .where(Item.category_id == category_id)
                )
            )
    return conds


def _sales_register_union_query(inv_conds, cn_conds):
    """Invoice rows (positive) UNION credit-note rows (negative amounts)."""
    inv_q = select(
        SaleInvoice.id.label("invoice_id"),
        SaleInvoice.number.label("invoice_number"),
        SaleInvoice.date.label("invoice_date"),
        SaleInvoice.customer_name.label("customer"),
        SaleInvoice.branch_name.label("branch"),
        SaleInvoice.cashier.label("cashier"),
        SaleInvoice.subtotal.label("taxable_amount"),
        SaleInvoice.tax_total.label("tax_amount"),
        SaleInvoice.discount.label("discount"),
        SaleInvoice.total.label("net_amount"),
        SaleInvoice.payment_mode.label("payment_mode"),
        func.coalesce(SaleInvoice.paid_amount, 0).label("paid_amount"),
        _invoice_outstanding_expr().label("remaining_amount"),
        literal("Invoice").label("transaction_type"),
        cast(SaleInvoice.status, String).label("status"),
        _null_str().label("document_id"),
        literal("invoice").label("detail_kind"),
    ).where(and_(*inv_conds) if inv_conds else True)

    cn_q = (
        select(
            _null_str().label("invoice_id"),
            SalesReturn.number.label("invoice_number"),
            SalesReturn.date.label("invoice_date"),
            SalesReturn.customer_name.label("customer"),
            SalesReturn.branch_name.label("branch"),
            SaleInvoice.cashier.label("cashier"),
            (-func.coalesce(SalesReturn.subtotal, 0)).label("taxable_amount"),
            (-func.coalesce(SalesReturn.tax_total, 0)).label("tax_amount"),
            literal(0.0).label("discount"),
            (-func.coalesce(SalesReturn.total, 0)).label("net_amount"),
            SaleInvoice.payment_mode.label("payment_mode"),
            (-func.coalesce(SalesReturn.credited_amount, 0)).label("paid_amount"),
            literal(0.0).label("remaining_amount"),
            literal("Credit Note").label("transaction_type"),
            cast(SalesReturn.status, String).label("status"),
            SalesReturn.id.label("document_id"),
            literal("credit_note").label("detail_kind"),
        )
        .select_from(SalesReturn)
        .join(SaleInvoice, SaleInvoice.id == SalesReturn.invoice_id)
        .where(and_(*cn_conds) if cn_conds else True)
    )
    return inv_q.union_all(cn_q).subquery()


def _signed_sales_docs_subquery(inv_conds, cn_conds):
    """One row per invoice (+) and credit note (−) with signed totals/qty."""
    per_inv = (
        select(
            SaleInvoice.date.label("doc_date"),
            SaleInvoice.id.label("doc_id"),
            SaleInvoice.payment_mode.label("payment_mode"),
            SaleInvoice.cashier.label("cashier"),
            SaleInvoice.branch_id.label("branch_id"),
            SaleInvoice.branch_name.label("branch"),
            SaleInvoice.customer_id.label("customer_id"),
            SaleInvoice.customer_name.label("customer"),
            SaleInvoice.total.label("total"),
            func.coalesce(SaleInvoice.discount, 0).label("discount"),
            func.coalesce(SaleInvoice.tax_total, 0).label("tax_total"),
            func.coalesce(SaleInvoice.paid_amount, 0).label("paid_amount"),
            _invoice_outstanding_expr().label("outstanding"),
            func.coalesce(func.sum(SaleLineItem.qty), 0).label("quantity_sold"),
        )
        .select_from(SaleInvoice)
        .outerjoin(SaleLineItem, SaleLineItem.invoice_id == SaleInvoice.id)
        .where(and_(*inv_conds) if inv_conds else True)
        .group_by(
            SaleInvoice.date,
            SaleInvoice.id,
            SaleInvoice.payment_mode,
            SaleInvoice.cashier,
            SaleInvoice.branch_id,
            SaleInvoice.branch_name,
            SaleInvoice.customer_id,
            SaleInvoice.customer_name,
            SaleInvoice.total,
            SaleInvoice.discount,
            SaleInvoice.tax_total,
            SaleInvoice.paid_amount,
            SaleInvoice.credited_amount,
        )
    )
    per_cn = (
        select(
            SalesReturn.date.label("doc_date"),
            SalesReturn.id.label("doc_id"),
            SaleInvoice.payment_mode.label("payment_mode"),
            SaleInvoice.cashier.label("cashier"),
            SalesReturn.branch_id.label("branch_id"),
            SalesReturn.branch_name.label("branch"),
            SalesReturn.customer_id.label("customer_id"),
            SalesReturn.customer_name.label("customer"),
            (-func.coalesce(SalesReturn.total, 0)).label("total"),
            literal(0.0).label("discount"),
            (-func.coalesce(SalesReturn.tax_total, 0)).label("tax_total"),
            literal(0.0).label("paid_amount"),
            literal(0.0).label("outstanding"),
            (-func.coalesce(func.sum(SalesReturnLineItem.return_qty), 0)).label("quantity_sold"),
        )
        .select_from(SalesReturn)
        .join(SaleInvoice, SaleInvoice.id == SalesReturn.invoice_id)
        .outerjoin(SalesReturnLineItem, SalesReturnLineItem.return_id == SalesReturn.id)
        .where(and_(*cn_conds) if cn_conds else True)
        .group_by(
            SalesReturn.date,
            SalesReturn.id,
            SaleInvoice.payment_mode,
            SaleInvoice.cashier,
            SalesReturn.branch_id,
            SalesReturn.branch_name,
            SalesReturn.customer_id,
            SalesReturn.customer_name,
            SalesReturn.total,
            SalesReturn.tax_total,
        )
    )
    return per_inv.union_all(per_cn).subquery()


def _signed_sales_lines_query(inv_conds, cn_conds):
    """Invoice lines (positive qty/value) UNION credit-note lines (negative)."""
    inv_q = (
        select(
            SaleInvoice.id.label("invoice_id"),
            SaleInvoice.number.label("invoice_number"),
            SaleInvoice.date.label("invoice_date"),
            SaleLineItem.item_id.label("item_id"),
            func.coalesce(Item.sku, SaleLineItem.sku, SaleLineItem.item_id).label("product_code"),
            SaleLineItem.name.label("product_name"),
            Category.id.label("category_id"),
            func.coalesce(Category.name, "Uncategorized").label("category"),
            SaleInvoice.customer_name.label("customer"),
            SaleInvoice.branch_name.label("branch"),
            SaleInvoice.cashier.label("cashier"),
            SaleLineItem.qty.label("quantity"),
            SaleLineItem.price.label("unit_price"),
            SaleLineItem.discount.label("discount"),
            SaleLineItem.line_total.label("line_total"),
            (func.coalesce(Item.cost_price, 0) * SaleLineItem.qty).label("cost_value"),
            (
                SaleLineItem.line_total
                - (func.coalesce(Item.cost_price, 0) * SaleLineItem.qty)
            ).label("profit"),
            SaleInvoice.payment_mode.label("payment_mode"),
            func.coalesce(SaleInvoice.paid_amount, 0).label("paid_amount"),
            _invoice_outstanding_expr().label("remaining_amount"),
            literal("Invoice").label("transaction_type"),
            cast(SaleInvoice.status, String).label("status"),
            _null_str().label("document_id"),
            literal("invoice").label("detail_kind"),
        )
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleInvoice.id == SaleLineItem.invoice_id)
        .outerjoin(Item, Item.id == SaleLineItem.item_id)
        .outerjoin(Category, Category.id == Item.category_id)
        .where(and_(*inv_conds) if inv_conds else True)
    )
    cn_q = (
        select(
            _null_str().label("invoice_id"),
            SalesReturn.number.label("invoice_number"),
            SalesReturn.date.label("invoice_date"),
            SalesReturnLineItem.item_id.label("item_id"),
            func.coalesce(Item.sku, SalesReturnLineItem.item_id).label("product_code"),
            SalesReturnLineItem.name.label("product_name"),
            Category.id.label("category_id"),
            func.coalesce(Category.name, "Uncategorized").label("category"),
            SalesReturn.customer_name.label("customer"),
            SalesReturn.branch_name.label("branch"),
            SaleInvoice.cashier.label("cashier"),
            (-func.coalesce(SalesReturnLineItem.return_qty, 0)).label("quantity"),
            SalesReturnLineItem.price.label("unit_price"),
            literal(0.0).label("discount"),
            (-func.coalesce(SalesReturnLineItem.line_total, 0)).label("line_total"),
            (
                -func.coalesce(Item.cost_price, 0) * func.coalesce(SalesReturnLineItem.return_qty, 0)
            ).label("cost_value"),
            (
                -func.coalesce(SalesReturnLineItem.line_total, 0)
                + (func.coalesce(Item.cost_price, 0) * func.coalesce(SalesReturnLineItem.return_qty, 0))
            ).label("profit"),
            SaleInvoice.payment_mode.label("payment_mode"),
            literal(0.0).label("paid_amount"),
            literal(0.0).label("remaining_amount"),
            literal("Credit Note").label("transaction_type"),
            cast(SalesReturn.status, String).label("status"),
            SalesReturn.id.label("document_id"),
            literal("credit_note").label("detail_kind"),
        )
        .select_from(SalesReturnLineItem)
        .join(SalesReturn, SalesReturn.id == SalesReturnLineItem.return_id)
        .join(SaleInvoice, SaleInvoice.id == SalesReturn.invoice_id)
        .outerjoin(Item, Item.id == SalesReturnLineItem.item_id)
        .outerjoin(Category, Category.id == Item.category_id)
        .where(and_(*cn_conds) if cn_conds else True)
    )
    return inv_q.union_all(cn_q)


def _purchase_filters(
    branch_id: Optional[str],
    vendor_id: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    allowed_branch_ids: Optional[list[str]] = None,
    item_id: Optional[str] = None,
):
    conds = [PurchaseBill.status != InvoiceStatus.cancelled]
    branch_cond = _branch_condition(PurchaseBill.branch_id, branch_id, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if vendor_id:
        conds.append(PurchaseBill.vendor_id == vendor_id)
    if date_from:
        conds.append(PurchaseBill.date >= (date_from.isoformat() if hasattr(date_from, 'isoformat') else date_from))
    if date_to:
        conds.append(PurchaseBill.date <= (date_to.isoformat() if hasattr(date_to, 'isoformat') else date_to))
    if search:
        conds.append(
            PurchaseBill.number.ilike(f"%{search}%")
            | PurchaseBill.vendor_name.ilike(f"%{search}%")
        )
    if item_id:
        conds.append(
            PurchaseBill.id.in_(
                select(PurchaseLineItem.bill_id).where(PurchaseLineItem.item_id == item_id)
            )
        )
    return conds


def _vr_filters(
    branch_id: Optional[str],
    vendor_id: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    allowed_branch_ids: Optional[list[str]] = None,
    item_id: Optional[str] = None,
):
    """Filters for active vendor returns (debit notes)."""
    conds = [VendorReturn.voided.is_(False)]
    branch_cond = _branch_condition(VendorReturn.branch_id, branch_id, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if vendor_id:
        conds.append(VendorReturn.vendor_id == vendor_id)
    if date_from:
        conds.append(VendorReturn.date >= _iso_date(date_from))
    if date_to:
        conds.append(VendorReturn.date <= _iso_date(date_to))
    if search:
        conds.append(
            VendorReturn.number.ilike(f"%{search}%")
            | VendorReturn.vendor_name.ilike(f"%{search}%")
        )
    if item_id:
        conds.append(
            VendorReturn.id.in_(
                select(ReturnLineItem.return_id).where(ReturnLineItem.item_id == item_id)
            )
        )
    return conds


def _active_vendor_return_totals():
    """All active returns per bill — used to restore original bill amounts.

    Creating a vendor return mutates PurchaseBill.total / paid_amount, so reports
    must add those returns back on the bill row and then list them as negatives.
    Date filters apply only to the debit-note union rows, not this restore.
    """
    return (
        select(
            VendorReturn.bill_id.label("bill_id"),
            func.coalesce(func.sum(VendorReturn.total), 0).label("ret_total"),
            func.coalesce(func.sum(VendorReturn.credited_amount), 0).label("ret_credited"),
        )
        .where(VendorReturn.voided.is_(False))
        .group_by(VendorReturn.bill_id)
        .subquery()
    )


def _original_bill_total(vr_agg):
    return func.coalesce(PurchaseBill.total, 0) + func.coalesce(vr_agg.c.ret_total, 0)


def _original_bill_paid(vr_agg):
    return func.coalesce(PurchaseBill.paid_amount, 0) + func.coalesce(vr_agg.c.ret_credited, 0)


def _bill_outstanding_expr(vr_agg):
    """AP remaining after payments and active vendor returns. Never below 0."""
    raw = (
        func.coalesce(PurchaseBill.total, 0)
        - func.coalesce(PurchaseBill.paid_amount, 0)
        - func.coalesce(vr_agg.c.ret_credited, 0)
    )
    return case((raw < 0, literal(0.0)), else_=raw)


def _purchase_register_union_query(bill_conds, vr_conds):
    """Bill rows (original / positive) UNION vendor-return rows (negative amounts)."""
    vr_agg = _active_vendor_return_totals()
    bill_q = (
        select(
            PurchaseBill.id.label("bill_id"),
            PurchaseBill.number.label("bill_number"),
            PurchaseBill.date.label("bill_date"),
            PurchaseBill.vendor_name.label("vendor"),
            PurchaseBill.branch_name.label("branch"),
            PurchaseBill.subtotal.label("subtotal"),
            PurchaseBill.tax_total.label("tax"),
            _original_bill_total(vr_agg).label("total"),
            _original_bill_paid(vr_agg).label("paid"),
            _bill_outstanding_expr(vr_agg).label("balance"),
            literal("Bill").label("transaction_type"),
            cast(PurchaseBill.status, String).label("status"),
            _null_str().label("document_id"),
            literal("bill").label("detail_kind"),
        )
        .select_from(PurchaseBill)
        .outerjoin(vr_agg, vr_agg.c.bill_id == PurchaseBill.id)
        .where(and_(*bill_conds) if bill_conds else True)
    )
    vr_q = (
        select(
            _null_str().label("bill_id"),
            VendorReturn.number.label("bill_number"),
            VendorReturn.date.label("bill_date"),
            VendorReturn.vendor_name.label("vendor"),
            VendorReturn.branch_name.label("branch"),
            (-func.coalesce(VendorReturn.subtotal, 0)).label("subtotal"),
            (-func.coalesce(VendorReturn.tax_total, 0)).label("tax"),
            (-func.coalesce(VendorReturn.total, 0)).label("total"),
            (-func.coalesce(VendorReturn.credited_amount, 0)).label("paid"),
            literal(0.0).label("balance"),
            literal("Debit Note").label("transaction_type"),
            cast(VendorReturn.status, String).label("status"),
            VendorReturn.id.label("document_id"),
            literal("debit_note").label("detail_kind"),
        )
        .select_from(VendorReturn)
        .where(and_(*vr_conds) if vr_conds else True)
    )
    return bill_q.union_all(vr_q).subquery()


def _signed_purchase_docs_subquery(bill_conds, vr_conds):
    """One row per bill (+) and vendor return (−) with signed totals/qty."""
    vr_agg = _active_vendor_return_totals()
    per_bill = (
        select(
            PurchaseBill.date.label("doc_date"),
            PurchaseBill.id.label("doc_id"),
            PurchaseBill.vendor_id.label("vendor_id"),
            PurchaseBill.vendor_name.label("vendor"),
            PurchaseBill.branch_id.label("branch_id"),
            PurchaseBill.branch_name.label("branch"),
            _original_bill_total(vr_agg).label("total"),
            func.coalesce(PurchaseBill.tax_total, 0).label("tax_total"),
            _original_bill_paid(vr_agg).label("paid_amount"),
            _bill_outstanding_expr(vr_agg).label("outstanding"),
            func.coalesce(func.sum(PurchaseLineItem.qty), 0).label("quantity_purchased"),
        )
        .select_from(PurchaseBill)
        .outerjoin(vr_agg, vr_agg.c.bill_id == PurchaseBill.id)
        .outerjoin(PurchaseLineItem, PurchaseLineItem.bill_id == PurchaseBill.id)
        .where(and_(*bill_conds) if bill_conds else True)
        .group_by(
            PurchaseBill.date,
            PurchaseBill.id,
            PurchaseBill.vendor_id,
            PurchaseBill.vendor_name,
            PurchaseBill.branch_id,
            PurchaseBill.branch_name,
            PurchaseBill.total,
            PurchaseBill.tax_total,
            PurchaseBill.paid_amount,
            PurchaseBill.credited_amount,
            vr_agg.c.ret_total,
            vr_agg.c.ret_credited,
        )
    )
    per_vr = (
        select(
            VendorReturn.date.label("doc_date"),
            VendorReturn.id.label("doc_id"),
            VendorReturn.vendor_id.label("vendor_id"),
            VendorReturn.vendor_name.label("vendor"),
            VendorReturn.branch_id.label("branch_id"),
            VendorReturn.branch_name.label("branch"),
            (-func.coalesce(VendorReturn.total, 0)).label("total"),
            (-func.coalesce(VendorReturn.tax_total, 0)).label("tax_total"),
            (-func.coalesce(VendorReturn.credited_amount, 0)).label("paid_amount"),
            literal(0.0).label("outstanding"),
            (-func.coalesce(func.sum(ReturnLineItem.return_qty), 0)).label("quantity_purchased"),
        )
        .select_from(VendorReturn)
        .outerjoin(ReturnLineItem, ReturnLineItem.return_id == VendorReturn.id)
        .where(and_(*vr_conds) if vr_conds else True)
        .group_by(
            VendorReturn.date,
            VendorReturn.id,
            VendorReturn.vendor_id,
            VendorReturn.vendor_name,
            VendorReturn.branch_id,
            VendorReturn.branch_name,
            VendorReturn.total,
            VendorReturn.tax_total,
            VendorReturn.credited_amount,
        )
    )
    return per_bill.union_all(per_vr).subquery()


def _signed_purchase_lines_query(bill_conds, vr_conds):
    """Bill lines (positive qty/value) UNION vendor-return lines (negative)."""
    bill_q = (
        select(
            PurchaseBill.id.label("bill_id"),
            PurchaseBill.number.label("bill_number"),
            PurchaseBill.date.label("bill_date"),
            PurchaseLineItem.item_id.label("item_id"),
            PurchaseLineItem.name.label("product"),
            PurchaseBill.vendor_name.label("vendor"),
            PurchaseBill.branch_name.label("branch"),
            PurchaseLineItem.qty.label("quantity"),
            PurchaseLineItem.cost.label("unit_cost"),
            PurchaseLineItem.discount.label("discount"),
            PurchaseLineItem.line_total.label("line_total"),
            literal("Bill").label("transaction_type"),
            cast(PurchaseBill.status, String).label("status"),
            _null_str().label("document_id"),
            literal("bill").label("detail_kind"),
        )
        .select_from(PurchaseLineItem)
        .join(PurchaseBill, PurchaseBill.id == PurchaseLineItem.bill_id)
        .where(and_(*bill_conds) if bill_conds else True)
    )
    vr_q = (
        select(
            _null_str().label("bill_id"),
            VendorReturn.number.label("bill_number"),
            VendorReturn.date.label("bill_date"),
            ReturnLineItem.item_id.label("item_id"),
            ReturnLineItem.name.label("product"),
            VendorReturn.vendor_name.label("vendor"),
            VendorReturn.branch_name.label("branch"),
            (-func.coalesce(ReturnLineItem.return_qty, 0)).label("quantity"),
            ReturnLineItem.cost.label("unit_cost"),
            literal(0.0).label("discount"),
            (-func.coalesce(ReturnLineItem.line_total, 0)).label("line_total"),
            literal("Debit Note").label("transaction_type"),
            cast(VendorReturn.status, String).label("status"),
            VendorReturn.id.label("document_id"),
            literal("debit_note").label("detail_kind"),
        )
        .select_from(ReturnLineItem)
        .join(VendorReturn, VendorReturn.id == ReturnLineItem.return_id)
        .where(and_(*vr_conds) if vr_conds else True)
    )
    return bill_q.union_all(vr_q)


def _branch_filter(search: Optional[str], branch_id: Optional[str]):
    conds = []
    transfer_pred = _transfer_branch_predicate(branch_id)
    if transfer_pred is not None:
        conds.append(transfer_pred)
    if search:
        conds.append(TransferLineItem.item_name.ilike(f"%{search}%"))
    return conds


def _paged_count(model, conds):
    query = select(func.count(model.id))
    if conds:
        query = query.where(and_(*conds))
    return query
def _parse_period(
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[Optional[datetime], Optional[datetime]]:
    """Inclusive local-day bounds for filtering StockMovement.created_at."""
    start = None
    end = None
    if date_from:
        start = datetime.combine(datetime.strptime(date_from, "%Y-%m-%d").date(), time.min)
    if date_to:
        end = datetime.combine(datetime.strptime(date_to, "%Y-%m-%d").date(), time.max)
    return start, end


def _bucket_movement(
    movement_type: str,
    source_type: Optional[str],
    delta: int,
) -> tuple[int, int, int, int, int]:
    """Return (purchases_in, sales_out, transfers_in, transfers_out, adjustments)."""
    mt = (movement_type or "").lower()
    st = (source_type or "").lower()
    d = int(delta)
    if d == 0:
        return (0, 0, 0, 0, 0)

    if mt in ("grn", "grn_reversal") or st == "grn":
        return (d, 0, 0, 0, 0)

    if st == "transfer" or mt == "transfer":
        if d > 0:
            return (0, 0, d, 0, 0)
        return (0, 0, 0, -d, 0)

    if st in ("return", "sales_return") or mt in ("return", "sales_return", "sale_reversal"):
        if d > 0:
            return (0, 0, 0, 0, d)
        return (0, -d, 0, 0, 0)

    if mt in ("vendor_return",) or st in ("vendor_return",):
        if d < 0:
            return (0, 0, 0, 0, d)
        return (0, 0, 0, 0, d)

    if mt == "sale" or st == "sale_invoice":
        if d < 0:
            return (0, -d, 0, 0, 0)
        return (0, 0, 0, 0, d)

    if mt == "adjustment" or st in ("opening", "manual", "adjustment"):
        return (0, 0, 0, 0, d)

    if d < 0:
        return (0, -d, 0, 0, 0)
    return (d, 0, 0, 0, 0)


def _trail_node(
    *,
    doc_type: str,
    doc_id: str,
    number: str,
    status: str,
    date: Optional[str],
    total: float,
    extra: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "type": doc_type,
        "id": doc_id,
        "number": number,
        "status": status,
        "date": date,
        "total": float(total or 0),
    }
    if extra:
        row.update(extra)
    return row


@router.get("/sales-summary", dependencies=[Depends(require_perm("reports.view"))])
async def sales_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    inv_conds = _sale_filters(branch_id, None, start, end, allowed_branch_ids=branch_scope)
    cn_conds = _cn_filters(branch_id, None, start, end, allowed_branch_ids=branch_scope)
    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)
    logger.debug("Sales summary date range %s to %s", start.isoformat(), end.isoformat())

    q = select(
        func.coalesce(func.sum(docs.c.total), 0).label("total"),
        func.count(docs.c.doc_id).label("count"),
        func.coalesce(func.sum(docs.c.tax_total), 0).label("gst"),
        func.coalesce(func.sum(docs.c.discount), 0).label("discount"),
        func.coalesce(func.sum(docs.c.paid_amount), 0).label("collected"),
        func.coalesce(func.sum(docs.c.outstanding), 0).label("outstanding"),
    ).select_from(docs)
    result = await db.execute(q)
    row = result.one()

    daily = [
        {"date": f"Apr {i}", "invoices": 12 + i % 8, "total": 82000 + i * 4200, "collected": 78000 + i * 3900}
        for i in range(3, 17)
    ]

    total_sales = float(row.total or 0)
    total_tax = float(row.gst or 0)
    total_discount = float(row.discount or 0)
    total_paid = float(row.collected or 0)
    return {
        "period": {"from": start, "to": end},
        "total_tax": total_tax,
        "total_paid": total_paid,
        "total_sales": total_sales,
        "invoice_count": int(row.count or 0),
        "total_gst": total_tax,
        "total_discount": total_discount,
        "collected": total_paid,
        "outstanding": float(row.outstanding or 0),
        "daily": daily,
    }


@router.get("/purchase-summary", dependencies=[Depends(require_perm("reports.view"))])
async def purchase_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    bill_conds = _purchase_filters(branch_id, None, None, start, end, allowed_branch_ids=branch_scope)
    vr_conds = _vr_filters(branch_id, None, None, start, end, allowed_branch_ids=branch_scope)
    docs = _signed_purchase_docs_subquery(bill_conds, vr_conds)
    logger.debug("Purchase summary date range %s to %s", start.isoformat(), end.isoformat())

    q = select(
        func.coalesce(func.sum(docs.c.total), 0).label("total"),
        func.count(docs.c.doc_id).label("count"),
        func.coalesce(func.sum(docs.c.paid_amount), 0).label("paid"),
        func.coalesce(func.sum(docs.c.outstanding), 0).label("outstanding"),
    ).select_from(docs)
    result = await db.execute(q)
    row = result.one()
    total_purchases = float(row.total or 0)
    total_paid = float(row.paid or 0)
    return {
        "period": {"from": start, "to": end},
        "total_purchases": total_purchases,
        "bill_count": int(row.count or 0),
        "paid": total_paid,
        "outstanding": float(row.outstanding or 0),
    }


def _tax_line_exprs(line_total_col, tax_rate_col):
    """Tax-inclusive line totals → taxable + tax amount expressions."""
    rate = func.coalesce(tax_rate_col, 0.0)
    taxable = case(
        (rate <= 0, func.coalesce(line_total_col, 0.0)),
        else_=(func.coalesce(line_total_col, 0.0) * 100.0) / (100.0 + rate),
    )
    tax_amt = func.coalesce(line_total_col, 0.0) - taxable
    return rate, taxable, tax_amt


def _fmt_tax_pct(rate: float) -> str:
    value = float(rate or 0)
    if value == int(value):
        return str(int(value))
    return f"{value:g}"


def _tax_name_for_rate(rate: float, labels_by_rate: dict[float, str]) -> str:
    """Prefer configured TaxRate.label; otherwise GST {rate}%."""
    rate = float(rate or 0)
    for key, label in labels_by_rate.items():
        if abs(key - rate) < 0.0001 and label:
            return label
    pct = _fmt_tax_pct(rate)
    return f"Exempt ({pct}%)" if rate <= 0 else f"GST {pct}%"


def _round_rate_key(rate: float) -> float:
    return round(float(rate or 0), 4)


@router.get("/tax-summary", dependencies=[Depends(require_perm("reports.view"))])
async def tax_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    """One row per configured tax rate (Settings → Taxes), not CGST/SGST splits."""
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = start.isoformat() if hasattr(start, "isoformat") else start
    end_s = end.isoformat() if hasattr(end, "isoformat") else end

    # Available taxes in this app — active TaxRate rows from settings.
    tax_rate_rows = (
        await db.execute(select(TaxRate).where(TaxRate.active.is_(True)).order_by(TaxRate.rate))
    ).scalars().all()
    labels_by_rate: dict[float, str] = {}
    available_rates: list[float] = []
    for tr in tax_rate_rows:
        key = _round_rate_key(tr.rate)
        available_rates.append(key)
        if key not in labels_by_rate:
            labels_by_rate[key] = (tr.label or "").strip()

    sale_conds = [
        SaleInvoice.status != InvoiceStatus.cancelled,
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
    ]
    sale_branch = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if sale_branch is not None:
        sale_conds.append(sale_branch)

    purchase_conds = [
        PurchaseBill.status != InvoiceStatus.cancelled,
        PurchaseBill.date >= start_s,
        PurchaseBill.date <= end_s,
    ]
    purchase_branch = _branch_condition(PurchaseBill.branch_id, branch_id, branch_scope)
    if purchase_branch is not None:
        purchase_conds.append(purchase_branch)

    cn_conds = [
        SalesReturn.status != SalesReturnStatus.void,
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
    ]
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)

    dn_conds = [
        VendorReturn.voided.is_(False),
        VendorReturn.date >= start_s,
        VendorReturn.date <= end_s,
    ]
    dn_branch = _branch_condition(VendorReturn.branch_id, branch_id, branch_scope)
    if dn_branch is not None:
        dn_conds.append(dn_branch)

    sale_rate, sale_taxable, sale_tax = _tax_line_exprs(SaleLineItem.line_total, SaleLineItem.tax_rate)
    purchase_rate, purchase_taxable, purchase_tax = _tax_line_exprs(
        PurchaseLineItem.line_total, PurchaseLineItem.tax_rate,
    )
    cn_rate, cn_taxable, cn_tax = _tax_line_exprs(SalesReturnLineItem.line_total, SalesReturnLineItem.tax_rate)
    dn_rate, dn_taxable, dn_tax = _tax_line_exprs(ReturnLineItem.line_total, ReturnLineItem.tax_rate)

    async def _rate_totals(query):
        return [dict(r._mapping) for r in (await db.execute(query)).fetchall()]

    sales_rows = await _rate_totals(
        select(
            sale_rate.label("rate"),
            func.coalesce(func.sum(sale_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(sale_tax), 0).label("tax_amount"),
        )
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleInvoice.id == SaleLineItem.invoice_id)
        .where(and_(*sale_conds))
        .group_by(sale_rate)
    )
    purchase_rows = await _rate_totals(
        select(
            purchase_rate.label("rate"),
            func.coalesce(func.sum(purchase_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(purchase_tax), 0).label("tax_amount"),
        )
        .select_from(PurchaseLineItem)
        .join(PurchaseBill, PurchaseBill.id == PurchaseLineItem.bill_id)
        .where(and_(*purchase_conds))
        .group_by(purchase_rate)
    )
    cn_rows = await _rate_totals(
        select(
            cn_rate.label("rate"),
            func.coalesce(func.sum(cn_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(cn_tax), 0).label("tax_amount"),
        )
        .select_from(SalesReturnLineItem)
        .join(SalesReturn, SalesReturn.id == SalesReturnLineItem.return_id)
        .where(and_(*cn_conds))
        .group_by(cn_rate)
    )
    dn_rows = await _rate_totals(
        select(
            dn_rate.label("rate"),
            func.coalesce(func.sum(dn_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(dn_tax), 0).label("tax_amount"),
        )
        .select_from(ReturnLineItem)
        .join(VendorReturn, VendorReturn.id == ReturnLineItem.return_id)
        .where(and_(*dn_conds))
        .group_by(dn_rate)
    )

    by_rate: dict[float, dict[str, float]] = defaultdict(lambda: {"taxable_amount": 0.0, "tax_amount": 0.0})

    def _accumulate(raw_rows, sign: float = 1.0):
        for raw in raw_rows:
            rate = _round_rate_key(raw.get("rate") or 0)
            by_rate[rate]["taxable_amount"] += sign * float(raw.get("taxable_amount") or 0)
            by_rate[rate]["tax_amount"] += sign * float(raw.get("tax_amount") or 0)

    _accumulate(sales_rows)
    _accumulate(purchase_rows)
    _accumulate(cn_rows, -1.0)
    _accumulate(dn_rows, -1.0)

    def _is_available_rate(rate: float) -> bool:
        if not available_rates:
            return True
        return any(abs(rate - ar) < 0.0001 for ar in available_rates)

    rows: list[dict[str, Any]] = []
    for rate, amounts in by_rate.items():
        if not _is_available_rate(rate):
            continue
        taxable = round(amounts["taxable_amount"], 2)
        tax_amt = round(amounts["tax_amount"], 2)
        if abs(taxable) <= 0.0001 and abs(tax_amt) <= 0.0001:
            continue
        rows.append({
            "tax_name": _tax_name_for_rate(rate, labels_by_rate),
            "tax_percentage": float(rate),
            "taxable_amount": taxable,
            "tax_amount": tax_amt,
            "full_rate": float(rate),
        })

    sort_key = sort_by if sort_by in {
        "tax_name", "tax_percentage", "taxable_amount", "tax_amount",
    } else "tax_percentage"
    reverse = (sort_order or "asc").lower() == "desc"
    rows.sort(key=lambda r: (r["tax_percentage"], r["tax_name"]))
    rows.sort(
        key=lambda r: (r.get(sort_key) if r.get(sort_key) is not None else 0),
        reverse=reverse,
    )

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = len(rows)
    return paged(rows[sk:sk + lim], total, sk, lim)


@router.get("/tax-summary-detail", dependencies=[Depends(require_perm("reports.view"))])
async def tax_summary_detail(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    tax_name: Optional[str] = None,
    full_rate: Optional[float] = None,
    tax_percentage: Optional[float] = None,
    transaction_type: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    """Child register: documents contributing to one configured tax rate."""
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = start.isoformat() if hasattr(start, "isoformat") else start
    end_s = end.isoformat() if hasattr(end, "isoformat") else end

    if full_rate is not None:
        slab_rate = float(full_rate)
    elif tax_percentage is not None:
        slab_rate = float(tax_percentage)
    else:
        slab_rate = 0.0

    def _rate_match(value: float) -> bool:
        return abs(float(value or 0) - slab_rate) < 0.0001

    sale_conds = [
        SaleInvoice.status != InvoiceStatus.cancelled,
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
    ]
    sale_branch = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if sale_branch is not None:
        sale_conds.append(sale_branch)

    purchase_conds = [
        PurchaseBill.status != InvoiceStatus.cancelled,
        PurchaseBill.date >= start_s,
        PurchaseBill.date <= end_s,
    ]
    purchase_branch = _branch_condition(PurchaseBill.branch_id, branch_id, branch_scope)
    if purchase_branch is not None:
        purchase_conds.append(purchase_branch)

    cn_conds = [
        SalesReturn.status != SalesReturnStatus.void,
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
    ]
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)

    dn_conds = [
        VendorReturn.voided.is_(False),
        VendorReturn.date >= start_s,
        VendorReturn.date <= end_s,
    ]
    dn_branch = _branch_condition(VendorReturn.branch_id, branch_id, branch_scope)
    if dn_branch is not None:
        dn_conds.append(dn_branch)

    sale_rate, sale_taxable, sale_tax = _tax_line_exprs(SaleLineItem.line_total, SaleLineItem.tax_rate)
    purchase_rate, purchase_taxable, purchase_tax = _tax_line_exprs(
        PurchaseLineItem.line_total, PurchaseLineItem.tax_rate,
    )
    cn_rate, cn_taxable, cn_tax = _tax_line_exprs(SalesReturnLineItem.line_total, SalesReturnLineItem.tax_rate)
    dn_rate, dn_taxable, dn_tax = _tax_line_exprs(ReturnLineItem.line_total, ReturnLineItem.tax_rate)

    invoice_q = (
        select(
            SaleInvoice.id.label("document_id"),
            SaleInvoice.number.label("entry_number"),
            SaleInvoice.date.label("date"),
            literal("Invoice").label("transaction_type"),
            sale_rate.label("rate"),
            func.coalesce(func.sum(sale_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(sale_tax), 0).label("full_tax"),
        )
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleInvoice.id == SaleLineItem.invoice_id)
        .where(and_(*sale_conds))
        .group_by(SaleInvoice.id, SaleInvoice.number, SaleInvoice.date, sale_rate)
    )
    bill_q = (
        select(
            PurchaseBill.id.label("document_id"),
            PurchaseBill.number.label("entry_number"),
            PurchaseBill.date.label("date"),
            literal("Bill").label("transaction_type"),
            purchase_rate.label("rate"),
            func.coalesce(func.sum(purchase_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(purchase_tax), 0).label("full_tax"),
        )
        .select_from(PurchaseLineItem)
        .join(PurchaseBill, PurchaseBill.id == PurchaseLineItem.bill_id)
        .where(and_(*purchase_conds))
        .group_by(PurchaseBill.id, PurchaseBill.number, PurchaseBill.date, purchase_rate)
    )
    cn_q = (
        select(
            SalesReturn.id.label("document_id"),
            SalesReturn.number.label("entry_number"),
            SalesReturn.date.label("date"),
            literal("Credit Note").label("transaction_type"),
            cn_rate.label("rate"),
            func.coalesce(func.sum(cn_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(cn_tax), 0).label("full_tax"),
        )
        .select_from(SalesReturnLineItem)
        .join(SalesReturn, SalesReturn.id == SalesReturnLineItem.return_id)
        .where(and_(*cn_conds))
        .group_by(SalesReturn.id, SalesReturn.number, SalesReturn.date, cn_rate)
    )
    dn_q = (
        select(
            VendorReturn.id.label("document_id"),
            VendorReturn.number.label("entry_number"),
            VendorReturn.date.label("date"),
            literal("Debit Note").label("transaction_type"),
            dn_rate.label("rate"),
            func.coalesce(func.sum(dn_taxable), 0).label("taxable_amount"),
            func.coalesce(func.sum(dn_tax), 0).label("full_tax"),
        )
        .select_from(ReturnLineItem)
        .join(VendorReturn, VendorReturn.id == ReturnLineItem.return_id)
        .where(and_(*dn_conds))
        .group_by(VendorReturn.id, VendorReturn.number, VendorReturn.date, dn_rate)
    )

    rows: list[dict[str, Any]] = []
    for query, sign, txn_label in (
        (invoice_q, 1, "Invoice"),
        (bill_q, 1, "Bill"),
        (cn_q, -1, "Credit Note"),
        (dn_q, -1, "Debit Note"),
    ):
        if not _wants_transaction_type(transaction_type, txn_label):
            continue
        for raw in (await db.execute(query)).fetchall():
            mapping = dict(raw._mapping)
            if not _rate_match(mapping.get("rate") or 0):
                continue
            taxable = sign * float(mapping.get("taxable_amount") or 0)
            tax_amt = sign * float(mapping.get("full_tax") or 0)
            rows.append({
                "date": mapping.get("date"),
                "entry_number": mapping.get("entry_number") or "",
                "transaction_type": mapping.get("transaction_type") or "",
                "transaction_amount": round(taxable, 2),
                "tax_amount": round(tax_amt, 2),
                "document_id": mapping.get("document_id"),
                "detail_kind": {
                    "Invoice": "invoice",
                    "Bill": "bill",
                    "Credit Note": "credit_note",
                    "Debit Note": "debit_note",
                }.get(mapping.get("transaction_type") or "", ""),
                "tax_name": tax_name or "",
            })

    sort_key = sort_by if sort_by in {
        "date", "entry_number", "transaction_type", "transaction_amount", "tax_amount",
    } else "date"
    reverse = (sort_order or "desc").lower() != "asc"
    rows.sort(key=lambda r: (r.get("date") or "", r.get("entry_number") or ""))
    rows.sort(
        key=lambda r: (r.get(sort_key) if r.get(sort_key) is not None else 0),
        reverse=reverse,
    )

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = len(rows)
    return paged(rows[sk:sk + lim], total, sk, lim)


@router.get("/sales-register", dependencies=[Depends(require_perm("reports.view"))])
async def sales_register(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    payment_mode: Optional[str] = None,
    cashier_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    item_id: Optional[str] = None,
    category_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    filter_kwargs = dict(
        branch_id=branch_id,
        search=search,
        date_from=start,
        date_to=end,
        allowed_branch_ids=branch_scope,
        payment_mode=payment_mode,
        cashier_id=cashier_id,
        customer_id=customer_id,
        item_id=item_id,
        category_id=category_id,
    )
    inv_conds = _sale_filters(**filter_kwargs)
    cn_conds = _cn_filters(**filter_kwargs)
    docs = _sales_register_union_query(inv_conds, cn_conds)

    sort_map = {
        "invoice_number": docs.c.invoice_number,
        "invoice_date": docs.c.invoice_date,
        "customer": docs.c.customer,
        "branch": docs.c.branch,
        "cashier": docs.c.cashier,
        "taxable_amount": docs.c.taxable_amount,
        "tax_amount": docs.c.tax_amount,
        "discount": docs.c.discount,
        "net_amount": docs.c.net_amount,
        "payment_mode": docs.c.payment_mode,
        "paid_amount": docs.c.paid_amount,
        "remaining_amount": docs.c.remaining_amount,
        "transaction_type": docs.c.transaction_type,
        "status": docs.c.status,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "invoice_date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    query = _restrict_transaction_types(select(docs), docs.c.transaction_type, transaction_type)
    total = int((await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0)
    result = await db.execute(query.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/sales-lines", dependencies=[Depends(require_perm("reports.view"))])
async def sales_lines(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    item_id: Optional[str] = None,
    category_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    """Line-item sales detail for product / category drilldowns.

    Unlike sales-register (one row per invoice / credit note), this returns
    one row per line so qty / line_total roll up to product-wise / category-wise
    parents. Credit-note lines are signed negative.
    """
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    inv_conds = [
        SaleInvoice.status != InvoiceStatus.cancelled,
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
    ]
    cn_conds = [
        SalesReturn.status != SalesReturnStatus.void,
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)
    if search:
        inv_conds.append(
            SaleInvoice.number.ilike(f"%{search}%")
            | SaleLineItem.name.ilike(f"%{search}%")
            | SaleInvoice.customer_name.ilike(f"%{search}%")
        )
        cn_conds.append(
            SalesReturn.number.ilike(f"%{search}%")
            | SalesReturnLineItem.name.ilike(f"%{search}%")
            | SalesReturn.customer_name.ilike(f"%{search}%")
        )
    if item_id:
        inv_conds.append(SaleLineItem.item_id == item_id)
        cn_conds.append(SalesReturnLineItem.item_id == item_id)
    if category_id:
        if category_id in ("__none__", "__uncategorized__"):
            inv_conds.append(Item.category_id.is_(None))
            cn_conds.append(Item.category_id.is_(None))
        else:
            inv_conds.append(Item.category_id == category_id)
            cn_conds.append(Item.category_id == category_id)

    lines = _signed_sales_lines_query(inv_conds, cn_conds).subquery()
    sort_map = {
        "invoice_number": lines.c.invoice_number,
        "invoice_date": lines.c.invoice_date,
        "product_code": lines.c.product_code,
        "product_name": lines.c.product_name,
        "customer": lines.c.customer,
        "branch": lines.c.branch,
        "cashier": lines.c.cashier,
        "quantity": lines.c.quantity,
        "unit_price": lines.c.unit_price,
        "discount": lines.c.discount,
        "line_total": lines.c.line_total,
        "payment_mode": lines.c.payment_mode,
        "paid_amount": lines.c.paid_amount,
        "remaining_amount": lines.c.remaining_amount,
        "transaction_type": lines.c.transaction_type,
        "status": lines.c.status,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "invoice_date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    query = _restrict_transaction_types(select(lines), lines.c.transaction_type, transaction_type)
    total = int((await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0)
    result = await db.execute(query.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/daily-sales", dependencies=[Depends(require_perm("reports.view"))])
async def daily_sales(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)

    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)
    if search:
        inv_conds.append(SaleInvoice.cashier.ilike(f"%{search}%"))
        cn_conds.append(SaleInvoice.cashier.ilike(f"%{search}%"))

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)
    base_q = (
        select(
            docs.c.doc_date.label("date"),
            func.count(docs.c.doc_id).label("invoice_count"),
            func.coalesce(func.sum(docs.c.quantity_sold), 0).label("quantity_sold"),
            func.coalesce(func.sum(docs.c.total), 0).label("gross_sales"),
            func.coalesce(func.sum(docs.c.discount), 0).label("discounts"),
            func.coalesce(func.sum(docs.c.tax_total), 0).label("tax"),
            func.coalesce(func.sum(docs.c.total), 0).label("net_sales"),
        )
        .select_from(docs)
        .group_by(docs.c.doc_date)
    )

    sort_map = {
        "date": docs.c.doc_date,
        "invoice_count": func.count(docs.c.doc_id),
        "quantity_sold": func.coalesce(func.sum(docs.c.quantity_sold), 0),
        "gross_sales": func.coalesce(func.sum(docs.c.total), 0),
        "discounts": func.coalesce(func.sum(docs.c.discount), 0),
        "tax": func.coalesce(func.sum(docs.c.tax_total), 0),
        "net_sales": func.coalesce(func.sum(docs.c.total), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")

    total = int(
        (await db.execute(select(func.count(func.distinct(docs.c.doc_date))).select_from(docs))).scalar()
        or 0
    )
    result = await db.execute(base_q.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [
        {**dict(r._mapping), "date": r.date.isoformat() if hasattr(r.date, "isoformat") and r.date else r.date}
        for r in result.fetchall()
    ]
    return paged(rows, total, sk, lim)


@router.get("/daily-sales-returns", dependencies=[Depends(require_perm("reports.view"))])
async def daily_sales_returns(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    """Credit notes (sales returns) aggregated by return date."""
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)

    conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        conds.append(branch_cond)
    if search:
        conds.append(
            SalesReturn.number.ilike(f"%{search}%")
            | SalesReturn.customer_name.ilike(f"%{search}%")
        )

    qty_sq = (
        select(
            SalesReturnLineItem.return_id.label("return_id"),
            func.coalesce(func.sum(SalesReturnLineItem.return_qty), 0).label("qty"),
        )
        .group_by(SalesReturnLineItem.return_id)
        .subquery()
    )

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    base_q = (
        select(
            SalesReturn.date.label("date"),
            func.count(SalesReturn.id).label("return_count"),
            func.coalesce(func.sum(qty_sq.c.qty), 0).label("quantity_returned"),
            func.coalesce(func.sum(SalesReturn.subtotal), 0).label("gross_returns"),
            func.coalesce(func.sum(SalesReturn.tax_total), 0).label("tax"),
            func.coalesce(func.sum(SalesReturn.credited_amount), 0).label("credited_amount"),
            func.coalesce(func.sum(SalesReturn.total), 0).label("net_returns"),
        )
        .select_from(SalesReturn)
        .outerjoin(qty_sq, qty_sq.c.return_id == SalesReturn.id)
        .where(and_(*conds))
        .group_by(SalesReturn.date)
    )

    sort_map = {
        "date": SalesReturn.date,
        "return_count": func.count(SalesReturn.id),
        "quantity_returned": func.coalesce(func.sum(qty_sq.c.qty), 0),
        "gross_returns": func.coalesce(func.sum(SalesReturn.subtotal), 0),
        "tax": func.coalesce(func.sum(SalesReturn.tax_total), 0),
        "credited_amount": func.coalesce(func.sum(SalesReturn.credited_amount), 0),
        "net_returns": func.coalesce(func.sum(SalesReturn.total), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")

    total = int(
        (
            await db.execute(
                select(func.count(func.distinct(SalesReturn.date))).where(and_(*conds))
            )
        ).scalar()
        or 0
    )
    result = await db.execute(base_q.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [
        {
            **dict(r._mapping),
            "date": r.date.isoformat() if hasattr(r.date, "isoformat") and r.date else r.date,
        }
        for r in result.fetchall()
    ]
    return paged(rows, total, sk, lim)


@router.get("/product-sales", dependencies=[Depends(require_perm("reports.view"))])
async def product_sales(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)

    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)
    if search:
        inv_conds.append(SaleLineItem.name.ilike(f"%{search}%"))
        cn_conds.append(SalesReturnLineItem.name.ilike(f"%{search}%"))

    lines = _signed_sales_lines_query(inv_conds, cn_conds).subquery()
    sort_map = {
        "product_code": lines.c.product_code,
        "product_name": lines.c.product_name,
        "category": lines.c.category,
        "quantity_sold": func.coalesce(func.sum(lines.c.quantity), 0),
        "sales_value": func.coalesce(func.sum(lines.c.line_total), 0),
        "cost_value": func.coalesce(func.sum(lines.c.cost_value), 0),
        "profit": func.coalesce(func.sum(lines.c.profit), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_value", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    base = (
        select(
            lines.c.item_id.label("item_id"),
            lines.c.product_code.label("product_code"),
            lines.c.product_name.label("product_name"),
            lines.c.category.label("category"),
            func.coalesce(func.sum(lines.c.quantity), 0).label("quantity_sold"),
            func.coalesce(func.sum(lines.c.line_total), 0).label("sales_value"),
            func.coalesce(func.sum(lines.c.cost_value), 0).label("cost_value"),
            func.coalesce(func.sum(lines.c.profit), 0).label("profit"),
        )
        .select_from(lines)
        .group_by(lines.c.item_id, lines.c.product_code, lines.c.product_name, lines.c.category)
    )
    total = int((await db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/document-trail", dependencies=[Depends(require_perm("reports.view"))])
async def document_trail(
    number: str = Query(..., min_length=3),
    db: AsyncSession = Depends(get_db),
):
    """Trace upstream/downstream links for a document number (QT/SO/INV/CN/PO/GRN/PUR/RET)."""
    needle = number.strip()
    if not needle:
        raise HTTPException(400, "Document number is required")

    chain: list[dict[str, Any]] = []
    root_type: Optional[str] = None
    root_id: Optional[str] = None

    quote = (
        await db.execute(select(Quotation).where(Quotation.number == needle))
    ).scalar_one_or_none()
    if quote:
        root_type, root_id = "quotation", quote.id
        chain.append(_trail_node(
            doc_type="quotation",
            doc_id=quote.id,
            number=quote.number,
            status=str(quote.status.value if quote.status else quote.status),
            date=quote.date,
            total=quote.total,
            extra={"customer_name": quote.customer_name},
        ))
        if quote.converted_order_id:
            so = (await db.execute(
                select(SalesOrder).where(SalesOrder.id == quote.converted_order_id)
            )).scalar_one_or_none()
            if so:
                chain.append(_trail_node(
                    doc_type="sales_order",
                    doc_id=so.id,
                    number=so.number,
                    status=str(so.status.value if so.status else so.status),
                    date=so.date,
                    total=so.total,
                ))
                if so.converted_invoice_id:
                    inv = (await db.execute(
                        select(SaleInvoice).where(SaleInvoice.id == so.converted_invoice_id)
                    )).scalar_one_or_none()
                    if inv:
                        chain.append(_trail_node(
                            doc_type="invoice",
                            doc_id=inv.id,
                            number=inv.number,
                            status=str(inv.status.value if inv.status else inv.status),
                            date=inv.date,
                            total=inv.total,
                            extra={"origin": inv.origin},
                        ))
        if quote.converted_invoice_id:
            inv = (await db.execute(
                select(SaleInvoice).where(SaleInvoice.id == quote.converted_invoice_id)
            )).scalar_one_or_none()
            if inv and all(n["id"] != inv.id for n in chain):
                chain.append(_trail_node(
                    doc_type="invoice",
                    doc_id=inv.id,
                    number=inv.number,
                    status=str(inv.status.value if inv.status else inv.status),
                    date=inv.date,
                    total=inv.total,
                    extra={"origin": inv.origin},
                ))

    so = (
        await db.execute(select(SalesOrder).where(SalesOrder.number == needle))
    ).scalar_one_or_none()
    if so and not root_type:
        root_type, root_id = "sales_order", so.id
        upstream = (await db.execute(
            select(Quotation).where(Quotation.converted_order_id == so.id)
        )).scalar_one_or_none()
        if upstream:
            chain.append(_trail_node(
                doc_type="quotation",
                doc_id=upstream.id,
                number=upstream.number,
                status=str(upstream.status.value if upstream.status else upstream.status),
                date=upstream.date,
                total=upstream.total,
            ))
        chain.append(_trail_node(
            doc_type="sales_order",
            doc_id=so.id,
            number=so.number,
            status=str(so.status.value if so.status else so.status),
            date=so.date,
            total=so.total,
        ))
        if so.converted_invoice_id:
            inv = (await db.execute(
                select(SaleInvoice).where(SaleInvoice.id == so.converted_invoice_id)
            )).scalar_one_or_none()
            if inv:
                chain.append(_trail_node(
                    doc_type="invoice",
                    doc_id=inv.id,
                    number=inv.number,
                    status=str(inv.status.value if inv.status else inv.status),
                    date=inv.date,
                    total=inv.total,
                    extra={"origin": inv.origin},
                ))

    inv = (
        await db.execute(select(SaleInvoice).where(SaleInvoice.number == needle))
    ).scalar_one_or_none()
    if inv and not root_type:
        root_type, root_id = "invoice", inv.id
        upstream_quote = (await db.execute(
            select(Quotation).where(Quotation.converted_invoice_id == inv.id)
        )).scalar_one_or_none()
        if upstream_quote:
            chain.append(_trail_node(
                doc_type="quotation",
                doc_id=upstream_quote.id,
                number=upstream_quote.number,
                status=str(upstream_quote.status.value if upstream_quote.status else upstream_quote.status),
                date=upstream_quote.date,
                total=upstream_quote.total,
            ))
        upstream_so = (await db.execute(
            select(SalesOrder).where(SalesOrder.converted_invoice_id == inv.id)
        )).scalar_one_or_none()
        if upstream_so:
            q_from_so = (await db.execute(
                select(Quotation).where(Quotation.converted_order_id == upstream_so.id)
            )).scalar_one_or_none()
            if q_from_so and all(n["id"] != q_from_so.id for n in chain):
                chain.append(_trail_node(
                    doc_type="quotation",
                    doc_id=q_from_so.id,
                    number=q_from_so.number,
                    status=str(q_from_so.status.value if q_from_so.status else q_from_so.status),
                    date=q_from_so.date,
                    total=q_from_so.total,
                ))
            chain.append(_trail_node(
                doc_type="sales_order",
                doc_id=upstream_so.id,
                number=upstream_so.number,
                status=str(upstream_so.status.value if upstream_so.status else upstream_so.status),
                date=upstream_so.date,
                total=upstream_so.total,
            ))
        chain.append(_trail_node(
            doc_type="invoice",
            doc_id=inv.id,
            number=inv.number,
            status=str(inv.status.value if inv.status else inv.status),
            date=inv.date,
            total=inv.total,
            extra={"origin": inv.origin},
        ))
        returns = (await db.execute(
            select(SalesReturn).where(SalesReturn.invoice_id == inv.id).order_by(SalesReturn.date)
        )).scalars().all()
        for ret in returns:
            chain.append(_trail_node(
                doc_type="credit_note",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
                extra={"refund_method": ret.refund_method},
            ))
        pay_allocs = (await db.execute(
            select(CustomerPaymentAllocation, CustomerPayment)
            .join(CustomerPayment, CustomerPaymentAllocation.payment_id == CustomerPayment.id)
            .where(
                CustomerPaymentAllocation.invoice_id == inv.id,
                CustomerPayment.voided == False,  # noqa: E712
            )
            .order_by(CustomerPayment.date)
        )).all()
        for alloc, pay in pay_allocs:
            if any(n["id"] == pay.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="customer_payment",
                doc_id=pay.id,
                number=pay.number,
                status="void" if pay.voided else "recorded",
                date=pay.date,
                total=alloc.amount,
                extra={"payment_mode": pay.payment_mode, "invoice_number": inv.number},
            ))

    cn = (
        await db.execute(select(SalesReturn).where(SalesReturn.number == needle))
    ).scalar_one_or_none()
    if cn and not root_type:
        root_type, root_id = "credit_note", cn.id
        inv = (await db.execute(
            select(SaleInvoice).where(SaleInvoice.id == cn.invoice_id)
        )).scalar_one_or_none()
        if inv:
            return await document_trail(number=inv.number, db=db)
        chain.append(_trail_node(
            doc_type="credit_note",
            doc_id=cn.id,
            number=cn.number,
            status=str(cn.status.value if cn.status else cn.status),
            date=cn.date,
            total=cn.total,
        ))

    po = (
        await db.execute(select(PurchaseOrder).where(PurchaseOrder.number == needle))
    ).scalar_one_or_none()
    if po and not root_type:
        root_type, root_id = "purchase_order", po.id
        chain.append(_trail_node(
            doc_type="purchase_order",
            doc_id=po.id,
            number=po.number,
            status=str(po.status.value if po.status else po.status),
            date=po.date,
            total=po.total,
            extra={"vendor_name": po.vendor_name},
        ))
        grns = (await db.execute(
            select(GoodsReceiptNote)
            .where(GoodsReceiptNote.purchase_order_id == po.id)
            .order_by(GoodsReceiptNote.date)
        )).scalars().all()
        for grn in grns:
            chain.append(_trail_node(
                doc_type="grn",
                doc_id=grn.id,
                number=grn.number,
                status=str(grn.status.value if grn.status else grn.status),
                date=grn.date,
                total=grn.total,
            ))
            if grn.converted_bill_id:
                bill = (await db.execute(
                    select(PurchaseBill).where(PurchaseBill.id == grn.converted_bill_id)
                )).scalar_one_or_none()
                if bill and all(n["id"] != bill.id for n in chain):
                    chain.append(_trail_node(
                        doc_type="purchase_bill",
                        doc_id=bill.id,
                        number=bill.number,
                        status=str(bill.status.value if bill.status else bill.status),
                        date=bill.date,
                        total=bill.total,
                    ))
        if po.converted_bill_id:
            bill = (await db.execute(
                select(PurchaseBill).where(PurchaseBill.id == po.converted_bill_id)
            )).scalar_one_or_none()
            if bill and all(n["id"] != bill.id for n in chain):
                chain.append(_trail_node(
                    doc_type="purchase_bill",
                    doc_id=bill.id,
                    number=bill.number,
                    status=str(bill.status.value if bill.status else bill.status),
                    date=bill.date,
                    total=bill.total,
                ))

    grn = (
        await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.number == needle))
    ).scalar_one_or_none()
    if grn and not root_type:
        root_type, root_id = "grn", grn.id
        if grn.purchase_order_id:
            po = (await db.execute(
                select(PurchaseOrder).where(PurchaseOrder.id == grn.purchase_order_id)
            )).scalar_one_or_none()
            if po:
                return await document_trail(number=po.number, db=db)
        chain.append(_trail_node(
            doc_type="grn",
            doc_id=grn.id,
            number=grn.number,
            status=str(grn.status.value if grn.status else grn.status),
            date=grn.date,
            total=grn.total,
        ))
        if grn.converted_bill_id:
            bill = (await db.execute(
                select(PurchaseBill).where(PurchaseBill.id == grn.converted_bill_id)
            )).scalar_one_or_none()
            if bill:
                chain.append(_trail_node(
                    doc_type="purchase_bill",
                    doc_id=bill.id,
                    number=bill.number,
                    status=str(bill.status.value if bill.status else bill.status),
                    date=bill.date,
                    total=bill.total,
                ))

    bill = (
        await db.execute(select(PurchaseBill).where(PurchaseBill.number == needle))
    ).scalar_one_or_none()
    if bill and not root_type:
        root_type, root_id = "purchase_bill", bill.id
        if bill.grn_id:
            grn = (await db.execute(
                select(GoodsReceiptNote).where(GoodsReceiptNote.id == bill.grn_id)
            )).scalar_one_or_none()
            if grn:
                if grn.purchase_order_id:
                    po = (await db.execute(
                        select(PurchaseOrder).where(PurchaseOrder.id == grn.purchase_order_id)
                    )).scalar_one_or_none()
                    if po:
                        return await document_trail(number=po.number, db=db)
                chain.append(_trail_node(
                    doc_type="grn",
                    doc_id=grn.id,
                    number=grn.number,
                    status=str(grn.status.value if grn.status else grn.status),
                    date=grn.date,
                    total=grn.total,
                ))
        chain.append(_trail_node(
            doc_type="purchase_bill",
            doc_id=bill.id,
            number=bill.number,
            status=str(bill.status.value if bill.status else bill.status),
            date=bill.date,
            total=bill.total,
            extra={"vendor_name": bill.vendor_name},
        ))
        returns = (await db.execute(
            select(VendorReturn).where(VendorReturn.bill_id == bill.id).order_by(VendorReturn.date)
        )).scalars().all()
        for ret in returns:
            chain.append(_trail_node(
                doc_type="vendor_return",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
            ))
        pay_allocs = (await db.execute(
            select(VendorPaymentAllocation, VendorPayment)
            .join(VendorPayment, VendorPaymentAllocation.payment_id == VendorPayment.id)
            .where(
                VendorPaymentAllocation.bill_id == bill.id,
                VendorPayment.voided == False,  # noqa: E712
            )
            .order_by(VendorPayment.date)
        )).all()
        for alloc, pay in pay_allocs:
            if any(n["id"] == pay.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="vendor_payment",
                doc_id=pay.id,
                number=pay.number,
                status="void" if pay.voided else "recorded",
                date=pay.date,
                total=alloc.amount,
                extra={"payment_mode": pay.payment_mode, "bill_number": bill.number},
            ))

    vret = (
        await db.execute(select(VendorReturn).where(VendorReturn.number == needle))
    ).scalar_one_or_none()
    if vret and not root_type:
        bill = (await db.execute(
            select(PurchaseBill).where(PurchaseBill.id == vret.bill_id)
        )).scalar_one_or_none()
        if bill:
            return await document_trail(number=bill.number, db=db)

    if not root_type:
        raise HTTPException(404, f"No document found with number '{needle}'")

    # Append downstream docs when root was quote/SO but invoice exists in chain.
    invoice_ids = [n["id"] for n in chain if n["type"] == "invoice"]
    for inv_id in invoice_ids:
        returns = (await db.execute(
            select(SalesReturn).where(SalesReturn.invoice_id == inv_id).order_by(SalesReturn.date)
        )).scalars().all()
        for ret in returns:
            if any(n["id"] == ret.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="credit_note",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
                extra={"refund_method": ret.refund_method},
            ))

    bill_ids = [n["id"] for n in chain if n["type"] == "purchase_bill"]
    for bill_id in bill_ids:
        returns = (await db.execute(
            select(VendorReturn).where(VendorReturn.bill_id == bill_id).order_by(VendorReturn.date)
        )).scalars().all()
        for ret in returns:
            if any(n["id"] == ret.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="vendor_return",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
            ))

    return {
        "number": needle,
        "root_type": root_type,
        "root_id": root_id,
        "chain": chain,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_value", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total_q = select(func.count()).select_from(ProductSalesSummary).where(and_(*conds))
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(
        select(
            ProductSalesSummary.item_id.label("product_code"),
            ProductSalesSummary.product_name.label("product_name"),
            ProductSalesSummary.category_id.label("category"),
            ProductSalesSummary.quantity_sold.label("quantity_sold"),
            ProductSalesSummary.revenue.label("sales_value"),
            ProductSalesSummary.profit.label("profit"),
        )
        .where(and_(*conds))
        .order_by(order_by_expr)
        .offset(sk)
        .limit(lim)
    )
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/payment-sales", dependencies=[Depends(require_perm("reports.view"))])
async def payment_sales(
    branch_id: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)

    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)

    sort_map = {
        "payment_method": docs.c.payment_mode,
        "invoice_count": func.count(docs.c.doc_id),
        "quantity_sold": func.coalesce(func.sum(docs.c.quantity_sold), 0),
        "sales_amount": func.coalesce(func.sum(docs.c.total), 0),
        "tax_amount": func.coalesce(func.sum(docs.c.tax_total), 0),
        "discount_amount": func.coalesce(func.sum(docs.c.discount), 0),
        "net_sales": func.coalesce(func.sum(docs.c.total), 0),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    base = (
        select(
            docs.c.payment_mode.label("payment_mode"),
            func.count(docs.c.doc_id).label("invoice_count"),
            func.coalesce(func.sum(docs.c.quantity_sold), 0).label("quantity_sold"),
            func.coalesce(func.sum(docs.c.total), 0).label("sales_amount"),
            func.coalesce(func.sum(docs.c.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(docs.c.discount), 0).label("discount_amount"),
            func.coalesce(func.sum(docs.c.total), 0).label("net_sales"),
        )
        .select_from(docs)
        .group_by(docs.c.payment_mode)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    # Map raw payment_mode values (e.g. 'bank_transfer') to human-friendly labels
    _pm_map = {
        'cash': 'Cash',
        'card': 'Card',
        'upi': 'UPI',
        'bank_transfer': 'Bank Transfer',
        'credit': 'Credit',
    }
    for r in rows:
        raw = r.get('payment_mode')
        r['payment_mode'] = raw if raw is not None else '__none__'
        if raw is None:
            r['payment_method'] = 'Unrecorded'
        else:
            s = str(raw).strip().lower()
            r['payment_method'] = _pm_map.get(s) or ' '.join([w.capitalize() for w in s.replace('_', ' ').split()])
    return paged(rows, total, sk, lim)


@router.get("/category-sales", dependencies=[Depends(require_perm("reports.view"))])
async def category_sales(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)

    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)
    if search:
        inv_conds.append(Category.name.ilike(f"%{search}%"))
        cn_conds.append(Category.name.ilike(f"%{search}%"))

    lines = _signed_sales_lines_query(inv_conds, cn_conds).subquery()
    sort_map = {
        "category": lines.c.category,
        "quantity_sold": func.coalesce(func.sum(lines.c.quantity), 0),
        "sales_value": func.coalesce(func.sum(lines.c.line_total), 0),
        "cost_value": func.coalesce(func.sum(lines.c.cost_value), 0),
        "profit": func.coalesce(func.sum(lines.c.profit), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_value", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    base = (
        select(
            lines.c.category_id.label("category_id"),
            lines.c.category.label("category"),
            func.coalesce(func.sum(lines.c.quantity), 0).label("quantity_sold"),
            func.coalesce(func.sum(lines.c.line_total), 0).label("sales_value"),
            func.coalesce(func.sum(lines.c.cost_value), 0).label("cost_value"),
            func.coalesce(func.sum(lines.c.profit), 0).label("profit"),
        )
        .select_from(lines)
        .group_by(lines.c.category_id, lines.c.category)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/branch-sales", dependencies=[Depends(require_perm("reports.view"))])
async def branch_sales(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)

    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)
    sort_map = {
        "branch": docs.c.branch,
        "invoice_count": func.count(docs.c.doc_id),
        "sales_amount": func.coalesce(func.sum(docs.c.total), 0),
        "tax_amount": func.coalesce(func.sum(docs.c.tax_total), 0),
        "discount_amount": func.coalesce(func.sum(docs.c.discount), 0),
        "net_sales": func.coalesce(func.sum(docs.c.total), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            docs.c.branch_id.label("branch_id"),
            docs.c.branch.label("branch"),
            func.count(docs.c.doc_id).label("invoice_count"),
            func.coalesce(func.sum(docs.c.total), 0).label("sales_amount"),
            func.coalesce(func.sum(docs.c.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(docs.c.discount), 0).label("discount_amount"),
            func.coalesce(func.sum(docs.c.total), 0).label("net_sales"),
        )
        .select_from(docs)
        .group_by(docs.c.branch_id, docs.c.branch)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/cashier-sales", dependencies=[Depends(require_perm("reports.view"))])
async def cashier_sales(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)

    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)
    sort_map = {
        "cashier": docs.c.cashier,
        "invoice_count": func.count(docs.c.doc_id),
        "sales_amount": func.coalesce(func.sum(docs.c.total), 0),
        "tax_amount": func.coalesce(func.sum(docs.c.tax_total), 0),
        "discount_amount": func.coalesce(func.sum(docs.c.discount), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            User.id.label("cashier_id"),
            docs.c.cashier.label("cashier"),
            func.count(docs.c.doc_id).label("invoice_count"),
            func.coalesce(func.sum(docs.c.total), 0).label("sales_amount"),
            func.coalesce(func.sum(docs.c.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(docs.c.discount), 0).label("discount_amount"),
        )
        .select_from(docs)
        .outerjoin(User, User.name == docs.c.cashier)
        .group_by(User.id, docs.c.cashier)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    for r in rows:
        if not r.get("cashier_id"):
            r["cashier_id"] = "__none__"
        if not r.get("cashier"):
            r["cashier"] = "Unassigned"
    return paged(rows, total, sk, lim)


@router.get("/customer-sales", dependencies=[Depends(require_perm("reports.view"))])
async def customer_sales(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)
    if search:
        inv_conds.append(SaleInvoice.customer_name.ilike(f"%{search}%"))
        cn_conds.append(SalesReturn.customer_name.ilike(f"%{search}%"))

    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)
    sort_map = {
        "customer": docs.c.customer,
        "invoice_count": func.count(docs.c.doc_id),
        "sales_amount": func.coalesce(func.sum(docs.c.total), 0),
        "paid_amount": func.coalesce(func.sum(docs.c.paid_amount), 0),
        "outstanding_amount": func.coalesce(func.sum(docs.c.outstanding), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            docs.c.customer_id.label("customer_id"),
            docs.c.customer.label("customer"),
            func.count(docs.c.doc_id).label("invoice_count"),
            func.coalesce(func.sum(docs.c.total), 0).label("sales_amount"),
            func.coalesce(func.sum(docs.c.paid_amount), 0).label("paid_amount"),
            func.coalesce(func.sum(docs.c.outstanding), 0).label("outstanding_amount"),
        )
        .select_from(docs)
        .group_by(docs.c.customer_id, docs.c.customer)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    for r in rows:
        if not r.get("customer"):
            r["customer"] = "Walk-in"
    return paged(rows, total, sk, lim)


@router.get("/purchase-register", dependencies=[Depends(require_perm("reports.view"))])
async def purchase_register(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    vendor_id: Optional[str] = None,
    item_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    filter_kwargs = dict(
        branch_id=branch_id,
        vendor_id=vendor_id,
        search=search,
        date_from=start,
        date_to=end,
        allowed_branch_ids=branch_scope,
        item_id=item_id,
    )
    bill_conds = _purchase_filters(**filter_kwargs)
    vr_conds = _vr_filters(**filter_kwargs)
    docs = _purchase_register_union_query(bill_conds, vr_conds)

    sort_map = {
        "bill_number": docs.c.bill_number,
        "bill_date": docs.c.bill_date,
        "vendor": docs.c.vendor,
        "branch": docs.c.branch,
        "subtotal": docs.c.subtotal,
        "tax": docs.c.tax,
        "total": docs.c.total,
        "paid": docs.c.paid,
        "balance": docs.c.balance,
        "transaction_type": docs.c.transaction_type,
        "status": docs.c.status,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "bill_date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    query = _restrict_transaction_types(select(docs), docs.c.transaction_type, transaction_type)
    total = int((await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0)
    result = await db.execute(query.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/daily-purchase-returns", dependencies=[Depends(require_perm("reports.view"))])
async def daily_purchase_returns(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    """Vendor returns (debit notes) aggregated by return date."""
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)

    conds = [
        VendorReturn.date >= start_s,
        VendorReturn.date <= end_s,
        VendorReturn.voided.is_(False),
    ]
    branch_cond = _branch_condition(VendorReturn.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        conds.append(branch_cond)
    if search:
        conds.append(
            VendorReturn.number.ilike(f"%{search}%")
            | VendorReturn.vendor_name.ilike(f"%{search}%")
        )

    qty_sq = (
        select(
            ReturnLineItem.return_id.label("return_id"),
            func.coalesce(func.sum(ReturnLineItem.return_qty), 0).label("qty"),
        )
        .group_by(ReturnLineItem.return_id)
        .subquery()
    )

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    base_q = (
        select(
            VendorReturn.date.label("date"),
            func.count(VendorReturn.id).label("return_count"),
            func.coalesce(func.sum(qty_sq.c.qty), 0).label("quantity_returned"),
            func.coalesce(func.sum(VendorReturn.subtotal), 0).label("gross_returns"),
            func.coalesce(func.sum(VendorReturn.tax_total), 0).label("tax"),
            func.coalesce(func.sum(VendorReturn.credited_amount), 0).label("credited_amount"),
            func.coalesce(func.sum(VendorReturn.total), 0).label("net_returns"),
        )
        .select_from(VendorReturn)
        .outerjoin(qty_sq, qty_sq.c.return_id == VendorReturn.id)
        .where(and_(*conds))
        .group_by(VendorReturn.date)
    )

    sort_map = {
        "date": VendorReturn.date,
        "return_count": func.count(VendorReturn.id),
        "quantity_returned": func.coalesce(func.sum(qty_sq.c.qty), 0),
        "gross_returns": func.coalesce(func.sum(VendorReturn.subtotal), 0),
        "tax": func.coalesce(func.sum(VendorReturn.tax_total), 0),
        "credited_amount": func.coalesce(func.sum(VendorReturn.credited_amount), 0),
        "net_returns": func.coalesce(func.sum(VendorReturn.total), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")

    total = int(
        (
            await db.execute(
                select(func.count(func.distinct(VendorReturn.date))).where(and_(*conds))
            )
        ).scalar()
        or 0
    )
    result = await db.execute(base_q.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [
        {
            **dict(r._mapping),
            "date": r.date.isoformat() if hasattr(r.date, "isoformat") and r.date else r.date,
        }
        for r in result.fetchall()
    ]
    return paged(rows, total, sk, lim)


@router.get("/purchase-lines", dependencies=[Depends(require_perm("reports.view"))])
async def purchase_lines(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    vendor_id: Optional[str] = None,
    item_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    """Line-item purchase detail for product-wise purchase drilldowns.

    One row per bill line / vendor-return line so qty / line_total roll up
    to product-wise parents. Debit-note lines are signed negative.
    """
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    bill_conds = [
        PurchaseBill.status != InvoiceStatus.cancelled,
        PurchaseBill.date >= start_s,
        PurchaseBill.date <= end_s,
    ]
    vr_conds = [
        VendorReturn.voided.is_(False),
        VendorReturn.date >= start_s,
        VendorReturn.date <= end_s,
    ]
    branch_cond = _branch_condition(PurchaseBill.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        bill_conds.append(branch_cond)
    vr_branch = _branch_condition(VendorReturn.branch_id, branch_id, branch_scope)
    if vr_branch is not None:
        vr_conds.append(vr_branch)
    if vendor_id:
        bill_conds.append(PurchaseBill.vendor_id == vendor_id)
        vr_conds.append(VendorReturn.vendor_id == vendor_id)
    if item_id:
        bill_conds.append(PurchaseLineItem.item_id == item_id)
        vr_conds.append(ReturnLineItem.item_id == item_id)
    if search:
        bill_conds.append(
            PurchaseBill.number.ilike(f"%{search}%")
            | PurchaseLineItem.name.ilike(f"%{search}%")
            | PurchaseBill.vendor_name.ilike(f"%{search}%")
        )
        vr_conds.append(
            VendorReturn.number.ilike(f"%{search}%")
            | ReturnLineItem.name.ilike(f"%{search}%")
            | VendorReturn.vendor_name.ilike(f"%{search}%")
        )

    lines = _signed_purchase_lines_query(bill_conds, vr_conds).subquery()
    sort_map = {
        "bill_number": lines.c.bill_number,
        "bill_date": lines.c.bill_date,
        "product": lines.c.product,
        "vendor": lines.c.vendor,
        "branch": lines.c.branch,
        "quantity": lines.c.quantity,
        "unit_cost": lines.c.unit_cost,
        "discount": lines.c.discount,
        "line_total": lines.c.line_total,
        "transaction_type": lines.c.transaction_type,
        "status": lines.c.status,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "bill_date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    query = _restrict_transaction_types(select(lines), lines.c.transaction_type, transaction_type)
    total = int((await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0)
    result = await db.execute(query.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/vendor-purchases", dependencies=[Depends(require_perm("reports.view"))])
async def vendor_purchases(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    bill_conds = [
        PurchaseBill.date >= start_s,
        PurchaseBill.date <= end_s,
        PurchaseBill.status != InvoiceStatus.cancelled,
    ]
    vr_conds = [
        VendorReturn.date >= start_s,
        VendorReturn.date <= end_s,
        VendorReturn.voided.is_(False),
    ]
    branch_cond = _branch_condition(PurchaseBill.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        bill_conds.append(branch_cond)
    vr_branch = _branch_condition(VendorReturn.branch_id, branch_id, branch_scope)
    if vr_branch is not None:
        vr_conds.append(vr_branch)
    if search:
        bill_conds.append(PurchaseBill.vendor_name.ilike(f"%{search}%"))
        vr_conds.append(VendorReturn.vendor_name.ilike(f"%{search}%"))

    docs = _signed_purchase_docs_subquery(bill_conds, vr_conds)
    sort_map = {
        "vendor": docs.c.vendor,
        "purchase_count": func.count(docs.c.doc_id),
        "purchase_amount": func.coalesce(func.sum(docs.c.total), 0),
        "paid_amount": func.coalesce(func.sum(docs.c.paid_amount), 0),
        "outstanding_amount": func.coalesce(func.sum(docs.c.outstanding), 0),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "purchase_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            docs.c.vendor_id.label("vendor_id"),
            docs.c.vendor.label("vendor"),
            func.count(docs.c.doc_id).label("purchase_count"),
            func.coalesce(func.sum(docs.c.total), 0).label("purchase_amount"),
            func.coalesce(func.sum(docs.c.paid_amount), 0).label("paid_amount"),
            func.coalesce(func.sum(docs.c.outstanding), 0).label("outstanding_amount"),
        )
        .select_from(docs)
        .group_by(docs.c.vendor_id, docs.c.vendor)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/product-purchases", dependencies=[Depends(require_perm("reports.view"))])
async def product_purchases(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    bill_conds = [
        PurchaseBill.date >= start_s,
        PurchaseBill.date <= end_s,
        PurchaseBill.status != InvoiceStatus.cancelled,
    ]
    vr_conds = [
        VendorReturn.date >= start_s,
        VendorReturn.date <= end_s,
        VendorReturn.voided.is_(False),
    ]
    branch_cond = _branch_condition(PurchaseBill.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        bill_conds.append(branch_cond)
    vr_branch = _branch_condition(VendorReturn.branch_id, branch_id, branch_scope)
    if vr_branch is not None:
        vr_conds.append(vr_branch)
    if search:
        bill_conds.append(PurchaseLineItem.name.ilike(f"%{search}%"))
        vr_conds.append(ReturnLineItem.name.ilike(f"%{search}%"))

    lines = _signed_purchase_lines_query(bill_conds, vr_conds).subquery()
    sort_map = {
        "product": lines.c.product,
        "quantity_purchased": func.coalesce(func.sum(lines.c.quantity), 0),
        "purchase_cost": func.coalesce(func.sum(lines.c.line_total), 0),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "quantity_purchased", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            lines.c.item_id.label("item_id"),
            lines.c.product.label("product"),
            func.coalesce(func.sum(lines.c.quantity), 0).label("quantity_purchased"),
            func.coalesce(func.sum(lines.c.line_total), 0).label("purchase_cost"),
        )
        .select_from(lines)
        .group_by(lines.c.item_id, lines.c.product)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    # average_cost for frontend column
    for r in rows:
        qty = float(r.get("quantity_purchased") or 0)
        cost = float(r.get("purchase_cost") or 0)
        r["average_cost"] = (cost / qty) if qty else 0
    return paged(rows, total, sk, lim)


@router.get("/current-stock", dependencies=[Depends(require_perm("reports.view"))])
async def current_stock(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    conds = []
    stock_branch = _eq_or_in(ItemStock.branch_id, branch_id)
    if stock_branch is not None:
        conds.append(stock_branch)
    if search:
        conds.append(Item.name.ilike(f"%{search}%"))

    sort_map = {
        "product_code": Item.sku,
        "product_name": Item.name,
        "category": Category.name,
        "branch": Branch.name,
        "available_stock": ItemStock.quantity,
        "reserved_stock": Item.reorder_level,
        "stock_value": ItemStock.quantity * func.coalesce(Item.cost_price, 0),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "product_name", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            Item.sku.label("product_code"),
            Item.name.label("product_name"),
            Category.name.label("category"),
            Branch.name.label("branch"),
            ItemStock.quantity.label("available_stock"),
            Item.reorder_level.label("reserved_stock"),
            (ItemStock.quantity * func.coalesce(Item.cost_price, 0)).label("stock_value"),
        )
        .join(Item, Item.id == ItemStock.item_id)
        .join(Branch, Branch.id == ItemStock.branch_id)
        .join(Category, Category.id == Item.category_id, isouter=True)
        .where(and_(*conds) if conds else True)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/low-stock", dependencies=[Depends(require_perm("reports.view"))])
async def low_stock(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    conds = [ItemStock.quantity <= Item.reorder_level]
    stock_branch = _eq_or_in(ItemStock.branch_id, branch_id)
    if stock_branch is not None:
        conds.append(stock_branch)
    if search:
        conds.append(Item.name.ilike(f"%{search}%"))

    sort_map = {
        "product": Item.name,
        "available_quantity": ItemStock.quantity,
        "reorder_level": Item.reorder_level,
        "branch": Branch.name,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "product", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            Item.name.label("product"),
            ItemStock.quantity.label("available_quantity"),
            Item.reorder_level.label("reorder_level"),
            Branch.name.label("branch"),
        )
        .join(Item, Item.id == ItemStock.item_id)
        .join(Branch, Branch.id == ItemStock.branch_id)
        .where(and_(*conds))
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/out-of-stock", dependencies=[Depends(require_perm("reports.view"))])
async def out_of_stock(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    conds = [ItemStock.quantity <= 0]
    stock_branch = _eq_or_in(ItemStock.branch_id, branch_id)
    if stock_branch is not None:
        conds.append(stock_branch)
    if search:
        conds.append(Item.name.ilike(f"%{search}%"))

    sort_map = {
        "product": Item.name,
        "category": Category.name,
        "branch": Branch.name,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "product", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            Item.name.label("product"),
            Category.name.label("category"),
            Branch.name.label("branch"),
        )
        .select_from(ItemStock)
        .join(Item, Item.id == ItemStock.item_id)
        .join(Branch, Branch.id == ItemStock.branch_id)
        .join(Category, Category.id == Item.category_id, isouter=True)
        .where(and_(*conds))
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/stock-transfers", dependencies=[Depends(require_perm("reports.view"))])
async def stock_transfers(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    start, end = _normalize_date_range(date_from, date_to)

    conds = []
    transfer_branch = _transfer_branch_predicate(branch_id)
    if transfer_branch is not None:
        conds.append(transfer_branch)
    if search:
        conds.append(TransferLineItem.item_name.ilike(f"%{search}%"))
    if start:
        conds.append(StockTransfer.request_date >= start.isoformat())
    if end:
        conds.append(StockTransfer.request_date <= end.isoformat())

    sort_map = {
        "transfer_number": StockTransfer.ref_number,
        "from_branch": StockTransfer.from_branch_name,
        "to_branch": StockTransfer.to_branch_name,
        "product": TransferLineItem.item_name,
        "quantity": TransferLineItem.qty,
        "transfer_date": StockTransfer.request_date,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "transfer_date", "desc")

    base = (
        select(
            StockTransfer.id.label("transfer_id"),
            StockTransfer.ref_number.label("transfer_number"),
            StockTransfer.from_branch_name.label("from_branch"),
            StockTransfer.to_branch_name.label("to_branch"),
            TransferLineItem.item_name.label("product"),
            TransferLineItem.qty.label("quantity"),
            StockTransfer.request_date.label("transfer_date"),
        )
        .select_from(TransferLineItem)
        .join(StockTransfer, StockTransfer.id == TransferLineItem.transfer_id)
        .where(and_(*conds) if conds else True)
    )

    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


SPOILAGE_REASONS = ("Damaged / Spoilage", "Expiry removal")


@router.get("/spoilage-damage", dependencies=[Depends(require_perm("reports.view"))])
async def spoilage_damage(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Approved stock write-offs for damage, spoilage, and expiry removal."""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    start_dt, end_dt = _parse_period(date_from, date_to)

    qty_lost = StockAdjustment.before_qty - StockAdjustment.after_qty
    conds = [StockAdjustment.reason.in_(SPOILAGE_REASONS)]
    adj_branch = _eq_or_in(StockAdjustment.branch_id, branch_id)
    if adj_branch is not None:
        conds.append(adj_branch)
    if search:
        like = f"%{search}%"
        conds.append(
            Item.name.ilike(like)
            | Item.sku.ilike(like)
            | AdjustmentRequest.ref_number.ilike(like)
            | StockAdjustment.reason.ilike(like)
        )
    if start_dt:
        conds.append(StockAdjustment.created_at >= start_dt)
    if end_dt:
        conds.append(StockAdjustment.created_at <= end_dt)

    sort_map = {
        "date": StockAdjustment.created_at,
        "reference_number": AdjustmentRequest.ref_number,
        "product_code": Item.sku,
        "product": Item.name,
        "branch": Branch.name,
        "before_qty": StockAdjustment.before_qty,
        "after_qty": StockAdjustment.after_qty,
        "quantity_lost": qty_lost,
        "reason": StockAdjustment.reason,
        "adjusted_by": StockAdjustment.adjusted_by,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")

    base = (
        select(
            AdjustmentRequest.id.label("adjustment_id"),
            StockAdjustment.created_at.label("date"),
            AdjustmentRequest.ref_number.label("reference_number"),
            Item.sku.label("product_code"),
            Item.name.label("product"),
            Branch.name.label("branch"),
            StockAdjustment.before_qty.label("before_qty"),
            StockAdjustment.after_qty.label("after_qty"),
            qty_lost.label("quantity_lost"),
            StockAdjustment.reason.label("reason"),
            StockAdjustment.notes.label("notes"),
            StockAdjustment.adjusted_by.label("adjusted_by"),
        )
        .select_from(StockAdjustment)
        .join(Item, Item.id == StockAdjustment.item_id)
        .join(Branch, Branch.id == StockAdjustment.branch_id)
        .outerjoin(AdjustmentRequest, AdjustmentRequest.id == StockAdjustment.request_id)
        .where(and_(*conds))
    )

    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = []
    for r in result.fetchall():
        row = dict(r._mapping)
        if row.get("date") is not None:
            row["date"] = row["date"].isoformat()
        rows.append(row)
    return paged(rows, total, sk, lim)


@router.get("/expiry-batches", dependencies=[Depends(require_perm("reports.view"))])
async def expiry_batches(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    within_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
):
    """Active batches that are expired or due to expire within `within_days`."""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    today = date.today()
    horizon_str = (today + timedelta(days=int(within_days))).isoformat()

    conds = [
        ItemBatch.active == True,  # noqa: E712
        ItemBatch.quantity > 0,
        ItemBatch.expiry_date.isnot(None),
        ItemBatch.expiry_date <= horizon_str,
    ]
    batch_branch = _eq_or_in(ItemBatch.branch_id, branch_id)
    if batch_branch is not None:
        conds.append(batch_branch)
    if search:
        like = f"%{search}%"
        conds.append(
            Item.name.ilike(like)
            | Item.sku.ilike(like)
            | ItemBatch.batch_number.ilike(like)
        )

    stock_value = ItemBatch.quantity * func.coalesce(ItemBatch.cost_price, Item.cost_price, 0)
    sort_map = {
        "product_code": Item.sku,
        "product": Item.name,
        "batch_number": ItemBatch.batch_number,
        "branch": Branch.name,
        "expiry_date": ItemBatch.expiry_date,
        "quantity": ItemBatch.quantity,
        "mfg_date": ItemBatch.mfg_date,
        "stock_value": stock_value,
        "status": ItemBatch.expiry_date,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "expiry_date", "asc")

    base = (
        select(
            Item.sku.label("product_code"),
            Item.name.label("product"),
            ItemBatch.batch_number.label("batch_number"),
            Branch.name.label("branch"),
            ItemBatch.mfg_date.label("mfg_date"),
            ItemBatch.expiry_date.label("expiry_date"),
            ItemBatch.quantity.label("quantity"),
            stock_value.label("stock_value"),
            ItemBatch.received_date.label("received_date"),
        )
        .select_from(ItemBatch)
        .join(Item, Item.id == ItemBatch.item_id)
        .join(Branch, Branch.id == ItemBatch.branch_id)
        .where(and_(*conds))
    )

    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = []
    for r in result.fetchall():
        row = dict(r._mapping)
        exp = row.get("expiry_date")
        try:
            exp_date = date.fromisoformat(exp) if exp else None
        except ValueError:
            exp_date = None
        if exp_date is None:
            row["days_to_expiry"] = None
            row["status"] = "—"
        else:
            days = (exp_date - today).days
            row["days_to_expiry"] = days
            row["status"] = "Expired" if days < 0 else "Near Expiry"
        rows.append(row)
    return paged(rows, total, sk, lim)


@router.get("/daily-tax", dependencies=[Depends(require_perm("reports.view"))])
async def daily_tax(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat()]
    sale_branch = _eq_or_in(SaleInvoice.branch_id, branch_id)
    if sale_branch is not None:
        conds.append(sale_branch)
    if search:
        conds.append(SaleInvoice.number.ilike(f"%{search}%"))

    sort_map = {
        "date": SaleInvoice.date,
        "taxable_sales": func.sum(SaleInvoice.subtotal),
        "tax_amount": func.sum(SaleInvoice.tax_total),
        "exempt_sales": func.sum(case((SaleInvoice.tax_total == 0, SaleInvoice.total), else_=0)),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            SaleInvoice.date.label("date"),
            func.coalesce(func.sum(SaleInvoice.subtotal), 0).label("taxable_sales"),
            func.coalesce(func.sum(SaleInvoice.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(case((SaleInvoice.tax_total == 0, SaleInvoice.total), else_=0)), 0).label("exempt_sales"),
        )
        .where(and_(*conds))
        .group_by(SaleInvoice.date)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/monthly-tax", dependencies=[Depends(require_perm("reports.view"))])
async def monthly_tax(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    month_expr = func.substr(SaleInvoice.date, 1, 7)
    conds = [SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat()]
    sale_branch = _eq_or_in(SaleInvoice.branch_id, branch_id)
    if sale_branch is not None:
        conds.append(sale_branch)
    if search:
        conds.append(SaleInvoice.number.ilike(f"%{search}%"))

    sort_map = {
        "month": month_expr,
        "taxable_sales": func.sum(SaleInvoice.subtotal),
        "tax_amount": func.sum(SaleInvoice.tax_total),
        "exempt_sales": func.sum(case((SaleInvoice.tax_total == 0, SaleInvoice.total), else_=0)),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "month", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            month_expr.label("month"),
            func.coalesce(func.sum(SaleInvoice.subtotal), 0).label("taxable_sales"),
            func.coalesce(func.sum(SaleInvoice.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(case((SaleInvoice.tax_total == 0, SaleInvoice.total), else_=0)), 0).label("exempt_sales"),
        )
        .where(and_(*conds))
        .group_by(month_expr)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/quarterly-tax", dependencies=[Depends(require_perm("reports.view"))])
async def quarterly_tax(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    period_expr = func.substr(SaleInvoice.date, 1, 7)
    conds = [SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat()]
    sale_branch = _eq_or_in(SaleInvoice.branch_id, branch_id)
    if sale_branch is not None:
        conds.append(sale_branch)
    if search:
        conds.append(SaleInvoice.number.ilike(f"%{search}%"))

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            period_expr.label("period"),
            func.coalesce(func.sum(SaleInvoice.subtotal), 0).label("taxable_sales"),
            func.coalesce(func.sum(SaleInvoice.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(case((SaleInvoice.tax_total == 0, SaleInvoice.total), else_=0)), 0).label("exempt_sales"),
        )
        .where(and_(*conds))
        .group_by(period_expr)
    )
    result = await db.execute(base)
    grouped = {}
    for row in result.fetchall():
        year, month = row.period.split("-")
        quarter = (int(month) - 1) // 3 + 1
        qkey = f"{year}-Q{quarter}"
        entry = grouped.setdefault(
            qkey,
            {"period": qkey, "taxable_sales": 0.0, "tax_amount": 0.0, "exempt_sales": 0.0},
        )
        entry["taxable_sales"] += float(row.taxable_sales or 0)
        entry["tax_amount"] += float(row.tax_amount or 0)
        entry["exempt_sales"] += float(row.exempt_sales or 0)

    rows = [value for _, value in sorted(grouped.items(), reverse=True)]
    total = len(rows)
    return paged(rows[sk:sk+lim], total, sk, lim)


@router.get("/gst-summary", dependencies=[Depends(require_perm("reports.view"))])
async def gst_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat()]
    sale_branch = _eq_or_in(SaleInvoice.branch_id, branch_id)
    if sale_branch is not None:
        conds.append(sale_branch)

    gst_tax = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.tax_total), 0)).where(and_(*conds)))).scalar() or 0
    )
    gst_taxable = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.subtotal), 0)).where(and_(*conds)))).scalar() or 0
    )
    exempt_amount = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(and_(*conds, SaleInvoice.tax_total == 0)))).scalar() or 0
    )
    return [
        {"tax_type": "GST", "taxable_amount": gst_taxable, "tax_collected": gst_tax},
        {"tax_type": "Exempt", "taxable_amount": exempt_amount, "tax_collected": 0},
    ]


@router.get("/outstanding-receivables", dependencies=[Depends(require_perm("reports.view"))])
async def outstanding_receivables(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    outstanding = _invoice_outstanding_expr()
    conds = [
        outstanding > 0.01,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    sale_branch = _eq_or_in(SaleInvoice.branch_id, branch_id)
    if sale_branch is not None:
        conds.append(sale_branch)
    if search:
        conds.append(
            SaleInvoice.number.ilike(f"%{search}%")
            | SaleInvoice.customer_name.ilike(f"%{search}%")
        )
    conds.append(SaleInvoice.date >= start.isoformat())
    conds.append(SaleInvoice.date <= end.isoformat())
    sort_map = {
        "customer": SaleInvoice.customer_name,
        "invoice_number": SaleInvoice.number,
        "invoice_date": SaleInvoice.date,
        "due_date": SaleInvoice.date,
        "outstanding_amount": outstanding,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "due_date", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    query = (
        select(
            SaleInvoice.id.label("invoice_id"),
            SaleInvoice.customer_name.label("customer"),
            SaleInvoice.number.label("invoice_number"),
            SaleInvoice.date.label("invoice_date"),
            SaleInvoice.date.label("due_date"),
            outstanding.label("outstanding_amount"),
        )
        .where(and_(*conds))
        .order_by(order_by_expr)
        .offset(sk)
        .limit(lim)
    )
    total_q = select(func.count()).select_from(SaleInvoice).where(and_(*conds))
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(query)
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/outstanding-payables", dependencies=[Depends(require_perm("reports.view"))])
async def outstanding_payables(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [PurchaseBill.total > PurchaseBill.paid_amount]
    purchase_branch = _eq_or_in(PurchaseBill.branch_id, branch_id)
    if purchase_branch is not None:
        conds.append(purchase_branch)
    if search:
        conds.append(
            PurchaseBill.number.ilike(f"%{search}%")
            | PurchaseBill.vendor_name.ilike(f"%{search}%")
        )
    conds.append(PurchaseBill.date >= start.isoformat())
    conds.append(PurchaseBill.date <= end.isoformat())
    sort_map = {
        "vendor": PurchaseBill.vendor_name,
        "bill_number": PurchaseBill.number,
        "bill_date": PurchaseBill.date,
        "due_date": PurchaseBill.due_date,
        "outstanding_amount": PurchaseBill.total - PurchaseBill.paid_amount,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "due_date", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    query = (
        select(
            PurchaseBill.id.label("bill_id"),
            PurchaseBill.vendor_name.label("vendor"),
            PurchaseBill.number.label("bill_number"),
            PurchaseBill.date.label("bill_date"),
            PurchaseBill.due_date.label("due_date"),
            (PurchaseBill.total - PurchaseBill.paid_amount).label("outstanding_amount"),
        )
        .where(and_(*conds))
        .order_by(order_by_expr)
        .offset(sk)
        .limit(lim)
    )
    total_q = select(func.count()).select_from(PurchaseBill).where(and_(*conds))
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(query)
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/petty-cash", dependencies=[Depends(require_perm("reports.view"))])
async def petty_cash(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [CashEntry.date >= start.isoformat(), CashEntry.date <= end.isoformat()]
    cash_branch = _eq_or_in(CashEntry.branch_id, branch_id)
    if cash_branch is not None:
        conds.append(cash_branch)
    if search:
        conds.append(CashEntry.description.ilike(f"%{search}%"))

    sort_map = {
        "date": CashEntry.date,
        "expense_category": CashEntry.category,
        "description": CashEntry.description,
        "amount": CashEntry.amount,
        "branch": Branch.name,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    query = (
        select(
            CashEntry.date.label("date"),
            CashEntry.category.label("expense_category"),
            CashEntry.description.label("description"),
            CashEntry.amount.label("amount"),
            Branch.name.label("branch"),
        )
        .join(Branch, Branch.id == CashEntry.branch_id)
        .where(and_(*conds))
        .order_by(order_by_expr)
        .offset(sk)
        .limit(lim)
    )
    total_q = (
        select(func.count())
        .select_from(CashEntry)
        .join(Branch, Branch.id == CashEntry.branch_id)
        .where(and_(*conds))
    )
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(query)
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/top-customers", dependencies=[Depends(require_perm("reports.view"))])
async def top_customers(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    start_s = _iso_date(start)
    end_s = _iso_date(end)
    inv_conds = [
        SaleInvoice.date >= start_s,
        SaleInvoice.date <= end_s,
        SaleInvoice.status != InvoiceStatus.cancelled,
    ]
    cn_conds = [
        SalesReturn.date >= start_s,
        SalesReturn.date <= end_s,
        SalesReturn.status != SalesReturnStatus.void,
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        inv_conds.append(branch_cond)
    cn_branch = _branch_condition(SalesReturn.branch_id, branch_id, branch_scope)
    if cn_branch is not None:
        cn_conds.append(cn_branch)

    docs = _signed_sales_docs_subquery(inv_conds, cn_conds)
    outstanding_amount = func.coalesce(func.sum(docs.c.outstanding), 0)
    sort_map = {
        "customer": docs.c.customer,
        "invoice_count": func.count(docs.c.doc_id),
        "purchase_amount": func.coalesce(func.sum(docs.c.total), 0),
        "outstanding_amount": outstanding_amount,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "outstanding_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            docs.c.customer_id.label("customer_id"),
            docs.c.customer.label("customer"),
            func.count(docs.c.doc_id).label("invoice_count"),
            func.coalesce(func.sum(docs.c.total), 0).label("purchase_amount"),
            outstanding_amount.label("outstanding_amount"),
        )
        .select_from(docs)
        .group_by(docs.c.customer_id, docs.c.customer)
        .having(outstanding_amount != 0)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/vendor-outstanding", dependencies=[Depends(require_perm("reports.view"))])
async def vendor_outstanding(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: Optional[object] = Depends(current_user),
):
    branch_scope = await _resolve_branch_scope(user, db, branch_id)
    start, end = _normalize_date_range(date_from, date_to)
    conds = [
        PurchaseBill.date >= start.isoformat(),
        PurchaseBill.date <= end.isoformat(),
        PurchaseBill.status != InvoiceStatus.cancelled,
    ]
    branch_cond = _branch_condition(PurchaseBill.branch_id, branch_id, branch_scope)
    if branch_cond is not None:
        conds.append(branch_cond)

    sort_map = {
        "vendor": PurchaseBill.vendor_name,
        "purchase_count": func.count(PurchaseBill.id),
        "purchase_amount": func.coalesce(func.sum(PurchaseBill.total), 0),
        "outstanding_amount": func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "outstanding_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    outstanding_amount = func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0)
    base = (
        select(
            PurchaseBill.vendor_id.label("vendor_id"),
            PurchaseBill.vendor_name.label("vendor"),
            func.count(PurchaseBill.id).label("purchase_count"),
            func.coalesce(func.sum(PurchaseBill.total), 0).label("purchase_amount"),
            outstanding_amount.label("outstanding_amount"),
        )
        .where(and_(*conds))
        .group_by(PurchaseBill.vendor_id, PurchaseBill.vendor_name)
        .having(outstanding_amount != 0)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/stock-movement", dependencies=[Depends(require_perm("reports.view"))])
async def stock_movement(
    branch_id: Optional[str] = None,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    sale_conds = []
    purchase_conds = []
    transfer_conds = []

    sale_branch = _eq_or_in(SaleInvoice.branch_id, branch_id)
    if sale_branch is not None:
        sale_conds.append(sale_branch)
    purchase_branch = _eq_or_in(PurchaseBill.branch_id, branch_id)
    if purchase_branch is not None:
        purchase_conds.append(purchase_branch)
    transfer_branch = _transfer_branch_predicate(branch_id)
    if transfer_branch is not None:
        transfer_conds.append(transfer_branch)
    if search:
        sale_conds.append(SaleLineItem.name.ilike(f"%{search}%"))
        purchase_conds.append(PurchaseLineItem.name.ilike(f"%{search}%"))
        transfer_conds.append(TransferLineItem.item_name.ilike(f"%{search}%"))

    sale_q = select(
        SaleInvoice.date.label("date"),
        SaleLineItem.name.label("product"),
        literal("Sale").label("movement_type"),
        SaleLineItem.qty.label("quantity"),
        SaleInvoice.number.label("reference_number"),
        SaleInvoice.branch_name.label("branch"),
    ).select_from(SaleLineItem).join(SaleInvoice, SaleInvoice.id == SaleLineItem.invoice_id)
    if sale_conds:
        sale_q = sale_q.where(and_(*sale_conds))

    purchase_q = select(
        PurchaseBill.date.label("date"),
        PurchaseLineItem.name.label("product"),
        literal("Purchase").label("movement_type"),
        PurchaseLineItem.qty.label("quantity"),
        PurchaseBill.number.label("reference_number"),
        PurchaseBill.branch_name.label("branch"),
    ).select_from(PurchaseLineItem).join(PurchaseBill, PurchaseBill.id == PurchaseLineItem.bill_id)
    if purchase_conds:
        purchase_q = purchase_q.where(and_(*purchase_conds))

    transfer_q = select(
        StockTransfer.request_date.label("date"),
        TransferLineItem.item_name.label("product"),
        literal("Stock Transfer").label("movement_type"),
        TransferLineItem.qty.label("quantity"),
        StockTransfer.ref_number.label("reference_number"),
        func.concat(StockTransfer.from_branch_name, " → ", StockTransfer.to_branch_name).label("branch"),
    ).select_from(TransferLineItem).join(StockTransfer, StockTransfer.id == TransferLineItem.transfer_id)
    if transfer_conds:
        transfer_q = transfer_q.where(and_(*transfer_conds))

    union_query = sale_q.union_all(purchase_q, transfer_q).subquery()
    order_expr = union_query.c.date
    if sort_by == "product":
        order_expr = union_query.c.product
    elif sort_by == "movement_type":
        order_expr = union_query.c.movement_type
    elif sort_by == "quantity":
        order_expr = union_query.c.quantity
    elif sort_by == "reference_number":
        order_expr = union_query.c.reference_number
    elif sort_by == "branch":
        order_expr = union_query.c.branch

    desc = (sort_order or "asc").strip().lower() == "desc"
    ordered = order_expr.desc() if desc else order_expr.asc()

    total_q = select(func.count()).select_from(union_query)
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(select(union_query).order_by(ordered).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/branch-comparison", dependencies=[Depends(require_perm("reports.view"))])
async def branch_comparison(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    q = (
        select(
            SaleInvoice.branch_name.label("branch"),
            func.count(SaleInvoice.id).label("invoice_count"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("sales"),
            func.coalesce(func.sum(SaleInvoice.tax_total), 0).label("tax"),
            func.coalesce(func.sum(SaleInvoice.discount), 0).label("discount"),
        )
        .where(SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat())
        .group_by(SaleInvoice.branch_name)
        .order_by(SaleInvoice.branch_name)
    )
    result = await db.execute(q)
    return [dict(row._mapping) for row in result.fetchall()]


@router.get("/margin-analysis", dependencies=[Depends(require_perm("reports.view"))])
async def margin_analysis(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    sale_conds = [SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat()]

    sales_q = (
        select(
            func.coalesce(Category.name, "Uncategorized").label("category"),
            func.coalesce(func.sum(SaleLineItem.line_total), 0).label("revenue"),
            func.coalesce(func.sum(func.coalesce(Item.cost_price, 0) * SaleLineItem.qty), 0).label("cost"),
        )
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleInvoice.id == SaleLineItem.invoice_id)
        .join(Item, Item.id == SaleLineItem.item_id)
        .join(Category, Category.id == Item.category_id, isouter=True)
        .where(and_(*sale_conds))
        .group_by(Category.name)
        .order_by(func.sum(SaleLineItem.line_total).desc())
    )
    result = await db.execute(sales_q)
    by_category = []
    for row in result.fetchall():
        revenue = float(row.revenue or 0)
        cost = float(row.cost or 0)
        by_category.append({
            "category": row.category,
            "revenue": revenue,
            "cost": cost,
            "margin": revenue - cost,
            "margin_pct": round((revenue and (revenue - cost) * 100 / revenue) or 0, 2),
        })

    top_items_q = (
        select(
            SaleLineItem.name.label("name"),
            func.coalesce(func.sum(SaleLineItem.line_total), 0).label("revenue"),
            func.coalesce(func.sum(func.coalesce(Item.cost_price, 0) * SaleLineItem.qty), 0).label("cost"),
        )
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleInvoice.id == SaleLineItem.invoice_id)
        .join(Item, Item.id == SaleLineItem.item_id)
        .where(and_(*sale_conds))
        .group_by(SaleLineItem.name)
        .order_by((func.sum(SaleLineItem.line_total) - func.sum(func.coalesce(Item.cost_price, 0) * SaleLineItem.qty)).desc())
        .limit(8)
    )
    result = await db.execute(top_items_q)
    top_items = [
        {
            "name": row.name,
            "margin_pct": round((row.revenue and (row.revenue - row.cost) * 100 / row.revenue) or 0, 2),
            "revenue": float(row.revenue or 0),
        }
        for row in result.fetchall()
    ]
    return {"by_category": by_category, "top_items": top_items}

import asyncio
import hashlib
import json
import logging
import uuid
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, desc, distinct, exists, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from src.database import get_db
from src.date_utils import (
    MAX_DASHBOARD_DATE_RANGE_DAYS,
    business_timezone,
    parse_date_range,
)
from src.date_utils import (
    dashboard_business_today as business_today,
)
from src.models import (
    AuditLog,
    Branch,
    Category,
    CustomerPayment,
    CustomerPaymentAllocation,
    DailySalesSummary,
    InventorySnapshot,
    InvoiceStatus,
    Item,
    ItemBatch,
    ItemStock,
    SaleInvoice,
    SaleLineItem,
    SalesReturn,
    SalesReturnLineItem,
    StockMovement,
    User,
)
from src.routes.reports import _tax_line_exprs
from src.security import _has_global_branch_access, current_user, get_allowed_branch_ids

router = APIRouter()
logger = logging.getLogger("cosmopolitan.dashboard")
_DASHBOARD_CACHE: dict[str, tuple[datetime, dict]] = {}
_DASHBOARD_REFRESH_GUARD: dict[str, datetime] = {}
_DASHBOARD_REFRESH_LOCKS: dict[str, asyncio.Lock] = {}
_DASHBOARD_REFRESH_INTERVAL = timedelta(seconds=10)
PUBLIC_DASHBOARD_USER_ID = "public"


class DashboardFilters:
    def __init__(
        self,
        from_date: Optional[str] = Query(None, alias="from"),
        to: Optional[str] = Query(None),
        branch_id: Optional[str] = None,
        staff_id: Optional[str] = None,
        category_id: Optional[str] = None,
        refresh: bool = False,
        limit: int = Query(20, ge=1, le=500),
        cursor_date: Optional[str] = None,
        include_unposted: bool = False,
    ):
        self.from_date = from_date if isinstance(from_date, str) else None
        self.to = to if isinstance(to, str) else None
        self.branch_id = branch_id if isinstance(branch_id, str) else None
        self.staff_id = staff_id if isinstance(staff_id, str) else None
        self.category_id = category_id if isinstance(category_id, str) else None
        self.refresh = refresh is True
        self.limit = limit if isinstance(limit, int) else 20
        self.cursor_date = cursor_date if isinstance(cursor_date, str) else None
        self.include_unposted = include_unposted if isinstance(include_unposted, bool) else False


class DashboardExportRequest(BaseModel):
    tab: str
    format: str = "excel"
    filters: dict = Field(default_factory=dict)


@dataclass(frozen=True)
class Period:
    start: date
    end: date

    @property
    def start_s(self) -> str:
        return self.start.isoformat()

    @property
    def end_s(self) -> str:
        return self.end.isoformat()

    @property
    def days(self) -> int:
        return max(1, (self.end - self.start).days + 1)

    @property
    def previous(self) -> "Period":
        prev_end = self.start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=self.days - 1)
        return Period(prev_start, prev_end)


FINALIZED_INVOICE_STATUSES = (
    InvoiceStatus.pending,
    InvoiceStatus.partial,
    InvoiceStatus.overdue,
    InvoiceStatus.paid,
)


def _kam_uuid_shaped(value):
    return and_(
        func.length(value) == 36,
        func.substr(value, 9, 1) == "-",
        func.substr(value, 14, 1) == "-",
        func.substr(value, 19, 1) == "-",
        func.substr(value, 24, 1) == "-",
    )


def _kam_unknown_uuid_condition(value):
    user_alias = aliased(User)
    matching_user = exists(
        select(1)
        .select_from(user_alias)
        .where(user_alias.id == value)
        .correlate(SaleInvoice)
    )
    return and_(_kam_uuid_shaped(value), ~matching_user)


def _parse_period(filters: DashboardFilters) -> Period:
    today = business_today()
    start, end = parse_date_range(
        filters.from_date,
        filters.to,
        today.replace(day=1),
        today,
        MAX_DASHBOARD_DATE_RANGE_DAYS,
    )
    logger.debug(
        "Dashboard date range %s to %s (max %s days)",
        start.isoformat(),
        end.isoformat(),
        MAX_DASHBOARD_DATE_RANGE_DAYS,
    )
    return Period(start, end)


def _page(items: list[dict], total: Optional[int] = None, page: int = 1, page_size: Optional[int] = None) -> dict:
    return {
        "items": items,
        "page": page,
        "page_size": page_size or len(items),
        "total": len(items) if total is None else total,
    }


def _pct_delta(current: Optional[float], previous: Optional[float]) -> Optional[float]:
    if current is None or not previous:
        return None
    return round(((current - previous) / abs(previous)) * 100, 1)


def _collection_efficiency(
    collected: Optional[float],
    refunded: Optional[float],
    revenue: Optional[float],
) -> Optional[float]:
    if collected is None or refunded is None or revenue is None:
        return None
    return round(((collected - refunded) / revenue) * 100, 1) if revenue else 0


def _valid_invoice_status():
    return SaleInvoice.status.in_(FINALIZED_INVOICE_STATUSES)


def _outstanding_amount_expr():
    balance = (
        func.coalesce(SaleInvoice.total, 0)
        - func.coalesce(SaleInvoice.paid_amount, 0)
        - func.coalesce(SaleInvoice.credited_amount, 0)
    )
    return case((balance > 0, balance), else_=0)


def _kam_invoice_condition(staff_id: Optional[str]):
    if not staff_id:
        return None
    if staff_id == "__unassigned__":
        return and_(
            func.nullif(func.trim(SaleInvoice.customer_key_account_manager_snapshot), "").is_(None),
            func.nullif(func.trim(SaleInvoice.customer_key_account_manager_name_snapshot), "").is_(None),
        )
    normalized_staff_id = staff_id.strip().casefold()
    selected_user_name = (
        select(User.name).where(User.id == staff_id).scalar_subquery()
    )
    selected_name = func.coalesce(selected_user_name, staff_id.strip())
    selected_name_count = (
        select(func.count(User.id))
        .where(func.lower(func.trim(User.name)) == func.lower(func.trim(selected_name)))
        .scalar_subquery()
    )
    unique_user_id_for_name = (
        select(func.min(User.id))
        .where(func.lower(func.trim(User.name)) == func.lower(func.trim(selected_name)))
        .group_by(func.lower(func.trim(User.name)))
        .having(func.count(User.id) == 1)
        .scalar_subquery()
    )
    snapshot_values = (
        SaleInvoice.customer_key_account_manager_snapshot,
        SaleInvoice.customer_key_account_manager_name_snapshot,
    )
    normalized_values = tuple(
        func.lower(func.trim(value)) for value in snapshot_values
    )
    unknown_uuid_values = tuple(
        _kam_unknown_uuid_condition(value) for value in snapshot_values
    )
    return or_(
        *(
            func.trim(value) == staff_id.strip()
            for value in snapshot_values
        ),
        *(
            and_(
                normalized_value == normalized_staff_id,
                ~unknown_uuid_values[1 - index],
            )
            for index, normalized_value in enumerate(normalized_values)
        ),
        *(
            value == unique_user_id_for_name
            for value in snapshot_values
        ),
        and_(
            selected_name_count == 1,
            or_(
                *(
                    and_(
                        normalized_value == func.lower(func.trim(selected_name)),
                        ~unknown_uuid_values[1 - index],
                    )
                    for index, normalized_value in enumerate(normalized_values)
                )
            ),
        ),
    )


def _filters_dict(filters: DashboardFilters, period: Period) -> dict:
    payload = {
        "from": period.start_s,
        "to": period.end_s,
        "include_unposted": getattr(filters, "include_unposted", False),
    }
    for key in ("branch_id", "staff_id", "category_id"):
        value = getattr(filters, key)
        if value:
            payload[key] = value
    return payload


async def _resolve_branch_scope(user: User, db: AsyncSession) -> Optional[list[str]]:
    if not getattr(user, "id", None):
        try:
            user = await current_user(authorization=None, db=db)
        except RuntimeError:
            return None
    if _has_global_branch_access(user):
        return None
    branch_ids = await get_allowed_branch_ids(user, db)
    if branch_ids:
        return branch_ids
    if getattr(user, "branch_id", None):
        return [user.branch_id]
    return []


async def _allowed_branch_ids(db: AsyncSession, user: User) -> Optional[list[str]]:
    return await _resolve_branch_scope(user, db)


def _branch_condition(column, filters: DashboardFilters, allowed_branch_ids: Optional[list[str]]):
    if filters.branch_id:
        if allowed_branch_ids is not None and filters.branch_id not in allowed_branch_ids:
            raise HTTPException(403, "Branch is outside your dashboard scope")
        return column == filters.branch_id
    if allowed_branch_ids is not None:
        if not allowed_branch_ids:
            return column == "__no_branch_access__"
        return column.in_(allowed_branch_ids)
    return None


def _invoice_ids_for_category(category_id: str):
    return (
        select(SaleLineItem.invoice_id)
        .join(Item, SaleLineItem.item_id == Item.id)
        .where(Item.category_id == category_id)
    )


def _return_ids_for_category(category_id: str):
    return (
        select(SalesReturnLineItem.return_id)
        .join(Item, SalesReturnLineItem.item_id == Item.id)
        .where(Item.category_id == category_id)
    )


def _invoice_conditions(
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
):
    conds = [SaleInvoice.date >= period.start_s, SaleInvoice.date <= period.end_s]
    conds.append(_valid_invoice_status())
    branch_cond = _branch_condition(SaleInvoice.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.staff_id:
        conds.append(_kam_invoice_condition(filters.staff_id))
    if filters.category_id:
        conds.append(SaleInvoice.id.in_(_invoice_ids_for_category(filters.category_id)))
    return conds


async def _kam_staff_options(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    conds = [
        SaleInvoice.date >= period.start_s,
        SaleInvoice.date <= period.end_s,
        _valid_invoice_status(),
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.category_id:
        conds.append(SaleInvoice.id.in_(_invoice_ids_for_category(filters.category_id)))

    result = await db.execute(
        select(
            SaleInvoice.customer_key_account_manager_snapshot,
            SaleInvoice.customer_key_account_manager_name_snapshot,
        )
        .select_from(SaleInvoice)
        .where(and_(*conds))
        .distinct()
    )
    users = (
        await db.execute(select(User.id, User.name).where(User.name.is_not(None)))
    ).all()
    users_by_id = {user.id: user.name for user in users}
    user_ids_by_name: dict[str, list[str]] = {}
    for user in users:
        user_ids_by_name.setdefault((user.name or "").strip().casefold(), []).append(user.id)

    def normalize(value):
        return (value or "").strip()

    def user_label(user_id: str) -> str:
        name = users_by_id[user_id].strip()
        if len(user_ids_by_name.get(name.casefold(), [])) > 1:
            return f"{name} ({user_id[-6:]})"
        return name

    option_labels: dict[str, list[str]] = {}

    def add_option(person_key: str, value: str, label: str) -> None:
        option_labels.setdefault(person_key, [value]).append(label)

    for raw_value, name_value in result.fetchall():
        raw_value = normalize(raw_value)
        name_value = normalize(name_value)
        if not raw_value and not name_value:
            continue
        snapshot_user_ids = {
            value for value in (raw_value, name_value) if value in users_by_id
        }
        if snapshot_user_ids:
            for person_id in snapshot_user_ids:
                add_option(
                    f"user:{person_id}",
                    person_id,
                    user_label(person_id),
                )
            continue

        uuid_value = None
        for value in (raw_value, name_value):
            if not value:
                continue
            try:
                uuid.UUID(value)
                uuid_value = value
                break
            except ValueError:
                continue
        if uuid_value:
            add_option(f"unknown:{uuid_value.casefold()}", uuid_value, "Unknown KAM")
            continue

        normalized_names = {
            user_id
            for value in (raw_value, name_value)
            for user_id in user_ids_by_name.get(value.casefold(), [])
        }
        if len(normalized_names) == 1:
            person_id = next(iter(normalized_names))
            add_option(
                f"user:{person_id}",
                person_id,
                user_label(person_id),
            )
            continue

        value = name_value or raw_value
        normalized_value = value.casefold()
        add_option(f"name:{normalized_value}", value, value)

    options_by_person = []
    for person_key, values in option_labels.items():
        option_value, *labels = values
        label = max(
            labels,
            key=lambda candidate: (
                candidate.istitle(),
                candidate.casefold() == candidate,
                candidate,
            ),
        )
        options_by_person.append({"id": option_value, "name": label})

    options = sorted(
        options_by_person,
        key=lambda option: (option["name"].casefold(), option["id"]),
    )
    options.append({"id": "__unassigned__", "name": "Unassigned"})
    return options


def _line_conditions(filters: DashboardFilters, allowed_branch_ids: Optional[list[str]], period: Period):
    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    if filters.category_id:
        conds.append(Item.category_id == filters.category_id)
    return conds


def _dashboard_cogs_expr(filters: DashboardFilters):
    cost = func.coalesce(Item.cost_price, 0) * SaleLineItem.qty
    if filters.include_unposted:
        return cost
    return case(
        (
            SaleInvoice.status.notin_(
                (InvoiceStatus.draft, InvoiceStatus.pending_approval)
            ),
            cost,
        ),
        else_=literal(0.0),
    )


def _line_header_allocation(line_parent_id, line_amount, header_amount):
    line_totals = (
        select(
            line_parent_id.label("parent_id"),
            func.coalesce(func.sum(line_amount), 0).label("line_total"),
        )
        .group_by(line_parent_id)
        .subquery()
    )
    allocated_amount = func.coalesce(header_amount, 0) * func.coalesce(line_amount, 0)
    allocated_amount /= func.nullif(line_totals.c.line_total, 0)
    return line_totals, func.coalesce(allocated_amount, 0)


def _sale_line_source():
    line_totals, allocated_amount = _line_header_allocation(
        SaleLineItem.invoice_id,
        SaleLineItem.line_total,
        SaleInvoice.total,
    )
    source = (
        SaleLineItem.__table__
        .join(SaleInvoice.__table__, SaleLineItem.invoice_id == SaleInvoice.id)
        .outerjoin(Item.__table__, SaleLineItem.item_id == Item.id)
        .join(line_totals, line_totals.c.parent_id == SaleInvoice.id)
    )
    return source, allocated_amount


def _return_line_source():
    line_totals, allocated_amount = _line_header_allocation(
        SalesReturnLineItem.return_id,
        SalesReturnLineItem.line_total,
        SalesReturn.total,
    )
    source = (
        SalesReturnLineItem.__table__
        .join(SalesReturn.__table__, SalesReturnLineItem.return_id == SalesReturn.id)
        .outerjoin(Item.__table__, SalesReturnLineItem.item_id == Item.id)
        .join(line_totals, line_totals.c.parent_id == SalesReturn.id)
    )
    return source, allocated_amount


def _tax_exclusive_sale_amount(amount):
    return _tax_line_exprs(amount, SaleLineItem.tax_rate)[1]


def _tax_exclusive_return_amount(amount):
    return _tax_line_exprs(amount, SalesReturnLineItem.tax_rate)[1]


def _invoice_tax_amounts():
    source, amount = _sale_line_source()
    taxable = _tax_exclusive_sale_amount(amount)
    return (
        select(
            SaleLineItem.invoice_id.label("invoice_id"),
            func.coalesce(func.sum(amount - taxable), 0).label("tax_amount"),
        )
        .select_from(source)
        .group_by(SaleLineItem.invoice_id)
        .subquery()
    )


def _return_tax_amounts():
    source, amount = _return_line_source()
    taxable = _tax_exclusive_return_amount(amount)
    return (
        select(
            SalesReturnLineItem.return_id.label("return_id"),
            func.coalesce(func.sum(amount - taxable), 0).label("tax_amount"),
        )
        .select_from(source)
        .group_by(SalesReturnLineItem.return_id)
        .subquery()
    )


def _reconciled_mix(amounts: dict, labels: dict, total: float, key_name: str) -> list[dict]:
    ranked = sorted(
        (
            (key, float(value or 0))
            for key, value in amounts.items()
            if str(key).casefold() != "others"
        ),
        key=lambda entry: entry[1],
        reverse=True,
    )
    visible = ranked[:8]
    visible_total = round(sum(value for _, value in visible), 2)
    other_value = round(float(total or 0) - visible_total, 2)
    rows = [
        {
            key_name: labels.get(key, str(key)),
            "revenue": round(value, 2),
            "percentage": round((value / total) * 100, 1) if total else 0,
        }
        for key, value in visible
    ]
    if other_value != 0:
        rows.append({
            key_name: "Others",
            "revenue": other_value,
            "percentage": round((other_value / total) * 100, 1) if total else 0,
        })
    return rows


def _database_supports_materialized_views(db: AsyncSession) -> bool:
    # Keep this unsupported until existing read models encode dashboard definitions.
    return False


def _can_use_sales_mvs(db: AsyncSession, filters: DashboardFilters) -> bool:
    """Sales read models are unsupported until they include finalized/return semantics."""
    return False


def _mv_conds(model, filters: DashboardFilters, allowed_branch_ids: Optional[list[str]]):
    conds = []
    branch_cond = _branch_condition(model.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.staff_id:
        conds.append(model.cashier == filters.staff_id)
    return conds


def _stock_conditions(filters: DashboardFilters, allowed_branch_ids: Optional[list[str]]):
    conds = [Item.active == True]
    branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.category_id:
        conds.append(Item.category_id == filters.category_id)
    return conds


def _inventory_mv_conds(filters: DashboardFilters, allowed_branch_ids: Optional[list[str]]):
    conds = [Item.active == True]
    branch_cond = _branch_condition(InventorySnapshot.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.category_id:
        conds.append(InventorySnapshot.category_id == filters.category_id)
    return conds


def _return_conditions(
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
):
    conds = [
        SalesReturn.date >= period.start_s,
        SalesReturn.date <= period.end_s,
        SalesReturn.status != "void",
    ]
    branch_cond = _branch_condition(SalesReturn.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    invoice_conds = [
        SaleInvoice.id == SalesReturn.invoice_id,
        _valid_invoice_status(),
    ]
    kam_cond = _kam_invoice_condition(filters.staff_id)
    if kam_cond is not None:
        invoice_conds.append(kam_cond)
    valid_invoice = (
        select(1)
        .select_from(SaleInvoice)
        .where(and_(*invoice_conds))
        .correlate(SalesReturn)
    )
    conds.append(exists(valid_invoice))
    if filters.category_id:
        conds.append(SalesReturn.id.in_(_return_ids_for_category(filters.category_id)))
    return conds


def _return_line_conditions(
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
):
    conds = _return_conditions(filters, allowed_branch_ids, period)
    if filters.category_id:
        conds.append(Item.category_id == filters.category_id)
    return conds


async def _gross_revenue(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> float:
    if filters.category_id:
        conds = _line_conditions(filters, allowed_branch_ids, period)
        value = (
            await db.execute(
                select(func.coalesce(func.sum(SaleLineItem.line_total), 0))
                .select_from(SaleLineItem)
                .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
                .outerjoin(Item, SaleLineItem.item_id == Item.id)
                .where(and_(*conds))
            )
        ).scalar()
    else:
        conds = _invoice_conditions(filters, allowed_branch_ids, period)
        value = (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(and_(*conds))
            )
        ).scalar()
    return float(value or 0)


async def _returned_revenue(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> tuple[float, Optional[float]]:
    conds = _return_conditions(filters, allowed_branch_ids, period)
    if filters.category_id:
        return_source, return_amount = _return_line_source()
        returned = (
            await db.execute(
                select(func.coalesce(func.sum(return_amount), 0))
                .select_from(return_source)
                .where(and_(*_return_line_conditions(filters, allowed_branch_ids, period)))
            )
        ).scalar()
        credited = None
    else:
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(SalesReturn.total), 0).label("returned"),
                    func.coalesce(func.sum(SalesReturn.credited_amount), 0).label("credited"),
                ).where(and_(*conds))
            )
        ).one()
        returned = row.returned
        credited = row.credited
    return float(returned or 0), float(credited) if credited is not None else None


async def _daily_revenue_components(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if filters.category_id:
        sales_conds = _line_conditions(filters, allowed_branch_ids, period)
        sales_source, sales_amount = _sale_line_source()
        sales_taxable = _tax_exclusive_sale_amount(sales_amount)
        sales_rows = await db.execute(
            select(
                SaleInvoice.date.label("date"),
                func.coalesce(func.sum(sales_amount), 0).label("gross"),
                func.coalesce(func.sum(sales_taxable), 0).label("sales"),
            )
            .select_from(sales_source)
            .where(and_(*sales_conds))
            .group_by(SaleInvoice.date)
        )
        return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
        return_source, return_amount = _return_line_source()
        return_taxable = _tax_exclusive_return_amount(return_amount)
        return_rows = await db.execute(
            select(
                SalesReturn.date.label("date"),
                func.coalesce(func.sum(return_amount), 0).label("returned"),
                func.coalesce(func.sum(return_taxable), 0).label("net_returned"),
            )
            .select_from(return_source)
            .where(and_(*return_conds))
            .group_by(SalesReturn.date)
        )
    else:
        sales_conds = _invoice_conditions(filters, allowed_branch_ids, period)
        invoice_taxes = _invoice_tax_amounts()
        sales_rows = await db.execute(
            select(
                SaleInvoice.date.label("date"),
                func.coalesce(func.sum(SaleInvoice.total), 0).label("gross"),
                func.coalesce(
                    func.sum(
                        func.coalesce(SaleInvoice.total, 0)
                        - func.coalesce(invoice_taxes.c.tax_amount, 0)
                    ),
                    0,
                ).label("sales"),
            )
            .outerjoin(invoice_taxes, invoice_taxes.c.invoice_id == SaleInvoice.id)
            .where(and_(*sales_conds))
            .group_by(SaleInvoice.date)
        )
        return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
        return_taxes = _return_tax_amounts()
        return_rows = await db.execute(
            select(
                SalesReturn.date.label("date"),
                func.coalesce(func.sum(SalesReturn.total), 0).label("returned"),
                func.coalesce(
                    func.sum(
                        func.coalesce(SalesReturn.total, 0)
                        - func.coalesce(return_taxes.c.tax_amount, 0)
                    ),
                    0,
                ).label("net_returned"),
            )
            .outerjoin(return_taxes, return_taxes.c.return_id == SalesReturn.id)
            .where(and_(*return_conds))
            .group_by(SalesReturn.date)
        )

    gross_by_date = {}
    sales_by_date = {}
    for row in sales_rows.fetchall():
        gross_by_date[row.date] = float(row.gross or 0)
        sales_by_date[row.date] = float(row.sales or 0)
    returned_by_date = {}
    net_returned_by_date = {}
    for row in return_rows.fetchall():
        returned_by_date[row.date] = float(row.returned or 0)
        net_returned_by_date[row.date] = float(row.net_returned or 0)
    rows = []
    day = period.start
    while day <= period.end:
        day_s = day.isoformat()
        gross = gross_by_date.get(day_s, 0)
        returned = returned_by_date.get(day_s, 0)
        sales = sales_by_date.get(day_s, 0) - net_returned_by_date.get(day_s, 0)
        rows.append(
            {
                "date": day_s,
                "gross": round(gross, 2),
                "returned": round(returned, 2),
                "sales": round(sales, 2),
            }
        )
        day += timedelta(days=1)
    return rows


async def _invoice_summary(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> dict:
    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(SaleInvoice.paid_amount), 0).label("collected"),
                func.coalesce(func.sum(SaleInvoice.discount), 0).label("discount"),
                func.count(SaleInvoice.id).label("bill_count"),
            ).where(and_(*conds))
        )
    ).one()
    invoice_taxes = _invoice_tax_amounts()
    bill_totals = (
        await db.execute(
            select(
                func.coalesce(SaleInvoice.total, 0)
                - func.coalesce(invoice_taxes.c.tax_amount, 0)
            )
            .outerjoin(invoice_taxes, invoice_taxes.c.invoice_id == SaleInvoice.id)
            .where(and_(*conds), SaleInvoice.total.is_not(None))
            .order_by(
                func.coalesce(SaleInvoice.total, 0)
                - func.coalesce(invoice_taxes.c.tax_amount, 0)
            )
        )
    ).scalars().all()
    bill_count_for_median = len(bill_totals)
    if bill_count_for_median:
        middle = bill_count_for_median // 2
        median_bill_value = (
            float(bill_totals[middle])
            if bill_count_for_median % 2
            else (float(bill_totals[middle - 1]) + float(bill_totals[middle])) / 2
        )
    else:
        median_bill_value = None
    daily_revenue = await _daily_revenue_components(db, filters, allowed_branch_ids, period)
    gross = round(sum(row["gross"] for row in daily_revenue), 2)
    returned = round(sum(row["returned"] for row in daily_revenue), 2)
    revenue = round(sum(row["sales"] for row in daily_revenue), 2)
    bill_count = int(row.bill_count or 0)
    return {
        "gross_revenue": gross,
        "returned_revenue": returned,
        "revenue": revenue,
        "revenue_including_tax": round(gross - returned, 2),
        "collected": float(row.collected or 0),
        "discount": float(row.discount or 0),
        "average_bill_value": revenue / bill_count if bill_count else 0,
        "median_bill_value": median_bill_value,
        "bill_count": bill_count,
    }


async def _line_profit_summary(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> dict:
    rows = await _line_profit_by_day(db, filters, allowed_branch_ids, period)
    taxable_revenue = sum(row["taxable_revenue"] for row in rows)
    profit = sum(row["profit"] for row in rows)
    cost_covered_revenue = sum(row["cost_covered_revenue"] for row in rows)
    return {
        "taxable_revenue": taxable_revenue,
        "profit": profit,
        "profit_margin": round((profit / taxable_revenue) * 100, 1) if taxable_revenue else 0,
        "cost_coverage_pct": (
            round((cost_covered_revenue / taxable_revenue) * 100, 1)
            if taxable_revenue > 0 else 0
        ),
    }


async def _line_profit_by_day(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    sales_conds = _line_conditions(filters, allowed_branch_ids, period)
    sales_source, sales_amount = _sale_line_source()
    _, sales_taxable, _ = _tax_line_exprs(sales_amount, SaleLineItem.tax_rate)
    sales_rows = await db.execute(
        select(
            SaleInvoice.date.label("date"),
            func.coalesce(func.sum(sales_taxable), 0).label("taxable"),
            func.coalesce(
                func.sum(case((Item.cost_price > 0, sales_taxable), else_=0)),
                0,
            ).label("cost_covered"),
            func.coalesce(
                func.sum(sales_taxable - (func.coalesce(Item.cost_price, 0) * SaleLineItem.qty)),
                0,
            ).label("profit"),
        )
        .select_from(sales_source)
        .where(and_(*sales_conds))
        .group_by(SaleInvoice.date)
    )

    return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
    return_source, return_amount = _return_line_source()
    _, return_taxable, _ = _tax_line_exprs(return_amount, SalesReturnLineItem.tax_rate)
    return_rows = await db.execute(
        select(
            SalesReturn.date.label("date"),
            func.coalesce(func.sum(return_taxable), 0).label("taxable"),
            func.coalesce(
                func.sum(case((Item.cost_price > 0, return_taxable), else_=0)),
                0,
            ).label("cost_covered"),
            func.coalesce(
                func.sum(
                    return_taxable
                    - (func.coalesce(Item.cost_price, 0) * func.coalesce(SalesReturnLineItem.return_qty, 0))
                ),
                0,
            ).label("profit"),
        )
        .select_from(return_source)
        .where(and_(*return_conds))
        .group_by(SalesReturn.date)
    )
    sales_by_date = {
        row.date: (
            float(row.taxable or 0),
            float(row.profit or 0),
            float(row.cost_covered or 0),
        )
        for row in sales_rows.fetchall()
    }
    returns_by_date = {
        row.date: (
            float(row.taxable or 0),
            float(row.profit or 0),
            float(row.cost_covered or 0),
        )
        for row in return_rows.fetchall()
    }
    rows = []
    day = period.start
    while day <= period.end:
        day_s = day.isoformat()
        sales_taxable, sales_profit, sales_cost_covered = sales_by_date.get(day_s, (0, 0, 0))
        returned_taxable, returned_profit, returned_cost_covered = returns_by_date.get(day_s, (0, 0, 0))
        rows.append({
            "date": day_s,
            "taxable_revenue": sales_taxable - returned_taxable,
            "profit": sales_profit - returned_profit,
            "cost_covered_revenue": sales_cost_covered - returned_cost_covered,
        })
        day += timedelta(days=1)
    return rows


async def _invoice_total_for_period(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> float:
    rows = await _daily_revenue_components(db, filters, allowed_branch_ids, period)
    return sum(row["sales"] for row in rows)


async def _sales_trend(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    revenue_rows = await _daily_revenue_components(db, filters, allowed_branch_ids, period)
    bills_conds = _invoice_conditions(filters, allowed_branch_ids, period)
    bills_result = await db.execute(
        select(SaleInvoice.date, func.count(SaleInvoice.id).label("bills"))
        .where(and_(*bills_conds))
        .group_by(SaleInvoice.date)
    )
    bills_by_date = {row.date: int(row.bills or 0) for row in bills_result.fetchall()}
    return [
        {**row, "bills": bills_by_date.get(row["date"], 0)}
        for row in revenue_rows
    ]


async def _revenue_vs_profit(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    revenue_rows = await _daily_revenue_components(db, filters, allowed_branch_ids, period)
    profit_rows = await _line_profit_by_day(db, filters, allowed_branch_ids, period)
    profit_by_date = {row["date"]: row["profit"] for row in profit_rows}
    return [
        {"date": row["date"], "revenue": row["sales"], "profit": profit_by_date.get(row["date"], 0)}
        for row in revenue_rows
    ]


async def _category_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    total_revenue: Optional[float] = None,
) -> list[dict]:
    sales_conds = _line_conditions(filters, allowed_branch_ids, period)
    sales_source, sales_amount = _sale_line_source()
    sales_amount = _tax_exclusive_sale_amount(sales_amount)
    sales_rows = await db.execute(
        select(
            func.coalesce(Category.name, "Uncategorized").label("category"),
            func.coalesce(func.sum(sales_amount), 0).label("revenue"),
        )
        .select_from(sales_source)
        .outerjoin(Category, Item.category_id == Category.id)
        .where(and_(*sales_conds))
        .group_by(Category.name)
    )
    return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
    return_source, return_amount = _return_line_source()
    return_amount = _tax_exclusive_return_amount(return_amount)
    return_rows = await db.execute(
        select(
            func.coalesce(Category.name, "Uncategorized").label("category"),
            func.coalesce(func.sum(return_amount), 0).label("returned"),
        )
        .select_from(return_source)
        .outerjoin(Category, Item.category_id == Category.id)
        .where(and_(*return_conds))
        .group_by(Category.name)
    )
    amounts = {row.category: float(row.revenue or 0) for row in sales_rows.fetchall()}
    labels = {category: category for category in amounts}
    for row in return_rows.fetchall():
        amounts[row.category] = amounts.get(row.category, 0) - float(row.returned or 0)
        labels[row.category] = row.category
    if total_revenue is None:
        total_revenue = await _invoice_total_for_period(db, filters, allowed_branch_ids, period)
    return _reconciled_mix(amounts, labels, total_revenue, "category")


async def _brand_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    total_revenue: Optional[float] = None,
) -> list[dict]:
    sales_conds = _line_conditions(filters, allowed_branch_ids, period)
    normalized_brand = func.lower(func.trim(func.coalesce(Item.brand, "")))
    normalized_brand = case((normalized_brand.in_(("", "unbranded")), ""), else_=normalized_brand)
    brand_label = func.min(func.nullif(func.trim(Item.brand), ""))
    sales_source, sales_amount = _sale_line_source()
    sales_amount = _tax_exclusive_sale_amount(sales_amount)
    sales_rows = await db.execute(
        select(
            normalized_brand.label("brand_key"),
            brand_label.label("brand"),
            func.coalesce(func.sum(sales_amount), 0).label("revenue"),
        )
        .select_from(sales_source)
        .where(and_(*sales_conds))
        .group_by(normalized_brand)
    )
    return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
    return_source, return_amount = _return_line_source()
    return_amount = _tax_exclusive_return_amount(return_amount)
    return_rows = await db.execute(
        select(
            normalized_brand.label("brand_key"),
            brand_label.label("brand"),
            func.coalesce(func.sum(return_amount), 0).label("returned"),
        )
        .select_from(return_source)
        .where(and_(*return_conds))
        .group_by(normalized_brand)
    )
    amounts = {}
    labels = {}
    for row in sales_rows.fetchall():
        brand_key = row.brand_key or ""
        amounts[brand_key] = float(row.revenue or 0)
        labels[brand_key] = row.brand if brand_key else "Unbranded"
    for row in return_rows.fetchall():
        brand_key = row.brand_key or ""
        amounts[brand_key] = amounts.get(brand_key, 0) - float(row.returned or 0)
        labels[brand_key] = row.brand if brand_key else "Unbranded"
    if total_revenue is None:
        total_revenue = await _invoice_total_for_period(db, filters, allowed_branch_ids, period)
    return _reconciled_mix(amounts, labels, total_revenue, "brand")


async def _top_products(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _line_conditions(filters, allowed_branch_ids, period)
    sales_source, sales_amount = _sale_line_source()
    sales_amount = _tax_exclusive_sale_amount(sales_amount)
    result = await db.execute(
        select(
            func.coalesce(SaleLineItem.item_id, SaleLineItem.name).label("product_id"),
            func.min(SaleLineItem.name).label("name"),
            func.coalesce(func.sum(SaleLineItem.qty), 0).label("qty"),
            func.coalesce(func.sum(sales_amount), 0).label("revenue"),
        )
        .select_from(sales_source)
        .where(and_(*conds))
        .group_by(func.coalesce(SaleLineItem.item_id, SaleLineItem.name))
        .order_by(desc("revenue"))
    )
    return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
    return_source, return_amount = _return_line_source()
    return_amount = _tax_exclusive_return_amount(return_amount)
    return_result = await db.execute(
        select(
            func.coalesce(SalesReturnLineItem.item_id, SalesReturnLineItem.name).label("product_id"),
            func.min(SalesReturnLineItem.name).label("name"),
            func.coalesce(func.sum(SalesReturnLineItem.return_qty), 0).label("qty"),
            func.coalesce(func.sum(return_amount), 0).label("revenue"),
        )
        .select_from(return_source)
        .where(and_(*return_conds))
        .group_by(func.coalesce(SalesReturnLineItem.item_id, SalesReturnLineItem.name))
    )
    items_by_product = {
        row.product_id: {
            "product_id": row.product_id,
            "name": row.name,
            "qty": float(row.qty or 0),
            "revenue": float(row.revenue or 0),
        }
        for row in result.fetchall()
    }
    for row in return_result.fetchall():
        item = items_by_product.setdefault(row.product_id, {
            "product_id": row.product_id,
            "name": row.name,
            "qty": 0.0,
            "revenue": 0.0,
        })
        item["qty"] -= float(row.qty or 0)
        item["revenue"] -= float(row.revenue or 0)
    items = list(items_by_product.values())
    items.sort(key=lambda item: item["revenue"], reverse=True)
    items = items[:limit]
    return _page(items, page_size=limit)


async def _top_customers(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    sales_source, sales_amount = _sale_line_source()
    sales_amount = _tax_exclusive_sale_amount(sales_amount)
    customer_key = func.coalesce(SaleInvoice.customer_id, "walk-in")
    customer_name = func.min(case(
        (SaleInvoice.customer_id.is_(None), "Walk-in"),
        else_=func.coalesce(SaleInvoice.customer_name, "Walk-in"),
    ))
    result = await db.execute(
        select(
            customer_key.label("customer_id"),
            customer_name.label("name"),
            func.count(distinct(SaleInvoice.id)).label("bill_count"),
            func.coalesce(func.sum(sales_amount), 0).label("revenue"),
        )
        .select_from(sales_source)
        .where(and_(*conds))
        .group_by(SaleInvoice.customer_id)
        .order_by(desc("revenue"))
    )
    return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
    return_source, return_amount = _return_line_source()
    return_amount = _tax_exclusive_return_amount(return_amount)
    return_rows = await db.execute(
        select(
            func.coalesce(SalesReturn.customer_id, "walk-in").label("customer_id"),
            func.coalesce(func.sum(return_amount), 0).label("revenue"),
        )
        .select_from(return_source)
        .where(and_(*return_conds))
        .group_by(SalesReturn.customer_id)
    )
    revenues = {}
    for row in return_rows.fetchall():
        revenues[row.customer_id] = float(row.revenue or 0)
    items = [
        {
            "customer_id": row.customer_id,
            "name": row.name,
            "bill_count": int(row.bill_count or 0),
            "revenue": float(row.revenue or 0) - revenues.get(row.customer_id, 0),
        }
        for row in result.fetchall()
    ]
    items.sort(key=lambda item: item["revenue"], reverse=True)
    items = items[:limit]
    return _page(items, page_size=limit)


async def _recent_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = (
        _line_conditions(filters, allowed_branch_ids, period)
        if filters.category_id
        else _invoice_conditions(filters, allowed_branch_ids, period)
    )
    if filters.cursor_date:
        try:
            cursor = datetime.fromisoformat(filters.cursor_date)
        except ValueError:
            raise HTTPException(400, "Invalid cursor_date")
        conds.append(SaleInvoice.created_at < cursor)
    if filters.category_id:
        sales_source, sales_amount = _sale_line_source()
        sales_amount = _tax_exclusive_sale_amount(sales_amount)
        result = await db.execute(
            select(
                SaleInvoice.id,
                SaleInvoice.number,
                SaleInvoice.customer_name,
                SaleInvoice.date,
                func.coalesce(func.sum(sales_amount), 0).label("total"),
                SaleInvoice.status,
            )
            .select_from(sales_source)
            .where(and_(*conds))
            .group_by(
                SaleInvoice.id,
                SaleInvoice.number,
                SaleInvoice.customer_name,
                SaleInvoice.date,
                SaleInvoice.status,
                SaleInvoice.created_at,
            )
            .order_by(desc(SaleInvoice.created_at), desc(SaleInvoice.id))
            .limit(limit)
        )
    else:
        result = await db.execute(
            select(
                SaleInvoice.id,
                SaleInvoice.number,
                SaleInvoice.customer_name,
                SaleInvoice.date,
                SaleInvoice.total,
                SaleInvoice.status,
            )
            .where(and_(*conds))
            .order_by(desc(SaleInvoice.created_at), desc(SaleInvoice.id))
            .limit(limit)
        )
    items = [
        {
            "id": row.id,
            "invoice_id": row.id,
            "number": row.number,
            "customer": row.customer_name or "Walk-in",
            "date": row.date,
            "total": float(row.total or 0),
            "status": row.status.value if hasattr(row.status, "value") else str(row.status),
        }
        for row in result.fetchall()
    ]
    return _page(items, page_size=limit)


async def _branch_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    conds = (
        _line_conditions(filters, allowed_branch_ids, period)
        if filters.category_id else _invoice_conditions(filters, allowed_branch_ids, period)
    )
    if filters.category_id:
        sales_source, sales_amount = _sale_line_source()
        sales_amount = _tax_exclusive_sale_amount(sales_amount)
        result = await db.execute(
            select(
                SaleInvoice.branch_id.label("branch_id"),
                func.coalesce(Branch.name, SaleInvoice.branch_name, SaleInvoice.branch_id).label("branch"),
                func.count(distinct(SaleInvoice.id)).label("transactions"),
                func.coalesce(func.sum(sales_amount), 0).label("sales"),
            )
            .select_from(sales_source)
            .outerjoin(Branch, SaleInvoice.branch_id == Branch.id)
            .where(and_(*conds))
            .group_by(Branch.name, SaleInvoice.branch_name, SaleInvoice.branch_id)
        )
    else:
        invoice_taxes = _invoice_tax_amounts()
        result = await db.execute(
            select(
                SaleInvoice.branch_id.label("branch_id"),
                func.coalesce(Branch.name, SaleInvoice.branch_name, SaleInvoice.branch_id).label("branch"),
                func.count(SaleInvoice.id).label("transactions"),
                func.coalesce(
                    func.sum(
                        func.coalesce(SaleInvoice.total, 0)
                        - func.coalesce(invoice_taxes.c.tax_amount, 0)
                    ),
                    0,
                ).label("sales"),
            )
            .select_from(SaleInvoice)
            .outerjoin(Branch, SaleInvoice.branch_id == Branch.id)
            .outerjoin(invoice_taxes, invoice_taxes.c.invoice_id == SaleInvoice.id)
            .where(and_(*conds))
            .group_by(Branch.name, SaleInvoice.branch_name, SaleInvoice.branch_id)
        )
    sales_by_branch = {
        row.branch_id: {
            "branch": row.branch,
            "transactions": int(row.transactions or 0),
            "sales": float(row.sales or 0),
        }
        for row in result.fetchall()
    }
    return_conds = _return_conditions(filters, allowed_branch_ids, period)
    if filters.category_id:
        return_conds = _return_line_conditions(filters, allowed_branch_ids, period)
        return_source, return_amount = _return_line_source()
        return_amount = _tax_exclusive_return_amount(return_amount)
        return_result = await db.execute(
            select(
                SalesReturn.branch_id,
                func.coalesce(func.sum(return_amount), 0).label("returned"),
            )
            .select_from(return_source)
            .where(and_(*return_conds))
            .group_by(SalesReturn.branch_id)
        )
    else:
        return_taxes = _return_tax_amounts()
        return_result = await db.execute(
            select(
                SalesReturn.branch_id,
                func.coalesce(
                    func.sum(
                        func.coalesce(SalesReturn.total, 0)
                        - func.coalesce(return_taxes.c.tax_amount, 0)
                    ),
                    0,
                ).label("returned"),
            )
            .outerjoin(return_taxes, return_taxes.c.return_id == SalesReturn.id)
            .where(and_(*return_conds))
            .group_by(SalesReturn.branch_id)
        )
    for row in return_result.fetchall():
        if row.branch_id not in sales_by_branch:
            branch_name = (
                await db.execute(select(Branch.name).where(Branch.id == row.branch_id))
            ).scalar_one_or_none()
            sales_by_branch[row.branch_id] = {
                "branch": branch_name or row.branch_id,
                "transactions": 0,
                "sales": 0.0,
            }
        sales_by_branch[row.branch_id]["sales"] -= float(row.returned or 0)
    return sorted(sales_by_branch.values(), key=lambda row: row["sales"], reverse=True)


def _shift_month(value: date, months: int) -> date:
    absolute_month = value.year * 12 + value.month - 1 + months
    year, month_index = divmod(absolute_month, 12)
    month = month_index + 1
    return date(year, month, min(value.day, monthrange(year, month)[1]))


def _sales_pulse_periods(today: date) -> dict[str, Period]:
    daily = Period(today, today)
    last_7_days = Period(today - timedelta(days=6), today)
    previous_7_days = Period(today - timedelta(days=13), today - timedelta(days=7))
    month_to_date = Period(today.replace(day=1), today)
    previous_month_start = _shift_month(month_to_date.start, -1)
    previous_month_end = min(
        previous_month_start + timedelta(days=today.day - 1),
        date(previous_month_start.year, previous_month_start.month, monthrange(
            previous_month_start.year, previous_month_start.month
        )[1]),
    )
    previous_month_to_date = Period(previous_month_start, previous_month_end)
    return {
        "daily_current": daily,
        "daily_previous": Period(today - timedelta(days=1), today - timedelta(days=1)),
        "weekly_current": last_7_days,
        "weekly_previous": previous_7_days,
        "monthly_current": month_to_date,
        "monthly_previous": previous_month_to_date,
    }


async def _sales_target_for_branches(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
) -> float:
    conditions = [Branch.active.is_(True)]
    branch_condition = _branch_condition(Branch.id, filters, allowed_branch_ids)
    if branch_condition is not None:
        conditions.append(branch_condition)
    result = await db.execute(
        select(func.coalesce(func.sum(Branch.monthly_sales_target), 0)).where(and_(*conditions))
    )
    return float(result.scalar() or 0)


async def _sales_dashboard_payload(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]] = None,
) -> dict:
    period = _parse_period(filters)
    pulse_periods = _sales_pulse_periods(business_today())
    pulse_values = {
        key: await _invoice_total_for_period(db, filters, allowed, pulse_period)
        for key, pulse_period in pulse_periods.items()
    }

    invoice_summary = await _invoice_summary(db, filters, allowed, period)
    previous_invoice_summary = await _invoice_summary(db, filters, allowed, period.previous)
    profit_summary = await _line_profit_summary(db, filters, allowed, period)
    previous_profit_summary = await _line_profit_summary(db, filters, allowed, period.previous)
    sales_trend = await _sales_trend(db, filters, allowed, period)
    revenue_profit = await _revenue_vs_profit(db, filters, allowed, period)
    branches = await _branch_sales(db, filters, allowed, period)
    category_sales_data = await _category_sales(
        db, filters, allowed, period, total_revenue=invoice_summary["revenue"]
    )
    brand_sales_data = await _brand_sales(
        db, filters, allowed, period, total_revenue=invoice_summary["revenue"]
    )
    top_products_data = await _top_products(db, filters, allowed, period)
    top_customers_data = await _top_customers(db, filters, allowed, period)
    recent_sales_data = await _recent_sales(db, filters, allowed, period)

    target = await _sales_target_for_branches(db, filters, allowed)

    return {
        "filters": _filters_dict(filters, period),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kpis": {
            "daily_sales": pulse_values["daily_current"],
            "weekly_sales": pulse_values["weekly_current"],
            "monthly_sales": pulse_values["monthly_current"],
            "total_revenue": invoice_summary["revenue"],
            "gross_revenue": invoice_summary["gross_revenue"],
            "returned_revenue": invoice_summary["returned_revenue"],
            "profit_margin": profit_summary["profit_margin"],
            "cost_coverage_pct": profit_summary["cost_coverage_pct"],
            "average_bill_value": invoice_summary["average_bill_value"],
            "median_bill_value": invoice_summary["median_bill_value"],
        },
        "deltas": {
            "daily_sales": _pct_delta(pulse_values["daily_current"], pulse_values["daily_previous"]),
            "weekly_sales": _pct_delta(pulse_values["weekly_current"], pulse_values["weekly_previous"]),
            "monthly_sales": _pct_delta(pulse_values["monthly_current"], pulse_values["monthly_previous"]),
            "total_revenue": _pct_delta(invoice_summary["revenue"], previous_invoice_summary["revenue"]),
            "profit_margin": (
                round(profit_summary["profit_margin"] - previous_profit_summary["profit_margin"], 1)
                if previous_profit_summary["profit_margin"] else None
            ),
            "average_bill_value": _pct_delta(invoice_summary["average_bill_value"], previous_invoice_summary["average_bill_value"]),
        },
        "delta_values": {
            "daily_sales": {
                "previous": pulse_values["daily_previous"],
                "current": pulse_values["daily_current"],
            },
            "weekly_sales": {
                "previous": pulse_values["weekly_previous"],
                "current": pulse_values["weekly_current"],
            },
            "monthly_sales": {
                "previous": pulse_values["monthly_previous"],
                "current": pulse_values["monthly_current"],
            },
            "total_revenue": {
                "previous": previous_invoice_summary["revenue"],
                "current": invoice_summary["revenue"],
            },
            "profit_margin": {
                "previous": previous_profit_summary["profit_margin"],
                "current": profit_summary["profit_margin"],
            },
            "average_bill_value": {
                "previous": previous_invoice_summary["average_bill_value"],
                "current": invoice_summary["average_bill_value"],
            },
        },
        "charts": {
            "sales_trend": sales_trend,
            "revenue_vs_profit": revenue_profit,
            "category_pie": category_sales_data,
            "brand_donut": brand_sales_data,
        },
        "analytics": {
            "target_vs_achievement": {
                "target": round(target, 2),
                "achieved": invoice_summary["revenue"],
                "achievement_pct": round((invoice_summary["revenue"] / target) * 100, 1) if target else 0,
                "target_period": "Full-month target; not prorated to the selected date range.",
            },
            "branch_wise_sales": branches,
        },
        "tables": {
            "top_products": top_products_data,
            "top_customers": top_customers_data,
            "recent_sales": recent_sales_data,
        },
    }


async def _inventory_payload(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]] = None) -> dict:
    period = _parse_period(filters)
    stock_conds = _stock_conditions(filters, allowed)

    if not _database_supports_materialized_views(db):
        summary = (
            await db.execute(
                select(
                    func.count(distinct(ItemStock.item_id)).label("products"),
                    func.coalesce(func.sum(ItemStock.quantity * func.coalesce(Item.cost_price, 0)), 0).label("inventory_value"),
                    func.coalesce(func.sum(case((ItemStock.quantity <= 0, 1), else_=0)), 0).label("out_of_stock"),
                    func.coalesce(func.sum(case((and_(ItemStock.quantity > 0, ItemStock.quantity <= Item.reorder_level), 1), else_=0)), 0).label("low_stock"),
                )
                .select_from(ItemStock)
                .join(Item, ItemStock.item_id == Item.id)
                .where(and_(*stock_conds))
            )
        ).one()
    else:
        snapshot_conds = _inventory_mv_conds(filters, allowed)
        summary = (
            await db.execute(
                select(
                    func.count(distinct(InventorySnapshot.item_id)).label("products"),
                    func.coalesce(func.sum(InventorySnapshot.inventory_value), 0).label("inventory_value"),
                    func.coalesce(func.sum(case((InventorySnapshot.quantity <= 0, 1), else_=0)), 0).label("out_of_stock"),
                    func.coalesce(func.sum(case((and_(InventorySnapshot.quantity > 0, InventorySnapshot.quantity <= InventorySnapshot.reorder_level), 1), else_=0)), 0).label("low_stock"),
                )
                .where(and_(*snapshot_conds))
            )
        ).one()

    current_stock = await _current_stock(db, filters, allowed, limit=20)
    low_stock = await _low_stock(db, filters, allowed, limit=500)
    out_of_stock = await _out_of_stock(db, filters, allowed, limit=500)
    dead_stock = await _dead_stock(db, filters, allowed, period, limit=500)
    expired = await _expired_batches(db, filters, allowed, limit=500)
    expiring_30_days = await _expiry_near(db, filters, allowed, limit=500)
    stock_by_category = await _stock_by_category(db, filters, allowed)
    moving = await _stock_movement_segments(db, filters, allowed, period)
    batch_movement = await _batch_movement(db, filters, allowed, period)
    products = int(summary.products or 0)

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "inventory_value": float(summary.inventory_value or 0),
            "products": products,
            "out_of_stock": int(summary.out_of_stock or 0),
            "low_stock": int(summary.low_stock or 0),
        },
        "deltas": {"inventory_value": None, "products": None, "out_of_stock": None, "low_stock": None},
        "charts": {
            "inventory_value_trend": [],
            "fast_vs_slow_moving": [
                {"segment": "Fast moving", "count": moving["fast_count"], "items": moving["fast_names"]},
                {"segment": "Slow moving", "count": moving["slow_count"], "items": moving["slow_names"]},
            ],
            "stock_by_category": stock_by_category,
        },
        "analytics": {
            "fifo_fefo": await _fifo_fefo(db, filters, allowed, expiring_30_days["total"]),
            "batch_movement": {**batch_movement, "dead_stock_skus": dead_stock["total"]},
        },
        "tables": {
            "current_stock": current_stock,
            "low_stock": low_stock,
            "out_of_stock": out_of_stock,
            "dead_stock": dead_stock,
            "expired": expired,
            "expiring_30_days": expiring_30_days,
            "expiry_near": expiring_30_days,
        },
    }


async def _current_stock(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], limit: int = 20) -> dict:
    if not _database_supports_materialized_views(db):
        conds = [Item.active == True]
        branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed)
        if branch_cond is not None:
            conds.append(branch_cond)
        if filters.category_id:
            conds.append(Item.category_id == filters.category_id)
        result = await db.execute(
            select(
                ItemStock.item_id,
                Item.name,
                func.coalesce(Branch.name, ItemStock.branch_id).label("branch"),
                ItemStock.quantity.label("qty"),
                (ItemStock.quantity * func.coalesce(Item.cost_price, 0)).label("value"),
            )
            .select_from(ItemStock)
            .join(Item, ItemStock.item_id == Item.id)
            .outerjoin(Branch, ItemStock.branch_id == Branch.id)
            .where(and_(*conds))
            .order_by(desc("value"))
            .limit(limit)
        )
    else:
        conds = _inventory_mv_conds(filters, allowed)
        result = await db.execute(
            select(
                InventorySnapshot.item_id,
                Item.name,
                func.coalesce(Branch.name, InventorySnapshot.branch_id).label("branch"),
                InventorySnapshot.quantity.label("qty"),
                InventorySnapshot.inventory_value.label("value"),
            )
            .select_from(InventorySnapshot)
            .join(Item, InventorySnapshot.item_id == Item.id)
            .outerjoin(Branch, InventorySnapshot.branch_id == Branch.id)
            .where(and_(*conds))
            .order_by(desc("value"))
            .limit(limit)
        )
    items = [
        {
            "item_id": row.item_id,
            "name": row.name,
            "branch": row.branch,
            "qty": int(row.qty or 0),
            "value": float(row.value or 0),
        }
        for row in result.fetchall()
    ]
    return _page(items, page_size=limit)


async def _stock_level_table(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    quantity_condition,
    limit: int,
) -> dict:
    conds = [Item.active == True, quantity_condition]
    branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.category_id:
        conds.append(Item.category_id == filters.category_id)
    total = int(
        (
            await db.execute(
                select(func.count(ItemStock.id))
                .select_from(ItemStock)
                .join(Item, ItemStock.item_id == Item.id)
                .where(and_(*conds))
            )
        ).scalar()
        or 0
    )
    result = await db.execute(
        select(
            ItemStock.item_id,
            Item.name,
            ItemStock.branch_id,
            func.coalesce(Branch.name, ItemStock.branch_id).label("branch"),
            ItemStock.quantity.label("qty"),
            Item.reorder_level,
        )
        .select_from(ItemStock)
        .join(Item, ItemStock.item_id == Item.id)
        .outerjoin(Branch, ItemStock.branch_id == Branch.id)
        .where(and_(*conds))
        .order_by(ItemStock.quantity.asc(), Item.name.asc(), ItemStock.branch_id.asc())
        .limit(limit)
    )
    items = [
        {
            "item_id": row.item_id,
            "name": row.name,
            "branch_id": row.branch_id,
            "branch": row.branch,
            "qty": float(row.qty or 0),
            "reorder_level": float(row.reorder_level or 0),
        }
        for row in result.fetchall()
    ]
    return _page(items, total=total, page_size=limit)


async def _low_stock(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    limit: int = 500,
) -> dict:
    return await _stock_level_table(
        db,
        filters,
        allowed,
        and_(ItemStock.quantity > 0, ItemStock.quantity <= Item.reorder_level),
        limit,
    )


async def _out_of_stock(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    limit: int = 500,
) -> dict:
    return await _stock_level_table(
        db,
        filters,
        allowed,
        ItemStock.quantity <= 0,
        limit,
    )


async def _stock_movement_segments(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> dict:
    stock_conds = [Item.active == True, ItemStock.quantity > 0]
    stock_branch = _branch_condition(ItemStock.branch_id, filters, allowed)
    if stock_branch is not None:
        stock_conds.append(stock_branch)
    if filters.category_id:
        stock_conds.append(Item.category_id == filters.category_id)

    sales_conds = [
        SaleLineItem.item_id == ItemStock.item_id,
        _valid_invoice_status(),
        SaleInvoice.date >= period.start_s,
        SaleInvoice.date <= period.end_s,
    ]
    sale_branch = _branch_condition(SaleInvoice.branch_id, filters, allowed)
    if sale_branch is not None:
        sales_conds.append(sale_branch)
    kam_cond = _kam_invoice_condition(filters.staff_id)
    if kam_cond is not None:
        sales_conds.append(kam_cond)
    has_sales = exists(
        select(1)
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
        .where(and_(*sales_conds))
    )

    fast_count = int(
        (
            await db.execute(
                select(func.count(distinct(ItemStock.item_id)))
                .select_from(ItemStock)
                .join(Item, ItemStock.item_id == Item.id)
                .where(and_(*stock_conds, has_sales))
            )
        ).scalar()
        or 0
    )
    slow_count = int(
        (
            await db.execute(
                select(func.count(distinct(ItemStock.item_id)))
                .select_from(ItemStock)
                .join(Item, ItemStock.item_id == Item.id)
                .where(and_(*stock_conds, ~has_sales))
            )
        ).scalar()
        or 0
    )

    stock_exists_conds = [ItemStock.item_id == SaleLineItem.item_id, ItemStock.quantity > 0, Item.active == True]
    stock_branch = _branch_condition(ItemStock.branch_id, filters, allowed)
    if stock_branch is not None:
        stock_exists_conds.append(stock_branch)
    if filters.category_id:
        stock_exists_conds.append(Item.category_id == filters.category_id)
    has_positive_stock = exists(
        select(1)
        .select_from(ItemStock)
        .join(Item, ItemStock.item_id == Item.id)
        .where(and_(*stock_exists_conds))
    )
    sold_conds = _line_conditions(filters, allowed, period)
    fast_rows = (
        await db.execute(
            select(Item.name)
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .join(Item, SaleLineItem.item_id == Item.id)
            .where(and_(*sold_conds, has_positive_stock))
            .group_by(Item.id, Item.name)
            .order_by(desc(func.sum(SaleLineItem.qty)))
            .limit(8)
        )
    ).fetchall()
    slow_rows = (
        await db.execute(
            select(Item.name)
            .select_from(ItemStock)
            .join(Item, ItemStock.item_id == Item.id)
            .where(and_(*stock_conds, ~has_sales))
            .group_by(Item.id, Item.name)
            .order_by(Item.name)
            .limit(8)
        )
    ).fetchall()
    return {
        "fast_count": fast_count,
        "slow_count": slow_count,
        "fast_names": [row.name for row in fast_rows if row.name],
        "slow_names": [row.name for row in slow_rows if row.name],
    }


async def _batch_movement(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> dict:
    batch_conds = [
        ItemBatch.received_date >= period.start_s,
        ItemBatch.received_date <= period.end_s,
        Item.active == True,
    ]
    batch_branch = _branch_condition(ItemBatch.branch_id, filters, allowed)
    if batch_branch is not None:
        batch_conds.append(batch_branch)
    if filters.category_id:
        batch_conds.append(Item.category_id == filters.category_id)
    received_batches = int(
        (
            await db.execute(
                select(func.count(ItemBatch.id))
                .select_from(ItemBatch)
                .join(Item, ItemBatch.item_id == Item.id)
                .where(and_(*batch_conds))
            )
        ).scalar()
        or 0
    )

    start_utc = datetime.combine(period.start, time.min, tzinfo=business_timezone()).astimezone(timezone.utc)
    end_utc = datetime.combine(period.end + timedelta(days=1), time.min, tzinfo=business_timezone()).astimezone(timezone.utc)
    movement_conds = [
        StockMovement.created_at >= start_utc.replace(tzinfo=None),
        StockMovement.created_at < end_utc.replace(tzinfo=None),
    ]
    movement_branch = _branch_condition(StockMovement.branch_id, filters, allowed)
    if movement_branch is not None:
        movement_conds.append(movement_branch)
    if filters.category_id:
        movement_conds.append(Item.category_id == filters.category_id)
    movement_counts = (
        await db.execute(
            select(
                func.count(StockMovement.id).label("total"),
                func.count(StockMovement.batch_id).label("batch_linked"),
                func.coalesce(func.sum(case((StockMovement.delta > 0, 1), else_=0)), 0).label("stock_in"),
                func.coalesce(func.sum(case((StockMovement.delta < 0, 1), else_=0)), 0).label("stock_out"),
                func.coalesce(
                    func.sum(case((and_(StockMovement.delta < 0, StockMovement.batch_id.is_not(None)), 1), else_=0)),
                    0,
                ).label("batch_consumed"),
            )
            .select_from(StockMovement)
            .join(Item, StockMovement.item_id == Item.id)
            .where(and_(*movement_conds))
        )
    ).one()
    return {
        "received_batches": received_batches,
        "consumed_batches": int(movement_counts.batch_consumed or 0),
        "stock_in_movements": int(movement_counts.stock_in or 0),
        "stock_out_movements": int(movement_counts.stock_out or 0),
        "movement_records": int(movement_counts.total or 0),
        "received_label": "Batches received",
        "received_tooltip": "Count of item_batches rows with received_date in the selected range.",
        "consumed_label": "Stock-out movement records",
        "consumed_tooltip": (
            "Count of stock_movements rows with a negative quantity delta in the selected range. "
            f"{int(movement_counts.batch_consumed or 0)} of these are linked to a batch."
        ),
        "dead_stock_skus": 0,
    }


async def _dead_stock(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    if not _database_supports_materialized_views(db):
        stock_conds = [Item.active == True, ItemStock.quantity > 0]
        branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed)
        if branch_cond is not None:
            stock_conds.append(branch_cond)
        if filters.category_id:
            stock_conds.append(Item.category_id == filters.category_id)
        sales_exists_conds = [
            SaleLineItem.item_id == ItemStock.item_id,
            _valid_invoice_status(),
            SaleInvoice.date >= period.start_s,
            SaleInvoice.date <= period.end_s,
        ]
        sale_branch_cond = _branch_condition(SaleInvoice.branch_id, filters, allowed)
        if sale_branch_cond is not None:
            sales_exists_conds.append(sale_branch_cond)
        kam_cond = _kam_invoice_condition(filters.staff_id)
        if kam_cond is not None:
            sales_exists_conds.append(kam_cond)
        sales_exists = exists(
            select(1)
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .where(and_(*sales_exists_conds))
        )
        result = await db.execute(
            select(
                ItemStock.item_id,
                Item.name,
                func.coalesce(func.sum(ItemStock.quantity), 0).label("qty"),
                func.coalesce(func.sum(ItemStock.quantity * func.coalesce(Item.cost_price, 0)), 0).label("value"),
            )
            .select_from(ItemStock)
            .join(Item, ItemStock.item_id == Item.id)
            .where(and_(*stock_conds, ~sales_exists))
            .group_by(ItemStock.item_id, Item.name)
            .order_by(desc("value"))
            .limit(limit)
        )
    else:
        stock_conds = _inventory_mv_conds(filters, allowed)
        sales_exists_conds = [
            SaleLineItem.item_id == InventorySnapshot.item_id,
            _valid_invoice_status(),
            SaleInvoice.date >= period.start_s,
            SaleInvoice.date <= period.end_s,
        ]
        sale_branch_cond = _branch_condition(SaleInvoice.branch_id, filters, allowed)
        if sale_branch_cond is not None:
            sales_exists_conds.append(sale_branch_cond)
        kam_cond = _kam_invoice_condition(filters.staff_id)
        if kam_cond is not None:
            sales_exists_conds.append(kam_cond)
        sales_exists = exists(
            select(1)
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .where(and_(*sales_exists_conds))
        )
        result = await db.execute(
            select(
                InventorySnapshot.item_id,
                Item.name,
                func.coalesce(func.sum(InventorySnapshot.quantity), 0).label("qty"),
                func.coalesce(func.sum(InventorySnapshot.inventory_value), 0).label("value"),
            )
            .select_from(InventorySnapshot)
            .join(Item, InventorySnapshot.item_id == Item.id)
            .where(and_(*stock_conds, InventorySnapshot.quantity > 0, ~sales_exists))
            .group_by(InventorySnapshot.item_id, Item.name)
            .order_by(desc("value"))
            .limit(limit)
        )
    items = [
        {"item_id": row.item_id, "name": row.name, "qty": int(row.qty or 0), "value": float(row.value or 0)}
        for row in result.fetchall()
    ]
    return _page(items, page_size=limit)


async def _expiry_batches(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    expired: bool,
    limit: int,
) -> dict:
    today = business_today()
    until = (today + timedelta(days=30)).isoformat()
    conds = [
        ItemBatch.quantity > 0,
        ItemBatch.active == True,
        ItemBatch.expiry_date != None,
        ItemBatch.expiry_date != "",
    ]
    if expired:
        conds.append(ItemBatch.expiry_date < today.isoformat())
    else:
        conds.extend([ItemBatch.expiry_date >= today.isoformat(), ItemBatch.expiry_date <= until])
    branch_cond = _branch_condition(ItemBatch.branch_id, filters, allowed)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.category_id:
        conds.append(Item.category_id == filters.category_id)
    total = int(
        (
            await db.execute(
                select(func.count(ItemBatch.id))
                .select_from(ItemBatch)
                .join(Item, ItemBatch.item_id == Item.id)
                .where(and_(*conds))
            )
        ).scalar()
        or 0
    )
    result = await db.execute(
        select(
            ItemBatch.id,
            Item.name,
            ItemBatch.batch_number,
            ItemBatch.expiry_date,
            ItemBatch.quantity.label("qty"),
        )
        .select_from(ItemBatch)
        .join(Item, ItemBatch.item_id == Item.id)
        .where(and_(*conds))
        .order_by(ItemBatch.expiry_date.asc())
        .limit(limit)
    )
    items = [
        {
            "id": row.id,
            "name": row.name,
            "batch_number": row.batch_number,
            "expiry_date": row.expiry_date,
            "qty": float(row.qty or 0),
        }
        for row in result.fetchall()
    ]
    return _page(items, total=total, page_size=limit)


async def _expiry_near(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    limit: int = 500,
) -> dict:
    return await _expiry_batches(db, filters, allowed, expired=False, limit=limit)


async def _expired_batches(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    limit: int = 500,
) -> dict:
    return await _expiry_batches(db, filters, allowed, expired=True, limit=limit)


async def _stock_by_category(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]]) -> list[dict]:
    if not _database_supports_materialized_views(db):
        conds = [Item.active == True]
        branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed)
        if branch_cond is not None:
            conds.append(branch_cond)
        if filters.category_id:
            conds.append(Item.category_id == filters.category_id)
        result = await db.execute(
            select(
                func.coalesce(Category.name, "Uncategorized").label("category"),
                func.coalesce(func.sum(ItemStock.quantity * func.coalesce(Item.cost_price, 0)), 0).label("value"),
            )
            .select_from(ItemStock)
            .join(Item, ItemStock.item_id == Item.id)
            .outerjoin(Category, Item.category_id == Category.id)
            .where(and_(*conds))
            .group_by(Category.name)
            .order_by(desc("value"))
            .limit(8)
        )
    else:
        conds = _inventory_mv_conds(filters, allowed)
        result = await db.execute(
            select(
                func.coalesce(Category.name, "Uncategorized").label("category"),
                func.coalesce(func.sum(InventorySnapshot.inventory_value), 0).label("value"),
            )
            .select_from(InventorySnapshot)
            .join(Item, InventorySnapshot.item_id == Item.id)
            .outerjoin(Category, Item.category_id == Category.id)
            .where(and_(*conds))
            .group_by(Category.name)
            .order_by(desc("value"))
            .limit(8)
        )
    rows = [
        {"category": row.category, "value": round(float(row.value or 0), 2)}
        for row in result.fetchall()
    ]
    total_value = round(float(
        (
            await db.execute(
                select(
                    func.coalesce(
                        func.sum(ItemStock.quantity * func.coalesce(Item.cost_price, 0)),
                        0,
                    )
                )
                .select_from(ItemStock)
                .join(Item, ItemStock.item_id == Item.id)
                .where(and_(*_stock_conditions(filters, allowed)))
            )
        ).scalar()
        or 0
    ), 2)
    other_value = round(total_value - sum(row["value"] for row in rows), 2)
    if other_value != 0:
        rows.append({"category": "Others", "value": other_value})
    return rows


async def _fifo_fefo(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], near_expiry_count: int = 0) -> dict:
    batch_conds = [Item.active == True, ItemBatch.quantity > 0, ItemBatch.active == True]
    branch_cond = _branch_condition(ItemBatch.branch_id, filters, allowed)
    if branch_cond is not None:
        batch_conds.append(branch_cond)
    if filters.category_id:
        batch_conds.append(Item.category_id == filters.category_id)
    row = (
        await db.execute(
            select(
                func.count(distinct(ItemBatch.item_id)).label("tracked_products"),
                func.count(ItemBatch.id).label("active_batches"),
                func.coalesce(func.sum(case((ItemBatch.expiry_date != None, 1), else_=0)), 0).label("expiry_batches"),
            )
            .select_from(ItemBatch)
            .join(Item, ItemBatch.item_id == Item.id)
            .where(and_(*batch_conds))
        )
    ).one()
    active_batches = int(row.active_batches or 0)
    expiry_batches = int(row.expiry_batches or 0)
    return {
        "tracked_products": int(row.tracked_products or 0),
        "active_batches": active_batches,
        "near_expiry_batches": near_expiry_count,
        "fefo_coverage": round((expiry_batches / active_batches) * 100, 1) if active_batches else 0,
    }


def _payment_mode_expr():
    mode = func.lower(func.trim(func.coalesce(CustomerPayment.payment_mode, "")))
    return case(
        (mode.in_(("bank_transfer", "bank transfer", "transfer")), "bank transfer"),
        (mode.in_(("cash", "card", "upi", "cheque", "credit")), mode),
        else_="other",
    )


def _payment_conditions(
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
):
    conds = [
        CustomerPayment.date >= period.start_s,
        CustomerPayment.date <= period.end_s,
        CustomerPayment.voided.is_(False),
    ]
    branch_cond = _branch_condition(CustomerPayment.branch_id, filters, allowed)
    if branch_cond is not None:
        conds.append(branch_cond)
    return conds


async def _payment_distribution(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> list[dict]:
    mode_expr = _payment_mode_expr()
    amount_expr = (
        CustomerPaymentAllocation.amount
        if filters.staff_id
        else CustomerPayment.total_amount
    )
    query = select(
        mode_expr.label("method"),
        func.coalesce(func.sum(amount_expr), 0).label("amount"),
    ).select_from(CustomerPayment)
    if filters.staff_id:
        query = query.join(
            CustomerPaymentAllocation,
            CustomerPaymentAllocation.payment_id == CustomerPayment.id,
        ).join(
            SaleInvoice,
            SaleInvoice.id == CustomerPaymentAllocation.invoice_id,
        ).where(_kam_invoice_condition(filters.staff_id))
    rows = await db.execute(
        query.where(and_(*_payment_conditions(filters, allowed, period)))
        .group_by(mode_expr)
    )
    amounts = {method: float(amount or 0) for method, amount in rows.fetchall()}
    methods = ("cash", "card", "upi", "cheque", "bank transfer", "credit")
    distribution = [
        {"method": method.upper(), "amount": amounts.get(method, 0)}
        for method in methods
    ]
    if amounts.get("other", 0) > 0:
        distribution.append({"method": "OTHER", "amount": amounts["other"]})
    return distribution


async def _tax_collected(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> float:
    _, _, invoice_tax = _tax_line_exprs(SaleLineItem.line_total, SaleLineItem.tax_rate)
    invoice_conds = _line_conditions(filters, allowed, period)
    invoice_tax_total = (
        await db.execute(
            select(func.coalesce(func.sum(invoice_tax), 0))
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .outerjoin(Item, SaleLineItem.item_id == Item.id)
            .where(and_(*invoice_conds))
        )
    ).scalar()

    _, _, return_tax = _tax_line_exprs(SalesReturnLineItem.line_total, SalesReturnLineItem.tax_rate)
    return_conds = _return_line_conditions(filters, allowed, period)
    return_tax_total = (
        await db.execute(
            select(func.coalesce(func.sum(return_tax), 0))
            .select_from(SalesReturnLineItem)
            .join(SalesReturn, SalesReturnLineItem.return_id == SalesReturn.id)
            .outerjoin(Item, SalesReturnLineItem.item_id == Item.id)
            .where(and_(*return_conds))
        )
    ).scalar()
    return round(float(invoice_tax_total or 0) - float(return_tax_total or 0), 2)


async def _billing_payload(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]] = None) -> dict:
    period = _parse_period(filters)
    conds = _invoice_conditions(filters, allowed, period)
    previous_conds = _invoice_conditions(filters, allowed, period.previous)

    payment_distribution = await _payment_distribution(db, filters, allowed, period)
    by_method = {row["method"].lower(): row["amount"] for row in payment_distribution}
    transfer_amount = by_method.get("bank transfer", 0)
    previous_transfer_amount = None

    outstanding_expr = _outstanding_amount_expr()

    async def get_pending_total():
        return float(
            (
                await db.execute(
                    select(func.coalesce(func.sum(outstanding_expr), 0)).where(
                        and_(*conds, outstanding_expr > 0)
                    )
                )
            ).scalar()
            or 0
        )

    async def get_previous_pending():
        return float(
            (
                await db.execute(
                    select(func.coalesce(func.sum(outstanding_expr), 0)).where(
                        and_(*previous_conds, outstanding_expr > 0)
                    )
                )
            ).scalar()
            or 0
        )

    previous_by_method = {}
    if not filters.category_id:
        previous_distribution = await _payment_distribution(db, filters, allowed, period.previous)
        previous_by_method = {row["method"].lower(): row["amount"] for row in previous_distribution}
        previous_transfer_amount = previous_by_method.get("bank transfer", 0)

    current = await _invoice_summary(db, filters, allowed, period)
    previous = await _invoice_summary(db, filters, allowed, period.previous)
    refunds = await _refund_summary(db, filters, allowed, period)
    previous_refunds = await _refund_summary(db, filters, allowed, period.previous)
    pending_total = await get_pending_total()
    previous_pending = await get_previous_pending()
    daily_count = await _daily_billing_count(db, filters, allowed, period)
    refund_trends = await _refund_trends(db, filters, allowed, period)
    pending_payments = await _pending_payments(db, filters, allowed, period)
    pending_invoice_count_result = await _pending_invoice_count(db, conds)
    recent_refunds = await _recent_refunds(db, filters, allowed, period)
    discounted_bills = await _discounted_bills(db, filters, allowed, period)
    tax_collected = await _tax_collected(db, filters, allowed, period)
    if filters.category_id:
        payment_distribution = None
        by_method = {}
        pending_total = None
        previous_pending = None
        current["collected"] = None
        previous["collected"] = None
        current["discount"] = None
        previous["discount"] = None
        refunds["credited_amount"] = None
        previous_refunds["credited_amount"] = None

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "cash": None if filters.category_id else by_method.get("cash", 0),
            "card": None if filters.category_id else by_method.get("card", 0),
            "upi": None if filters.category_id else by_method.get("upi", 0),
            "cheque": None if filters.category_id else by_method.get("cheque", 0),
            "transfer": None if filters.category_id else transfer_amount,
            "credit": None if filters.category_id else by_method.get("credit", 0),
            "other": None if filters.category_id else by_method.get("other", 0),
            "collected": current["collected"],
            "pending_payments": pending_total,
            "refunds": refunds["amount"],
            "credited_refunds": refunds["credited_amount"],
            "discounts": current["discount"],
            "tax_collected": tax_collected,
        },
        "deltas": {
            "cash": _pct_delta(
                None if filters.category_id else by_method.get("cash", 0),
                None if filters.category_id else previous_by_method.get("cash", 0),
            ),
            "card": _pct_delta(
                None if filters.category_id else by_method.get("card", 0),
                None if filters.category_id else previous_by_method.get("card", 0),
            ),
            "upi": _pct_delta(
                None if filters.category_id else by_method.get("upi", 0),
                None if filters.category_id else previous_by_method.get("upi", 0),
            ),
            "cheque": _pct_delta(
                None if filters.category_id else by_method.get("cheque", 0),
                None if filters.category_id else previous_by_method.get("cheque", 0),
            ),
            "transfer": _pct_delta(
                None if filters.category_id else transfer_amount,
                None if filters.category_id else previous_transfer_amount,
            ),
            "credit": _pct_delta(
                None if filters.category_id else by_method.get("credit", 0),
                None if filters.category_id else previous_by_method.get("credit", 0),
            ),
            "other": _pct_delta(
                None if filters.category_id else by_method.get("other", 0),
                None if filters.category_id else previous_by_method.get("other", 0),
            ),
            "pending_payments": _pct_delta(pending_total, previous_pending),
            "refunds": _pct_delta(refunds["amount"], previous_refunds["amount"]),
            "credited_refunds": _pct_delta(refunds["credited_amount"], previous_refunds["credited_amount"]),
            "discounts": _pct_delta(current["discount"], previous["discount"]),
        },
        "delta_values": {
            "cash": {
                "previous": None if filters.category_id else previous_by_method.get("cash", 0),
                "current": None if filters.category_id else by_method.get("cash", 0),
            },
            "card": {
                "previous": None if filters.category_id else previous_by_method.get("card", 0),
                "current": None if filters.category_id else by_method.get("card", 0),
            },
            "upi": {
                "previous": None if filters.category_id else previous_by_method.get("upi", 0),
                "current": None if filters.category_id else by_method.get("upi", 0),
            },
            "cheque": {
                "previous": None if filters.category_id else previous_by_method.get("cheque", 0),
                "current": None if filters.category_id else by_method.get("cheque", 0),
            },
            "transfer": {
                "previous": None if filters.category_id else previous_transfer_amount,
                "current": None if filters.category_id else transfer_amount,
            },
            "credit": {
                "previous": None if filters.category_id else previous_by_method.get("credit", 0),
                "current": None if filters.category_id else by_method.get("credit", 0),
            },
            "other": {
                "previous": None if filters.category_id else previous_by_method.get("other", 0),
                "current": None if filters.category_id else by_method.get("other", 0),
            },
            "pending_payments": {
                "previous": previous_pending,
                "current": pending_total,
            },
            "refunds": {
                "previous": previous_refunds["amount"],
                "current": refunds["amount"],
            },
            "credited_refunds": {
                "previous": previous_refunds["credited_amount"],
                "current": refunds["credited_amount"],
            },
            "discounts": {
                "previous": previous["discount"],
                "current": current["discount"],
            },
        },
        "charts": {
            "payment_distribution": payment_distribution,
            "refund_trends": refund_trends,
            "daily_billing_count": daily_count,
        },
        "analytics": {
            "collection_efficiency": (
                None if filters.category_id else _collection_efficiency(
                    current["collected"],
                    refunds["credited_amount"],
                    current["revenue_including_tax"],
                )
            ),
            "refund_percentage": round((refunds["amount"] / current["gross_revenue"]) * 100, 1) if current["gross_revenue"] else 0,
            "pending_invoice_count": pending_invoice_count_result,
        },
        "tables": {
            "pending_payments": pending_payments,
            "recent_refunds": recent_refunds,
            "discounted_bills": discounted_bills,
        },
    }


async def _refund_summary(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> dict:
    amount, credited_amount = await _returned_revenue(db, filters, allowed, period)
    count = (
        await db.execute(
            select(func.count(SalesReturn.id)).where(and_(*_return_conditions(filters, allowed, period)))
        )
    ).scalar()
    return {
        "amount": amount,
        "credited_amount": credited_amount,
        "count": int(count or 0),
    }


async def _refund_trends(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> list[dict]:
    conds = _return_conditions(filters, allowed, period)
    if filters.category_id:
        conds = _return_line_conditions(filters, allowed, period)
        return_source, return_amount = _return_line_source()
        returned_result = await db.execute(
            select(
                SalesReturn.date.label("date"),
                func.coalesce(func.sum(return_amount), 0).label("refunds"),
            )
            .select_from(return_source)
            .where(and_(*conds))
            .group_by(SalesReturn.date)
        )
    else:
        returned_result = await db.execute(
            select(SalesReturn.date.label("date"), func.coalesce(func.sum(SalesReturn.total), 0).label("refunds"))
            .where(and_(*conds))
            .group_by(SalesReturn.date)
        )
    credited_result = None
    if not filters.category_id:
        credited_result = await db.execute(
            select(SalesReturn.date.label("date"), func.coalesce(func.sum(SalesReturn.credited_amount), 0).label("credited"))
            .where(and_(*conds))
            .group_by(SalesReturn.date)
        )
    refund_by_date = {row.date: float(row.refunds or 0) for row in returned_result.fetchall()}
    credited_by_date = (
        {row.date: float(row.credited or 0) for row in credited_result.fetchall()}
        if credited_result is not None
        else {}
    )

    trend_end = min(period.end, business_today())
    if trend_end < period.start:
        return [{
            "date": period.start_s,
            "refunds": 0,
            "credited_refunds": 0 if credited_result is not None else None,
        }]

    rows = []
    day = period.start
    while day <= trend_end:
        day_key = day.isoformat()
        rows.append({
            "date": day_key,
            "refunds": refund_by_date.get(day_key, 0),
            "credited_refunds": credited_by_date.get(day_key, 0) if credited_result is not None else None,
        })
        day += timedelta(days=1)
    return rows


async def _recent_refunds(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _return_conditions(filters, allowed, period)
    total = int(
        (
            await db.execute(
                select(func.count(SalesReturn.id)).where(and_(*conds))
            )
        ).scalar()
        or 0
    )
    if filters.category_id:
        conds = _return_line_conditions(filters, allowed, period)
        return_source, return_amount = _return_line_source()
        result = await db.execute(
            select(
                SalesReturn.id,
                SalesReturn.number,
                SalesReturn.invoice_number,
                SalesReturn.customer_name,
                SalesReturn.date,
                SalesReturn.credited_amount,
                func.coalesce(func.sum(return_amount), 0).label("amount"),
            )
            .select_from(return_source)
            .where(and_(*conds))
            .group_by(SalesReturn.id)
            .order_by(desc(SalesReturn.created_at), desc(SalesReturn.id))
            .limit(limit)
        )
    else:
        result = await db.execute(
            select(
                SalesReturn.id,
                SalesReturn.number,
                SalesReturn.invoice_number,
                SalesReturn.customer_name,
                SalesReturn.date,
                SalesReturn.credited_amount,
                SalesReturn.total.label("amount"),
            )
            .where(and_(*conds))
            .order_by(desc(SalesReturn.created_at), desc(SalesReturn.id))
            .limit(limit)
        )
    items = [
        {
            "id": row.id,
            "number": row.number,
            "invoice_number": row.invoice_number,
            "customer": row.customer_name or "Walk-in",
            "amount": float(row.amount or 0),
            "credited_amount": (
                float(row.credited_amount or 0) if not filters.category_id else None
            ),
            "date": row.date,
        }
        for row in result.fetchall()
    ]
    return _page(items, total=total, page_size=limit)


async def _daily_billing_count(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], period: Period) -> list[dict]:
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(DailySalesSummary, filters, allowed)
        conds.extend([DailySalesSummary.sale_date >= period.start, DailySalesSummary.sale_date <= period.end])
        result = await db.execute(
            select(DailySalesSummary.sale_date.label("date"), func.coalesce(func.sum(DailySalesSummary.bill_count), 0).label("count"))
            .where(and_(*conds))
            .group_by(DailySalesSummary.sale_date)
            .order_by(DailySalesSummary.sale_date)
        )
    else:
        conds = _invoice_conditions(filters, allowed, period)
        result = await db.execute(
            select(SaleInvoice.date, func.count(SaleInvoice.id).label("count"))
            .where(and_(*conds))
            .group_by(SaleInvoice.date)
            .order_by(SaleInvoice.date)
        )
    return [{"date": row.date, "count": int(row.count or 0)} for row in result.fetchall()]


async def _pending_invoice_count(db: AsyncSession, conds: list) -> int:
    outstanding_expr = _outstanding_amount_expr()
    value = (
        await db.execute(
            select(func.count(SaleInvoice.id)).where(and_(*conds, outstanding_expr > 0))
        )
    ).scalar()
    return int(value or 0)


async def _pending_payments(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _invoice_conditions(filters, allowed, period)
    outstanding_expr = _outstanding_amount_expr()
    today_s = business_today().isoformat()
    result = await db.execute(
        select(SaleInvoice)
        .where(and_(*conds, outstanding_expr > 0))
        .order_by(desc(SaleInvoice.created_at))
        .limit(limit)
    )
    items = [
        {
            "id": inv.id,
            "number": inv.number,
            "customer": inv.customer_name or "Walk-in",
            "balance": (
                None
                if filters.category_id
                else max(0.0, float(inv.total or 0) - float(inv.paid_amount or 0) - float(inv.credited_amount or 0))
            ),
            "date": inv.date,
            "due_date": inv.due_date,
            "overdue": bool(inv.due_date and inv.due_date < today_s),
        }
        for inv in result.scalars().all()
    ]
    return _page(items, page_size=limit)


async def _discounted_bills(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    if filters.category_id:
        conds = _line_conditions(filters, allowed, period)
        sales_source, sales_amount = _sale_line_source()
        result = await db.execute(
            select(
                SaleInvoice.id,
                SaleInvoice.number,
                SaleInvoice.customer_name,
                func.sum(sales_amount).label("total"),
            )
            .select_from(sales_source)
            .where(and_(*conds, SaleInvoice.discount > 0))
            .group_by(
                SaleInvoice.id,
                SaleInvoice.number,
                SaleInvoice.customer_name,
                SaleInvoice.created_at,
            )
            .order_by(desc(SaleInvoice.created_at))
            .limit(limit)
        )
        items = [
            {
                "id": row.id,
                "number": row.number,
                "customer": row.customer_name or "Walk-in",
                "discount": None,
                "total": float(row.total or 0),
            }
            for row in result.fetchall()
        ]
    else:
        conds = _invoice_conditions(filters, allowed, period)
        result = await db.execute(
            select(SaleInvoice)
            .where(and_(*conds, SaleInvoice.discount > 0))
            .order_by(desc(SaleInvoice.discount), desc(SaleInvoice.created_at))
            .limit(limit)
        )
        items = [
            {
                "id": inv.id,
                "number": inv.number,
                "customer": inv.customer_name or "Walk-in",
                "discount": float(inv.discount or 0),
                "total": float(inv.total or 0),
            }
            for inv in result.scalars().all()
        ]
    return _page(items, page_size=limit)


async def _operations_payload(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]] = None) -> dict:
    period = _parse_period(filters)
    today_period = Period(business_today(), business_today())
    yesterday = business_today() - timedelta(days=1)
    yesterday_period = Period(yesterday, yesterday)

    # Helper coroutine for today's count
    async def get_today_count():
        return int(
            (
                await db.execute(
                    select(func.count(SaleInvoice.id)).where(and_(*_invoice_conditions(filters, allowed, today_period)))
                )
            ).scalar()
            or 0
        )

    today_count = await get_today_count()
    yesterday_count = int(
        (
            await db.execute(
                select(func.count(SaleInvoice.id)).where(
                    and_(*_invoice_conditions(filters, allowed, yesterday_period))
                )
            )
        ).scalar()
        or 0
    )
    staff_sales = await _staff_sales(db, filters, allowed, period)
    branch_performance = await _branch_sales(db, filters, allowed, period)
    heatmap = await _hourly_heatmap(db, filters, allowed, period)
    summary = await _invoice_summary(db, filters, allowed, period)
    activity_logs = await _activity_logs(db, filters, period, allowed)

    best_staff = staff_sales[0]["staff"] if staff_sales else "—"
    best_branch = branch_performance[0]["branch"] if branch_performance else "—"
    peak = max(heatmap, key=lambda row: row["value"], default=None)
    staff_count = max(1, len(staff_sales))
    bills_per_staff_per_day = (
        summary["bill_count"] / max(1, period.days * staff_count)
    )

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "daily_transactions": today_count,
            "peak_sales_hour": peak["hour"] if peak else "—",
            "best_branch": best_branch,
            "best_staff": best_staff,
        },
        "deltas": {"daily_transactions": _pct_delta(today_count, yesterday_count)},
        "delta_values": {
            "daily_transactions": {
                "previous": yesterday_count,
                "current": today_count,
            },
        },
        "charts": {
            "staff_sales": staff_sales,
            "hourly_heatmap": heatmap,
            "branch_performance": branch_performance,
        },
        "analytics": {
            "productivity": round(bills_per_staff_per_day, 2),
            "bills_per_staff_per_day": round(bills_per_staff_per_day, 2),
            "bills_per_staff": round(summary["bill_count"] / staff_count, 1),
            "revenue_per_bill": summary["average_bill_value"],
        },
        "tables": {
            "staff_performance": _page(staff_sales, page_size=len(staff_sales) or 20),
            "branch_rankings": _page(branch_performance, page_size=len(branch_performance) or 20),
            "recent_logs": activity_logs,
        },
    }


async def _staff_sales(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], period: Period) -> list[dict]:
    conds = _line_conditions(filters, allowed, period)
    sales_source, sales_amount = _sale_line_source()
    sales_amount = _tax_exclusive_sale_amount(sales_amount)
    sales_source, staff_key, staff_label = _kam_resolution_source(sales_source)
    result = await db.execute(
        select(
            staff_key.label("kam_key"),
            func.min(staff_label).label("staff"),
            func.count(distinct(SaleInvoice.id)).label("bill_count"),
            func.coalesce(func.sum(sales_amount), 0).label("sales"),
        )
        .select_from(sales_source)
        .where(and_(*conds))
        .group_by(staff_key)
    )
    staff_sales = {
        row.kam_key: {
            "kam_key": row.kam_key,
            "staff": row.staff,
            "bill_count": int(row.bill_count or 0),
            "sales": float(row.sales or 0),
        }
        for row in result.fetchall()
    }

    return_conds = _return_line_conditions(filters, allowed, period)
    return_source, return_amount = _return_line_source()
    return_amount = _tax_exclusive_return_amount(return_amount)
    return_source = return_source.join(SaleInvoice.__table__, SaleInvoice.id == SalesReturn.invoice_id)
    return_source, return_staff_key, return_staff_label = _kam_resolution_source(return_source)
    return_result = await db.execute(
        select(
            return_staff_key.label("kam_key"),
            func.min(return_staff_label).label("staff"),
            func.coalesce(func.sum(return_amount), 0).label("returned"),
        )
        .select_from(return_source)
        .where(and_(*return_conds))
        .group_by(return_staff_key)
    )
    for row in return_result.fetchall():
        staff = staff_sales.setdefault(
            row.kam_key,
            {"kam_key": row.kam_key, "staff": row.staff, "bill_count": 0, "sales": 0.0},
        )
        staff["sales"] -= float(row.returned or 0)
    return sorted(staff_sales.values(), key=lambda row: row["sales"], reverse=True)


def _kam_snapshot_values():
    return (
        func.nullif(func.trim(SaleInvoice.customer_key_account_manager_snapshot), ""),
        func.nullif(func.trim(SaleInvoice.customer_key_account_manager_name_snapshot), ""),
    )


def _kam_resolution_source(source):
    raw_snapshot, name_snapshot = _kam_snapshot_values()
    candidate_name = func.coalesce(name_snapshot, raw_snapshot)
    raw_user = aliased(User, name="kam_raw_user")
    named_user = aliased(User, name="kam_name_user")
    normalized_user_names = (
        select(
            func.lower(func.trim(User.name)).label("normalized_name"),
            func.count(User.id).label("user_count"),
            func.min(User.id).label("user_id"),
            func.min(User.name).label("user_name"),
        )
        .group_by(func.lower(func.trim(User.name)))
        .cte("dashboard_kam_names")
    )
    raw_is_unknown_uuid = and_(
        _kam_uuid_shaped(raw_snapshot),
        raw_user.id.is_(None),
    )
    source = source.outerjoin(raw_user, raw_user.id == raw_snapshot)
    source = source.outerjoin(named_user, named_user.id == name_snapshot)
    source = source.outerjoin(
        normalized_user_names,
        and_(
            ~raw_is_unknown_uuid,
            func.lower(func.trim(candidate_name))
            == normalized_user_names.c.normalized_name,
        ),
    )
    identity_name = case(
        (raw_is_unknown_uuid, raw_snapshot),
        else_=candidate_name,
    )
    resolved_user_id = func.coalesce(
        raw_user.id,
        case((~raw_is_unknown_uuid, named_user.id), else_=None),
        case(
            (
                and_(
                    ~raw_is_unknown_uuid,
                    normalized_user_names.c.user_count == 1,
                ),
                normalized_user_names.c.user_id,
            ),
            else_=None,
        ),
    )
    resolved_user_name = func.coalesce(
        raw_user.name,
        case((~raw_is_unknown_uuid, named_user.name), else_=None),
        case(
            (
                and_(
                    ~raw_is_unknown_uuid,
                    normalized_user_names.c.user_count == 1,
                ),
                normalized_user_names.c.user_name,
            ),
            else_=None,
        ),
    )
    identity = case(
        (resolved_user_id.is_not(None), literal("user:") + resolved_user_id),
        (
            identity_name.is_not(None),
            literal("name:") + func.lower(func.trim(identity_name)),
        ),
        else_="unassigned",
    )
    has_uuid_snapshot = or_(
        _kam_uuid_shaped(raw_snapshot),
        _kam_uuid_shaped(name_snapshot),
    )
    display = func.coalesce(
        resolved_user_name,
        case(
            (
                and_(resolved_user_id.is_(None), has_uuid_snapshot),
                "Unknown KAM",
            ),
            else_=candidate_name,
        ),
        "Unassigned",
    )
    return source, identity, display


async def _hourly_heatmap(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> list[dict]:
    conds = _invoice_conditions(filters, allowed, period)
    if filters.category_id:
        sales_conds = _line_conditions(filters, allowed, period)
        sales_source, sales_amount = _sale_line_source()
        result = await db.execute(
            select(SaleInvoice.created_at, sales_amount.label("amount"))
            .select_from(sales_source)
            .where(and_(*sales_conds))
        )
        return_conds = _return_line_conditions(filters, allowed, period)
        return_source, return_amount = _return_line_source()
        return_amount = _tax_exclusive_return_amount(return_amount)
        return_result = await db.execute(
            select(SalesReturn.created_at, return_amount.label("amount"))
            .select_from(return_source)
            .where(and_(*return_conds))
        )
        entries = [(created_at, float(amount or 0)) for created_at, amount in result.fetchall()]
        entries.extend(
            (created_at, -float(amount or 0))
            for created_at, amount in return_result.fetchall()
        )
    else:
        sales_source, sales_amount = _sale_line_source()
        sales_amount = _tax_exclusive_sale_amount(sales_amount)
        result = await db.execute(
            select(
                SaleInvoice.created_at,
                sales_amount,
            )
            .select_from(sales_source)
            .where(and_(*conds))
        )
        entries = [(created_at, float(amount or 0)) for created_at, amount in result.fetchall()]
    names = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
    values: dict[tuple[int, int], float] = {}
    tz = business_timezone()
    for created_at, amount in entries:
        if created_at is None:
            continue
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        local_time = created_at.astimezone(tz)
        key = (local_time.weekday(), local_time.hour)
        values[key] = values.get(key, 0) + amount
    return [
        {"day": names[weekday], "hour": f"{hour:02d}:00", "value": value}
        for (weekday, hour), value in sorted(values.items())
    ]


async def _activity_logs(
    db: AsyncSession,
    filters: DashboardFilters,
    period: Period,
    allowed_branch_ids: Optional[list[str]],
    limit: int = 20,
) -> dict:
    tz = business_timezone()
    start_dt = datetime.combine(period.start, time.min, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
    end_dt = (
        datetime.combine(period.end + timedelta(days=1), time.min, tzinfo=tz)
        .astimezone(timezone.utc)
        .replace(tzinfo=None)
    )
    conds = [AuditLog.created_at >= start_dt, AuditLog.created_at < end_dt]
    branch_cond = _branch_condition(AuditLog.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.cursor_date:
        try:
            cursor = datetime.fromisoformat(filters.cursor_date)
        except ValueError:
            raise HTTPException(400, "Invalid cursor_date")
        conds.append(AuditLog.created_at < cursor)
    result = await db.execute(
        select(AuditLog)
        .where(and_(*conds))
        .order_by(desc(AuditLog.created_at), desc(AuditLog.id))
        .limit(limit)
    )
    items = [
        {
            "id": log.id,
            "created_at": log.created_at.isoformat(timespec="minutes") if log.created_at else "",
            "module": log.module or "",
            "detail": log.detail or log.action,
            "risk": log.risk,
        }
        for log in result.scalars().all()
    ]
    return _page(items, page_size=limit)


@router.get("/filters")
async def dashboard_filters(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    allowed = await _resolve_branch_scope(user, db)
    branch_query = select(Branch).where(Branch.active == True).order_by(Branch.name)
    if allowed is not None:
        if allowed:
            branch_query = branch_query.where(Branch.id.in_(allowed))
        else:
            branch_query = branch_query.where(Branch.id == "__no_branch_access__")
    branches = (await db.execute(branch_query)).scalars().all()
    staff_options = await _kam_staff_options(db, filters, allowed, _parse_period(filters))
    categories = (await db.execute(select(Category).order_by(Category.name))).scalars().all()
    return {
        "branches": [{"id": branch.id, "name": branch.name} for branch in branches],
        "staff": staff_options,
        "categories": [{"id": category.id, "name": category.name} for category in categories],
    }


@router.get("/summary")
async def dashboard_summary(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    total_revenue = await _invoice_total_for_period(db, filters, allowed, period)
    return {
        "filters": _filters_dict(filters, period),
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "cache_key": _cache_key("summary", PUBLIC_DASHBOARD_USER_ID, _filters_dict(filters, period)),
        "total_revenue": total_revenue,
    }


@router.get("/sales")
async def sales_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _cached_dashboard_payload(
        "sales",
        user.id,
        _filters_dict(filters, period),
        ttl_seconds=120,
        loader=lambda: _sales_dashboard_payload(db, filters, allowed=allowed),
        allowed_branch_ids=allowed,
        bypass_cache=filters.refresh,
    )


@router.get("/inventory")
async def inventory_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _cached_dashboard_payload(
        "inventory",
        user.id,
        _filters_dict(filters, period),
        ttl_seconds=300,
        loader=lambda: _inventory_payload(db, filters, allowed=allowed),
        allowed_branch_ids=allowed,
        bypass_cache=filters.refresh,
    )


@router.get("/billing")
async def billing_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _cached_dashboard_payload(
        "billing",
        user.id,
        _filters_dict(filters, period),
        ttl_seconds=120,
        loader=lambda: _billing_payload(db, filters, allowed=allowed),
        allowed_branch_ids=allowed,
        bypass_cache=filters.refresh,
    )


@router.get("/operations")
async def operations_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _cached_dashboard_payload(
        "operations",
        user.id,
        _filters_dict(filters, period),
        ttl_seconds=120,
        loader=lambda: _operations_payload(db, filters, allowed=allowed),
        allowed_branch_ids=allowed,
        bypass_cache=filters.refresh,
    )


@router.get("/sales/top-products")
async def sales_top_products(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _top_products(db, filters, allowed, period, limit=filters.limit)


@router.get("/sales/recent-sales")
async def sales_recent_sales(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _recent_sales(db, filters, allowed, period, limit=filters.limit)


@router.get("/inventory/low-stock")
async def inventory_low_stock(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    allowed = await _resolve_branch_scope(user, db)
    return await _low_stock(db, filters, allowed, limit=filters.limit)


@router.get("/inventory/expiry-near")
async def inventory_expiry_near(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    allowed = await _resolve_branch_scope(user, db)
    return await _expiry_near(db, filters, allowed, limit=filters.limit)


@router.get("/billing/pending-payments")
async def billing_pending_payments(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _pending_payments(db, filters, allowed, period, limit=filters.limit)


@router.get("/operations/activity-logs")
async def operations_activity_logs(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    period = _parse_period(filters)
    allowed = await _resolve_branch_scope(user, db)
    return await _activity_logs(db, filters, period, allowed, limit=filters.limit)


@router.post("/export")
async def export_dashboard(
    payload: DashboardExportRequest,
):
    digest = _cache_key(payload.tab, PUBLIC_DASHBOARD_USER_ID, payload.filters)
    return {
        "job_id": f"exp_{uuid.uuid4().hex[:12]}",
        "status": "queued",
        "cache_key": digest,
        "format": payload.format,
    }


def _cache_key(scope: str, user_id: str, filters: dict) -> str:
    raw = json.dumps(filters or {}, sort_keys=True, default=str)
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"dashboard:{scope}:{user_id}:{digest}"


def invalidate_dashboard_cache_for_user(user_id: str) -> None:
    keys_to_remove = [key for key in _DASHBOARD_CACHE if key.split(':')[2] == user_id]
    for key in keys_to_remove:
        _DASHBOARD_CACHE.pop(key, None)
        _DASHBOARD_REFRESH_GUARD.pop(key, None)


async def _cached_dashboard_payload(
    scope: str,
    user_id: str,
    filters: dict,
    ttl_seconds: int,
    loader,
    allowed_branch_ids: Optional[list[str]] = None,
    bypass_cache: bool = False,
):
    cache_filters = {
        **(filters or {}),
        "permitted_branch_ids": (
            None
            if allowed_branch_ids is None
            else sorted(set(allowed_branch_ids))
        ),
    }
    key = _cache_key(scope, user_id, cache_filters)
    now = datetime.utcnow()
    cached = _DASHBOARD_CACHE.get(key)

    def cached_response(hit: bool, refresh_throttled: bool = False):
        response = dict(cached[1])
        response["cache"] = {
            "key": key,
            "hit": hit,
            "ttl_seconds": ttl_seconds,
        }
        if refresh_throttled:
            response["cache"]["refresh_throttled"] = True
        return response

    async def load_and_cache():
        loaded = await loader()
        stored_at = datetime.utcnow()
        loaded["generated_at"] = datetime.now(timezone.utc).isoformat()
        loaded["cache"] = {"key": key, "hit": False, "ttl_seconds": ttl_seconds}
        _DASHBOARD_CACHE[key] = (
            stored_at + timedelta(seconds=ttl_seconds),
            loaded,
        )
        return loaded

    if bypass_cache:
        lock = _DASHBOARD_REFRESH_LOCKS.setdefault(key, asyncio.Lock())
        async with lock:
            now = datetime.utcnow()
            cached = _DASHBOARD_CACHE.get(key)
            last_refresh = _DASHBOARD_REFRESH_GUARD.get(key)
            if (
                cached
                and last_refresh
                and now - last_refresh < _DASHBOARD_REFRESH_INTERVAL
            ):
                return cached_response(hit=True, refresh_throttled=True)
            payload = await load_and_cache()
            _DASHBOARD_REFRESH_GUARD[key] = datetime.utcnow()
            return payload

    if cached and cached[0] > now:
        return cached_response(hit=True)
    return await load_and_cache()

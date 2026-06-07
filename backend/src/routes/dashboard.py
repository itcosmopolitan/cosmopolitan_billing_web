import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, desc, distinct, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src import config
from src.database import get_db
from src.date_utils import MAX_DASHBOARD_DATE_RANGE_DAYS, parse_date_range
from src.models import (
    AuditLog,
    Branch,
    Category,
    DailySalesSummary,
    InvoiceStatus,
    InventorySnapshot,
    Item,
    ItemBatch,
    ItemStock,
    PaymentSummary,
    ProductSalesSummary,
    PurchaseBill,
    PurchaseLineItem,
    RefundSummary,
    SaleInvoice,
    SaleLineItem,
    StaffPerformanceSummary,
    User,
    UserBranch,
)
router = APIRouter()
logger = logging.getLogger("cosmopolitan.dashboard")
_DASHBOARD_CACHE: dict[str, tuple[datetime, dict]] = {}
PUBLIC_DASHBOARD_USER_ID = "public"


class DashboardFilters:
    def __init__(
        self,
        from_date: Optional[str] = Query(None, alias="from"),
        to: Optional[str] = Query(None),
        branch_id: Optional[str] = None,
        staff_id: Optional[str] = None,
        category_id: Optional[str] = None,
        limit: int = Query(20, ge=1, le=500),
        cursor_date: Optional[str] = None,
    ):
        self.from_date = from_date if isinstance(from_date, str) else None
        self.to = to if isinstance(to, str) else None
        self.branch_id = branch_id if isinstance(branch_id, str) else None
        self.staff_id = staff_id if isinstance(staff_id, str) else None
        self.category_id = category_id if isinstance(category_id, str) else None
        self.limit = limit if isinstance(limit, int) else 20
        self.cursor_date = cursor_date if isinstance(cursor_date, str) else None


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


def _parse_period(filters: DashboardFilters) -> Period:
    today = date.today()
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


def _pct_delta(current: float, previous: float) -> float:
    if not previous:
        return 100.0 if current else 0.0
    return round(((current - previous) / abs(previous)) * 100, 1)


def _status_not_cancelled():
    return SaleInvoice.status != InvoiceStatus.cancelled


def _filters_dict(filters: DashboardFilters, period: Period) -> dict:
    payload = {
        "from": period.start_s,
        "to": period.end_s,
    }
    for key in ("branch_id", "staff_id", "category_id"):
        value = getattr(filters, key)
        if value:
            payload[key] = value
    return payload


async def _allowed_branch_ids(db: AsyncSession, user: User) -> Optional[list[str]]:
    if getattr(user, "all_branches", False):
        return None
    result = await db.execute(select(UserBranch.branch_id).where(UserBranch.user_id == user.id))
    ids = [row[0] for row in result.fetchall()]
    if ids:
        return ids
    if user.branch_id:
        return [user.branch_id]
    return []


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


def _invoice_conditions(
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    *,
    include_status: bool = True,
):
    conds = [SaleInvoice.date >= period.start_s, SaleInvoice.date <= period.end_s]
    if include_status:
        conds.append(_status_not_cancelled())
    branch_cond = _branch_condition(SaleInvoice.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.staff_id:
        conds.append(SaleInvoice.cashier == filters.staff_id)
    if filters.category_id:
        conds.append(
            exists(
                select(1)
                .select_from(SaleLineItem)
                .join(Item, SaleLineItem.item_id == Item.id)
                .where(
                    and_(
                        SaleLineItem.invoice_id == SaleInvoice.id,
                        Item.category_id == filters.category_id,
                    )
                )
            )
        )
    return conds


def _line_conditions(filters: DashboardFilters, allowed_branch_ids: Optional[list[str]], period: Period):
    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    if filters.category_id:
        conds.append(Item.category_id == filters.category_id)
    return conds


def _database_supports_materialized_views(db: AsyncSession) -> bool:
    dialect = db.bind.dialect.name if getattr(db, "bind", None) is not None else "sqlite"
    try:
        use_read_models = bool(config.get().dashboard_use_materialized_views)
    except RuntimeError:
        use_read_models = False
    return use_read_models and dialect == "postgresql"


def _can_use_sales_mvs(db: AsyncSession, filters: DashboardFilters) -> bool:
    return _database_supports_materialized_views(db) and filters.category_id is None


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
    conds = []
    branch_cond = _branch_condition(InventorySnapshot.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        conds.append(branch_cond)
    if filters.category_id:
        conds.append(InventorySnapshot.category_id == filters.category_id)
    return conds


async def _invoice_summary(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> dict:
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(DailySalesSummary, filters, allowed_branch_ids)
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(DailySalesSummary.revenue), 0).label("revenue"),
                    func.coalesce(func.sum(DailySalesSummary.collected), 0).label("collected"),
                    func.coalesce(func.sum(DailySalesSummary.discount), 0).label("discount"),
                    func.coalesce(func.avg(DailySalesSummary.average_bill_value), 0).label("average_bill_value"),
                    func.coalesce(func.sum(DailySalesSummary.bill_count), 0).label("bill_count"),
                )
                .where(and_(*conds, DailySalesSummary.sale_date >= period.start, DailySalesSummary.sale_date <= period.end))
            )
        ).one()
        return {
            "revenue": float(row.revenue or 0),
            "collected": float(row.collected or 0),
            "discount": float(row.discount or 0),
            "average_bill_value": float(row.average_bill_value or 0),
            "bill_count": int(row.bill_count or 0),
        }

    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(SaleInvoice.total), 0).label("revenue"),
                func.coalesce(func.sum(SaleInvoice.paid_amount), 0).label("collected"),
                func.coalesce(func.sum(SaleInvoice.discount), 0).label("discount"),
                func.coalesce(func.avg(SaleInvoice.total), 0).label("average_bill_value"),
                func.count(SaleInvoice.id).label("bill_count"),
            ).where(and_(*conds))
        )
    ).one()
    return {
        "revenue": float(row.revenue or 0),
        "collected": float(row.collected or 0),
        "discount": float(row.discount or 0),
        "average_bill_value": float(row.average_bill_value or 0),
        "bill_count": int(row.bill_count or 0),
    }


async def _line_profit_summary(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> dict:
    if not _database_supports_materialized_views(db):
        conds = _line_conditions(filters, allowed_branch_ids, period)
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(SaleLineItem.line_total), 0).label("line_revenue"),
                    func.coalesce(
                        func.sum(
                            SaleLineItem.line_total
                            - (func.coalesce(Item.cost_price, 0) * SaleLineItem.qty)
                        ),
                        0,
                    ).label("profit"),
                )
                .select_from(SaleLineItem)
                .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
                .outerjoin(Item, SaleLineItem.item_id == Item.id)
                .where(and_(*conds))
            )
        ).one()
    else:
        conds = [
            ProductSalesSummary.sale_date >= period.start,
            ProductSalesSummary.sale_date <= period.end,
        ]
        conds.extend(_mv_conds(ProductSalesSummary, filters, allowed_branch_ids))
        if filters.category_id:
            conds.append(ProductSalesSummary.category_id == filters.category_id)
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(ProductSalesSummary.revenue), 0).label("line_revenue"),
                    func.coalesce(func.sum(ProductSalesSummary.profit), 0).label("profit"),
                )
                .where(and_(*conds))
            )
        ).one()
    line_revenue = float(row.line_revenue or 0)
    profit = float(row.profit or 0)
    return {
        "line_revenue": line_revenue,
        "profit": profit,
        "profit_margin": round((profit / line_revenue) * 100, 1) if line_revenue else 0,
    }


async def _invoice_total_for_period(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> float:
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(DailySalesSummary, filters, allowed_branch_ids)
        conds.append(DailySalesSummary.sale_date >= period.start)
        conds.append(DailySalesSummary.sale_date <= period.end)
        value = (
            await db.execute(
                select(func.coalesce(func.sum(DailySalesSummary.revenue), 0)).where(and_(*conds))
            )
        ).scalar()
        return float(value or 0)

    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    value = (
        await db.execute(
            select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(and_(*conds))
        )
    ).scalar()
    return float(value or 0)


async def _sales_trend(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(DailySalesSummary, filters, allowed_branch_ids)
        conds.extend([DailySalesSummary.sale_date >= period.start, DailySalesSummary.sale_date <= period.end])
        result = await db.execute(
            select(
                DailySalesSummary.sale_date,
                func.coalesce(func.sum(DailySalesSummary.revenue), 0).label("sales"),
                func.coalesce(func.sum(DailySalesSummary.bill_count), 0).label("bills"),
            )
            .where(and_(*conds))
            .group_by(DailySalesSummary.sale_date)
            .order_by(DailySalesSummary.sale_date)
        )
        return [
            {"date": row.sale_date, "sales": float(row.sales or 0), "bills": int(row.bills or 0)}
            for row in result.fetchall()
        ]

    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    result = await db.execute(
        select(
            SaleInvoice.date,
            func.coalesce(func.sum(SaleInvoice.total), 0).label("sales"),
            func.count(SaleInvoice.id).label("bills"),
        )
        .where(and_(*conds))
        .group_by(SaleInvoice.date)
        .order_by(SaleInvoice.date)
    )
    return [
        {"date": row.date, "sales": float(row.sales or 0), "bills": int(row.bills or 0)}
        for row in result.fetchall()
    ]


async def _revenue_vs_profit(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if not _database_supports_materialized_views(db):
        conds = _line_conditions(filters, allowed_branch_ids, period)
        result = await db.execute(
            select(
                SaleInvoice.date.label("date"),
                func.coalesce(func.sum(SaleLineItem.line_total), 0).label("revenue"),
                func.coalesce(
                    func.sum(
                        SaleLineItem.line_total
                        - (func.coalesce(Item.cost_price, 0) * SaleLineItem.qty)
                    ),
                    0,
                ).label("profit"),
            )
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .outerjoin(Item, SaleLineItem.item_id == Item.id)
            .where(and_(*conds))
            .group_by(SaleInvoice.date)
            .order_by(SaleInvoice.date)
        )
    else:
        conds = [
            ProductSalesSummary.sale_date >= period.start,
            ProductSalesSummary.sale_date <= period.end,
        ]
        conds.extend(_mv_conds(ProductSalesSummary, filters, allowed_branch_ids))
        if filters.category_id:
            conds.append(ProductSalesSummary.category_id == filters.category_id)
        result = await db.execute(
            select(
                ProductSalesSummary.sale_date.label("date"),
                func.coalesce(func.sum(ProductSalesSummary.revenue), 0).label("revenue"),
                func.coalesce(func.sum(ProductSalesSummary.profit), 0).label("profit"),
            )
            .where(and_(*conds))
            .group_by(ProductSalesSummary.sale_date)
            .order_by(ProductSalesSummary.sale_date)
        )
    return [
        {"date": row.date, "revenue": float(row.revenue or 0), "profit": float(row.profit or 0)}
        for row in result.fetchall()
    ]


async def _category_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if not _database_supports_materialized_views(db):
        conds = _line_conditions(filters, allowed_branch_ids, period)
        result = await db.execute(
            select(
                func.coalesce(Category.name, "Uncategorized").label("category"),
                func.coalesce(func.sum(SaleLineItem.line_total), 0).label("revenue"),
            )
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .outerjoin(Item, SaleLineItem.item_id == Item.id)
            .outerjoin(Category, Item.category_id == Category.id)
            .where(and_(*conds))
            .group_by(Category.name)
            .order_by(desc("revenue"))
            .limit(8)
        )
    else:
        conds = [
            ProductSalesSummary.sale_date >= period.start,
            ProductSalesSummary.sale_date <= period.end,
        ]
        conds.extend(_mv_conds(ProductSalesSummary, filters, allowed_branch_ids))
        if filters.category_id:
            conds.append(ProductSalesSummary.category_id == filters.category_id)
        result = await db.execute(
            select(
                func.coalesce(Category.name, "Uncategorized").label("category"),
                func.coalesce(func.sum(ProductSalesSummary.revenue), 0).label("revenue"),
            )
            .select_from(ProductSalesSummary)
            .outerjoin(Category, ProductSalesSummary.category_id == Category.id)
            .where(and_(*conds))
            .group_by(Category.name)
            .order_by(desc("revenue"))
            .limit(8)
        )
    return [{"category": row.category, "revenue": float(row.revenue or 0)} for row in result.fetchall()]


async def _brand_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if not _database_supports_materialized_views(db):
        conds = _line_conditions(filters, allowed_branch_ids, period)
        result = await db.execute(
            select(
                func.coalesce(Item.brand, "Unbranded").label("brand"),
                func.coalesce(func.sum(SaleLineItem.line_total), 0).label("revenue"),
            )
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .outerjoin(Item, SaleLineItem.item_id == Item.id)
            .where(and_(*conds))
            .group_by(Item.brand)
            .order_by(desc("revenue"))
            .limit(8)
        )
    else:
        conds = [
            ProductSalesSummary.sale_date >= period.start,
            ProductSalesSummary.sale_date <= period.end,
        ]
        conds.extend(_mv_conds(ProductSalesSummary, filters, allowed_branch_ids))
        if filters.category_id:
            conds.append(ProductSalesSummary.category_id == filters.category_id)
        result = await db.execute(
            select(
                func.coalesce(ProductSalesSummary.brand, "Unbranded").label("brand"),
                func.coalesce(func.sum(ProductSalesSummary.revenue), 0).label("revenue"),
            )
            .where(and_(*conds))
            .group_by(ProductSalesSummary.brand)
            .order_by(desc("revenue"))
            .limit(8)
        )
    return [{"brand": row.brand or "Unbranded", "revenue": float(row.revenue or 0)} for row in result.fetchall()]


async def _top_products(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    if not _database_supports_materialized_views(db):
        conds = _line_conditions(filters, allowed_branch_ids, period)
        result = await db.execute(
            select(
                func.coalesce(SaleLineItem.item_id, SaleLineItem.name).label("product_id"),
                SaleLineItem.name.label("name"),
                func.coalesce(func.sum(SaleLineItem.qty), 0).label("qty"),
                func.coalesce(func.sum(SaleLineItem.line_total), 0).label("revenue"),
            )
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .outerjoin(Item, SaleLineItem.item_id == Item.id)
            .where(and_(*conds))
            .group_by(SaleLineItem.item_id, SaleLineItem.name)
            .order_by(desc("revenue"))
            .limit(limit)
        )
    else:
        conds = [
            ProductSalesSummary.sale_date >= period.start,
            ProductSalesSummary.sale_date <= period.end,
        ]
        conds.extend(_mv_conds(ProductSalesSummary, filters, allowed_branch_ids))
        if filters.category_id:
            conds.append(ProductSalesSummary.category_id == filters.category_id)
        result = await db.execute(
            select(
                func.coalesce(ProductSalesSummary.item_id, ProductSalesSummary.product_name).label("product_id"),
                ProductSalesSummary.product_name.label("name"),
                func.coalesce(func.sum(ProductSalesSummary.quantity_sold), 0).label("qty"),
                func.coalesce(func.sum(ProductSalesSummary.revenue), 0).label("revenue"),
            )
            .where(and_(*conds))
            .group_by(ProductSalesSummary.item_id, ProductSalesSummary.product_name)
            .order_by(desc("revenue"))
            .limit(limit)
        )
    items = [
        {
            "product_id": row.product_id,
            "name": row.name,
            "qty": int(row.qty or 0),
            "revenue": float(row.revenue or 0),
        }
        for row in result.fetchall()
    ]
    return _page(items, page_size=limit)


async def _top_customers(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    result = await db.execute(
        select(
            func.coalesce(SaleInvoice.customer_id, SaleInvoice.customer_name).label("customer_id"),
            func.coalesce(SaleInvoice.customer_name, "Walk-in").label("name"),
            func.count(SaleInvoice.id).label("bill_count"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("revenue"),
        )
        .where(and_(*conds))
        .group_by(SaleInvoice.customer_id, SaleInvoice.customer_name)
        .order_by(desc("revenue"))
        .limit(limit)
    )
    items = [
        {
            "customer_id": row.customer_id,
            "name": row.name,
            "bill_count": int(row.bill_count or 0),
            "revenue": float(row.revenue or 0),
        }
        for row in result.fetchall()
    ]
    return _page(items, page_size=limit)


async def _recent_sales(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _invoice_conditions(filters, allowed_branch_ids, period)
    if filters.cursor_date:
        try:
            cursor = datetime.fromisoformat(filters.cursor_date)
        except ValueError:
            raise HTTPException(400, "Invalid cursor_date")
        conds.append(SaleInvoice.created_at < cursor)
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
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(DailySalesSummary, filters, allowed_branch_ids)
        result = await db.execute(
            select(
                func.coalesce(Branch.name, DailySalesSummary.branch_id).label("branch"),
                func.coalesce(func.sum(DailySalesSummary.bill_count), 0).label("transactions"),
                func.coalesce(func.sum(DailySalesSummary.revenue), 0).label("sales"),
            )
            .select_from(DailySalesSummary)
            .outerjoin(Branch, DailySalesSummary.branch_id == Branch.id)
            .where(and_(*conds, DailySalesSummary.sale_date >= period.start, DailySalesSummary.sale_date <= period.end))
            .group_by(Branch.name, DailySalesSummary.branch_id)
            .order_by(desc("sales"))
        )
    else:
        conds = _invoice_conditions(filters, allowed_branch_ids, period)
        result = await db.execute(
            select(
                func.coalesce(Branch.name, SaleInvoice.branch_name, SaleInvoice.branch_id).label("branch"),
                func.count(SaleInvoice.id).label("transactions"),
                func.coalesce(func.sum(SaleInvoice.total), 0).label("sales"),
            )
            .select_from(SaleInvoice)
            .outerjoin(Branch, SaleInvoice.branch_id == Branch.id)
            .where(and_(*conds))
            .group_by(Branch.name, SaleInvoice.branch_name, SaleInvoice.branch_id)
            .order_by(desc("sales"))
        )
    return [
        {
            "branch": row.branch,
            "transactions": int(row.transactions or 0),
            "sales": float(row.sales or 0),
        }
        for row in result.fetchall()
    ]


async def _period_sales_totals(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed_branch_ids: Optional[list[str]],
    period: Period,
) -> tuple[float, float, float]:
    end = period.end
    weekly_start = max(period.start, end - timedelta(days=6))
    monthly_start = max(period.start, end.replace(day=1))
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(DailySalesSummary, filters, allowed_branch_ids)
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(DailySalesSummary.revenue).filter(DailySalesSummary.sale_date == end), 0).label("daily_sales"),
                    func.coalesce(
                        func.sum(DailySalesSummary.revenue)
                        .filter(DailySalesSummary.sale_date >= weekly_start)
                        .filter(DailySalesSummary.sale_date <= end),
                        0,
                    ).label("weekly_sales"),
                    func.coalesce(
                        func.sum(DailySalesSummary.revenue)
                        .filter(DailySalesSummary.sale_date >= monthly_start)
                        .filter(DailySalesSummary.sale_date <= end),
                        0,
                    ).label("monthly_sales"),
                )
                .where(and_(*conds))
            )
        ).one()
        return float(row.daily_sales or 0), float(row.weekly_sales or 0), float(row.monthly_sales or 0)

    fallback_conds = [
        SaleInvoice.date >= monthly_start.isoformat(),
        SaleInvoice.date <= end.isoformat(),
        _status_not_cancelled(),
    ]
    branch_cond = _branch_condition(SaleInvoice.branch_id, filters, allowed_branch_ids)
    if branch_cond is not None:
        fallback_conds.append(branch_cond)
    if filters.staff_id:
        fallback_conds.append(SaleInvoice.cashier == filters.staff_id)
    if filters.category_id:
        fallback_conds.append(
            exists(
                select(1)
                .select_from(SaleLineItem)
                .join(Item, SaleLineItem.item_id == Item.id)
                .where(
                    and_(
                        SaleLineItem.invoice_id == SaleInvoice.id,
                        Item.category_id == filters.category_id,
                    )
                )
            )
        )
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(SaleInvoice.total).filter(SaleInvoice.date == end.isoformat()), 0).label("daily_sales"),
                func.coalesce(
                    func.sum(SaleInvoice.total)
                    .filter(SaleInvoice.date >= weekly_start.isoformat())
                    .filter(SaleInvoice.date <= end.isoformat()),
                    0,
                ).label("weekly_sales"),
                func.coalesce(
                    func.sum(SaleInvoice.total)
                    .filter(SaleInvoice.date >= monthly_start.isoformat())
                    .filter(SaleInvoice.date <= end.isoformat()),
                    0,
                ).label("monthly_sales"),
            )
            .where(and_(*fallback_conds))
        )
    ).one()
    return float(row.daily_sales or 0), float(row.weekly_sales or 0), float(row.monthly_sales or 0)


async def _sales_dashboard_payload(
    db: AsyncSession,
    filters: DashboardFilters,
) -> dict:
    period = _parse_period(filters)
    allowed = None
    daily_sales, weekly_sales, monthly_sales = await _period_sales_totals(db, filters, allowed, period)

    invoice_summary = await _invoice_summary(db, filters, allowed, period)
    previous_invoice_summary = await _invoice_summary(db, filters, allowed, period.previous)
    profit_summary = await _line_profit_summary(db, filters, allowed, period)
    previous_profit_summary = await _line_profit_summary(db, filters, allowed, period.previous)
    sales_trend = await _sales_trend(db, filters, allowed, period)
    revenue_profit = await _revenue_vs_profit(db, filters, allowed, period)
    branches = await _branch_sales(db, filters, allowed, period)
    category_sales_data = await _category_sales(db, filters, allowed, period)
    brand_sales_data = await _brand_sales(db, filters, allowed, period)
    top_products_data = await _top_products(db, filters, allowed, period)
    top_customers_data = await _top_customers(db, filters, allowed, period)
    recent_sales_data = await _recent_sales(db, filters, allowed, period)

    target = max(invoice_summary["revenue"] * 1.12, previous_invoice_summary["revenue"] * 1.1, 1)

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "daily_sales": daily_sales,
            "weekly_sales": weekly_sales,
            "monthly_sales": monthly_sales,
            "total_revenue": invoice_summary["revenue"],
            "profit_margin": profit_summary["profit_margin"],
            "average_bill_value": invoice_summary["average_bill_value"],
        },
        "deltas": {
            "daily_sales": 0,
            "weekly_sales": 0,
            "monthly_sales": 0,
            "total_revenue": _pct_delta(invoice_summary["revenue"], previous_invoice_summary["revenue"]),
            "profit_margin": _pct_delta(profit_summary["profit_margin"], previous_profit_summary["profit_margin"]),
            "average_bill_value": _pct_delta(invoice_summary["average_bill_value"], previous_invoice_summary["average_bill_value"]),
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
            },
            "branch_wise_sales": branches,
        },
        "tables": {
            "top_products": top_products_data,
            "top_customers": top_customers_data,
            "recent_sales": recent_sales_data,
        },
    }


async def _inventory_payload(db: AsyncSession, filters: DashboardFilters) -> dict:
    period = _parse_period(filters)
    allowed = None
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
    low_stock = await _low_stock(db, filters, allowed, limit=20)
    dead_stock = await _dead_stock(db, filters, allowed, period, limit=20)
    expiry_near = await _expiry_near(db, filters, allowed, limit=20)
    stock_by_category = await _stock_by_category(db, filters, allowed)
    sold_item_count = await _sold_item_count(db, filters, allowed, period)
    inventory_value_trend = await _inventory_value_trend(db, filters, allowed, period)
    products = int(summary.products or 0)

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "inventory_value": float(summary.inventory_value or 0),
            "products": products,
            "out_of_stock": int(summary.out_of_stock or 0),
            "low_stock": int(summary.low_stock or 0),
        },
        "deltas": {"inventory_value": 0, "products": 0, "out_of_stock": 0, "low_stock": 0},
        "charts": {
            "inventory_value_trend": inventory_value_trend,
            "fast_vs_slow_moving": [
                {"segment": "Fast moving", "count": sold_item_count},
                {"segment": "Slow moving", "count": max(0, products - sold_item_count)},
            ],
            "stock_by_category": stock_by_category,
        },
        "analytics": {
            "fifo_fefo": await _fifo_fefo(db, filters, allowed, expiry_near["total"]),
            "batch_movement": {
                "received_batches": expiry_near["total"],
                "consumed_batches": sold_item_count,
                "dead_stock_skus": dead_stock["total"],
            },
        },
        "tables": {
            "current_stock": current_stock,
            "low_stock": low_stock,
            "dead_stock": dead_stock,
            "expiry_near": expiry_near,
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


async def _low_stock(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], limit: int = 20) -> dict:
    if not _database_supports_materialized_views(db):
        conds = [Item.active == True]
        branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed)
        if branch_cond is not None:
            conds.append(branch_cond)
        if filters.category_id:
            conds.append(Item.category_id == filters.category_id)
        conds.append(ItemStock.quantity <= Item.reorder_level)
        result = await db.execute(
            select(
                ItemStock.item_id.label("item_id"),
                Item.name,
                ItemStock.quantity.label("qty"),
                Item.reorder_level,
            )
            .select_from(ItemStock)
            .join(Item, ItemStock.item_id == Item.id)
            .where(and_(*conds))
            .order_by(ItemStock.quantity.asc(), Item.name.asc())
            .limit(limit)
        )
    else:
        conds = _inventory_mv_conds(filters, allowed)
        conds.append(InventorySnapshot.quantity <= InventorySnapshot.reorder_level)
        result = await db.execute(
            select(
                InventorySnapshot.item_id.label("item_id"),
                Item.name,
                InventorySnapshot.quantity.label("qty"),
                InventorySnapshot.reorder_level,
            )
            .select_from(InventorySnapshot)
            .join(Item, InventorySnapshot.item_id == Item.id)
            .where(and_(*conds))
            .order_by(InventorySnapshot.quantity.asc(), Item.name.asc())
            .limit(limit)
        )
    items = [
        {"item_id": row.item_id, "name": row.name, "qty": int(row.qty or 0), "reorder_level": int(row.reorder_level or 0)}
        for row in result.fetchall()
    ]
    return _page(items, page_size=limit)


async def _sold_item_count(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> int:
    conds = _line_conditions(filters, allowed, period)
    result = await db.execute(
        select(func.count(distinct(SaleLineItem.item_id)))
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
        .outerjoin(Item, SaleLineItem.item_id == Item.id)
        .where(and_(*conds, SaleLineItem.item_id != None))
    )
    return int(result.scalar() or 0)


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
        sales_exists = exists(
            select(1)
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .where(
                and_(
                    SaleLineItem.item_id == ItemStock.item_id,
                    SaleInvoice.status != InvoiceStatus.cancelled,
                    SaleInvoice.date >= period.start_s,
                    SaleInvoice.date <= period.end_s,
                    *(_branch_condition(SaleInvoice.branch_id, filters, allowed) is not None and [
                        _branch_condition(SaleInvoice.branch_id, filters, allowed)
                    ] or []),
                    *(filters.staff_id and [SaleInvoice.cashier == filters.staff_id] or []),
                )
            )
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
        sales_exists = exists(
            select(1)
            .select_from(SaleLineItem)
            .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
            .where(
                and_(
                    SaleLineItem.item_id == InventorySnapshot.item_id,
                    SaleInvoice.status != InvoiceStatus.cancelled,
                    SaleInvoice.date >= period.start_s,
                    SaleInvoice.date <= period.end_s,
                    *(_branch_condition(SaleInvoice.branch_id, filters, allowed) is not None and [
                        _branch_condition(SaleInvoice.branch_id, filters, allowed)
                    ] or []),
                    *(filters.staff_id and [SaleInvoice.cashier == filters.staff_id] or []),
                )
            )
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


async def _expiry_near(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], limit: int = 20) -> dict:
    today = date.today()
    until = (today + timedelta(days=30)).isoformat()
    conds = [ItemBatch.quantity > 0, ItemBatch.expiry_date != None, ItemBatch.expiry_date != "", ItemBatch.expiry_date <= until]
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
            "qty": int(row.qty or 0),
        }
        for row in result.fetchall()
    ]
    return _page(items, total=total, page_size=limit)


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
    return [{"category": row.category, "value": float(row.value or 0)} for row in result.fetchall()]


async def _inventory_value_trend(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if not _database_supports_materialized_views(db):
        snapshot_conds = [Item.active == True]
        branch_cond = _branch_condition(ItemStock.branch_id, filters, allowed)
        if branch_cond is not None:
            snapshot_conds.append(branch_cond)
        if filters.category_id:
            snapshot_conds.append(Item.category_id == filters.category_id)
        current_value = float(
            (
                await db.execute(
                    select(func.coalesce(func.sum(ItemStock.quantity * func.coalesce(Item.cost_price, 0)), 0))
                    .select_from(ItemStock)
                    .join(Item, ItemStock.item_id == Item.id)
                    .where(and_(*snapshot_conds))
                )
            ).scalar()
            or 0
        )
    else:
        snapshot_conds = _inventory_mv_conds(filters, allowed)
        current_value = float(
            (
                await db.execute(
                    select(func.coalesce(func.sum(InventorySnapshot.inventory_value), 0)).where(and_(*snapshot_conds))
                )
            ).scalar()
            or 0
        )

    purchase_conds = [
        PurchaseBill.date >= period.start_s,
        PurchaseBill.date <= period.end_s,
        PurchaseBill.status != InvoiceStatus.cancelled,
    ]
    purchase_branch_cond = _branch_condition(PurchaseBill.branch_id, filters, allowed)
    if purchase_branch_cond is not None:
        purchase_conds.append(purchase_branch_cond)
    if filters.category_id:
        purchase_conds.append(Item.category_id == filters.category_id)

    purchase_rows = await db.execute(
        select(
            PurchaseBill.date,
            func.coalesce(func.sum(PurchaseLineItem.line_total), 0).label("value"),
        )
        .select_from(PurchaseLineItem)
        .join(PurchaseBill, PurchaseLineItem.bill_id == PurchaseBill.id)
        .outerjoin(Item, PurchaseLineItem.item_id == Item.id)
        .where(and_(*purchase_conds))
        .group_by(PurchaseBill.date)
        .order_by(PurchaseBill.date)
    )
    purchase_by_date = {row.date: float(row.value or 0) for row in purchase_rows.fetchall()}

    sales_conds = _line_conditions(filters, allowed, period)
    sales_cost_rows = await db.execute(
        select(
            SaleInvoice.date,
            func.coalesce(func.sum(func.coalesce(Item.cost_price, 0) * SaleLineItem.qty), 0).label("value"),
        )
        .select_from(SaleLineItem)
        .join(SaleInvoice, SaleLineItem.invoice_id == SaleInvoice.id)
        .outerjoin(Item, SaleLineItem.item_id == Item.id)
        .where(and_(*sales_conds))
        .group_by(SaleInvoice.date)
        .order_by(SaleInvoice.date)
    )
    sales_cost_by_date = {row.date: float(row.value or 0) for row in sales_cost_rows.fetchall()}

    trend_end = min(period.end, date.today())
    if trend_end < period.start:
        return [{"date": period.start_s, "value": current_value}]

    total_purchase = sum(purchase_by_date.values())
    total_sales_cost = sum(sales_cost_by_date.values())
    raw_delta = total_purchase - total_sales_cost

    if not total_purchase and not total_sales_cost:
        dates = _sampled_dates(period.start, trend_end, max_points=60)
        return [{"date": day.isoformat(), "value": round(current_value, 2)} for day in dates]

    if current_value:
        target_movement = max(current_value * 0.18, 1)
        scale = min(1, target_movement / abs(raw_delta)) if raw_delta else 0.08
    else:
        scale = 0.15

    rolling_value = max(0, current_value - (raw_delta * scale))
    sample_dates = _sampled_dates(period.start, trend_end, max_points=60)
    sample_dates_set = set(sample_dates)
    rows = []
    day = period.start
    
    # Only iterate through days, but optimize to skip unnecessary date operations
    while day <= trend_end:
        day_key = day.isoformat()
        rolling_value = max(
            0,
            rolling_value
            + (purchase_by_date.get(day_key, 0) * scale)
            - (sales_cost_by_date.get(day_key, 0) * scale),
        )
        if day in sample_dates_set:
            rows.append({"date": day_key, "value": round(rolling_value, 2)})
        day += timedelta(days=1)

    if rows:
        rows[-1]["value"] = round(current_value, 2)
    return rows or [{"date": trend_end.isoformat(), "value": round(current_value, 2)}]


def _sampled_dates(start: date, end: date, max_points: int = 60) -> list[date]:
    days = max(1, (end - start).days + 1)
    step = max(1, (days + max_points - 1) // max_points)
    sampled = [start + timedelta(days=offset) for offset in range(0, days, step)]
    if sampled[-1] != end:
        sampled.append(end)
    return sampled


async def _fifo_fefo(db: AsyncSession, filters: DashboardFilters, allowed: Optional[list[str]], near_expiry_count: int = 0) -> dict:
    batch_conds = [ItemBatch.quantity > 0]
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


async def _billing_payload(db: AsyncSession, filters: DashboardFilters) -> dict:
    period = _parse_period(filters)
    allowed = None
    conds = _invoice_conditions(filters, allowed, period)
    previous_conds = _invoice_conditions(filters, allowed, period.previous)

    if _can_use_sales_mvs(db, filters):
        payment_conds = _mv_conds(PaymentSummary, filters, allowed)
        payment_conds.extend([PaymentSummary.paid_date >= period.start, PaymentSummary.paid_date <= period.end])
        payment_rows = await db.execute(
            select(
                func.coalesce(PaymentSummary.payment_method, "cash").label("method"),
                func.coalesce(func.sum(PaymentSummary.collected), 0).label("amount"),
            )
            .where(and_(*payment_conds))
            .group_by(PaymentSummary.payment_method)
            .order_by(desc("amount"))
        )
    else:
        payment_rows = await db.execute(
            select(
                func.coalesce(SaleInvoice.payment_mode, "cash").label("method"),
                func.coalesce(func.sum(SaleInvoice.paid_amount), 0).label("amount"),
            )
            .where(and_(*conds))
            .group_by(SaleInvoice.payment_mode)
            .order_by(desc("amount"))
        )
    payment_distribution = [
        {"method": (row.method or "cash").upper(), "amount": float(row.amount or 0)}
        for row in payment_rows.fetchall()
    ]
    by_method = {row["method"].lower(): row["amount"] for row in payment_distribution}

    # Helper coroutines for scalar queries
    async def get_pending_total():
        return float(
            (
                await db.execute(
                    select(func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0)).where(
                        and_(*conds, SaleInvoice.total > SaleInvoice.paid_amount)
                    )
                )
            ).scalar()
            or 0
        )

    async def get_previous_pending():
        return float(
            (
                await db.execute(
                    select(func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0)).where(
                        and_(*previous_conds, SaleInvoice.total > SaleInvoice.paid_amount)
                    )
                )
            ).scalar()
            or 0
        )

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

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "cash": by_method.get("cash", 0),
            "card": by_method.get("card", 0),
            "upi": by_method.get("upi", 0),
            "pending_payments": pending_total,
            "refunds": refunds["amount"],
            "discounts": current["discount"],
        },
        "deltas": {
            "cash": 0,
            "card": 0,
            "upi": 0,
            "pending_payments": _pct_delta(pending_total, previous_pending),
            "refunds": _pct_delta(refunds["amount"], previous_refunds["amount"]),
            "discounts": _pct_delta(current["discount"], previous["discount"]),
        },
        "charts": {
            "payment_distribution": payment_distribution,
            "refund_trends": refund_trends,
            "daily_billing_count": daily_count,
        },
        "analytics": {
            "collection_efficiency": round((current["collected"] / current["revenue"]) * 100, 1) if current["revenue"] else 0,
            "refund_percentage": round((refunds["amount"] / current["revenue"]) * 100, 1) if current["revenue"] else 0,
            "pending_invoice_count": pending_invoice_count_result,
        },
        "tables": {
            "pending_payments": pending_payments,
            "recent_refunds": recent_refunds,
            "discounted_bills": discounted_bills,
        },
    }


def _refund_conditions(filters: DashboardFilters, allowed_branch_ids: Optional[list[str]], period: Period):
    conds = _invoice_conditions(filters, allowed_branch_ids, period, include_status=False)
    conds.append(SaleInvoice.status == InvoiceStatus.cancelled)
    return conds


async def _refund_summary(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> dict:
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(RefundSummary, filters, allowed)
        conds.extend([RefundSummary.refund_date >= period.start, RefundSummary.refund_date <= period.end])
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(RefundSummary.refund_amount), 0).label("amount"),
                    func.coalesce(func.sum(RefundSummary.refund_count), 0).label("count"),
                ).where(and_(*conds))
            )
        ).one()
    else:
        conds = _refund_conditions(filters, allowed, period)
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(SaleInvoice.total), 0).label("amount"),
                    func.count(SaleInvoice.id).label("count"),
                ).where(and_(*conds))
            )
        ).one()
    return {"amount": float(row.amount or 0), "count": int(row.count or 0)}


async def _refund_trends(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> list[dict]:
    if _can_use_sales_mvs(db, filters):
        conds = _mv_conds(RefundSummary, filters, allowed)
        conds.extend([RefundSummary.refund_date >= period.start, RefundSummary.refund_date <= period.end])
        result = await db.execute(
            select(RefundSummary.refund_date.label("date"), func.coalesce(func.sum(RefundSummary.refund_amount), 0).label("refunds"))
            .where(and_(*conds))
            .group_by(RefundSummary.refund_date)
            .order_by(RefundSummary.refund_date)
        )
    else:
        conds = _refund_conditions(filters, allowed, period)
        result = await db.execute(
            select(SaleInvoice.date, func.coalesce(func.sum(SaleInvoice.total), 0).label("refunds"))
            .where(and_(*conds))
            .group_by(SaleInvoice.date)
            .order_by(SaleInvoice.date)
        )
    refund_by_date = {row.date: float(row.refunds or 0) for row in result.fetchall()}

    trend_end = min(period.end, date.today())
    if trend_end < period.start:
        return [{"date": period.start_s, "refunds": 0}]

    rows = []
    day = period.start
    while day <= trend_end:
        day_key = day.isoformat()
        rows.append({"date": day_key, "refunds": refund_by_date.get(day_key, 0)})
        day += timedelta(days=1)
    return rows


async def _recent_refunds(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
    limit: int = 20,
) -> dict:
    conds = _refund_conditions(filters, allowed, period)
    total = int(
        (
            await db.execute(
                select(func.count(SaleInvoice.id)).where(and_(*conds))
            )
        ).scalar()
        or 0
    )
    result = await db.execute(
        select(SaleInvoice)
        .where(and_(*conds))
        .order_by(desc(SaleInvoice.created_at), desc(SaleInvoice.id))
        .limit(limit)
    )
    items = [
        {
            "id": f"cn-{inv.id}",
            "number": f"CN-{inv.number}",
            "customer": inv.customer_name or "Walk-in",
            "amount": float(inv.total or 0),
            "date": inv.date,
        }
        for inv in result.scalars().all()
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
    value = (
        await db.execute(
            select(func.count(SaleInvoice.id)).where(and_(*conds, SaleInvoice.total > SaleInvoice.paid_amount))
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
    result = await db.execute(
        select(SaleInvoice)
        .where(and_(*conds, SaleInvoice.total > SaleInvoice.paid_amount))
        .order_by(desc(SaleInvoice.created_at))
        .limit(limit)
    )
    items = [
        {
            "id": inv.id,
            "number": inv.number,
            "customer": inv.customer_name or "Walk-in",
            "balance": float((inv.total or 0) - (inv.paid_amount or 0)),
            "date": inv.date,
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


async def _operations_payload(db: AsyncSession, filters: DashboardFilters) -> dict:
    period = _parse_period(filters)
    allowed = None
    conds = _invoice_conditions(filters, allowed, period)
    today_period = Period(period.end, period.end)

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
    staff_sales = await _staff_sales(db, filters, allowed, period)
    branch_performance = await _branch_sales(db, filters, allowed, period)
    heatmap = await _hourly_heatmap(db, filters, allowed, period)
    summary = await _invoice_summary(db, filters, allowed, period)
    activity_logs = await _activity_logs(db, filters, period)

    best_staff = staff_sales[0]["staff"] if staff_sales else "—"
    best_branch = branch_performance[0]["branch"] if branch_performance else "—"
    peak = max(heatmap, key=lambda row: row["value"], default=None)
    staff_count = max(1, len(staff_sales))

    return {
        "filters": _filters_dict(filters, period),
        "kpis": {
            "daily_transactions": today_count,
            "peak_sales_hour": peak["hour"] if peak else "—",
            "best_branch": best_branch,
            "best_staff": best_staff,
        },
        "deltas": {"daily_transactions": 0, "peak_sales_hour": 0, "best_branch": 0, "best_staff": 0},
        "charts": {
            "staff_sales": staff_sales,
            "hourly_heatmap": heatmap,
            "branch_performance": branch_performance,
        },
        "analytics": {
            "productivity": round((summary["bill_count"] / max(1, period.days * staff_count)) * 100, 1),
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
    conds = _invoice_conditions(filters, allowed, period)
    result = await db.execute(
        select(
            func.coalesce(SaleInvoice.cashier, "Unassigned").label("staff"),
            func.count(SaleInvoice.id).label("bill_count"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("sales"),
        )
        .where(and_(*conds))
        .group_by(SaleInvoice.cashier)
        .order_by(desc("sales"))
        .limit(20)
    )
    return [
        {"staff": row.staff, "bill_count": int(row.bill_count or 0), "sales": float(row.sales or 0)}
        for row in result.fetchall()
    ]


async def _hourly_heatmap(
    db: AsyncSession,
    filters: DashboardFilters,
    allowed: Optional[list[str]],
    period: Period,
) -> list[dict]:
    conds = _invoice_conditions(filters, allowed, period)
    dialect = db.bind.dialect.name if db.bind is not None else "sqlite"
    if dialect == "postgresql":
        hour_expr = func.to_char(SaleInvoice.created_at, "HH24")
        day_expr = func.to_char(SaleInvoice.created_at, "Dy")
    else:
        hour_expr = func.strftime("%H", SaleInvoice.created_at)
        day_expr = func.strftime("%w", SaleInvoice.created_at)
    result = await db.execute(
        select(
            day_expr.label("day"),
            hour_expr.label("hour"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("value"),
        )
        .where(and_(*conds))
        .group_by(day_expr, hour_expr)
    )
    day_map = {"0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat"}
    rows = []
    for row in result.fetchall():
        day = str(row.day).strip()
        hour = str(row.hour).strip()
        if len(hour) == 2 and hour.isdigit():
            hour = f"{int(hour)}:00"
        rows.append({"day": day_map.get(day, day[:3]), "hour": hour, "value": float(row.value or 0)})
    return rows


async def _activity_logs(db: AsyncSession, filters: DashboardFilters, period: Period, limit: int = 20) -> dict:
    start_dt = datetime.combine(period.start, time.min)
    end_dt = datetime.combine(period.end + timedelta(days=1), time.min)
    conds = [AuditLog.created_at >= start_dt, AuditLog.created_at < end_dt]
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
    db: AsyncSession = Depends(get_db),
):
    branch_query = select(Branch).where(Branch.active == True).order_by(Branch.name)
    branches = (await db.execute(branch_query)).scalars().all()
    staff_rows = (await db.execute(select(User).where(User.active == True).order_by(User.name))).scalars().all()
    categories = (await db.execute(select(Category).order_by(Category.name))).scalars().all()
    return {
        "branches": [{"id": branch.id, "name": branch.name} for branch in branches],
        "staff": [{"id": staff.name, "name": staff.name} for staff in staff_rows],
        "categories": [{"id": category.id, "name": category.name} for category in categories],
    }


@router.get("/summary")
async def dashboard_summary(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    allowed = None
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
):
    period = _parse_period(filters)
    return await _sales_dashboard_payload(db, filters)


@router.get("/inventory")
async def inventory_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _cached_dashboard_payload(
        "inventory",
        PUBLIC_DASHBOARD_USER_ID,
        _filters_dict(filters, period),
        ttl_seconds=300,
        loader=lambda: _inventory_payload(db, filters),
    )


@router.get("/billing")
async def billing_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _cached_dashboard_payload(
        "billing",
        PUBLIC_DASHBOARD_USER_ID,
        _filters_dict(filters, period),
        ttl_seconds=120,
        loader=lambda: _billing_payload(db, filters),
    )


@router.get("/operations")
async def operations_dashboard(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _cached_dashboard_payload(
        "operations",
        PUBLIC_DASHBOARD_USER_ID,
        _filters_dict(filters, period),
        ttl_seconds=120,
        loader=lambda: _operations_payload(db, filters),
    )


@router.get("/sales/top-products")
async def sales_top_products(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _top_products(db, filters, None, period, limit=filters.limit)


@router.get("/sales/recent-sales")
async def sales_recent_sales(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _recent_sales(db, filters, None, period, limit=filters.limit)


@router.get("/inventory/low-stock")
async def inventory_low_stock(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    return await _low_stock(db, filters, None, limit=filters.limit)


@router.get("/inventory/expiry-near")
async def inventory_expiry_near(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    return await _expiry_near(db, filters, None, limit=filters.limit)


@router.get("/billing/pending-payments")
async def billing_pending_payments(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _pending_payments(db, filters, None, period, limit=filters.limit)


@router.get("/operations/activity-logs")
async def operations_activity_logs(
    filters: DashboardFilters = Depends(),
    db: AsyncSession = Depends(get_db),
):
    period = _parse_period(filters)
    return await _activity_logs(db, filters, period, limit=filters.limit)


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


async def _cached_dashboard_payload(scope: str, user_id: str, filters: dict, ttl_seconds: int, loader):
    key = _cache_key(scope, user_id, filters)
    now = datetime.utcnow()
    cached = _DASHBOARD_CACHE.get(key)
    if cached and cached[0] > now:
        payload = dict(cached[1])
        payload["cache"] = {"key": key, "hit": True, "ttl_seconds": ttl_seconds}
        return payload
    payload = await loader()
    payload["cache"] = {"key": key, "hit": False, "ttl_seconds": ttl_seconds}
    _DASHBOARD_CACHE[key] = (now + timedelta(seconds=ttl_seconds), payload)
    return payload

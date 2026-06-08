
import logging
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, case, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.date_utils import MAX_REPORT_DATE_RANGE_DAYS, parse_date_range
from src.models import (
    Branch,
    Category,
    CashEntry,
    Customer,
    DailySalesSummary,
    InventorySnapshot,
    Item,
    ItemStock,
    PaymentSummary,
    ProductSalesSummary,
    PurchaseBill,
    PurchaseLineItem,
    SaleInvoice,
    SaleLineItem,
    StockTransfer,
    TransferLineItem,
    Vendor,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.security import require_perm

router = APIRouter()
logger = logging.getLogger("cosmopolitan.reports")


def _normalize_date_range(
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[str, str]:
    start, end = parse_date_range(
        date_from,
        date_to,
        date.today() - timedelta(days=30),
        date.today(),
        MAX_REPORT_DATE_RANGE_DAYS,
    )
    return start.isoformat(), end.isoformat()


def _sale_filters(
    branch_id: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
):
    conds = []
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
    if date_from:
        conds.append(SaleInvoice.date >= date_from)
    if date_to:
        conds.append(SaleInvoice.date <= date_to)
    if search:
        conds.append(
            SaleInvoice.number.ilike(f"%{search}%")
            | SaleInvoice.customer_name.ilike(f"%{search}%")
        )
    return conds


def _purchase_filters(
    branch_id: Optional[str],
    vendor_id: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
):
    conds = []
    if branch_id:
        conds.append(PurchaseBill.branch_id == branch_id)
    if vendor_id:
        conds.append(PurchaseBill.vendor_id == vendor_id)
    if date_from:
        conds.append(PurchaseBill.date >= date_from)
    if date_to:
        conds.append(PurchaseBill.date <= date_to)
    if search:
        conds.append(
            PurchaseBill.number.ilike(f"%{search}%")
            | PurchaseBill.vendor_name.ilike(f"%{search}%")
        )
    return conds


def _branch_filter(search: Optional[str], branch_id: Optional[str]):
    conds = []
    if branch_id:
        conds.append(
            (StockTransfer.from_branch_id == branch_id)
            | (StockTransfer.to_branch_id == branch_id)
        )
    if search:
        conds.append(TransferLineItem.item_name.ilike(f"%{search}%"))
    return conds


def _paged_count(model, conds):
    query = select(func.count(model.id))
    if conds:
        query = query.where(and_(*conds))
    return query


@router.get("/sales-summary", dependencies=[Depends(require_perm("reports.view"))])
async def sales_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = _sale_filters(branch_id, None, start, end)
    base = and_(*conds) if conds else True

    total_sales = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(base))).scalar() or 0
    )
    invoice_count = int(
        (await db.execute(select(func.count(SaleInvoice.id)).where(base))).scalar() or 0
    )
    total_tax = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.tax_total), 0)).where(base))).scalar() or 0
    )
    total_discount = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.discount), 0)).where(base))).scalar() or 0
    )
    total_paid = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.paid_amount), 0)).where(base))).scalar() or 0
    )
    return {
        "period": {"from": start, "to": end},
        "total_sales": total_sales,
        "invoice_count": invoice_count,
        "total_tax": total_tax,
        "total_discount": total_discount,
        "total_paid": total_paid,
        "outstanding": max(0, total_sales - total_paid),
    }


@router.get("/purchase-summary", dependencies=[Depends(require_perm("reports.view"))])
async def purchase_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = _purchase_filters(branch_id, None, None, start, end)
    base = and_(*conds) if conds else True

    total_purchases = float(
        (await db.execute(select(func.coalesce(func.sum(PurchaseBill.total), 0)).where(base))).scalar() or 0
    )
    bill_count = int(
        (await db.execute(select(func.count(PurchaseBill.id)).where(base))).scalar() or 0
    )
    total_paid = float(
        (await db.execute(select(func.coalesce(func.sum(PurchaseBill.paid_amount), 0)).where(base))).scalar() or 0
    )
    return {
        "period": {"from": start, "to": end},
        "total_purchases": total_purchases,
        "bill_count": bill_count,
        "paid": total_paid,
        "outstanding": max(0, total_purchases - total_paid),
    }


@router.get("/tax-summary", dependencies=[Depends(require_perm("reports.view"))])
async def tax_summary(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    sale_conds = _sale_filters(None, None, start, end)
    purchase_conds = _purchase_filters(None, None, None, start, end)
    sale_base = and_(*sale_conds) if sale_conds else True
    purchase_base = and_(*purchase_conds) if purchase_conds else True

    sales_taxable = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.subtotal), 0)).where(sale_base))).scalar() or 0
    )
    sales_tax = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.tax_total), 0)).where(sale_base))).scalar() or 0
    )
    exempt_sales = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(and_(sale_base, SaleInvoice.tax_total == 0)))).scalar() or 0
    )
    purchase_taxable = float(
        (await db.execute(select(func.coalesce(func.sum(PurchaseBill.subtotal), 0)).where(purchase_base))).scalar() or 0
    )
    purchase_tax = float(
        (await db.execute(select(func.coalesce(func.sum(PurchaseBill.tax_total), 0)).where(purchase_base))).scalar() or 0
    )
    exempt_purchases = float(
        (await db.execute(select(func.coalesce(func.sum(PurchaseBill.total), 0)).where(and_(purchase_base, PurchaseBill.tax_total == 0)))).scalar() or 0
    )
    return {
        "period": {"from": start, "to": end},
        "output_tax": [
            {"rate": "GST", "taxable": sales_taxable, "tax_collected": sales_tax},
            {"rate": "Exempt", "taxable": exempt_sales, "tax_collected": 0},
        ],
        "input_tax": [
            {"rate": "GST", "taxable": purchase_taxable, "tax_collected": purchase_tax},
            {"rate": "Exempt", "taxable": exempt_purchases, "tax_collected": 0},
        ],
        "total_output": sales_tax,
        "total_input": purchase_tax,
        "net_payable": max(0, sales_tax - purchase_tax),
    }


@router.get("/sales-register", dependencies=[Depends(require_perm("reports.view"))])
async def sales_register(
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
    conds = _sale_filters(branch_id, search, start, end)
    query = select(
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
        SaleInvoice.status.label("status"),
    ).where(and_(*conds) if conds else True)

    sort_map = {
        "invoice_number": SaleInvoice.number,
        "invoice_date": SaleInvoice.date,
        "customer": SaleInvoice.customer_name,
        "branch": SaleInvoice.branch_name,
        "cashier": SaleInvoice.cashier,
        "taxable_amount": SaleInvoice.subtotal,
        "tax_amount": SaleInvoice.tax_total,
        "discount": SaleInvoice.discount,
        "net_amount": SaleInvoice.total,
        "payment_mode": SaleInvoice.payment_mode,
        "status": SaleInvoice.status,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "invoice_date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)

    total_q = select(func.count()).select_from(SaleInvoice).where(and_(*conds) if conds else True)
    total = int((await db.execute(total_q)).scalar() or 0)
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
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [DailySalesSummary.sale_date >= start, DailySalesSummary.sale_date <= end]
    if branch_id:
        conds.append(DailySalesSummary.branch_id == branch_id)
    if search:
        conds.append(DailySalesSummary.cashier.ilike(f"%{search}%"))

    sort_map = {
        "date": DailySalesSummary.sale_date,
        "invoice_count": DailySalesSummary.bill_count,
        "quantity_sold": DailySalesSummary.revenue,
        "gross_sales": DailySalesSummary.revenue,
        "discounts": DailySalesSummary.discount,
        "tax": DailySalesSummary.revenue,
        "net_sales": DailySalesSummary.collected,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total_q = select(func.count()).select_from(DailySalesSummary).where(and_(*conds))
    total = int((await db.execute(total_q)).scalar() or 0)

    result = await db.execute(
        select(
            DailySalesSummary.sale_date.label("date"),
            DailySalesSummary.bill_count.label("invoice_count"),
            DailySalesSummary.revenue.label("gross_sales"),
            DailySalesSummary.discount.label("discounts"),
            DailySalesSummary.collected.label("net_sales"),
        )
        .where(and_(*conds))
        .order_by(order_by_expr)
        .offset(sk)
        .limit(lim)
    )
    rows = [{**dict(r._mapping), "date": r.date.isoformat() if r.date else None} for r in result.fetchall()]
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
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [ProductSalesSummary.sale_date >= start, ProductSalesSummary.sale_date <= end]
    if branch_id:
        conds.append(ProductSalesSummary.branch_id == branch_id)
    if search:
        conds.append(ProductSalesSummary.product_name.ilike(f"%{search}%"))

    sort_map = {
        "product_code": ProductSalesSummary.item_id,
        "product_name": ProductSalesSummary.product_name,
        "category": ProductSalesSummary.category_id,
        "quantity_sold": ProductSalesSummary.quantity_sold,
        "sales_value": ProductSalesSummary.revenue,
        "cost_value": ProductSalesSummary.revenue,
        "profit": ProductSalesSummary.profit,
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
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [ProductSalesSummary.sale_date >= start, ProductSalesSummary.sale_date <= end]
    if branch_id:
        conds.append(ProductSalesSummary.branch_id == branch_id)
    if search:
        conds.append(Category.name.ilike(f"%{search}%"))

    sort_map = {
        "category": Category.name,
        "quantity_sold": func.sum(ProductSalesSummary.quantity_sold),
        "sales_value": func.sum(ProductSalesSummary.revenue),
        "cost_value": func.sum(ProductSalesSummary.revenue),
        "profit": func.sum(ProductSalesSummary.profit),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_value", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = select(
        Category.name.label("category"),
        func.coalesce(func.sum(ProductSalesSummary.quantity_sold), 0).label("quantity_sold"),
        func.coalesce(func.sum(ProductSalesSummary.revenue), 0).label("sales_value"),
        func.coalesce(func.sum(ProductSalesSummary.profit), 0).label("profit"),
    ).select_from(ProductSalesSummary).join(Category, Category.id == ProductSalesSummary.category_id, isouter=True).where(and_(*conds)).group_by(Category.name)

    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/branch-sales", dependencies=[Depends(require_perm("reports.view"))])
async def branch_sales(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]
    sort_map = {
        "branch": SaleInvoice.branch_name,
        "invoice_count": func.count(SaleInvoice.id),
        "sales_amount": func.coalesce(func.sum(SaleInvoice.total), 0),
        "tax_amount": func.coalesce(func.sum(SaleInvoice.tax_total), 0),
        "discount_amount": func.coalesce(func.sum(SaleInvoice.discount), 0),
        "net_sales": func.coalesce(func.sum(SaleInvoice.total), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            SaleInvoice.branch_name.label("branch"),
            func.count(SaleInvoice.id).label("invoice_count"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("sales_amount"),
            func.coalesce(func.sum(SaleInvoice.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(SaleInvoice.discount), 0).label("discount_amount"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("net_sales"),
        )
        .where(and_(*conds))
        .group_by(SaleInvoice.branch_name)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/cashier-sales", dependencies=[Depends(require_perm("reports.view"))])
async def cashier_sales(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]
    sort_map = {
        "cashier": SaleInvoice.cashier,
        "invoice_count": func.count(SaleInvoice.id),
        "sales_amount": func.coalesce(func.sum(SaleInvoice.total), 0),
        "tax_amount": func.coalesce(func.sum(SaleInvoice.tax_total), 0),
        "discount_amount": func.coalesce(func.sum(SaleInvoice.discount), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "sales_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            SaleInvoice.cashier.label("cashier"),
            func.count(SaleInvoice.id).label("invoice_count"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("sales_amount"),
            func.coalesce(func.sum(SaleInvoice.tax_total), 0).label("tax_amount"),
            func.coalesce(func.sum(SaleInvoice.discount), 0).label("discount_amount"),
        )
        .where(and_(*conds))
        .group_by(SaleInvoice.cashier)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/purchase-register", dependencies=[Depends(require_perm("reports.view"))])
async def purchase_register(
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
    conds = _purchase_filters(branch_id, None, search, start, end)
    query = select(
        PurchaseBill.number.label("bill_number"),
        PurchaseBill.date.label("bill_date"),
        PurchaseBill.vendor_name.label("vendor"),
        PurchaseBill.branch_name.label("branch"),
        PurchaseBill.subtotal.label("subtotal"),
        PurchaseBill.tax_total.label("tax"),
        PurchaseBill.total.label("total"),
        PurchaseBill.paid_amount.label("paid"),
        (PurchaseBill.total - PurchaseBill.paid_amount).label("balance"),
        PurchaseBill.status.label("status"),
    ).where(and_(*conds) if conds else True)

    sort_map = {
        "bill_number": PurchaseBill.number,
        "bill_date": PurchaseBill.date,
        "vendor": PurchaseBill.vendor_name,
        "branch": PurchaseBill.branch_name,
        "subtotal": PurchaseBill.subtotal,
        "tax": PurchaseBill.tax_total,
        "total": PurchaseBill.total,
        "paid": PurchaseBill.paid_amount,
        "balance": PurchaseBill.total - PurchaseBill.paid_amount,
        "status": PurchaseBill.status,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "bill_date", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total_q = select(func.count()).select_from(PurchaseBill).where(and_(*conds) if conds else True)
    total = int((await db.execute(total_q)).scalar() or 0)
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
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [PurchaseBill.date >= start, PurchaseBill.date <= end]
    if branch_id:
        conds.append(PurchaseBill.branch_id == branch_id)
    if search:
        conds.append(PurchaseBill.vendor_name.ilike(f"%{search}%"))

    sort_map = {
        "vendor": PurchaseBill.vendor_name,
        "purchase_count": func.count(PurchaseBill.id),
        "purchase_amount": func.coalesce(func.sum(PurchaseBill.total), 0),
        "paid_amount": func.coalesce(func.sum(PurchaseBill.paid_amount), 0),
        "outstanding_amount": func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "purchase_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            PurchaseBill.vendor_name.label("vendor"),
            func.count(PurchaseBill.id).label("purchase_count"),
            func.coalesce(func.sum(PurchaseBill.total), 0).label("purchase_amount"),
            func.coalesce(func.sum(PurchaseBill.paid_amount), 0).label("paid_amount"),
            func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0).label("outstanding_amount"),
        )
        .where(and_(*conds))
        .group_by(PurchaseBill.vendor_name)
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
):
    start, end = _normalize_date_range(date_from, date_to)
    conds = [PurchaseBill.date >= start, PurchaseBill.date <= end]
    if branch_id:
        conds.append(PurchaseBill.branch_id == branch_id)
    if search:
        conds.append(PurchaseLineItem.name.ilike(f"%{search}%"))

    sort_map = {
        "product": PurchaseLineItem.name,
        "quantity_purchased": func.coalesce(func.sum(PurchaseLineItem.qty), 0),
        "purchase_cost": func.coalesce(func.sum(PurchaseLineItem.line_total), 0),
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "quantity_purchased", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            PurchaseLineItem.name.label("product"),
            func.coalesce(func.sum(PurchaseLineItem.qty), 0).label("quantity_purchased"),
            func.coalesce(func.sum(PurchaseLineItem.line_total), 0).label("purchase_cost"),
        )
        .select_from(PurchaseLineItem)
        .join(PurchaseBill, PurchaseBill.id == PurchaseLineItem.bill_id)
        .where(and_(*conds))
        .group_by(PurchaseLineItem.name)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
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
    if branch_id:
        conds.append(InventorySnapshot.branch_id == branch_id)
    if search:
        conds.append(Item.name.ilike(f"%{search}%"))

    sort_map = {
        "product_code": Item.sku,
        "product_name": Item.name,
        "category": Category.name,
        "branch": InventorySnapshot.branch_id,
        "available_stock": InventorySnapshot.quantity,
        "reserved_stock": InventorySnapshot.reorder_level,
        "stock_value": InventorySnapshot.inventory_value,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "product_name", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            Item.sku.label("product_code"),
            Item.name.label("product_name"),
            Category.name.label("category"),
            InventorySnapshot.branch_id.label("branch"),
            InventorySnapshot.quantity.label("available_stock"),
            InventorySnapshot.reorder_level.label("reserved_stock"),
            InventorySnapshot.inventory_value.label("stock_value"),
        )
        .join(Item, Item.id == InventorySnapshot.item_id)
        .join(Category, Category.id == InventorySnapshot.category_id, isouter=True)
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
    conds = [InventorySnapshot.quantity <= InventorySnapshot.reorder_level]
    if branch_id:
        conds.append(InventorySnapshot.branch_id == branch_id)
    if search:
        conds.append(Item.name.ilike(f"%{search}%"))

    sort_map = {
        "product": Item.name,
        "available_quantity": InventorySnapshot.quantity,
        "reorder_level": InventorySnapshot.reorder_level,
        "branch": InventorySnapshot.branch_id,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "product", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            Item.name.label("product"),
            InventorySnapshot.quantity.label("available_quantity"),
            InventorySnapshot.reorder_level.label("reorder_level"),
            InventorySnapshot.branch_id.label("branch"),
        )
        .join(Item, Item.id == InventorySnapshot.item_id)
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
    conds = [InventorySnapshot.quantity <= 0]
    if branch_id:
        conds.append(InventorySnapshot.branch_id == branch_id)
    if search:
        conds.append(Item.name.ilike(f"%{search}%"))

    sort_map = {
        "product": Item.name,
        "category": Category.name,
        "branch": InventorySnapshot.branch_id,
    }

    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "product", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            Item.name.label("product"),
            Category.name.label("category"),
            InventorySnapshot.branch_id.label("branch"),
        )
        .join(Item, Item.id == InventorySnapshot.item_id)
        .join(Category, Category.id == InventorySnapshot.category_id, isouter=True)
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
    if branch_id:
        conds.append((StockTransfer.from_branch_id == branch_id) | (StockTransfer.to_branch_id == branch_id))
    if search:
        conds.append(TransferLineItem.item_name.ilike(f"%{search}%"))
    if start:
        conds.append(StockTransfer.request_date >= start)
    if end:
        conds.append(StockTransfer.request_date <= end)

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
    conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
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
    conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
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
    conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
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
    conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)

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
    db: AsyncSession = Depends(get_db),
):
    conds = [SaleInvoice.total > SaleInvoice.paid_amount]
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
    if search:
        conds.append(
            SaleInvoice.number.ilike(f"%{search}%")
            | SaleInvoice.customer_name.ilike(f"%{search}%")
        )
    sort_map = {
        "customer": SaleInvoice.customer_name,
        "invoice_number": SaleInvoice.number,
        "invoice_date": SaleInvoice.date,
        "due_date": SaleInvoice.date,
        "outstanding_amount": SaleInvoice.total - SaleInvoice.paid_amount,
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "due_date", "asc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    query = (
        select(
            SaleInvoice.customer_name.label("customer"),
            SaleInvoice.number.label("invoice_number"),
            SaleInvoice.date.label("invoice_date"),
            SaleInvoice.date.label("due_date"),
            (SaleInvoice.total - SaleInvoice.paid_amount).label("outstanding_amount"),
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
    db: AsyncSession = Depends(get_db),
):
    conds = [PurchaseBill.total > PurchaseBill.paid_amount]
    if branch_id:
        conds.append(PurchaseBill.branch_id == branch_id)
    if search:
        conds.append(
            PurchaseBill.number.ilike(f"%{search}%")
            | PurchaseBill.vendor_name.ilike(f"%{search}%")
        )
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
    conds = [CashEntry.date >= start, CashEntry.date <= end]
    if branch_id:
        conds.append(CashEntry.branch_id == branch_id)
    if search:
        conds.append(CashEntry.description.ilike(f"%{search}%"))

    sort_map = {
        "date": CashEntry.date,
        "expense_category": CashEntry.category,
        "description": CashEntry.description,
        "amount": CashEntry.amount,
        "branch": CashEntry.branch_id,
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
            CashEntry.branch_id.label("branch"),
        )
        .where(and_(*conds))
        .order_by(order_by_expr)
        .offset(sk)
        .limit(lim)
    )
    total_q = select(func.count()).select_from(CashEntry).where(and_(*conds))
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(query)
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/top-customers", dependencies=[Depends(require_perm("reports.view"))])
async def top_customers(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sort_map = {
        "customer": SaleInvoice.customer_name,
        "invoice_count": func.count(SaleInvoice.id),
        "purchase_amount": func.coalesce(func.sum(SaleInvoice.total), 0),
        "outstanding_amount": func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "purchase_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            SaleInvoice.customer_name.label("customer"),
            func.count(SaleInvoice.id).label("invoice_count"),
            func.coalesce(func.sum(SaleInvoice.total), 0).label("purchase_amount"),
            func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0).label("outstanding_amount"),
        )
        .group_by(SaleInvoice.customer_name)
    )
    total_q = select(func.count()).select_from(base.subquery())
    total = int((await db.execute(total_q)).scalar() or 0)
    result = await db.execute(base.order_by(order_by_expr).offset(sk).limit(lim))
    rows = [dict(r._mapping) for r in result.fetchall()]
    return paged(rows, total, sk, lim)


@router.get("/vendor-outstanding", dependencies=[Depends(require_perm("reports.view"))])
async def vendor_outstanding(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sort_map = {
        "vendor": PurchaseBill.vendor_name,
        "purchase_count": func.count(PurchaseBill.id),
        "purchase_amount": func.coalesce(func.sum(PurchaseBill.total), 0),
        "outstanding_amount": func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0),
    }
    order_by_expr = resolve_sort(sort_by, sort_order, sort_map, "outstanding_amount", "desc")
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    base = (
        select(
            PurchaseBill.vendor_name.label("vendor"),
            func.count(PurchaseBill.id).label("purchase_count"),
            func.coalesce(func.sum(PurchaseBill.total), 0).label("purchase_amount"),
            func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0).label("outstanding_amount"),
        )
        .group_by(PurchaseBill.vendor_name)
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

    if branch_id:
        sale_conds.append(SaleInvoice.branch_id == branch_id)
        purchase_conds.append(PurchaseBill.branch_id == branch_id)
        transfer_conds.append(
            (StockTransfer.from_branch_id == branch_id)
            | (StockTransfer.to_branch_id == branch_id)
        )
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
        .where(SaleInvoice.date >= start, SaleInvoice.date <= end)
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
    sale_conds = [SaleInvoice.date >= start, SaleInvoice.date <= end]

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

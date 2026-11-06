"""Current Stock report — Stock / Reserved / Available split matches Items & Stock."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.date_utils import business_day_bounds_utc, business_today
from src.models import (
    Branch,
    Category,
    Item,
    ItemStock,
    StockMovement,
    SalesOrder,
    SalesOrderStatus,
    StockReservation,
    StockReservationStatus,
    User,
)
from src.report_catalog import REPORT_CATEGORIES
from src.routes.reports import current_stock, current_stock_reservations


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    db = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    db.add(Category(id="c1", name="Dry Foods"))
    db.add_all([
        Item(id="i1", name="Alpha", sku="SKU-A", category_id="c1", cost_price=10),
        Item(id="i2", name="Beta", sku="SKU-B", category_id="c1", cost_price=5),
    ])
    db.add_all([
        ItemStock(id="s1", item_id="i1", branch_id="b1", quantity=20),
        ItemStock(id="s2", item_id="i2", branch_id="b1", quantity=-18),
    ])
    db.add_all([
        SalesOrder(
            id="so-1",
            number="SO-1",
            branch_id="b1",
            branch_name="Main",
            customer_name="Walk-in",
            date="2025-01-01",
            status=SalesOrderStatus.confirmed,
        ),
        SalesOrder(
            id="so-2",
            number="SO-2",
            branch_id="b1",
            branch_name="Main",
            customer_name="Walk-in",
            date="2025-01-02",
            status=SalesOrderStatus.confirmed,
        ),
        StockReservation(
            id="r1", item_id="i1", branch_id="b1", qty=5,
            source_type="sales_order", source_ref="so-1",
            status=StockReservationStatus.active,
        ),
        StockReservation(
            id="r2", item_id="i1", branch_id="b1", qty=7,
            source_type="sales_order", source_ref="so-2",
            status=StockReservationStatus.released,
        ),
    ])
    await db.commit()
    return db


async def _rows(db: AsyncSession, sort_by: str = "product_name", sort_order: str = "asc") -> list[dict]:
    page = await current_stock(
        branch_id=None,
        search=None,
        sort_by=sort_by,
        sort_order=sort_order,
        skip=0,
        limit=50,
        db=db,
    )
    return page["items"]


def _current_stock_column_keys() -> list[str]:
    for category in REPORT_CATEGORIES:
        for report in category["reports"]:
            if report["id"] == "current-stock":
                return [column["key"] for column in report["columns"]]
    raise AssertionError("current-stock report not found in catalog")


def test_inventory_snapshot_reports_hide_date_range_filter():
    report_ids = {
        report["id"]
        for category in REPORT_CATEGORIES
        for report in category["reports"]
    }
    no_date_reports = {"low-stock", "out-of-stock", "expiry-batches"}
    for report_id in sorted(no_date_reports):
        report = next(report for category in REPORT_CATEGORIES for report in category["reports"] if report["id"] == report_id)
        assert report.get("dateFilter") == "none", f"{report_id} should not show a date range"
    current_stock_report = next(report for category in REPORT_CATEGORIES for report in category["reports"] if report["id"] == "current-stock")
    assert current_stock_report.get("dateFilter") == "asOf", "current-stock should use an as-of valuation date"
    assert report_ids.issuperset(no_date_reports | {"current-stock"})


def test_current_stock_splits_stock_reserved_available():
    async def scenario():
        db = await _build_session()
        try:
            rows = {row["product_code"]: row for row in await _rows(db)}
        finally:
            await db.close()
        return rows

    rows = asyncio.run(scenario())

    alpha = rows["SKU-A"]
    assert alpha["stock"] == 20
    assert alpha["reserved_stock"] == 5  # released reservation is ignored
    assert alpha["available_qty"] == 15
    assert alpha["stock_value"] == 200

    beta = rows["SKU-B"]
    assert beta["stock"] == -18  # oversold quantity shown as-is
    assert beta["reserved_stock"] == 0
    assert beta["available_qty"] == -18
    assert beta["stock_value"] == 0  # negative stock valued at zero


def test_current_stock_today_uses_live_inventory_without_snapshot():
    async def scenario():
        db = await _build_session()
        try:
            page = await current_stock(
                branch_id=None,
                search=None,
                sort_by="product_code",
                sort_order="asc",
                skip=0,
                limit=50,
                date_to=business_today().isoformat(),
                db=db,
            )
            return page["items"]
        finally:
            await db.close()

    rows = asyncio.run(scenario())
    assert {row["product_code"] for row in rows} == {"SKU-A", "SKU-B"}
    assert {row["product_code"]: row["stock"] for row in rows} == {
        "SKU-A": 20,
        "SKU-B": -18,
    }


def test_current_stock_past_date_reconstructs_quantity_from_movements():
    async def scenario():
        db = await _build_session()
        try:
            today = business_today()
            db.add_all([
                StockMovement(
                    id="move-a-after-cutoff",
                    item_id="i1",
                    branch_id="b1",
                    delta=5,
                    before_qty=15,
                    after_qty=20,
                    movement_type="receipt",
                    created_at=datetime.combine(today, time(hour=12)),
                ),
                StockMovement(
                    id="move-b-after-cutoff",
                    item_id="i2",
                    branch_id="b1",
                    delta=-3,
                    before_qty=-15,
                    after_qty=-18,
                    movement_type="sale",
                    created_at=datetime.combine(today, time(hour=12)),
                ),
            ])
            await db.commit()
            page = await current_stock(
                branch_id=None,
                search=None,
                sort_by="product_code",
                sort_order="asc",
                skip=0,
                limit=50,
                date_to=(today - date.resolution).isoformat(),
                db=db,
            )
            return page["items"]
        finally:
            await db.close()

    rows = asyncio.run(scenario())
    assert {row["product_code"]: row["stock"] for row in rows} == {
        "SKU-A": 15,
        "SKU-B": -15,
    }


def test_current_stock_uses_ist_day_boundaries_for_sales_near_midnight():
    async def scenario():
        db = await _build_session()
        try:
            day = business_today() - timedelta(days=2)
            movements = []
            for label, local_time in (("early", time(0, 30)), ("late", time(23, 30))):
                local_dt = datetime.combine(day, local_time, tzinfo=ZoneInfo("Asia/Kolkata"))
                utc_dt = local_dt.astimezone(timezone.utc).replace(tzinfo=None)
                movements.append(
                    StockMovement(
                        id=f"midnight-{label}",
                        item_id="i1",
                        branch_id="b1",
                        delta=1,
                        before_qty=19,
                        after_qty=20,
                        movement_type="sale",
                        created_at=utc_dt,
                    )
                )
            db.add_all(movements)
            await db.commit()
            selected_day = await current_stock(
                branch_id=None,
                search=None,
                sort_by="product_code",
                sort_order="asc",
                skip=0,
                limit=50,
                date_to=day.isoformat(),
                db=db,
            )
            previous_day = await current_stock(
                branch_id=None,
                search=None,
                sort_by="product_code",
                sort_order="asc",
                skip=0,
                limit=50,
                date_to=(day - timedelta(days=1)).isoformat(),
                db=db,
            )
            return selected_day, previous_day
        finally:
            await db.close()

    selected_day, previous_day = asyncio.run(scenario())
    selected_item = next(row for row in selected_day["items"] if row["product_code"] == "SKU-A")
    previous_item = next(row for row in previous_day["items"] if row["product_code"] == "SKU-A")
    assert selected_item["stock"] == 20
    assert previous_item["stock"] == 18
    assert selected_day["reserved_is_current"] is True


def test_business_day_bounds_are_half_open_utc_instants():
    day = date(2026, 11, 1)
    start_utc, next_start_utc = business_day_bounds_utc(day)
    assert start_utc == datetime(2026, 10, 31, 18, 30)
    assert next_start_utc == datetime(2026, 11, 1, 18, 30)


def test_current_stock_rows_cover_catalog_columns():
    async def scenario():
        db = await _build_session()
        try:
            return await _rows(db)
        finally:
            await db.close()

    rows = asyncio.run(scenario())
    expected = set(_current_stock_column_keys())
    assert expected == {
        "product_code", "product_name", "category", "branch",
        "stock", "reserved_stock", "available_qty", "stock_value",
    }
    for row in rows:
        assert expected <= set(row.keys())


def test_current_stock_summary_only_returns_single_total_row():
    async def scenario():
        db = await _build_session()
        try:
            return await current_stock(
                branch_id=None,
                search=None,
                sort_by="product_name",
                sort_order="asc",
                skip=0,
                limit=1,
                summary_only=True,
                db=db,
            )
        finally:
            await db.close()

    page = asyncio.run(scenario())
    assert page["total"] == 2
    assert page["skip"] == 0
    assert page["limit"] == 1
    assert len(page["items"]) == 1
    row = page["items"][0]
    assert row["product_code"] == "TOTAL"
    assert row["product_name"] == "TOTAL"
    assert row["stock"] == 2
    assert row["reserved_stock"] == 5
    assert row["available_qty"] == -3
    assert row["stock_value"] == 200


def test_current_stock_reservations_lists_active_sales_orders_for_item():
    async def scenario():
        db = await _build_session()
        try:
            actor = User(
                id="reservation-report-user",
                name="Reservation Tester",
                email="reservation@example.com",
                hashed_password="x",
                all_branches=True,
            )
            db.add(actor)
            await db.commit()
            page = await current_stock_reservations(
                branch_id="b1",
                item_id="i1",
                search=None,
                sort_by="date",
                sort_order="desc",
                skip=0,
                limit=50,
                db=db,
                user=actor,
            )
            return page["items"]
        finally:
            await db.close()

    rows = asyncio.run(scenario())
    assert rows == [
        {
            "sales_order_number": "SO-1",
            "customer": "Walk-in",
            "branch": "Main",
            "date": "2025-01-01",
            "reserved_qty": 5,
            "status": "active",
            "product_code": "SKU-A",
            "product_name": "Alpha",
        }
    ]

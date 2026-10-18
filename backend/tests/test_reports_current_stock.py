"""Current Stock report — Stock / Reserved / Available split matches Items & Stock."""
from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import (
    Branch,
    Category,
    Item,
    ItemStock,
    StockReservation,
    StockReservationStatus,
)
from src.report_catalog import REPORT_CATEGORIES
from src.routes.reports import current_stock


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
        StockReservation(
            id="r1", item_id="i1", branch_id="b1", qty=5,
            source_type="sales_order", source_ref="SO-1",
            status=StockReservationStatus.active,
        ),
        StockReservation(
            id="r2", item_id="i1", branch_id="b1", qty=7,
            source_type="sales_order", source_ref="SO-2",
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


def test_current_stock_sorts_by_available():
    async def scenario():
        db = await _build_session()
        try:
            return await _rows(db, sort_by="available_qty", sort_order="asc")
        finally:
            await db.close()

    rows = asyncio.run(scenario())
    assert [row["product_code"] for row in rows] == ["SKU-B", "SKU-A"]

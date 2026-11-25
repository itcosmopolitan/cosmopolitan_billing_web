from __future__ import annotations

import asyncio
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from scripts.backfill_stock_movement_effective_date import run
from src.database import Base
from src.models import (
    AdjustmentRequest,
    Branch,
    Category,
    ComplimentaryEntry,
    GoodsReceiptNote,
    Item,
    ItemBranchConfig,
    PurchaseBill,
    SaleInvoice,
    SalesReturn,
    StockMovement,
    StockTransfer,
    Vendor,
    VendorReturn,
)
from src.routes._atomic import adjust_stock_atomic


def test_backfill_is_document_aware_idempotent_and_dry_run_is_read_only(tmp_path):
    async def scenario():
        database_path = tmp_path / "effective-date.sqlite"
        database_url = f"sqlite+aiosqlite:///{database_path}"
        engine = create_async_engine(database_url)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            db.add_all([
                Branch(id="branch", name="Main", code="MAIN"),
                Category(id="category", name="Food"),
            ])
            db.add(Item(
                id="item", name="Chicken", sku="CH-1", category_id="category",
                cost_price=10,
            ))
            db.add(SaleInvoice(
                id="invoice", number="INV-1", branch_id="branch",
                date="2026-11-01", shipment_date="2026-10-31",
            ))
            db.add_all([
                StockMovement(
                    id="document-linked",
                    item_id="item",
                    branch_id="branch",
                    delta=-1,
                    before_qty=2,
                    after_qty=1,
                    movement_type="sale",
                    source_type="sale_invoice",
                    source_ref="invoice",
                    created_at=datetime(2026, 11, 2, 12, 0),
                ),
                StockMovement(
                    id="legacy-unlinked",
                    item_id="item",
                    branch_id="branch",
                    delta=1,
                    before_qty=1,
                    after_qty=2,
                    movement_type="manual",
                    source_type=None,
                    created_at=datetime(2026, 11, 1, 18, 0),
                ),
            ])
            await db.commit()

        dry_counts = await run(database_url, batch_size=1, apply_changes=False)
        async with factory() as db:
            unchanged = (await db.execute(
                select(StockMovement).order_by(StockMovement.id)
            )).scalars().all()
            assert all(row.effective_date is None for row in unchanged)

        applied_counts = await run(database_url, batch_size=1, apply_changes=True)
        repeated_counts = await run(database_url, batch_size=1, apply_changes=True)
        async with factory() as db:
            movements = {
                row.id: row.effective_date
                for row in (await db.execute(select(StockMovement))).scalars().all()
            }
        await engine.dispose()
        return dry_counts, applied_counts, repeated_counts, movements

    dry_counts, applied_counts, repeated_counts, movements = asyncio.run(scenario())
    assert dry_counts[("sale", "document_date")] == 1
    assert dry_counts[("manual", "created_at_ist_fallback")] == 1
    assert applied_counts == dry_counts
    assert not repeated_counts
    assert movements == {
        "document-linked": date(2026, 10, 31),
        "legacy-unlinked": date(2026, 11, 1),
    }


def test_atomic_stock_writes_use_the_source_document_dates():
    async def scenario():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            db.add_all([
                Branch(id="branch", name="Main", code="MAIN"),
                Category(id="category", name="Food"),
                Vendor(id="vendor", name="Vendor"),
            ])
            db.add(Item(
                id="item", name="Chicken", sku="CH-1", category_id="category",
                cost_price=10,
            ))
            db.add_all([
                SaleInvoice(
                    id="invoice", number="INV-1", branch_id="branch",
                    date="2026-11-01", shipment_date="2026-10-30",
                ),
                GoodsReceiptNote(
                    id="grn", number="GRN-1", vendor_id="vendor",
                    branch_id="branch", date="2026-10-29",
                ),
                PurchaseBill(
                    id="bill-only", number="BILL-1", vendor_id="vendor",
                    branch_id="branch", date="2026-10-28",
                ),
                SalesReturn(
                    id="sales-return", number="CN-1", invoice_id="invoice",
                    branch_id="branch", date="2026-10-27",
                ),
                VendorReturn(
                    id="vendor-return", number="VR-1", bill_id="bill-only",
                    vendor_id="vendor", branch_id="branch", date="2026-10-26",
                ),
                StockTransfer(
                    id="transfer", ref_number="TR-1", from_branch_id="branch",
                    to_branch_id="branch", recorded_date="2026-10-25",
                ),
                ComplimentaryEntry(
                    id="complimentary", number="COMP-1", reason="Sample",
                    branch_id="branch", date="2026-10-24",
                ),
                AdjustmentRequest(
                    id="adjustment", ref_number="ADJ-1", branch_id="branch",
                    item_id="item", item_name="Chicken", new_qty=1,
                    adjustment_date=date(2026, 10, 23),
                ),
                ItemBranchConfig(
                    id="config", item_id="item", branch_id="branch",
                    opening_stock_date=date(2026, 10, 22),
                ),
            ])
            await db.flush()
            movements = [
                ("grn", "grn", "grn"),
                ("grn", "grn", "bill-only"),
                ("sale", "sale_invoice", "invoice"),
                ("return", "sales_return", "sales-return"),
                ("vendor_return", "vendor_return", "vendor-return"),
                ("transfer", "transfer", "transfer"),
                ("complimentary", "complimentary_entry", "complimentary"),
                ("adjustment", "adjustment", "adjustment"),
                ("adjustment", "opening", "item"),
            ]
            for movement_type, source_type, source_ref in movements:
                await adjust_stock_atomic(
                    db,
                    item_id="item",
                    branch_id="branch",
                    delta=1,
                    movement_type=movement_type,
                    source_type=source_type,
                    source_ref=source_ref,
                )
            await db.commit()
            saved = (await db.execute(
                select(StockMovement).order_by(StockMovement.id)
            )).scalars().all()
            by_source = {
                (movement.source_type, movement.source_ref): movement.effective_date
                for movement in saved
            }
        await engine.dispose()
        return by_source

    by_source = asyncio.run(scenario())
    assert by_source == {
        ("grn", "grn"): date(2026, 10, 29),
        ("grn", "bill-only"): date(2026, 10, 28),
        ("sale_invoice", "invoice"): date(2026, 10, 30),
        ("sales_return", "sales-return"): date(2026, 10, 27),
        ("vendor_return", "vendor-return"): date(2026, 10, 26),
        ("transfer", "transfer"): date(2026, 10, 25),
        ("complimentary_entry", "complimentary"): date(2026, 10, 24),
        ("adjustment", "adjustment"): date(2026, 10, 23),
        ("opening", "item"): date(2026, 10, 22),
    }

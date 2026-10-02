import asyncio
import json
from datetime import date, timedelta
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import (
    Branch,
    Item,
    ItemBatch,
    ItemStock,
    PoolSaleAllocation,
    SaleInvoice,
    SaleLineItem,
    StockMovement,
    StockPool,
    StockPoolBranch,
)
from src.pool_sales import consume_clubbed_sale_line, reverse_pool_allocations_for_cancel
from src.routes._atomic import set_batch_quantity_atomic
from src.routes.reports import stock_movement
from src.stock_pools import pooled_item_quantities


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return session_factory()


async def _verify_pooled_quantities_filter_expiry_only_when_tracked() -> None:
    db = await _build_session()
    try:
        branch = Branch(id="branch-a", name="Branch A", code="A")
        pool = StockPool(id="pool-1", name="Pool", active=True, allow_cross_branch_sales=True)
        db.add_all([
            branch,
            pool,
            StockPoolBranch(id="member-a", pool_id=pool.id, branch_id=branch.id),
            Item(id="no-expiry", name="No expiry", batch_tracking=True, expiry_tracking=False),
            Item(id="with-expiry", name="Expiry tracked", batch_tracking=True, expiry_tracking=True),
        ])
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        db.add_all([
            ItemBatch(
                id="batch-no-expiry",
                item_id="no-expiry",
                branch_id=branch.id,
                batch_number="LOT-A",
                quantity=4,
                expiry_date=yesterday,
                active=True,
            ),
            ItemBatch(
                id="batch-expired",
                item_id="with-expiry",
                branch_id=branch.id,
                batch_number="LOT-B",
                quantity=6,
                expiry_date=yesterday,
                active=True,
            ),
            ItemBatch(
                id="batch-valid",
                item_id="with-expiry",
                branch_id=branch.id,
                batch_number="LOT-C",
                quantity=3,
                expiry_date=tomorrow,
                active=True,
            ),
        ])
        await db.commit()

        quantities = await pooled_item_quantities(
            db,
            item_ids=["no-expiry", "with-expiry"],
            pool_id=pool.id,
        )
        assert quantities == {"no-expiry": 4.0, "with-expiry": 3.0}
    finally:
        await db.close()


def test_pooled_quantities_respect_expiry_tracking() -> None:
    asyncio.run(_verify_pooled_quantities_filter_expiry_only_when_tracked())


async def _verify_untracked_draw_uses_branch_first_then_largest_owner() -> None:
    db = await _build_session()
    try:
        branch_a = Branch(id="branch-a", name="Branch A", code="A")
        branch_b = Branch(id="branch-b", name="Branch B", code="B")
        branch_c = Branch(id="branch-c", name="Branch C", code="C")
        item = Item(id="item-1", name="Widget", cost_price=7, batch_tracking=False)
        pool = StockPool(id="pool-1", name="Pool", active=True, allow_cross_branch_sales=True)
        invoice = SaleInvoice(
            id="invoice-1",
            number="POS-1",
            branch_id=branch_a.id,
            branch_name=branch_a.name,
            date=date.today().isoformat(),
        )
        line = SaleLineItem(
            id="line-1",
            invoice_id=invoice.id,
            item_id=item.id,
            name=item.name,
            qty=4,
            price=10,
            line_total=40,
        )
        db.add_all([
            branch_a,
            branch_b,
            branch_c,
            item,
            pool,
            StockPoolBranch(id="member-a", pool_id=pool.id, branch_id=branch_a.id),
            StockPoolBranch(id="member-b", pool_id=pool.id, branch_id=branch_b.id),
            StockPoolBranch(id="member-c", pool_id=pool.id, branch_id=branch_c.id),
            ItemStock(id="stock-a", item_id=item.id, branch_id=branch_a.id, quantity=1),
            ItemStock(id="stock-b", item_id=item.id, branch_id=branch_b.id, quantity=5),
            ItemStock(id="stock-c", item_id=item.id, branch_id=branch_c.id, quantity=3),
            invoice,
            line,
        ])
        await db.commit()

        allocations = await consume_clubbed_sale_line(
            db,
            item=item,
            line_input=SimpleNamespace(qty=4, batch_allocation=None),
            line=line,
            pool=pool,
            member_branches=[branch_a, branch_b, branch_c],
            sale_branch_id=branch_a.id,
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            created_by="Tester",
            allow_oversell=False,
        )
        await db.commit()

        assert len(allocations) == 1
        assert allocations[0]["owner_branch_id"] == branch_b.id
        assert allocations[0]["qty"] == 3
        stock = dict((await db.execute(
            select(ItemStock.branch_id, ItemStock.quantity).where(ItemStock.item_id == item.id)
        )).all())
        assert stock == {branch_a.id: 0, branch_b.id: 2, branch_c.id: 3}

        movement_types = {
            (movement.branch_id, movement.movement_type)
            for movement in (await db.execute(select(StockMovement))).scalars().all()
        }
        assert (branch_b.id, "pool_transfer_out") in movement_types
        assert (branch_a.id, "pool_transfer_in") in movement_types
        assert (branch_a.id, "sale") in movement_types
        assert (await db.execute(select(PoolSaleAllocation))).scalars().one().qty == 3
    finally:
        await db.close()


def test_untracked_draw_prioritizes_sale_branch_then_largest_owner() -> None:
    asyncio.run(_verify_untracked_draw_uses_branch_first_then_largest_owner())


async def _verify_tracked_draw_and_cancel_restore_original_batch() -> None:
    db = await _build_session()
    try:
        branch_a = Branch(id="branch-a", name="Branch A", code="A")
        branch_b = Branch(id="branch-b", name="Branch B", code="B")
        item = Item(
            id="item-tracked",
            name="Tracked Widget",
            cost_price=7,
            batch_tracking=True,
            expiry_tracking=True,
        )
        pool = StockPool(
            id="pool-tracked",
            name="Tracked Pool",
            active=True,
            allow_cross_branch_sales=True,
        )
        invoice = SaleInvoice(
            id="invoice-tracked",
            number="POS-TRACKED",
            branch_id=branch_a.id,
            branch_name=branch_a.name,
            date=date.today().isoformat(),
        )
        line = SaleLineItem(
            id="line-tracked",
            invoice_id=invoice.id,
            item_id=item.id,
            name=item.name,
            qty=4,
            price=10,
            line_total=40,
        )
        local_batch = ItemBatch(
            id="batch-local",
            item_id=item.id,
            branch_id=branch_a.id,
            batch_number="LOCAL",
            quantity=1,
            initial_qty=1,
            cost_price=9,
            expiry_date=(date.today() + timedelta(days=10)).isoformat(),
            received_date=date.today().isoformat(),
            active=True,
        )
        expired_batch = ItemBatch(
            id="batch-expired-source",
            item_id=item.id,
            branch_id=branch_b.id,
            batch_number="EXPIRED",
            quantity=4,
            initial_qty=4,
            cost_price=2,
            expiry_date=(date.today() - timedelta(days=1)).isoformat(),
            received_date=date.today().isoformat(),
            active=True,
        )
        source_batch = ItemBatch(
            id="batch-source",
            item_id=item.id,
            branch_id=branch_b.id,
            batch_number="SOURCE",
            quantity=5,
            initial_qty=5,
            cost_price=4,
            expiry_date=(date.today() + timedelta(days=30)).isoformat(),
            received_date=date.today().isoformat(),
            active=True,
        )
        db.add_all([
            branch_a,
            branch_b,
            item,
            pool,
            StockPoolBranch(id="tracked-member-a", pool_id=pool.id, branch_id=branch_a.id),
            StockPoolBranch(id="tracked-member-b", pool_id=pool.id, branch_id=branch_b.id),
            ItemStock(id="tracked-stock-a", item_id=item.id, branch_id=branch_a.id, quantity=1),
            ItemStock(id="tracked-stock-b", item_id=item.id, branch_id=branch_b.id, quantity=9),
            local_batch,
            expired_batch,
            source_batch,
            invoice,
            line,
        ])
        await db.commit()

        allocations = await consume_clubbed_sale_line(
            db,
            item=item,
            line_input=SimpleNamespace(
                qty=4,
                batch_allocation=[SimpleNamespace(batch_id=local_batch.id, qty=1)],
            ),
            line=line,
            pool=pool,
            member_branches=[branch_a, branch_b],
            sale_branch_id=branch_a.id,
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            created_by="Tester",
            allow_oversell=False,
        )
        await db.commit()

        assert len(allocations) == 1
        assert allocations[0]["source_batch_id"] == source_batch.id
        assert allocations[0]["source_batch_no"] == source_batch.batch_number
        assert allocations[0]["unit_cost"] == source_batch.cost_price
        assert allocations[0]["qty"] == 3
        manifest = json.loads(line.batch_allocation)
        destination_batch_id = next(
            entry["batch_id"] for entry in manifest
            if entry["batch_id"] != local_batch.id
        )
        destination_batch = (await db.execute(
            select(ItemBatch).where(ItemBatch.id == destination_batch_id)
        )).scalar_one()
        await db.refresh(source_batch)
        await db.refresh(expired_batch)
        await db.refresh(destination_batch)
        assert destination_batch.batch_number == source_batch.batch_number
        assert destination_batch.quantity == 0
        assert source_batch.quantity == 2
        assert expired_batch.quantity == 4

        # Cancellation restores the sale branch first, then moves the pooled
        # portion back to its exact original source batch.
        await set_batch_quantity_atomic(db, batch_id=local_batch.id, new_qty=1)
        await set_batch_quantity_atomic(db, batch_id=destination_batch_id, new_qty=3)
        reversals = await reverse_pool_allocations_for_cancel(
            db,
            invoice_id=invoice.id,
            invoice_number=invoice.number,
            created_by="Tester",
        )
        await db.commit()

        await db.refresh(source_batch)
        await db.refresh(destination_batch)
        assert len(reversals) == 1
        assert source_batch.quantity == 5
        assert destination_batch.quantity == 0
        stock = dict((await db.execute(
            select(ItemStock.branch_id, ItemStock.quantity).where(ItemStock.item_id == item.id)
        )).all())
        assert stock == {branch_a.id: 1, branch_b.id: 9}
        movement_report = await stock_movement(skip=0, limit=100, db=db)
        reversal_rows = [
            row for row in movement_report["items"]
            if row["movement_type"].startswith("Pool reversal")
        ]
        assert {
            (row["movement_type"], row["branch"], row["quantity"])
            for row in reversal_rows
        } == {
            ("Pool reversal out", branch_a.name, -3),
            ("Pool reversal in", branch_b.name, 3),
        }
    finally:
        await db.close()


def test_tracked_draw_and_cancel_restore_original_batch() -> None:
    asyncio.run(_verify_tracked_draw_and_cancel_restore_original_batch())

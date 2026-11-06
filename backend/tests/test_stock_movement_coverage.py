from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, Item, ItemBatch, ItemStock, StockMovement
from src.routes._atomic import set_batch_quantity_atomic, set_stock_atomic
from src.routes._stock_adjust_apply import apply_stock_adjustment
from src.routes.items import _seed_opening_stock
from src.routes.reports import stock_reconciliation
from src.models import User


async def _session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    db = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()
    db.add_all([
        Branch(id="branch-1", name="Main", code="MAIN"),
        Item(id="item-1", name="Rice", sku="RICE", cost_price=10),
    ])
    await db.commit()
    return db


def test_set_stock_atomic_records_absolute_quantity_delta():
    async def scenario():
        db = await _session()
        try:
            db.add(ItemStock(id="stock-1", item_id="item-1", branch_id="branch-1", quantity=8))
            await db.commit()

            await set_stock_atomic(
                db,
                item_id="item-1",
                branch_id="branch-1",
                new_qty=3,
                source_ref="count-1",
            )
            await db.commit()
            movement = (await db.execute(select(StockMovement))).scalar_one()
            return movement
        finally:
            await db.close()

    movement = asyncio.run(scenario())
    assert movement.delta == -5
    assert movement.before_qty == 8
    assert movement.after_qty == 3
    assert movement.movement_type == "adjustment"
    assert movement.source_type == "adjustment"
    assert movement.source_ref == "count-1"


def test_opening_stock_records_a_movement_for_untracked_items():
    async def scenario():
        db = await _session()
        try:
            item = (await db.execute(select(Item).where(Item.id == "item-1"))).scalar_one()
            await _seed_opening_stock(
                db,
                item=item,
                branch_id="branch-1",
                qty=12,
                cost_price=10,
            )
            await db.commit()
            return (await db.execute(select(StockMovement))).scalar_one()
        finally:
            await db.close()

    movement = asyncio.run(scenario())
    assert movement.delta == 12
    assert movement.movement_type == "adjustment"
    assert movement.source_type == "opening"
    assert movement.source_ref == "item-1"


def test_opening_batch_movement_links_the_created_batch():
    async def scenario():
        db = await _session()
        try:
            item = (await db.execute(select(Item).where(Item.id == "item-1"))).scalar_one()
            item.batch_tracking = True
            await _seed_opening_stock(
                db,
                item=item,
                branch_id="branch-1",
                qty=12,
                cost_price=10,
            )
            await db.commit()
            return (await db.execute(select(StockMovement))).scalar_one()
        finally:
            await db.close()

    movement = asyncio.run(scenario())
    assert movement.delta == 12
    assert movement.source_type == "opening"
    assert movement.batch_id is not None


def test_untracked_approved_adjustment_records_a_movement():
    async def scenario():
        db = await _session()
        try:
            db.add(ItemStock(id="stock-1", item_id="item-1", branch_id="branch-1", quantity=8))
            await db.commit()
            await apply_stock_adjustment(
                db,
                item_id="item-1",
                branch_id="branch-1",
                new_qty=4,
                reason="cycle-count",
                notes="Count corrected",
            )
            await db.commit()
            return (await db.execute(select(StockMovement))).scalar_one()
        finally:
            await db.close()

    movement = asyncio.run(scenario())
    assert movement.delta == -4
    assert movement.source_ref == "cycle-count"
    assert movement.notes == "Count corrected"


def test_adjustment_batch_consumption_fallback_records_absolute_delta():
    async def scenario():
        db = await _session()
        try:
            item = (await db.execute(select(Item).where(Item.id == "item-1"))).scalar_one()
            item.batch_tracking = True
            db.add_all([
                ItemStock(id="stock-1", item_id="item-1", branch_id="branch-1", quantity=10),
                ItemBatch(
                    id="batch-1",
                    item_id="item-1",
                    branch_id="branch-1",
                    batch_number="B-1",
                    quantity=2,
                    initial_qty=2,
                    cost_price=10,
                ),
            ])
            await db.commit()
            await apply_stock_adjustment(
                db,
                item_id="item-1",
                branch_id="branch-1",
                new_qty=5,
                reason="cycle-count",
            )
            await db.commit()
            return (await db.execute(select(StockMovement))).scalar_one()
        finally:
            await db.close()

    movement = asyncio.run(scenario())
    assert movement.delta == -5
    assert movement.before_qty == 10
    assert movement.after_qty == 5


def test_batch_decrement_clamp_records_movement_with_batch_id():
    async def scenario():
        db = await _session()
        try:
            db.add_all([
                ItemStock(id="stock-1", item_id="item-1", branch_id="branch-1", quantity=2),
                ItemBatch(
                    id="batch-1",
                    item_id="item-1",
                    branch_id="branch-1",
                    batch_number="B-1",
                    quantity=10,
                    initial_qty=10,
                    cost_price=10,
                ),
            ])
            await db.commit()
            await set_batch_quantity_atomic(db, batch_id="batch-1", new_qty=5)
            await db.commit()
            return (await db.execute(select(StockMovement))).scalar_one()
        finally:
            await db.close()

    movement = asyncio.run(scenario())
    assert movement.delta == -2
    assert movement.before_qty == 2
    assert movement.after_qty == 0
    assert movement.batch_id == "batch-1"


def test_stock_reconciliation_lists_only_mismatches():
    async def scenario():
        db = await _session()
        try:
            db.add(ItemStock(id="stock-1", item_id="item-1", branch_id="branch-1", quantity=8))
            db.add(StockMovement(
                id="movement-1",
                item_id="item-1",
                branch_id="branch-1",
                delta=5,
                before_qty=0,
                after_qty=5,
                movement_type="grn",
            ))
            await db.commit()
            return await stock_reconciliation(
                branch_id=None,
                skip=0,
                limit=50,
                db=db,
                user=User(id="user-1", name="Tester", hashed_password="x", all_branches=True),
            )
        finally:
            await db.close()

    result = asyncio.run(scenario())
    assert result["total"] == 1
    row = result["items"][0]
    assert row["stock_quantity"] == 8
    assert row["ledger_quantity"] == 5
    assert row["difference"] == 3

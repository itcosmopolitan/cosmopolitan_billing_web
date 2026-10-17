from __future__ import annotations

import asyncio
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.item_branch import weighted_average_unit_cost
from src.models import (
    Branch,
    Item,
    ItemBatch,
    ItemStock,
    StockReservation,
    StockTransfer,
    TransferLineItem,
    TransferStatus,
)
from src.routes._atomic import add_batch_atomic, adjust_stock_atomic, overdraw_stock_atomic
from src.routes._stock_ledger import get_available_qty, get_physical_qty, reserve_for_sales_order
from src.routes.transfers import _dispatch_transfer

ITEM = "item-1"
BRANCH = "br-1"


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()


async def _seed(db: AsyncSession, *, tracked: bool, on_hand: float = 0.0) -> None:
    db.add(Branch(id=BRANCH, name="Main", code="MAIN", allow_overselling=True))
    db.add(Item(id=ITEM, name="Widget", batch_tracking=tracked))
    db.add(ItemStock(id="stock-1", item_id=ITEM, branch_id=BRANCH, quantity=on_hand))
    await db.commit()


async def _stock(db: AsyncSession) -> float:
    return await get_physical_qty(db, item_id=ITEM, branch_id=BRANCH)


async def _batch_sum(db: AsyncSession) -> float:
    return float((await db.execute(
        select(func.coalesce(func.sum(ItemBatch.quantity), 0)).where(
            ItemBatch.item_id == ITEM, ItemBatch.branch_id == BRANCH,
        )
    )).scalar() or 0)


async def _placeholder_qty(db: AsyncSession) -> float | None:
    row = (await db.execute(
        select(ItemBatch.quantity).where(
            ItemBatch.item_id == ITEM,
            ItemBatch.branch_id == BRANCH,
            ItemBatch.is_overdraw == True,  # noqa: E712
        )
    )).scalars().first()
    return None if row is None else float(row)


def test_untracked_sale_goes_negative_instead_of_clamping_to_zero():
    asyncio.run(_run_untracked_negative())


async def _run_untracked_negative() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=False, on_hand=3)
        await overdraw_stock_atomic(
            db, item_id=ITEM, branch_id=BRANCH, qty=5, tracked=False,
            source_type="sale", source_ref="SO-1",
        )
        await db.commit()
        assert await _stock(db) == -2
    finally:
        await db.close()


def test_tracked_sale_drains_batches_then_overdraws_placeholder():
    asyncio.run(_run_tracked_overdraw())


async def _run_tracked_overdraw() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=True)
        await add_batch_atomic(db, item_id=ITEM, branch_id=BRANCH, qty=3, batch_number="B1", cost_price=10)
        await db.commit()

        await overdraw_stock_atomic(
            db, item_id=ITEM, branch_id=BRANCH, qty=5, tracked=True,
            source_type="sale", source_ref="SO-1",
        )
        await db.commit()

        assert await _stock(db) == -2
        assert await _placeholder_qty(db) == -2
        assert await _batch_sum(db) == -2
    finally:
        await db.close()


def test_receipt_settles_overdraw_placeholder_before_new_lot():
    asyncio.run(_run_receipt_settles())


async def _run_receipt_settles() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=True)
        await overdraw_stock_atomic(
            db, item_id=ITEM, branch_id=BRANCH, qty=2, tracked=True,
            source_type="sale", source_ref="SO-1",
        )
        await db.commit()

        lot = await add_batch_atomic(
            db, item_id=ITEM, branch_id=BRANCH, qty=10, batch_number="B2", cost_price=30,
        )
        await db.commit()

        assert await _stock(db) == 8
        assert await _placeholder_qty(db) == 0
        assert lot.quantity == 8
        assert lot.initial_qty == 10
        assert await _batch_sum(db) == await _stock(db)
    finally:
        await db.close()


def test_available_goes_negative_when_reserved_exceeds_physical():
    asyncio.run(_run_available_negative())


async def _run_available_negative() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=False, on_hand=0)
        line = SimpleNamespace(item_id=ITEM, qty=4, name="Widget", id="line-1")
        await reserve_for_sales_order(
            db, order_id="SO-1", branch_id=BRANCH, lines=[line], allow_oversell=True,
        )
        await db.commit()

        reserved = (await db.execute(select(StockReservation.qty))).scalars().all()
        assert [float(q) for q in reserved] == [4]
        assert await get_available_qty(db, item_id=ITEM, branch_id=BRANCH) == -4
    finally:
        await db.close()


def test_reservation_without_overselling_still_rejects_shortage():
    asyncio.run(_run_reservation_rejects())


async def _run_reservation_rejects() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=False, on_hand=1)
        line = SimpleNamespace(item_id=ITEM, qty=4, name="Widget", id="line-1")
        try:
            await reserve_for_sales_order(
                db, order_id="SO-1", branch_id=BRANCH, lines=[line], allow_oversell=False,
            )
        except ValueError as exc:
            assert "Insufficient stock" in str(exc)
        else:
            raise AssertionError("expected shortage ValueError")
    finally:
        await db.close()


def test_adjust_without_allow_negative_still_blocks_below_zero():
    asyncio.run(_run_adjust_blocks())


async def _run_adjust_blocks() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=False, on_hand=1)
        try:
            await adjust_stock_atomic(
                db, item_id=ITEM, branch_id=BRANCH, delta=-5, movement_type="sale",
            )
        except ValueError:
            await db.rollback()
        else:
            raise AssertionError("expected ValueError without allow_negative")
        assert await _stock(db) == 1
    finally:
        await db.close()


def test_weighted_average_cost_still_clamps_negative_on_hand_to_zero():
    assert weighted_average_unit_cost(-2, 25, 10, 30) == 30.0


def test_transfer_dispatch_blocks_when_source_available_is_short():
    asyncio.run(_run_transfer_dispatch_blocked())


async def _run_transfer_dispatch_blocked() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=False, on_hand=2)
        db.add(Branch(id="br-2", name="Dest", code="DEST", allow_overselling=False))
        transfer = StockTransfer(
            id="tr-1", ref_number="TR-1", from_branch_id=BRANCH, to_branch_id="br-2",
            status=TransferStatus.pending,
        )
        db.add(transfer)
        db.add(TransferLineItem(id="tl-1", transfer_id="tr-1", item_id=ITEM, item_name="Widget", qty=5))
        await db.commit()

        user = SimpleNamespace(id="u-1", name="Tester")
        with_raises = False
        try:
            await _dispatch_transfer(
                db, transfer, "tr-1", user=user, approved_by="Tester", request=None,
            )
        except HTTPException as exc:
            with_raises = True
            assert exc.status_code == 409
            assert exc.detail["code"] == "insufficient_transfer_stock"
            assert exc.detail["requested"] == 5
            assert exc.detail["available"] == 2
            assert exc.detail["item_name"] == "Widget"
            assert exc.detail["message"] == "Insufficient stock for Widget: requested 5, available 2"
        assert with_raises
        await db.refresh(transfer)
        assert transfer.status == TransferStatus.pending
        assert await _stock(db) == 2
    finally:
        await db.close()

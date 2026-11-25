import asyncio
from pathlib import Path
import sys

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Item,
    ItemBatch,
    ItemBranchConfig,
    ItemStock,
    PurchaseBill,
    PurchaseLineItem,
    Vendor,
)
from src.routes.purchases import (  # noqa: E402
    BulkDeleteIn,
    ReturnLine,
    VendorReturnCreate,
    bulk_delete_returns,
    create_return,
    undo_void_vendor_return,
    void_return,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_local = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return session_local()


async def _seed(db: AsyncSession, *, tracked: bool) -> None:
    branch = Branch(id="branch-1", name="Main", code="MAIN")
    vendor = Vendor(id="vendor-1", name="Acme")
    item = Item(id="item-1", name="Widget", sku="W-1", cost_price=30, batch_tracking=tracked)
    bill = PurchaseBill(
        id="bill-1",
        number="PB-1",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-11-25",
        subtotal=400,
        tax_total=0,
        total=400,
        paid_amount=0,
        status="pending",
    )
    seed_rows = [
        branch,
        vendor,
        item,
        ItemBranchConfig(
            id="item-branch-1",
            item_id=item.id,
            branch_id=branch.id,
            cost_price=30,
            is_available=True,
        ),
        ItemStock(id="stock-1", item_id=item.id, branch_id=branch.id, quantity=20),
        bill,
        PurchaseLineItem(
            id="bill-line-1",
            bill_id=bill.id,
            item_id=item.id,
            name=item.name,
            qty=10,
            cost=40,
            tax_rate=0,
            line_total=400,
        ),
    ]
    if tracked:
        seed_rows.extend([
            ItemBatch(
                id="old-batch",
                item_id=item.id,
                branch_id=branch.id,
                batch_number="OLD",
                quantity=10,
                initial_qty=10,
                cost_price=20,
                source_ref="old-bill",
                source_type="grn",
            ),
            ItemBatch(
                id="bill-batch",
                item_id=item.id,
                branch_id=branch.id,
                batch_number="BILL",
                quantity=10,
                initial_qty=10,
                cost_price=40,
                source_ref=bill.id,
                source_type="grn",
            ),
        ])
    db.add_all(seed_rows)
    await db.commit()


async def _cost_and_stock(db: AsyncSession) -> tuple[float, float]:
    config = (await db.execute(
        select(ItemBranchConfig).where(ItemBranchConfig.item_id == "item-1")
    )).scalar_one()
    stock = (await db.execute(
        select(ItemStock).where(ItemStock.item_id == "item-1")
    )).scalar_one()
    return config.cost_price, stock.quantity


async def _run_vendor_return_costing_lifecycle(*, tracked: bool) -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=tracked)
        created = await create_return(
            VendorReturnCreate(
                bill_id="bill-1",
                vendor_id="vendor-1",
                reason="Return excess stock",
                items=[
                    ReturnLine(
                        bill_line_id="bill-line-1",
                        item_id="item-1",
                        name="Widget",
                        original_qty=10,
                        return_qty=5,
                        cost=40,
                        tax_rate=0,
                    )
                ],
            ),
            db=db,
        )
        cost, quantity = await _cost_and_stock(db)
        assert cost == pytest.approx((20 * 30 - 5 * 40) / 15)
        assert quantity == pytest.approx(15)

        await void_return(created["id"], db=db)
        cost, quantity = await _cost_and_stock(db)
        assert cost == pytest.approx(30)
        assert quantity == pytest.approx(20)

        await undo_void_vendor_return(created["id"], db=db)
        cost, quantity = await _cost_and_stock(db)
        assert cost == pytest.approx((20 * 30 - 5 * 40) / 15)
        assert quantity == pytest.approx(15)

        await bulk_delete_returns(BulkDeleteIn(ids=[created["id"]]), db=db)
        cost, quantity = await _cost_and_stock(db)
        assert cost == pytest.approx(30)
        assert quantity == pytest.approx(20)
    finally:
        await db.close()


async def _run_delete_voided_return() -> None:
    db = await _build_session()
    try:
        await _seed(db, tracked=False)
        created = await create_return(
            VendorReturnCreate(
                bill_id="bill-1",
                vendor_id="vendor-1",
                reason="Return excess stock",
                items=[
                    ReturnLine(
                        bill_line_id="bill-line-1",
                        item_id="item-1",
                        name="Widget",
                        original_qty=10,
                        return_qty=5,
                        cost=40,
                        tax_rate=0,
                    )
                ],
            ),
            db=db,
        )
        await void_return(created["id"], db=db)
        await bulk_delete_returns(BulkDeleteIn(ids=[created["id"]]), db=db)

        cost, quantity = await _cost_and_stock(db)
        assert cost == pytest.approx(30)
        assert quantity == pytest.approx(20)
    finally:
        await db.close()


@pytest.mark.parametrize("tracked", [False, True])
def test_vendor_return_recalculates_branch_wac_and_reverses_it_on_void_and_delete(tracked: bool) -> None:
    asyncio.run(_run_vendor_return_costing_lifecycle(tracked=tracked))


def test_deleting_a_voided_vendor_return_does_not_restore_stock_twice() -> None:
    asyncio.run(_run_delete_voided_return())

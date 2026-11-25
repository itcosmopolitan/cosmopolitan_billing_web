import asyncio
from datetime import datetime, timedelta
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    AuditLog,
    Branch,
    GRNLineItem,
    GRNStatus,
    GoodsReceiptNote,
    Item,
    ItemBatch,
    ItemBranchConfig,
    ItemStock,
    PurchaseBill,
    PurchaseLineItem,
    Role,
    StockMovement,
    User,
    UserRole,
    Vendor,
)
from src.routes.purchases import (  # noqa: E402
    BillLineUpdate,
    BillUpdate,
    cancel_bill,
    cancel_grn,
    update_bill,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_local = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return session_local()


async def _seed_receipt(
    db: AsyncSession,
    *,
    tracked: bool = False,
    received_qty: float = 20,
    on_hand_qty: float = 30,
    cost: float = 40,
    branch_cost: float = 36.666667,
    batch_qty: float = 20,
) -> tuple[User, GoodsReceiptNote]:
    branch = Branch(id="branch-1", name="Main", code="MAIN")
    vendor = Vendor(id="vendor-1", name="Acme")
    item = Item(
        id="item-1",
        name="Widget",
        sku="W-1",
        cost_price=30,
        batch_tracking=tracked,
    )
    grn = GoodsReceiptNote(
        id="grn-1",
        number="GRN-1",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-11-25",
        subtotal=received_qty * cost,
        tax_total=0,
        total=received_qty * cost,
        status=GRNStatus.received,
        converted_bill_id="bill-1",
    )
    bill = PurchaseBill(
        id="bill-1",
        number="PB-1",
        vendor_id=vendor.id,
        vendor_name=vendor.name,
        branch_id=branch.id,
        branch_name=branch.name,
        date="2026-11-25",
        subtotal=received_qty * cost,
        tax_total=0,
        total=received_qty * cost,
        paid_amount=0,
        status="pending",
        grn_id=grn.id,
    )
    rows = [
        branch,
        vendor,
        item,
        Role(id="role-1", key="super_admin", label="Super Admin", permissions=["*"]),
        User(
            id="user-1",
            name="Admin",
            hashed_password="test-hash",
            role=UserRole.super_admin,
            all_branches=True,
        ),
        ItemBranchConfig(
            id="item-branch-1",
            item_id=item.id,
            branch_id=branch.id,
            cost_price=branch_cost,
            is_available=True,
        ),
        ItemStock(
            id="stock-1",
            item_id=item.id,
            branch_id=branch.id,
            quantity=on_hand_qty,
        ),
        grn,
        bill,
        GRNLineItem(
            id="grn-line-1",
            grn_id=grn.id,
            item_id=item.id,
            name=item.name,
            received_qty=received_qty,
            cost=cost,
            line_total=received_qty * cost,
        ),
        PurchaseLineItem(
            id="bill-line-1",
            bill_id=bill.id,
            item_id=item.id,
            name=item.name,
            qty=received_qty,
            cost=cost,
            tax_rate=0,
            discount=0,
            line_total=received_qty * cost,
        ),
    ]
    if tracked:
        rows.append(ItemBatch(
            id="receipt-batch",
            item_id=item.id,
            branch_id=branch.id,
            batch_number="BATCH-1",
            quantity=batch_qty,
            initial_qty=received_qty,
            cost_price=cost,
            source_ref=grn.id,
            source_type="grn",
        ))
    db.add_all(rows)
    await db.commit()
    return (await db.execute(select(User).where(User.id == "user-1"))).scalar_one(), grn


async def _read_cost_and_stock(db: AsyncSession) -> tuple[float, float]:
    cost = (await db.execute(
        select(ItemBranchConfig.cost_price).where(ItemBranchConfig.item_id == "item-1")
    )).scalar_one()
    quantity = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "item-1")
    )).scalar_one()
    return cost, quantity


async def _cancel_grn_restores_prior_weighted_average() -> None:
    db = await _build_session()
    try:
        user, grn = await _seed_receipt(db, on_hand_qty=30, branch_cost=36.666667)
        await cancel_bill("bill-1", db=db, user=user)
        await cancel_grn(grn.id, db=db, user=user)
        cost, quantity = await _read_cost_and_stock(db)
        assert quantity == pytest.approx(10)
        assert cost == pytest.approx(30)
    finally:
        await db.close()


async def _cancel_grn_rejects_insufficient_stock() -> None:
    db = await _build_session()
    try:
        user, grn = await _seed_receipt(db, on_hand_qty=5, branch_cost=36.666667)
        grn_id = grn.id
        await cancel_bill("bill-1", db=db, user=user)
        with pytest.raises(HTTPException, match="only 5 are available"):
            await cancel_grn(grn_id, db=db, user=user)
        cost, quantity = await _read_cost_and_stock(db)
        status = (await db.execute(
            select(GoodsReceiptNote.status).where(GoodsReceiptNote.id == grn_id)
        )).scalar_one()
        assert quantity == pytest.approx(5)
        assert cost == pytest.approx(36.666667)
        assert status == GRNStatus.received
    finally:
        await db.close()


async def _edit_direct_bill_recalculates_receipt_weighted_average() -> None:
    db = await _build_session()
    try:
        user, _grn = await _seed_receipt(db, on_hand_qty=30, branch_cost=36.666667)
        await update_bill(
            "bill-1",
            BillUpdate(items=[
                BillLineUpdate(
                    item_id="item-1",
                    name="Widget",
                    qty=10,
                    cost=40,
                    tax_rate=0,
                    discount=0,
                )
            ]),
            db=db,
            user=user,
        )
        cost, quantity = await _read_cost_and_stock(db)
        receipt_qty = (await db.execute(
            select(GRNLineItem.received_qty).where(GRNLineItem.grn_id == "grn-1")
        )).scalar_one()
        assert receipt_qty == pytest.approx(10)
        assert quantity == pytest.approx(20)
        assert cost == pytest.approx(35)
    finally:
        await db.close()


async def _edit_rejects_consumed_receipt_stock() -> None:
    db = await _build_session()
    try:
        user, _grn = await _seed_receipt(
            db,
            tracked=True,
            on_hand_qty=25,
            branch_cost=36.666667,
            batch_qty=15,
        )
        with pytest.raises(HTTPException, match="already been consumed"):
            await update_bill(
                "bill-1",
                BillUpdate(items=[
                    BillLineUpdate(
                        item_id="item-1",
                        name="Widget",
                        qty=10,
                        cost=40,
                        tax_rate=0,
                        discount=0,
                    )
                ]),
                db=db,
                user=user,
            )
        cost, quantity = await _read_cost_and_stock(db)
        assert quantity == pytest.approx(25)
        assert cost == pytest.approx(36.666667)
    finally:
        await db.close()


async def _edit_rejects_moved_untracked_receipt_stock() -> None:
    db = await _build_session()
    try:
        user, grn = await _seed_receipt(db, tracked=False)
        db.add(StockMovement(
            id="stock-out-1",
            item_id="item-1",
            branch_id="branch-1",
            delta=-1,
            before_qty=30,
            after_qty=29,
            movement_type="sale",
            source_type="sale",
            source_ref="sale-1",
            created_at=datetime.utcnow() + timedelta(seconds=1),
        ))
        await db.commit()
        with pytest.raises(HTTPException, match="already been consumed"):
            await update_bill(
                "bill-1",
                BillUpdate(items=[
                    BillLineUpdate(
                        item_id="item-1",
                        name="Widget",
                        qty=10,
                        cost=40,
                        tax_rate=0,
                        discount=0,
                    )
                ]),
                db=db,
                user=user,
            )
        cost, quantity = await _read_cost_and_stock(db)
        assert quantity == pytest.approx(30)
        assert cost == pytest.approx(36.666667)
    finally:
        await db.close()


async def _edit_separate_grn_bill_is_rejected() -> None:
    db = await _build_session()
    try:
        user, grn = await _seed_receipt(db)
        db.add(AuditLog(
            id="grn-verified",
            record_type="grn",
            record_id=grn.id,
            event_type="verified",
            action="verify_grn",
            detail="GRN verified",
        ))
        await db.commit()
        with pytest.raises(HTTPException, match="separately received GRN"):
            await update_bill(
                "bill-1",
                BillUpdate(items=[
                    BillLineUpdate(
                        item_id="item-1",
                        name="Widget",
                        qty=10,
                        cost=40,
                        tax_rate=0,
                        discount=0,
                    )
                ]),
                db=db,
                user=user,
            )
        grn_qty = (await db.execute(
            select(GRNLineItem.received_qty).where(GRNLineItem.grn_id == grn.id)
        )).scalar_one()
        assert grn_qty == pytest.approx(20)
    finally:
        await db.close()


def test_grn_cancellation_reverses_branch_weighted_average() -> None:
    asyncio.run(_cancel_grn_restores_prior_weighted_average())


def test_grn_cancellation_rejects_when_stock_is_unavailable() -> None:
    asyncio.run(_cancel_grn_rejects_insufficient_stock())


def test_direct_bill_quantity_edit_updates_receipt_and_weighted_average() -> None:
    asyncio.run(_edit_direct_bill_recalculates_receipt_weighted_average())


def test_direct_bill_edit_rejects_consumed_receipt_stock() -> None:
    asyncio.run(_edit_rejects_consumed_receipt_stock())


def test_direct_bill_edit_rejects_moved_untracked_receipt_stock() -> None:
    asyncio.run(_edit_rejects_moved_untracked_receipt_stock())


def test_separately_received_grn_bill_cannot_diverge_from_receipt() -> None:
    asyncio.run(_edit_separate_grn_bill_is_rejected())

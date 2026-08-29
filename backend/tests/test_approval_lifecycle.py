"""Approval lifecycle: draft → submit → approve for sales & purchases; POS direct via pos.use."""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Customer,
    GoodsReceiptNote,
    InvoiceStatus,
    Item,
    ItemStock,
    PurchaseBill,
    PurchaseOrder,
    PurchaseOrderStatus,
    Role,
    SaleInvoice,
    SaleLineItem,
    User,
    Vendor,
)
from src.routes.sales import (  # noqa: E402
    InvoiceApproveReject,
    InvoiceUpdate,
    SaleCreate,
    SalesReturnCreate,
    SalesReturnLineIn,
    approve_invoice,
    create_invoice,
    create_return,
    delete_invoice_payments,
    delete_invoice_returns,
    submit_invoice,
    update_invoice,
)
from src.routes.purchases import (  # noqa: E402
    BillApproveReject,
    GRNApproveReject,
    GRNCreate,
    POApprove,
    PurchaseCreate,
    PurchaseOrderCreate,
    approve_bill,
    approve_grn,
    approve_order,
    create_bill,
    create_grn,
    create_order,
    submit_bill,
    submit_grn,
    submit_order,
)


async def _session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()


async def _seed(db: AsyncSession) -> dict:
    creator_role = Role(
        id="role-creator",
        key="creator",
        label="Creator",
        permissions=["invoices.create", "invoices.view", "purchases.create", "purchases.view"],
    )
    approver_role = Role(
        id="role-approver",
        key="approver",
        label="Approver",
        permissions=[
            "invoices.create", "invoices.view", "invoices.approve",
            "purchases.create", "purchases.view", "purchases.approve",
        ],
    )
    cashier_role = Role(
        id="role-cashier",
        key="cashier",
        label="Cashier",
        permissions=["pos.use", "invoices.create", "invoices.view"],
    )
    db.add_all([creator_role, approver_role, cashier_role])
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    db.add(Customer(id="c1", name="Acme", credit_balance=500))
    db.add(Vendor(id="v1", name="Vendor Co"))
    item = Item(
        id="i1", name="Widget", sku="W1", cost_price=10, selling_price=25,
        reorder_level=0, active=True,
    )
    db.add(item)
    db.add(ItemStock(id="s1", item_id="i1", branch_id="b1", quantity=100))
    creator = User(
        id="u-creator", name="Creator User", email="creator@test.com",
        hashed_password="x", role_id="role-creator", all_branches=False,
    )
    approver = User(
        id="u-approver", name="Approver User", email="approver@test.com",
        hashed_password="x", role_id="role-approver", all_branches=False,
    )
    cashier = User(
        id="u-cashier", name="Cashier User", email="cashier@test.com",
        hashed_password="x", role_id="role-cashier", all_branches=False,
    )
    # Branch access via all_branches=False needs UserBranch — use all_branches True
    # for test simplicity while still gating via role permissions (not admin *).
    creator.all_branches = True
    approver.all_branches = True
    cashier.all_branches = True
    # Clear the all_branches short-circuit in can_direct_commit by leaving True
    # but roles without approve still fail user_can — wait, can_direct_commit
    # returns True if all_branches. Override: set all_branches False and skip
    # branch enforcement by using enforce that allows when empty? Safer to
    # monkeypatch isn't available — set all_branches False and add UserBranch.
    from src.models import UserBranch
    creator.all_branches = False
    approver.all_branches = False
    cashier.all_branches = False
    db.add_all([
        UserBranch(user_id="u-creator", branch_id="b1"),
        UserBranch(user_id="u-approver", branch_id="b1"),
        UserBranch(user_id="u-cashier", branch_id="b1"),
        creator, approver, cashier,
    ])
    await db.commit()
    return {"creator": creator, "approver": approver, "cashier": cashier}


async def test_sales_draft_submit_approve_lifecycle() -> None:
    db = await _session()
    users = await _seed(db)
    creator, approver = users["creator"], users["approver"]

    created = await create_invoice(
        SaleCreate(
            customer_id="c1",
            customer_name="Acme",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 2, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode=None,
            origin="invoice",
        ),
        user=creator,
        db=db,
    )
    assert created["status"] == "draft"

    stock = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock) == 100  # draft must not move stock

    inv = (await db.execute(select(SaleInvoice).where(SaleInvoice.id == created["id"]))).scalar_one()
    submitted = await submit_invoice(inv.id, db=db, user=creator)
    assert submitted["status"] == "pending_approval"

    approved = await approve_invoice(
        inv.id, InvoiceApproveReject(), db=db, user=approver,
    )
    assert approved["status"] == "pending"  # unpaid invoice after approve

    stock_after = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock_after) == 98

    cust = (await db.execute(select(Customer).where(Customer.id == "c1"))).scalar_one()
    assert float(cust.outstanding or 0) > 0


async def test_pos_direct_with_pos_use() -> None:
    db = await _session()
    users = await _seed(db)
    cashier = users["cashier"]

    created = await create_invoice(
        SaleCreate(
            customer_name="Walk-in",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode="cash",
            origin="pos",
        ),
        user=cashier,
        db=db,
    )
    assert created["status"] == "paid"

    stock = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock) == 99


async def test_pos_without_pos_use_rejected() -> None:
    db = await _session()
    users = await _seed(db)
    creator = users["creator"]  # has invoices.create but not pos.use

    from fastapi import HTTPException
    try:
        await create_invoice(
            SaleCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
                discount=0,
                payment_mode="cash",
                origin="pos",
            ),
            user=creator,
            db=db,
        )
        raise AssertionError("expected 403 for POS without pos.use")
    except HTTPException as exc:
        assert exc.status_code == 403


async def test_pos_invoice_edit_after_delete_payment() -> None:
    db = await _session()
    users = await _seed(db)
    cashier = users["cashier"]
    from fastapi import HTTPException

    unpaid = await create_invoice(
        SaleCreate(
            customer_name="Walk-in",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode=None,
            origin="pos",
        ),
        user=cashier,
        db=db,
    )
    assert unpaid["status"] == "pending"

    edited = await update_invoice(
        unpaid["id"],
        InvoiceUpdate(
            items=[{"item_id": "i1", "name": "Widget", "qty": 2, "price": 25, "tax_rate": 0}],
            discount=0,
        ),
        db=db,
        user=cashier,
    )
    assert edited["status"] == "pending"
    assert abs(float(edited["total"]) - 50) < 0.01

    paid = await create_invoice(
        SaleCreate(
            customer_name="Walk-in",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode="cash",
            origin="pos",
        ),
        user=cashier,
        db=db,
    )
    assert paid["status"] == "paid"
    try:
        await update_invoice(
            paid["id"],
            InvoiceUpdate(
                items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
                discount=0,
            ),
            db=db,
            user=cashier,
        )
        raise AssertionError("expected 400 when editing a paid POS bill")
    except HTTPException as exc:
        assert exc.status_code == 400

    deleted = await delete_invoice_payments(paid["id"], db=db, user=cashier)
    assert deleted["count"] >= 1 or deleted.get("cleared_legacy")

    after = await update_invoice(
        paid["id"],
        InvoiceUpdate(
            items=[{"item_id": "i1", "name": "Widget", "qty": 2, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode="cash",
        ),
        db=db,
        user=cashier,
    )
    assert after["status"] == "paid"
    assert abs(float(after["total"]) - 50) < 0.01


async def test_invoice_edit_after_delete_return() -> None:
    db = await _session()
    users = await _seed(db)
    cashier = users["cashier"]
    from fastapi import HTTPException

    unpaid = await create_invoice(
        SaleCreate(
            customer_name="Walk-in",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 2, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode=None,
            origin="pos",
        ),
        user=cashier,
        db=db,
    )
    line = (
        await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == unpaid["id"]))
    ).scalars().first()
    assert line is not None

    await create_return(
        SalesReturnCreate(
            invoice_id=unpaid["id"],
            reason="Wrong item",
            refund_method="cash",
            items=[
                SalesReturnLineIn(
                    invoice_line_id=line.id,
                    item_id="i1",
                    name="Widget",
                    return_qty=1,
                )
            ],
            notes="test return",
            created_by="Cashier",
        ),
        db=db,
        user=cashier,
    )

    try:
        await update_invoice(
            unpaid["id"],
            InvoiceUpdate(
                items=[{"item_id": "i1", "name": "Widget", "qty": 2, "price": 25, "tax_rate": 0}],
                discount=0,
            ),
            db=db,
            user=cashier,
        )
        raise AssertionError("expected 400 when editing an invoice with a return")
    except HTTPException as exc:
        assert exc.status_code == 400

    deleted = await delete_invoice_returns(unpaid["id"], db=db, user=cashier)
    assert deleted["count"] >= 1 or deleted.get("cleared_legacy")

    after = await update_invoice(
        unpaid["id"],
        InvoiceUpdate(
            items=[{"item_id": "i1", "name": "Widget", "qty": 3, "price": 25, "tax_rate": 0}],
            discount=0,
        ),
        db=db,
        user=cashier,
    )
    assert after["status"] == "pending"
    assert abs(float(after["total"]) - 75) < 0.01


async def test_pending_approval_invoice_cannot_be_edited() -> None:
    db = await _session()
    users = await _seed(db)
    creator = users["creator"]
    from fastapi import HTTPException

    created = await create_invoice(
        SaleCreate(
            customer_id="c1",
            customer_name="Acme",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
            discount=0,
            payment_mode=None,
        ),
        user=creator,
        db=db,
    )
    await submit_invoice(created["id"], db=db, user=creator)
    try:
        await update_invoice(
            created["id"],
            InvoiceUpdate(
                items=[{"item_id": "i1", "name": "Widget", "qty": 1, "price": 25, "tax_rate": 0}],
                discount=0,
            ),
            db=db,
            user=creator,
        )
        raise AssertionError("expected 400 when editing pending_approval")
    except HTTPException as exc:
        assert exc.status_code == 400


async def test_purchase_bill_and_po_lifecycle() -> None:
    db = await _session()
    users = await _seed(db)
    creator, approver = users["creator"], users["approver"]

    po = await create_order(
        PurchaseOrderCreate(
            vendor_id="v1",
            vendor_name="Vendor Co",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 5, "cost": 10, "tax_rate": 0}],
            discount=0,
        ),
        db=db,
        user=creator,
    )
    assert po["status"] == "draft"

    submitted_po = await submit_order(po["id"], db=db, user=creator)
    assert submitted_po["status"] == "pending_approval"

    approved_po = await approve_order(po["id"], POApprove(), db=db, user=approver)
    assert approved_po["status"] == "confirmed"

    bill = await create_bill(
        PurchaseCreate(
            vendor_id="v1",
            vendor_name="Vendor Co",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 3, "cost": 10, "tax_rate": 0}],
            discount=0,
            payment_mode=None,
        ),
        db=db,
        user=creator,
    )
    bill_row = (await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill["id"]))).scalar_one()
    assert (bill_row.status.value if hasattr(bill_row.status, "value") else str(bill_row.status)) == "draft"

    bill_id = bill["id"]
    submitted_bill = await submit_bill(bill_id, db=db, user=creator)
    assert submitted_bill["status"] == "pending_approval"

    stock_before = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()

    approved_bill = await approve_bill(
        bill_id, BillApproveReject(), db=db, user=approver,
    )
    assert approved_bill["status"] in ("pending", "paid")

    stock_after = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock_after) == int(stock_before) + 3


async def test_grn_draft_submit_approve_lifecycle() -> None:
    db = await _session()
    users = await _seed(db)
    creator, approver = users["creator"], users["approver"]

    created = await create_grn(
        GRNCreate(
            vendor_id="v1",
            vendor_name="Vendor Co",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": "i1", "name": "Widget", "qty": 4, "cost": 10, "tax_rate": 0}],
            discount=0,
        ),
        db=db,
        user=creator,
    )
    assert created["status"] == "draft"

    stock_before = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock_before) == 100

    submitted = await submit_grn(created["id"], db=db, user=creator)
    assert submitted["status"] == "pending_approval"

    stock_mid = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock_mid) == 100  # submit still no stock

    approved = await approve_grn(created["id"], GRNApproveReject(), db=db, user=approver)
    assert approved["status"] == "received"

    stock_after = (await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one()
    assert int(stock_after) == 104

    grn = (await db.execute(
        select(GoodsReceiptNote).where(GoodsReceiptNote.id == created["id"])
    )).scalar_one()
    assert (grn.status.value if hasattr(grn.status, "value") else str(grn.status)) == "received"


async def test_self_approve_blocked() -> None:
    db = await _session()
    users = await _seed(db)
    # Approver creates (direct commit) — for draft path use creator then try self-approve
    creator = users["creator"]
    created = await create_invoice(
        SaleCreate(
            customer_name="Walk-in",
            branch_id="b1",
            branch_name="Main",
            items=[{"item_id": None, "name": "Service", "qty": 1, "price": 50, "tax_rate": 0}],
            discount=0,
            origin="invoice",
        ),
        user=creator,
        db=db,
    )
    await submit_invoice(created["id"], db=db, user=creator)
    from fastapi import HTTPException
    try:
        await approve_invoice(created["id"], InvoiceApproveReject(), db=db, user=creator)
        raise AssertionError("expected self-approve 403")
    except HTTPException as exc:
        assert exc.status_code == 403


def test_run_all():
    asyncio.get_event_loop().run_until_complete(test_sales_draft_submit_approve_lifecycle())
    asyncio.get_event_loop().run_until_complete(test_pos_direct_with_pos_use())
    asyncio.get_event_loop().run_until_complete(test_pos_without_pos_use_rejected())
    asyncio.get_event_loop().run_until_complete(test_pos_invoice_edit_after_delete_payment())
    asyncio.get_event_loop().run_until_complete(test_invoice_edit_after_delete_return())
    asyncio.get_event_loop().run_until_complete(test_pending_approval_invoice_cannot_be_edited())
    asyncio.get_event_loop().run_until_complete(test_purchase_bill_and_po_lifecycle())
    asyncio.get_event_loop().run_until_complete(test_grn_draft_submit_approve_lifecycle())
    asyncio.get_event_loop().run_until_complete(test_self_approve_blocked())


if __name__ == "__main__":
    test_run_all()
    print("OK: approval lifecycle tests passed")

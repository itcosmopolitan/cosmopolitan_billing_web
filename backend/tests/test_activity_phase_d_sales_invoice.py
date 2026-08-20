import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException

from src.database import Base  # noqa: E402
from src.models import AuditLog, Branch, Customer, SaleLineItem, User  # noqa: E402
from src.routes.sales import (  # noqa: E402
    BulkDeleteIn,
    CustomerPaymentCreate,
    PaymentAllocationIn,
    SaleCreate,
    SalesReturnCreate,
    SalesReturnLineIn,
    bulk_delete_invoices,
    bulk_delete_payments,
    cancel_invoice,
    create_invoice,
    create_payment,
    create_return,
    void_payment,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> None:
    db.add_all([
        Branch(id="b1", name="Main", code="MAIN"),
        Customer(id="c1", name="Acme Customer", credit_balance=0),
    ])
    await db.commit()


async def _run_sales_invoice_activity_proof() -> None:
    db = await _build_session()
    try:
        await _seed(db)

        actor = User(
            id="u-sales-test",
            name="Sales Tester",
            email="sales-test@example.com",
            hashed_password="x",
            all_branches=True,
        )

        created_1 = await create_invoice(
            SaleCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                cashier="Staff",
                items=[
                    {
                        "item_id": None,
                        "name": "Sales Item A",
                        "qty": 1,
                        "price": 100,
                        "tax_rate": 0,
                    }
                ],
                discount=0,
                payment_mode="bank_transfer",
                notes="sales activity test",
            ),
            user=actor,
            db=db,
        )
        invoice_id_1 = created_1["id"]

        invoice_line = (
            await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id_1))
        ).scalars().first()
        assert invoice_line is not None, "Expected sale line item for created invoice"

        await create_return(
            SalesReturnCreate(
                invoice_id=invoice_id_1,
                reason="Damaged item",
                refund_method="cash",
                items=[
                    SalesReturnLineIn(
                        invoice_line_id=invoice_line.id,
                        item_id=None,
                        name=invoice_line.name,
                        return_qty=1,
                    )
                ],
                notes="return link test",
                created_by="Staff",
            ),
            db=db,
        )

        created_2 = await create_invoice(
            SaleCreate(
                customer_name="Walk-in",
                branch_id="b1",
                branch_name="Main",
                cashier="Staff",
                items=[
                    {
                        "item_id": None,
                        "name": "Sales Item B",
                        "qty": 1,
                        "price": 50,
                        "tax_rate": 0,
                    }
                ],
                discount=0,
                payment_mode=None,
                notes="sales void test",
            ),
            user=actor,
            db=db,
        )
        invoice_id_2 = created_2["id"]

        await cancel_invoice(invoice_id_2, db=db)

        rows_1 = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_invoice",
                    AuditLog.record_id == invoice_id_1,
                )
            )
        ).scalars().all()
        event_types_1 = {r.event_type for r in rows_1}
        assert "created" in event_types_1, "Expected created event for sales_invoice"
        assert "payment_recorded" in event_types_1, "Expected payment_recorded event for sales_invoice"
        assert "status_changed" in event_types_1, "Expected status_changed event for sales_invoice"
        assert "return_linked" in event_types_1, "Expected return_linked event for sales_invoice"

        return_link_logs = [r for r in rows_1 if r.event_type == "return_linked"]
        assert len(return_link_logs) >= 1, "Expected return_linked log row"
        link_meta = json.loads(return_link_logs[0].event_metadata or "{}")
        assert link_meta.get("target_record_type") == "sales_return"
        assert link_meta.get("target_record_id")

        rows_2 = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_invoice",
                    AuditLog.record_id == invoice_id_2,
                )
            )
        ).scalars().all()
        event_types_2 = {r.event_type for r in rows_2}
        assert "voided" in event_types_2, "Expected voided event for cancelled sales_invoice"

        created_3 = await create_invoice(
            SaleCreate(
                customer_id="c1",
                customer_name="Acme Customer",
                branch_id="b1",
                branch_name="Main",
                cashier="Staff",
                items=[
                    {
                        "item_id": None,
                        "name": "Sales Item C",
                        "qty": 1,
                        "price": 150,
                        "tax_rate": 0,
                    }
                ],
                discount=0,
                payment_mode=None,
                notes="multi payment invoice C",
            ),
            user=actor,
            db=db,
        )
        invoice_id_3 = created_3["id"]

        created_4 = await create_invoice(
            SaleCreate(
                customer_id="c1",
                customer_name="Acme Customer",
                branch_id="b1",
                branch_name="Main",
                cashier="Staff",
                items=[
                    {
                        "item_id": None,
                        "name": "Sales Item D",
                        "qty": 1,
                        "price": 150,
                        "tax_rate": 0,
                    }
                ],
                discount=0,
                payment_mode=None,
                notes="multi payment invoice D",
            ),
            user=actor,
            db=db,
        )
        invoice_id_4 = created_4["id"]

        pay_1 = await create_payment(
            CustomerPaymentCreate(
                customer_id="c1",
                payment_mode="bank_transfer",
                payment_ref="UTR-MULTI-SALES-1",
                allocations=[
                    PaymentAllocationIn(invoice_id=invoice_id_3, amount=30),
                    PaymentAllocationIn(invoice_id=invoice_id_4, amount=70),
                ],
                branch_id="b1",
                branch_name="Main",
                created_by="Staff",
            ),
            db=db,
        )

        multi_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_invoice",
                    AuditLog.event_type == "payment_recorded",
                    AuditLog.record_id.in_([invoice_id_3, invoice_id_4]),
                )
            )
        ).scalars().all()
        assert len(multi_logs) >= 2, "Expected payment_recorded entries for multi-invoice allocations"

        expected_amounts = {invoice_id_3: 30.0, invoice_id_4: 70.0}
        observed_amounts = {}
        for row in multi_logs:
            meta = json.loads(row.event_metadata or "{}")
            if meta.get("payment_id") == pay_1["id"]:
                observed_amounts[row.record_id] = float(meta.get("amount") or 0)
        assert observed_amounts == expected_amounts, "Each invoice must log only its own allocation amount"
        assert 100.0 not in observed_amounts.values(), "Full payment total must not be repeated on each invoice"

        await void_payment(pay_1["id"], db=db)
        void_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_invoice",
                    AuditLog.event_type == "payment_voided",
                    AuditLog.record_id.in_([invoice_id_3, invoice_id_4]),
                )
            )
        ).scalars().all()
        void_targets = {}
        for row in void_logs:
            meta = json.loads(row.event_metadata or "{}")
            if meta.get("payment_id") == pay_1["id"]:
                void_targets[row.record_id] = float(meta.get("amount") or 0)
        assert void_targets == expected_amounts, "payment_voided must be logged per invoice with allocation amount"

        try:
            await bulk_delete_invoices(BulkDeleteIn(ids=[invoice_id_3]), db=db, user=actor)
            raise AssertionError("Expected bulk delete to block invoice with voided payment allocation")
        except HTTPException as exc:
            assert exc.status_code == 400
            detail = exc.detail
            assert isinstance(detail, dict)
            assert detail.get("blocked")
            assert any(
                "linked payment" in str(b.get("reason", "")).lower()
                for b in detail["blocked"]
            )

        pay_2 = await create_payment(
            CustomerPaymentCreate(
                customer_id="c1",
                payment_mode="bank_transfer",
                payment_ref="UTR-MULTI-SALES-2",
                allocations=[
                    PaymentAllocationIn(invoice_id=invoice_id_3, amount=20),
                    PaymentAllocationIn(invoice_id=invoice_id_4, amount=40),
                ],
                branch_id="b1",
                branch_name="Main",
                created_by="Staff",
            ),
            db=db,
        )
        await bulk_delete_payments(BulkDeleteIn(ids=[pay_2["id"]]), db=db)

        deleted_logs = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.record_type == "sales_invoice",
                    AuditLog.event_type == "payment_deleted",
                    AuditLog.record_id.in_([invoice_id_3, invoice_id_4]),
                )
            )
        ).scalars().all()
        deleted_amounts = {}
        for row in deleted_logs:
            meta = json.loads(row.event_metadata or "{}")
            if meta.get("payment_id") == pay_2["id"]:
                deleted_amounts[row.record_id] = float(meta.get("amount") or 0)
        assert deleted_amounts == {invoice_id_3: 20.0, invoice_id_4: 40.0}
    finally:
        await db.close()


def test_sales_invoice_activity_catalogue() -> None:
    asyncio.run(_run_sales_invoice_activity_proof())


if __name__ == "__main__":
    asyncio.run(_run_sales_invoice_activity_proof())
    print("sales_invoice_activity_catalogue: PASS")

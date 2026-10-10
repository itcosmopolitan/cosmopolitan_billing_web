"""Bulk-deleting a customer payment must void its payment_records ledger row."""

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, CustomerPayment, Customer, PaymentRecord, SaleInvoice, User
from src.routes.sales import (
    BulkDeleteIn,
    CustomerPaymentCreate,
    PaymentAllocationIn,
    SaleCreate,
    bulk_delete_payments,
    create_invoice,
    create_payment,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _run_bulk_delete_voids_ledger() -> None:
    db = await _build_session()
    try:
        db.add_all([
            Branch(id="b1", name="Main", code="MAIN"),
            Customer(id="c1", name="Acme Customer", credit_balance=0, credit_limit=10000, is_credit_eligible=True),
        ])
        await db.commit()

        actor = User(
            id="u-ledger-test",
            name="Ledger Tester",
            email="ledger-test@example.com",
            hashed_password="x",
            all_branches=True,
        )
        invoice = await create_invoice(
            SaleCreate(
                customer_id="c1",
                customer_name="Acme Customer",
                branch_id="b1",
                branch_name="Main",
                cashier="Staff",
                items=[{"item_id": None, "name": "Item", "qty": 1, "price": 100, "tax_rate": 0}],
                discount=0,
                payment_mode="credit",
            ),
            user=actor,
            db=db,
        )
        pay = await create_payment(
            CustomerPaymentCreate(
                customer_id="c1",
                payment_mode="bank_transfer",
                payment_ref="UTR-LEDGER-1",
                allocations=[PaymentAllocationIn(invoice_id=invoice["id"], amount=40)],
                branch_id="b1",
                branch_name="Main",
                created_by="Staff",
            ),
            db=db,
        )

        ledger_before = (
            await db.execute(
                select(PaymentRecord).where(
                    PaymentRecord.source_document_type == "customer_payment",
                    PaymentRecord.source_document_id == pay["id"],
                )
            )
        ).scalar_one()
        assert ledger_before.voided is False

        await bulk_delete_payments(BulkDeleteIn(ids=[pay["id"]]), db=db)

        assert (
            await db.execute(select(CustomerPayment).where(CustomerPayment.id == pay["id"]))
        ).scalar_one_or_none() is None

        ledger_after = (
            await db.execute(
                select(PaymentRecord).where(PaymentRecord.id == ledger_before.id)
            )
        ).scalar_one_or_none()
        assert ledger_after is not None, "Ledger row must be kept as an audit trail"
        assert ledger_after.voided is True
        assert ledger_after.voided_at, "voided_at must be set when the ledger row is voided"

        invoice_row = (
            await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice["id"]))
        ).scalar_one()
        assert float(invoice_row.paid_amount or 0) == 0
    finally:
        await db.close()


def test_bulk_delete_payment_voids_ledger_row() -> None:
    asyncio.run(_run_bulk_delete_voids_ledger())

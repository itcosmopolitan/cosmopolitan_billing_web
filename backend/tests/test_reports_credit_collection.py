"""Credit collection report date-range totals and collection status."""
from __future__ import annotations

import asyncio
import sys
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Customer,
    CustomerPayment,
    CustomerPaymentAllocation,
    InvoiceStatus,
    SaleInvoice,
)
from src.routes.reports import credit_collection  # noqa: E402

AS_OF = date(2026, 3, 31)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _run_credit_collection_report() -> None:
    db = await _build_session()
    try:
        db.add_all([
            Branch(id="b1", name="Main", code="MAIN"),
            Customer(id="c-ext", name="External Customer", classification="external"),
            Customer(id="c-int", name="Internal Company", classification="internal"),
            SaleInvoice(
                id="inv-overdue",
                number="INV-OVERDUE",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                branch_name="Main",
                date="2026-03-01",
                due_date="2026-03-20",
                total=108,
                tax_total=8,
                paid_amount=20,
                credited_amount=10,
                status=InvoiceStatus.partial,
            ),
            SaleInvoice(
                id="inv-due-today",
                number="INV-DUE-TODAY",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                branch_name="Main",
                date=AS_OF.isoformat(),
                due_date=AS_OF.isoformat(),
                total=50,
                paid_amount=0,
                credited_amount=0,
                status=InvoiceStatus.pending,
            ),
            SaleInvoice(
                id="inv-not-due",
                number="INV-NOT-DUE",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                branch_name="Main",
                date="2026-03-10",
                due_date="2026-04-15",
                total=75,
                paid_amount=0,
                credited_amount=0,
                status=InvoiceStatus.pending,
            ),
            SaleInvoice(
                id="inv-internal",
                number="INV-INTERNAL",
                customer_id="c-int",
                customer_name="Internal Company",
                branch_id="b1",
                branch_name="Main",
                date="2026-03-01",
                due_date="2026-03-20",
                total=100,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            SaleInvoice(
                id="inv-after-cutoff",
                number="INV-AFTER-CUTOFF",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                branch_name="Main",
                date="2026-04-01",
                due_date="2026-04-15",
                total=100,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            SaleInvoice(
                id="inv-date-range",
                number="INV-DATE-RANGE",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                branch_name="Main",
                date="2026-09-01",
                due_date="2026-09-30",
                total=10000,
                paid_amount=9500,
                credited_amount=0,
                status=InvoiceStatus.partial,
            ),
            SaleInvoice(
                id="inv-paid-in-range",
                number="INV-PAID-IN-RANGE",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                branch_name="Main",
                date="2026-09-01",
                due_date="2026-09-30",
                total=1000,
                paid_amount=1000,
                credited_amount=0,
                status=InvoiceStatus.paid,
            ),
            *[
                CustomerPayment(
                    id=f"payment-{day}",
                    number=f"PAY-{day}",
                    customer_id="c-ext",
                    customer_name="External Customer",
                    branch_id="b1",
                    date=f"2026-10-{day:02d}",
                    total_amount=amount,
                    payment_mode="cash",
                    voided=False,
                )
                for day, amount in [
                    (1, 5000),
                    (2, 2000),
                    (5, 1000),
                    (10, 1000),
                    (15, 500),
                ]
            ],
            CustomerPayment(
                id="payment-paid-in-range",
                number="PAY-PAID-IN-RANGE",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                date="2026-10-07",
                total_amount=1000,
                payment_mode="cash",
                voided=False,
            ),
        ])
        for day, amount in [
            (1, 5000),
            (2, 2000),
            (5, 1000),
            (10, 1000),
            (15, 500),
        ]:
            db.add(CustomerPaymentAllocation(
                id=f"allocation-{day}",
                payment_id=f"payment-{day}",
                invoice_id="inv-date-range",
                invoice_number="INV-DATE-RANGE",
                amount=amount,
            ))
        db.add(CustomerPaymentAllocation(
            id="allocation-paid-in-range",
            payment_id="payment-paid-in-range",
            invoice_id="inv-paid-in-range",
            invoice_number="INV-PAID-IN-RANGE",
            amount=1000,
        ))
        await db.commit()

        report = await credit_collection(
            date_from="2026-03-01",
            date_to=AS_OF.isoformat(),
            skip=0,
            limit=50,
            db=db,
        )
        rows = {row["invoice_number"]: row for row in report["items"]}
        assert report["total"] == 3, rows
        assert set(rows) == {"INV-OVERDUE", "INV-DUE-TODAY", "INV-NOT-DUE"}

        overdue = rows["INV-OVERDUE"]
        assert overdue["original_amount"] == 108
        assert overdue["collected_amount"] == 20
        assert overdue["credited_amount"] == 10
        assert overdue["balance"] == 78
        assert overdue["days_overdue"] == 11
        assert overdue["collection_status"] == "Overdue"

        due_today = rows["INV-DUE-TODAY"]
        assert due_today["days_overdue"] == 0
        assert due_today["collection_status"] == "Due Today"

        not_due = rows["INV-NOT-DUE"]
        assert not_due["days_overdue"] == 0
        assert not_due["collection_status"] == "Not Due"

        exclusive = await credit_collection(
            date_from="2026-03-01",
            date_to=AS_OF.isoformat(),
            gst_mode="exclusive",
            skip=0,
            limit=50,
            db=db,
        )
        exclusive_overdue = next(
            row for row in exclusive["items"] if row["invoice_number"] == "INV-OVERDUE"
        )
        assert exclusive_overdue["original_amount"] == pytest.approx(100)
        assert exclusive_overdue["collected_amount"] == pytest.approx(20 * 100 / 108)
        assert exclusive_overdue["credited_amount"] == pytest.approx(10 * 100 / 108)
        assert exclusive_overdue["balance"] == pytest.approx(78 * 100 / 108)

        range_report = await credit_collection(
            date_from="2026-10-05",
            date_to="2026-10-10",
            skip=0,
            limit=50,
            db=db,
        )
        range_rows = {
            row["invoice_number"]: row for row in range_report["items"]
        }
        assert range_rows["INV-DATE-RANGE"]["original_amount"] == 10000
        assert range_rows["INV-DATE-RANGE"]["collected_amount"] == 2000
        assert range_rows["INV-DATE-RANGE"]["total_amount"] == 9000
        assert range_rows["INV-DATE-RANGE"]["remaining_amount"] == 1000
        assert range_rows["INV-PAID-IN-RANGE"]["collected_amount"] == 1000
        assert range_rows["INV-PAID-IN-RANGE"]["total_amount"] == 1000
        assert range_rows["INV-PAID-IN-RANGE"]["remaining_amount"] == 0
    finally:
        await db.close()


def test_credit_collection_report() -> None:
    asyncio.run(_run_credit_collection_report())

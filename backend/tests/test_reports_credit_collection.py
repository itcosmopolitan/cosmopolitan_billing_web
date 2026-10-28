"""Credit collection report — open receivables and collection status."""
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
from src.models import Branch, Customer, InvoiceStatus, SaleInvoice  # noqa: E402
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
        ])
        await db.commit()

        report = await credit_collection(
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
    finally:
        await db.close()


def test_credit_collection_report() -> None:
    asyncio.run(_run_credit_collection_report())

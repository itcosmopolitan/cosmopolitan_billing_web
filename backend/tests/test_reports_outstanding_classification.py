"""Outstanding reports omit internal companies and keep external customers."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Customer,
    InvoiceStatus,
    Organisation,
    PurchaseBill,
    SaleInvoice,
    Vendor,
)
from src.routes.reports import outstanding_payables, outstanding_receivables  # noqa: E402


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _run_external_outstanding_proof() -> None:
    db = await _build_session()
    try:
        db.add_all([
            Branch(id="b1", name="Main", code="MAIN"),
            Organisation(id="org-1", name="Cosmopolitan", gstin="ORG123"),
            Customer(id="c-ext", name="External Customer", classification="external", gstin="EXT999"),
            Customer(id="c-int", name="Internal Company", classification="internal", gstin="INT123"),
            Vendor(id="v-ext", name="External Supplier", gstin="SUP111"),
            Vendor(id="v-int-name", name="Internal Company", gstin="OTHER"),
            Vendor(id="v-int-gst", name="Sister Branch", gstin="ORG123"),
        ])
        db.add_all([
            SaleInvoice(
                id="inv-ext",
                number="INV-EXT",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                date="2026-10-05",
                total=100,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            SaleInvoice(
                id="inv-int",
                number="INV-INT",
                customer_id="c-int",
                customer_name="Internal Company",
                branch_id="b1",
                date="2026-10-05",
                total=80,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            PurchaseBill(
                id="bill-ext",
                number="BILL-EXT",
                vendor_id="v-ext",
                vendor_name="External Supplier",
                branch_id="b1",
                date="2026-10-05",
                due_date="2026-11-04",
                total=50,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            PurchaseBill(
                id="bill-int-name",
                number="BILL-INT-NAME",
                vendor_id="v-int-name",
                vendor_name="Internal Company",
                branch_id="b1",
                date="2026-10-05",
                due_date="2026-11-04",
                total=40,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            PurchaseBill(
                id="bill-int-gst",
                number="BILL-INT-GST",
                vendor_id="v-int-gst",
                vendor_name="Sister Branch",
                branch_id="b1",
                date="2026-10-05",
                due_date="2026-11-04",
                total=30,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
        ])
        await db.commit()

        receivables = await outstanding_receivables(
            date_from="2026-10-01",
            date_to="2026-10-11",
            db=db,
        )
        receivable_numbers = {row["invoice_number"] for row in receivables["items"]}
        assert receivable_numbers == {"INV-EXT"}
        assert receivables["total"] == 1

        payables = await outstanding_payables(
            date_from="2026-10-01",
            date_to="2026-10-11",
            db=db,
        )
        payable_numbers = {row["bill_number"] for row in payables["items"]}
        assert payable_numbers == {"BILL-EXT"}
        assert payables["total"] == 1
    finally:
        await db.close()


def test_outstanding_reports_exclude_internal_companies() -> None:
    asyncio.run(_run_external_outstanding_proof())


if __name__ == "__main__":
    test_outstanding_reports_exclude_internal_companies()
    print("outstanding_classification: PASS")

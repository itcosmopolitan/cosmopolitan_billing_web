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
from src.report_catalog import REPORT_CATEGORIES  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Customer,
    CustomerPayment,
    CustomerPaymentAllocation,
    InvoiceStatus,
    Organisation,
    PurchaseBill,
    SaleInvoice,
    SalesReturn,
    SalesReturnStatus,
    Vendor,
)
from src.routes.reports import (  # noqa: E402
    outstanding_payables,
    outstanding_receivables,
    sales_aging,
    top_customers,
)


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


async def _run_ar_reports_as_of_proof() -> None:
    db = await _build_session()
    try:
        db.add_all([
            Branch(id="b1", name="Main", code="MAIN"),
            Customer(id="c-ext", name="External Customer", classification="external"),
            Customer(id="c-int", name="Internal Company", classification="internal"),
            SaleInvoice(
                id="inv-paid-later",
                number="INV-PAID-LATER",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                date="2026-09-15",
                total=100,
                paid_amount=40,
                credited_amount=0,
                status=InvoiceStatus.partial,
            ),
            SaleInvoice(
                id="inv-credited-later",
                number="INV-CREDITED-LATER",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                date="2026-09-20",
                total=60,
                paid_amount=0,
                credited_amount=10,
                status=InvoiceStatus.partial,
            ),
            SaleInvoice(
                id="inv-internal",
                number="INV-INTERNAL-AS-OF",
                customer_id="c-int",
                customer_name="Internal Company",
                branch_id="b1",
                date="2026-09-15",
                total=80,
                paid_amount=0,
                status=InvoiceStatus.pending,
            ),
            CustomerPayment(
                id="pay-after-cutoff",
                number="PAY-AFTER-CUTOFF",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                date="2026-10-15",
                total_amount=40,
                payment_mode="cash",
                voided=False,
            ),
            CustomerPaymentAllocation(
                id="alloc-after-cutoff",
                payment_id="pay-after-cutoff",
                invoice_id="inv-paid-later",
                amount=40,
            ),
            SalesReturn(
                id="cn-after-cutoff",
                number="CN-AFTER-CUTOFF",
                invoice_id="inv-credited-later",
                invoice_number="INV-CREDITED-LATER",
                customer_id="c-ext",
                customer_name="External Customer",
                branch_id="b1",
                date="2026-10-15",
                total=10,
                credited_amount=10,
                status=SalesReturnStatus.processed,
            ),
        ])
        await db.commit()

        params = {
            "date_from": "2026-10-01",
            "date_to": "2026-10-10",
        }
        receivables = await outstanding_receivables(**params, db=db)
        aging = await sales_aging(date_to=params["date_to"], db=db)
        customer_outstanding = await top_customers(**params, db=db)

        receivable_total = sum(
            row["outstanding_amount_incl_gst"] for row in receivables["items"]
        )
        aging_total = sum(row["balance"] for row in aging["items"])
        customer_total = sum(
            row["outstanding_amount"] for row in customer_outstanding["items"]
        )
        assert receivable_total == aging_total == customer_total == 160
        assert {row["invoice_number"] for row in receivables["items"]} == {
            "INV-PAID-LATER",
            "INV-CREDITED-LATER",
        }
        assert customer_outstanding["total"] == 1
    finally:
        await db.close()


def test_ar_reports_share_historical_as_of_balances() -> None:
    asyncio.run(_run_ar_reports_as_of_proof())


def test_ar_reports_use_as_of_date_filters() -> None:
    report_ids = {"top-customers", "outstanding-receivables", "sales-aging"}
    catalog = {
        report["id"]: report
        for category in REPORT_CATEGORIES
        for report in category["reports"]
    }
    assert all(catalog[report_id].get("dateFilter") == "asOf" for report_id in report_ids)


if __name__ == "__main__":
    test_outstanding_reports_exclude_internal_companies()
    test_ar_reports_share_historical_as_of_balances()
    test_ar_reports_use_as_of_date_filters()
    print("outstanding_classification: PASS")

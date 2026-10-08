"""Sales / purchase aging reports — detail buckets and summary totals."""
from __future__ import annotations

import asyncio
import sys
from datetime import date, timedelta
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
    PurchaseBill,
    PurchaseOrder,
    PurchaseOrderStatus,
    SaleInvoice,
    SalesOrder,
    SalesOrderStatus,
    User,
    Vendor,
)
from src.routes.reports import (  # noqa: E402
    purchase_aging,
    purchase_aging_detail,
    sales_aging,
    sales_aging_detail,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> date:
    aged_as_of = date(2026, 3, 31)
    actor = User(
        id="u-aging",
        name="Aging Tester",
        email="aging@example.com",
        hashed_password="x",
        all_branches=True,
    )
    db.add_all([
        actor,
        Branch(id="b1", name="Main", code="MAIN"),
        Customer(id="c1", name="SILVER SPOON PVT LTD", customer_code="100142", branch_id="b1"),
        Customer(id="c2", name="Other Customer", customer_code="100200", branch_id="b1"),
        Vendor(id="v1", name="Acme Supplies"),
        Vendor(id="v2", name="Beta Traders"),
    ])

    # 65 days old → 63-93 bucket (matches sample: 01/25/26 as of 03/31/26)
    inv_65 = SaleInvoice(
        id="inv-65",
        number="MDV-0173600",
        customer_id="c1",
        customer_name="SILVER SPOON PVT LTD",
        branch_id="b1",
        branch_name="Main",
        child_counter_id="counter-1",
        cashier="Aging Tester",
        date=(aged_as_of - timedelta(days=65)).isoformat(),
        due_date=(aged_as_of - timedelta(days=35)).isoformat(),
        total=3208.80,
        paid_amount=0,
        credited_amount=0,
        status=InvoiceStatus.pending,
    )
    # 58 days old → 32-62 bucket
    inv_58 = SaleInvoice(
        id="inv-58",
        number="MDV-0173801",
        customer_id="c1",
        customer_name="SILVER SPOON PVT LTD",
        branch_id="b1",
        branch_name="Main",
        cashier="Aging Tester",
        date=(aged_as_of - timedelta(days=58)).isoformat(),
        due_date=(aged_as_of - timedelta(days=28)).isoformat(),
        total=1500.00,
        paid_amount=0,
        credited_amount=0,
        status=InvoiceStatus.pending,
    )
    # Fully paid — excluded
    inv_paid = SaleInvoice(
        id="inv-paid",
        number="MDV-PAID",
        customer_id="c1",
        customer_name="SILVER SPOON PVT LTD",
        branch_id="b1",
        branch_name="Main",
        cashier="Aging Tester",
        date=(aged_as_of - timedelta(days=10)).isoformat(),
        total=100,
        paid_amount=100,
        status=InvoiceStatus.paid,
    )
    # Other customer, 10 days → 1-31
    inv_other = SaleInvoice(
        id="inv-other",
        number="MDV-OTHER",
        customer_id="c2",
        customer_name="Other Customer",
        branch_id="b1",
        branch_name="Main",
        cashier="Aging Tester",
        date=(aged_as_of - timedelta(days=10)).isoformat(),
        total=400,
        paid_amount=0,
        status=InvoiceStatus.pending,
    )
    so = SalesOrder(
        id="so-1",
        number="SO174231",
        customer_id="c1",
        customer_name="SILVER SPOON PVT LTD",
        branch_id="b1",
        branch_name="Main",
        date=(aged_as_of - timedelta(days=70)).isoformat(),
        total=3208.80,
        status=SalesOrderStatus.converted,
        converted_invoice_id="inv-65",
    )

    bill_40 = PurchaseBill(
        id="bill-40",
        number="PUR-0040",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=(aged_as_of - timedelta(days=40)).isoformat(),
        due_date=(aged_as_of - timedelta(days=10)).isoformat(),
        total=900,
        paid_amount=100,
        status=InvoiceStatus.partial,
    )
    bill_130 = PurchaseBill(
        id="bill-130",
        number="PUR-0130",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=(aged_as_of - timedelta(days=130)).isoformat(),
        total=500,
        paid_amount=0,
        status=InvoiceStatus.pending,
    )
    bill_v2 = PurchaseBill(
        id="bill-v2",
        number="PUR-V2",
        vendor_id="v2",
        vendor_name="Beta Traders",
        branch_id="b1",
        branch_name="Main",
        date=(aged_as_of - timedelta(days=5)).isoformat(),
        total=250,
        paid_amount=0,
        status=InvoiceStatus.pending,
    )
    po = PurchaseOrder(
        id="po-1",
        number="PO-2026-0001",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=(aged_as_of - timedelta(days=45)).isoformat(),
        total=900,
        status=PurchaseOrderStatus.converted,
        converted_bill_id="bill-40",
    )

    db.add_all([
        inv_65, inv_58, inv_paid, inv_other, so,
        bill_40, bill_130, bill_v2, po,
    ])
    await db.commit()
    return aged_as_of


async def _run():
    db = await _build_session()
    try:
        aged_as_of = await _seed(db)
        date_to = aged_as_of.isoformat()

        detail = await sales_aging_detail(
            date_to=date_to,
            sort_by="aged_in_days",
            sort_order="desc",
            skip=0,
            limit=50,
            db=db,
        )
        assert detail["total"] == 3
        by_number = {r["invoice_number"]: r for r in detail["items"]}
        assert by_number["MDV-0173600"]["aged_in_days"] == 65
        assert by_number["MDV-0173600"]["bucket_63_93"] == 3208.80
        assert by_number["MDV-0173600"]["bucket_32_62"] is None
        assert by_number["MDV-0173600"]["order_number"] == "SO174231"
        assert by_number["MDV-0173801"]["aged_in_days"] == 58
        assert by_number["MDV-0173801"]["bucket_32_62"] == 1500.00
        assert by_number["MDV-OTHER"]["bucket_1_31"] == 400.0
        assert "MDV-PAID" not in by_number

        summary = await sales_aging(
            date_to=date_to,
            sort_by="customer",
            sort_order="asc",
            skip=0,
            limit=50,
            db=db,
        )
        assert summary["total"] == 2
        by_cust = {r["customer"]: r for r in summary["items"]}
        silver = by_cust["SILVER SPOON PVT LTD"]
        assert silver["invoice_count"] == 2
        assert silver["balance"] == 4708.80
        assert silver["bucket_63_93"] == 3208.80
        assert silver["bucket_32_62"] == 1500.00
        assert by_cust["Other Customer"]["balance"] == 400.0

        # Drill-down: one customer's open invoices only
        drilled = await sales_aging_detail(
            date_to=date_to,
            customer_id="c1",
            skip=0,
            limit=50,
            db=db,
        )
        assert drilled["total"] == 2
        assert all(r["customer_id"] == "c1" for r in drilled["items"])

        counter_filtered = await sales_aging_detail(
            date_to=date_to,
            child_counter_id="counter-1",
            skip=0,
            limit=50,
            db=db,
        )
        assert counter_filtered["total"] == 1
        assert counter_filtered["items"][0]["invoice_number"] == "MDV-0173600"

        p_detail = await purchase_aging_detail(
            date_to=date_to,
            sort_by="aged_in_days",
            sort_order="desc",
            skip=0,
            limit=50,
            db=db,
        )
        assert p_detail["total"] == 3
        by_bill = {r["bill_number"]: r for r in p_detail["items"]}
        assert by_bill["PUR-0040"]["balance"] == 800.0
        assert by_bill["PUR-0040"]["aged_in_days"] == 40
        assert by_bill["PUR-0040"]["bucket_32_62"] == 800.0
        assert by_bill["PUR-0040"]["po_number"] == "PO-2026-0001"
        assert by_bill["PUR-0130"]["bucket_over_124"] == 500.0
        assert by_bill["PUR-V2"]["bucket_1_31"] == 250.0

        p_summary = await purchase_aging(
            date_to=date_to,
            sort_by="vendor",
            sort_order="asc",
            skip=0,
            limit=50,
            db=db,
        )
        assert p_summary["total"] == 2
        by_vendor = {r["vendor"]: r for r in p_summary["items"]}
        acme = by_vendor["Acme Supplies"]
        assert acme["bill_count"] == 2
        assert acme["balance"] == 1300.0
        assert acme["bucket_32_62"] == 800.0
        assert acme["bucket_over_124"] == 500.0
        assert by_vendor["Beta Traders"]["balance"] == 250.0

        p_drilled = await purchase_aging_detail(
            date_to=date_to,
            vendor_id="v1",
            skip=0,
            limit=50,
            db=db,
        )
        assert p_drilled["total"] == 2
        assert all(r["vendor_id"] == "v1" for r in p_drilled["items"])
    finally:
        await db.close()


def test_aging_reports():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("aging_reports: PASS")

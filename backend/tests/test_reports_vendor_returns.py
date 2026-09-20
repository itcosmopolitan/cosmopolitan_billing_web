"""Purchase reports include vendor returns as negative debit-note entries."""
from __future__ import annotations

import asyncio
import sys
from datetime import date
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    InvoiceStatus,
    Item,
    PurchaseBill,
    PurchaseLineItem,
    ReturnLineItem,
    User,
    Vendor,
    VendorReturn,
)
from src.routes.reports import (  # noqa: E402
    product_purchases,
    purchase_lines,
    purchase_register,
    vendor_purchases,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> User:
    today = date.today().isoformat()
    actor = User(
        id="u-reports-vr",
        name="Report Tester",
        email="reports-vr@example.com",
        hashed_password="x",
        all_branches=True,
    )
    db.add_all([
        actor,
        Branch(id="b1", name="Main", code="MAIN"),
        Vendor(id="v1", name="Acme Supplies"),
        Item(id="item-1", name="Rice 5kg", sku="RICE-5", cost_price=40, selling_price=80),
    ])
    # Creating a vendor return mutates bill.total / paid_amount and stores
    # credited_amount = sum of active return totals.
    bill = PurchaseBill(
        id="bill-1",
        number="BILL-VR-0001",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=today,
        subtotal=160,
        tax_total=0,
        discount=0,
        total=80,
        paid_amount=80,
        credited_amount=80,
        status=InvoiceStatus.paid,
    )
    line = PurchaseLineItem(
        id="pline-1",
        bill_id="bill-1",
        item_id="item-1",
        name="Rice 5kg",
        qty=2,
        cost=80,
        tax_rate=0,
        line_total=160,
    )
    vr = VendorReturn(
        id="vr-1",
        number="DN-2026-0001",
        bill_id="bill-1",
        bill_number="BILL-VR-0001",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=today,
        reason="Defective",
        subtotal=80,
        tax_total=0,
        total=80,
        credited_amount=80,
        status=InvoiceStatus.paid,
        voided=False,
    )
    vr_line = ReturnLineItem(
        id="vr-line-1",
        return_id="vr-1",
        bill_line_id="pline-1",
        item_id="item-1",
        name="Rice 5kg",
        original_qty=2,
        return_qty=1,
        cost=80,
        tax_rate=0,
        line_total=80,
    )
    voided = VendorReturn(
        id="vr-void",
        number="DN-2026-VOID",
        bill_id="bill-1",
        bill_number="BILL-VR-0001",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=today,
        reason="Voided",
        subtotal=80,
        tax_total=0,
        total=80,
        credited_amount=0,
        status=InvoiceStatus.cancelled,
        voided=True,
    )
    db.add_all([bill, line, vr, vr_line, voided])
    await db.commit()
    return actor


async def _run() -> None:
    db = await _build_session()
    try:
        actor = await _seed(db)
        today = date.today().isoformat()

        register = await purchase_register(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        rows = {row["bill_number"]: row for row in register["items"]}
        assert register["total"] == 2, register
        assert "BILL-VR-0001" in rows
        assert "DN-2026-0001" in rows
        assert "DN-2026-VOID" not in rows

        bill = rows["BILL-VR-0001"]
        debit_note = rows["DN-2026-0001"]
        assert float(bill["total"]) == 160
        assert float(bill["subtotal"]) == 160
        assert bill["detail_kind"] == "bill"
        assert bill["transaction_type"] == "Bill"
        assert float(debit_note["total"]) == -80
        assert float(debit_note["subtotal"]) == -80
        assert debit_note["transaction_type"] == "Debit Note"
        assert debit_note["detail_kind"] == "debit_note"
        assert debit_note["document_id"] == "vr-1"
        assert float(bill["balance"]) == 0

        bills_only = await purchase_register(
            date_from=today,
            date_to=today,
            transaction_type="bill",
            db=db,
            user=actor,
        )
        assert bills_only["total"] == 1
        assert bills_only["items"][0]["transaction_type"] == "Bill"

        debit_notes_only = await purchase_register(
            date_from=today,
            date_to=today,
            transaction_type="debit_note",
            db=db,
            user=actor,
        )
        assert debit_notes_only["total"] == 1
        assert debit_notes_only["items"][0]["transaction_type"] == "Debit Note"

        lines = await purchase_lines(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        line_rows = lines["items"]
        assert len(line_rows) == 2
        qty_by_kind = {row["detail_kind"]: float(row["quantity"]) for row in line_rows}
        assert qty_by_kind["bill"] == 2
        assert qty_by_kind["debit_note"] == -1

        products = await product_purchases(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        assert products["total"] == 1
        product = products["items"][0]
        assert float(product["quantity_purchased"]) == 1
        assert float(product["purchase_cost"]) == 80

        vendors = await vendor_purchases(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        assert vendors["total"] == 1
        vendor = vendors["items"][0]
        assert int(vendor["purchase_count"]) == 2
        assert float(vendor["purchase_amount"]) == 80
        assert float(vendor["paid_amount"]) == 80
        assert float(vendor["outstanding_amount"]) == 0
    finally:
        await db.close()


def test_purchase_reports_include_vendor_returns_as_negatives() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("purchase_reports_vendor_returns: PASS")

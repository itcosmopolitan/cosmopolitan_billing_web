"""Sales reports include credit notes as negative entries."""
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
    SaleInvoice,
    SaleLineItem,
    SalesReturn,
    SalesReturnLineItem,
    SalesReturnStatus,
    User,
)
from src.routes.reports import daily_sales, product_sales, sales_lines, sales_register  # noqa: E402


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> User:
    today = date.today().isoformat()
    actor = User(
        id="u-reports-cn",
        name="Report Tester",
        email="reports-cn@example.com",
        hashed_password="x",
        all_branches=True,
    )
    db.add_all([
        actor,
        Branch(id="b1", name="Main", code="MAIN"),
        Item(id="item-1", name="Rice 5kg", sku="RICE-5", cost_price=40, selling_price=80),
    ])
    inv = SaleInvoice(
        id="inv-1",
        number="INV-CN-0001",
        customer_name="Acme Customer",
        branch_id="b1",
        branch_name="Main",
        cashier="Report Tester",
        date=today,
        subtotal=160,
        tax_total=0,
        discount=0,
        total=160,
        paid_amount=160,
        credited_amount=80,
        payment_mode="cash",
        status=InvoiceStatus.paid,
    )
    line = SaleLineItem(
        id="line-1",
        invoice_id="inv-1",
        item_id="item-1",
        name="Rice 5kg",
        sku="RICE-5",
        qty=2,
        price=80,
        tax_rate=0,
        line_total=160,
    )
    cn = SalesReturn(
        id="cn-1",
        number="CN-2026-0001",
        invoice_id="inv-1",
        invoice_number="INV-CN-0001",
        customer_name="Acme Customer",
        branch_id="b1",
        branch_name="Main",
        date=today,
        refund_method="cash",
        subtotal=80,
        tax_total=0,
        total=80,
        credited_amount=80,
        status=SalesReturnStatus.processed,
        created_by="Report Tester",
    )
    cn_line = SalesReturnLineItem(
        id="cn-line-1",
        return_id="cn-1",
        invoice_line_id="line-1",
        item_id="item-1",
        name="Rice 5kg",
        original_qty=2,
        return_qty=1,
        price=80,
        tax_rate=0,
        line_total=80,
    )
    voided = SalesReturn(
        id="cn-void",
        number="CN-2026-VOID",
        invoice_id="inv-1",
        invoice_number="INV-CN-0001",
        customer_name="Acme Customer",
        branch_id="b1",
        branch_name="Main",
        date=today,
        refund_method="cash",
        subtotal=80,
        tax_total=0,
        total=80,
        credited_amount=0,
        status=SalesReturnStatus.void,
        created_by="Report Tester",
    )
    db.add_all([inv, line, cn, cn_line, voided])
    await db.commit()
    return actor


async def _run() -> None:
    db = await _build_session()
    try:
        actor = await _seed(db)
        today = date.today().isoformat()

        register = await sales_register(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        rows = {row["invoice_number"]: row for row in register["items"]}
        assert register["total"] == 2, register
        assert "INV-CN-0001" in rows
        assert "CN-2026-0001" in rows
        assert "CN-2026-VOID" not in rows

        invoice = rows["INV-CN-0001"]
        credit_note = rows["CN-2026-0001"]
        assert float(invoice["net_amount"]) == 160
        assert invoice["detail_kind"] == "invoice"
        assert invoice["transaction_type"] == "Invoice"
        assert float(credit_note["net_amount"]) == -80
        assert float(credit_note["taxable_amount"]) == -80
        assert credit_note["transaction_type"] == "Credit Note"
        assert credit_note["detail_kind"] == "credit_note"
        assert credit_note["document_id"] == "cn-1"
        assert credit_note["status"] == "processed"
        assert float(invoice["remaining_amount"]) == 0

        invoices_only = await sales_register(
            date_from=today,
            date_to=today,
            transaction_type="invoice",
            db=db,
            user=actor,
        )
        assert invoices_only["total"] == 1
        assert invoices_only["items"][0]["transaction_type"] == "Invoice"

        credit_notes_only = await sales_register(
            date_from=today,
            date_to=today,
            transaction_type="credit_note",
            db=db,
            user=actor,
        )
        assert credit_notes_only["total"] == 1
        assert credit_notes_only["items"][0]["transaction_type"] == "Credit Note"

        lines = await sales_lines(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        line_rows = lines["items"]
        assert len(line_rows) == 2
        qty_by_kind = {row["detail_kind"]: float(row["quantity"]) for row in line_rows}
        assert qty_by_kind["invoice"] == 2
        assert qty_by_kind["credit_note"] == -1

        products = await product_sales(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        assert products["total"] == 1
        product = products["items"][0]
        assert float(product["quantity_sold"]) == 1
        assert float(product["sales_value"]) == 80

        daily = await daily_sales(
            date_from=today,
            date_to=today,
            db=db,
            user=actor,
        )
        assert daily["total"] == 1
        day = daily["items"][0]
        assert int(day["invoice_count"]) == 2
        assert float(day["quantity_sold"]) == 1
        assert float(day["net_sales"]) == 80
    finally:
        await db.close()


def test_sales_reports_include_credit_notes_as_negatives() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("sales_reports_credit_notes: PASS")

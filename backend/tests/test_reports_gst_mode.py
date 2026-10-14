"""Reports GST display mode — inclusive (default) vs exclusive money columns."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.database import Base  # noqa: E402
from src.gst_display import excl_amount, is_exclusive, scale_doc_rows  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Customer,
    InvoiceStatus,
    Item,
    PurchaseBill,
    SaleInvoice,
    SaleLineItem,
    SalesReturn,
    SalesReturnLineItem,
    User,
    Vendor,
)
from src.routes.reports import (  # noqa: E402
    daily_sales,
    daily_sales_returns,
    outstanding_payables,
    outstanding_receivables,
    purchase_register,
    sales_aging_detail,
    sales_lines,
    sales_register,
    tax_summary_detail,
    top_customers,
    vendor_outstanding,
)

AS_OF = "2026-03-31"
INVOICE_DATE = "2026-03-10"
BILL_DATE = "2026-03-10"
RETURN_DATE = "2026-03-12"


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> User:
    user = User(
        id="u-gst",
        name="GST Tester",
        email="gst@example.com",
        hashed_password="x",
        all_branches=True,
    )
    db.add_all([
        user,
        Branch(id="b1", name="Main", code="MAIN"),
        Customer(id="c1", name="Cust One", customer_code="C1", branch_id="b1"),
        Vendor(id="v1", name="Acme Supplies"),
    ])
    # GST-inclusive invoice: total 108 = taxable 100 + tax 8.
    db.add(SaleInvoice(
        id="inv-1",
        number="INV-1",
        customer_id="c1",
        customer_name="Cust One",
        branch_id="b1",
        branch_name="Main",
        cashier="GST Tester",
        date=INVOICE_DATE,
        due_date=INVOICE_DATE,
        subtotal=100.0,
        tax_total=8.0,
        discount=0.0,
        total=108.0,
        paid_amount=0.0,
        credited_amount=0.0,
        status=InvoiceStatus.pending,
    ))
    # GST-inclusive bill: total 216 = taxable 200 + tax 16, 16 paid.
    db.add(PurchaseBill(
        id="bill-1",
        number="PUR-1",
        vendor_id="v1",
        vendor_name="Acme Supplies",
        branch_id="b1",
        branch_name="Main",
        date=BILL_DATE,
        due_date=BILL_DATE,
        subtotal=200.0,
        tax_total=16.0,
        total=216.0,
        paid_amount=16.0,
        status=InvoiceStatus.partial,
    ))
    await db.commit()
    return user


def test_excl_amount_strips_line_gst():
    assert excl_amount(108, 8) == 100.0
    assert excl_amount(100, 0) == 100.0
    assert excl_amount(None, 8) == 0.0


def test_is_exclusive_only_for_exclusive_mode():
    assert is_exclusive("exclusive")
    assert is_exclusive(" Exclusive ")
    assert not is_exclusive("inclusive")
    assert not is_exclusive(None)
    assert not is_exclusive("unknown")


def test_scale_doc_rows_restates_by_taxable_ratio():
    rows = [{"total": 108.0, "tax": 8.0, "paid": 54.0, "qty": 3}]
    scale_doc_rows(rows, ["total", "paid"])
    assert rows[0]["total"] == 100.0
    assert rows[0]["paid"] == 50.0
    assert rows[0]["tax"] == 8.0
    assert rows[0]["qty"] == 3


async def _run_reports():
    db = await _build_session()
    try:
        user = await _seed(db)

        # Receivables: outstanding 108 inclusive, 100 exclusive.
        ar_incl = await outstanding_receivables(
            date_from=INVOICE_DATE, date_to=AS_OF, skip=0, limit=50, db=db,
        )
        ar_excl = await outstanding_receivables(
            date_from=INVOICE_DATE, date_to=AS_OF, skip=0, limit=50,
            gst_mode="exclusive", db=db,
        )
        assert ar_incl["items"][0]["outstanding_amount"] == 108.0
        assert ar_excl["items"][0]["outstanding_amount"] == 100.0

        # Payables: outstanding 200 inclusive; exclusive 200 * 200 / 216.
        ap_incl = await outstanding_payables(
            date_from=BILL_DATE, date_to=AS_OF, skip=0, limit=50, db=db,
        )
        ap_excl = await outstanding_payables(
            date_from=BILL_DATE, date_to=AS_OF, skip=0, limit=50,
            gst_mode="exclusive", db=db,
        )
        assert ap_incl["items"][0]["outstanding_amount"] == 200.0
        assert ap_excl["items"][0]["outstanding_amount"] == pytest.approx(200 * 200 / 216, abs=0.01)

        # Sales aging detail converts both original amount and balance.
        aging_excl = await sales_aging_detail(
            date_to=AS_OF, skip=0, limit=50, gst_mode="exclusive", db=db,
        )
        assert aging_excl["items"][0]["original_amount"] == 100.0
        assert aging_excl["items"][0]["balance"] == 100.0

        # Purchase register restates total and paid; tax column is unchanged.
        reg_excl = await purchase_register(
            date_from=BILL_DATE, date_to=AS_OF, skip=0, limit=50,
            gst_mode="exclusive", db=db, user=user,
        )
        row = reg_excl["items"][0]
        assert row["total"] == 200.0
        assert row["tax"] == 16.0

        reg_incl = await purchase_register(
            date_from=BILL_DATE, date_to=AS_OF, skip=0, limit=50, db=db, user=user,
        )
        assert reg_incl["items"][0]["total"] == 216.0

        # Vendor outstanding restates purchase and outstanding amounts per bill.
        vo_excl = await vendor_outstanding(
            date_from=BILL_DATE, date_to=AS_OF, skip=0, limit=50,
            gst_mode="exclusive", db=db, user=user,
        )
        assert vo_excl["items"][0]["purchase_amount"] == 200.0
        assert vo_excl["items"][0]["outstanding_amount"] == pytest.approx(200 * 200 / 216, abs=0.01)

        # Top customers: sales docs restated in exclusive mode.
        tc_incl = await top_customers(
            date_from=INVOICE_DATE, date_to=AS_OF, skip=0, limit=50, db=db, user=user,
        )
        tc_excl = await top_customers(
            date_from=INVOICE_DATE, date_to=AS_OF, skip=0, limit=50,
            gst_mode="exclusive", db=db, user=user,
        )
        assert tc_incl["items"][0]["purchase_amount"] == 108.0
        assert tc_excl["items"][0]["purchase_amount"] == 100.0
        assert tc_excl["items"][0]["outstanding_amount"] == 100.0

        # Sales register drilldown: net amount restated, taxable amount unchanged.
        sr_excl = await sales_register(
            date_from=INVOICE_DATE, date_to=AS_OF, skip=0, limit=50,
            gst_mode="exclusive", db=db, user=user,
        )
        sale_row = next(r for r in sr_excl["items"] if r["invoice_number"] == "INV-1")
        assert sale_row["net_amount"] == 100.0
        assert sale_row["taxable_amount"] == 100.0
        assert sale_row["tax_amount"] == 8.0

        sr_incl = await sales_register(
            date_from=INVOICE_DATE, date_to=AS_OF, skip=0, limit=50, db=db, user=user,
        )
        sale_row_incl = next(r for r in sr_incl["items"] if r["invoice_number"] == "INV-1")
        assert sale_row_incl["net_amount"] == 108.0
    finally:
        await db.close()


def test_gst_mode_reports():
    asyncio.run(_run_reports())


async def _seed_sales_activity(db: AsyncSession) -> None:
    # Widget sold for 108 incl. 8% GST (cost 60); half of it returned later.
    db.add(Item(id="it-1", name="Widget", cost_price=60.0, tax_rate=8.0))
    db.add(SaleLineItem(
        id="sli-1",
        invoice_id="inv-1",
        item_id="it-1",
        name="Widget",
        qty=1.0,
        price=108.0,
        tax_rate=8.0,
        discount=0.0,
        line_total=108.0,
    ))
    db.add(SalesReturn(
        id="cn-1",
        number="CN-1",
        invoice_id="inv-1",
        invoice_number="INV-1",
        customer_id="c1",
        customer_name="Cust One",
        branch_id="b1",
        branch_name="Main",
        date=RETURN_DATE,
        refund_method="cash",
        subtotal=50.0,
        tax_total=4.0,
        total=54.0,
        credited_amount=54.0,
    ))
    db.add(SalesReturnLineItem(
        id="srl-1",
        return_id="cn-1",
        invoice_line_id="sli-1",
        item_id="it-1",
        name="Widget",
        original_qty=1.0,
        return_qty=0.5,
        price=108.0,
        tax_rate=8.0,
        line_total=54.0,
    ))
    await db.commit()


def _row_by(rows, key, value):
    return next(r for r in rows if r[key] == value)


async def _run_sales_reports():
    db = await _build_session()
    try:
        user = await _seed(db)
        await _seed_sales_activity(db)
        common = dict(date_from=INVOICE_DATE, date_to=AS_OF, db=db, user=user)

        # Daily sales: GST-exclusive restates money; tax stays as stored.
        ds_incl = await daily_sales(skip=0, limit=50, **common)
        ds_excl = await daily_sales(skip=0, limit=50, gst_mode="exclusive", **common)
        inv_incl = _row_by(ds_incl["items"], "date", INVOICE_DATE)
        cn_incl = _row_by(ds_incl["items"], "date", RETURN_DATE)
        assert inv_incl["gross_sales"] == 108.0
        assert inv_incl["tax"] == 8.0
        assert cn_incl["gross_sales"] == -54.0
        assert cn_incl["tax"] == -4.0

        inv_excl = _row_by(ds_excl["items"], "date", INVOICE_DATE)
        cn_excl = _row_by(ds_excl["items"], "date", RETURN_DATE)
        assert inv_excl["gross_sales"] == 100.0
        assert inv_excl["net_sales"] == 100.0
        assert inv_excl["tax"] == 8.0
        assert cn_excl["gross_sales"] == pytest.approx(-50.0)
        assert cn_excl["net_sales"] == pytest.approx(-50.0)
        assert cn_excl["tax"] == -4.0

        # Sales lines: unit price, line total and cost restated; taxable unchanged.
        sl_incl = await sales_lines(skip=0, limit=50, **common)
        sl_excl = await sales_lines(skip=0, limit=50, gst_mode="exclusive", **common)
        inv_line_incl = _row_by(sl_incl["items"], "transaction_type", "Invoice")
        cn_line_incl = _row_by(sl_incl["items"], "transaction_type", "Credit Note")
        assert inv_line_incl["unit_price"] == 108.0
        assert inv_line_incl["line_total"] == 108.0
        assert inv_line_incl["cost_value"] == 60.0
        assert inv_line_incl["profit"] == pytest.approx(40.0)
        assert cn_line_incl["line_total"] == -54.0
        assert cn_line_incl["cost_value"] == -30.0
        assert cn_line_incl["profit"] == pytest.approx(-20.0)

        inv_line = _row_by(sl_excl["items"], "transaction_type", "Invoice")
        cn_line = _row_by(sl_excl["items"], "transaction_type", "Credit Note")
        assert inv_line["unit_price"] == pytest.approx(100.0)
        assert inv_line["line_total"] == pytest.approx(100.0)
        assert inv_line["cost_value"] == pytest.approx(60 * 100 / 108)
        assert inv_line["taxable_total"] == pytest.approx(100.0)
        assert inv_line["profit"] == pytest.approx(100 - 60 * 100 / 108)
        assert cn_line["line_total"] == pytest.approx(-50.0)
        assert cn_line["cost_value"] == pytest.approx(-30 * 100 / 108)
        assert cn_line["taxable_total"] == pytest.approx(-50.0)

        # Daily sales returns: credited and net restated; gross and tax unchanged.
        dr_incl = await daily_sales_returns(skip=0, limit=50, **common)
        dr_excl = await daily_sales_returns(skip=0, limit=50, gst_mode="exclusive", **common)
        r_incl = _row_by(dr_incl["items"], "date", RETURN_DATE)
        assert r_incl["credited_amount"] == 54.0
        assert r_incl["net_returns"] == 54.0
        assert r_incl["gross_returns"] == 50.0
        assert r_incl["tax"] == 4.0

        r_excl = _row_by(dr_excl["items"], "date", RETURN_DATE)
        assert r_excl["credited_amount"] == pytest.approx(50.0)
        assert r_excl["net_returns"] == pytest.approx(50.0)
        assert r_excl["gross_returns"] == 50.0
        assert r_excl["tax"] == 4.0
        assert r_excl["quantity_returned"] == 0.5
    finally:
        await db.close()


def test_gst_mode_sales_reports():
    asyncio.run(_run_sales_reports())


async def _run_tax_summary_detail():
    db = await _build_session()
    try:
        user = await _seed(db)
        await _seed_sales_activity(db)
        common = dict(
            date_from=INVOICE_DATE, date_to=AS_OF, full_rate=8.0,
            skip=0, limit=50, db=db, user=user,
        )

        # Default is gross: invoice 108 incl. 8 tax; credit note reverses 54 incl. 4 tax.
        gross = await tax_summary_detail(**common)
        inv = _row_by(gross["items"], "transaction_type", "Invoice")
        cn = _row_by(gross["items"], "transaction_type", "Credit Note")
        assert inv["transaction_amount"] == 108.0
        assert inv["tax_amount"] == 8.0
        assert cn["transaction_amount"] == -54.0
        assert cn["tax_amount"] == -4.0

        # Exclusive shows taxable only; tax is unchanged.
        net = await tax_summary_detail(gst_mode="exclusive", **common)
        inv_net = _row_by(net["items"], "transaction_type", "Invoice")
        cn_net = _row_by(net["items"], "transaction_type", "Credit Note")
        assert inv_net["transaction_amount"] == pytest.approx(100.0)
        assert inv_net["tax_amount"] == 8.0
        assert cn_net["transaction_amount"] == pytest.approx(-50.0)
        assert cn_net["tax_amount"] == -4.0
    finally:
        await db.close()


def test_gst_mode_tax_summary_detail():
    asyncio.run(_run_tax_summary_detail())

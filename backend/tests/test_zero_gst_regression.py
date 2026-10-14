"""Regression: taxable customers/vendors must never keep a stale 0% GST on
item lines, while legitimate zero-GST cases (internal customer, same GSTIN,
0% item) stay at 0%."""
import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Customer,
    Item,
    Organisation,
    PurchaseOrderLineItem,
    QuotationLineItem,
    SalesOrderLineItem,
    User,
    Vendor,
)
from src.routes.purchases import (  # noqa: E402
    PurchaseOrderCreate,
    PurchaseOrderLineIn,
    create_order as create_purchase_order,
)
from src.routes.sales import (  # noqa: E402
    LineItemIn,
    QuotationCreate,
    _apply_internal_customer_gst,
    convert_quote_to_order,
    create_quotation,
)

ORG_GSTIN = "33AAZCS1429R1Z1"


async def _session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    db = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()
    db.add_all([
        Branch(id="b1", name="Main", code="MAIN"),
        Organisation(id="org1", name="Org", gstin=ORG_GSTIN),
        User(id="u1", name="Tester", email="t@example.com", hashed_password="x", all_branches=True),
        Item(id="i8", name="Eight", cost_price=40, selling_price=108, tax_rate=8),
        Item(id="i0", name="Zero", cost_price=40, selling_price=100, tax_rate=0),
        Customer(id="ext", name="External", gstin="29ABCDE1234F1Z5", classification="external"),
        Customer(id="int", name="Internal", classification="internal"),
        Customer(id="same", name="Same", gstin=ORG_GSTIN, classification="external"),
        Vendor(id="vext", name="VExt", gstin="29ABCDE1234F1Z5"),
        Vendor(id="vsame", name="VSame", gstin=ORG_GSTIN),
    ])
    await db.commit()
    return engine, db


def _run(coro_fn):
    async def _wrap():
        engine, db = await _session()
        try:
            return await coro_fn(db)
        finally:
            await db.close()
            await engine.dispose()
    return asyncio.run(_wrap())


def _apply(customer_id, item_id, rate):
    async def go(db):
        line = SimpleNamespace(item_id=item_id, price=108.0, tax_rate=rate, line_discount=0)
        await _apply_internal_customer_gst(db, customer_id, [line], None)
        return line.tax_rate
    return _run(go)


def test_external_customer_stale_zero_restored_from_item_master():
    assert _apply("ext", "i8", 0) == 8


def test_external_customer_keeps_snapshot_rate():
    assert _apply("ext", "i8", 18) == 18


def test_walk_in_stale_zero_restored():
    assert _apply(None, "i8", 0) == 8


def test_zero_percent_item_stays_zero():
    assert _apply("ext", "i0", 0) == 0


def test_internal_customer_stays_zero():
    assert _apply("int", "i8", 8) == 0
    assert _apply("int", "i8", 0) == 0


def test_same_gstin_customer_stays_zero():
    assert _apply("same", "i8", 8) == 0
    assert _apply("same", "i8", 0) == 0


def test_free_text_line_is_untouched():
    assert _apply("ext", None, 0) == 0


def _quote(customer_id, rate):
    async def go(db):
        user = (await db.execute(select(User).where(User.id == "u1"))).scalar_one()
        res = await create_quotation(
            QuotationCreate(
                customer_id=customer_id, customer_name="C", branch_id="b1", branch_name="Main",
                items=[LineItemIn(item_id="i8", name="Eight", qty=1, price=108, tax_rate=rate)],
            ),
            db=db, user=user,
        )
        line = (await db.execute(select(QuotationLineItem))).scalar_one()
        return line.tax_rate
    return _run(go)


def test_create_quotation_restores_stale_zero():
    assert _quote("ext", 0) == 8


@pytest.mark.parametrize("cid", ["int", "same"])
def test_create_quotation_zero_cases_stay_zero(cid):
    assert _quote(cid, 8) == 0


def test_convert_zeroed_quote_to_order_restores_rate_and_totals():
    async def go(db):
        user = (await db.execute(select(User).where(User.id == "u1"))).scalar_one()
        await create_quotation(
            QuotationCreate(
                customer_id="ext", customer_name="C", branch_id="b1", branch_name="Main",
                items=[LineItemIn(item_id="i8", name="Eight", qty=1, price=108, tax_rate=8)],
            ),
            db=db, user=user,
        )
        # Simulate legacy bad data: quote persisted with 0% GST.
        from src.models import Quotation
        q = (await db.execute(select(Quotation))).scalar_one()
        ql = (await db.execute(select(QuotationLineItem))).scalar_one()
        ql.tax_rate = 0
        q.tax_total = 0
        q.subtotal = q.total
        await db.commit()
        await convert_quote_to_order(q.id, db=db, user=user)
        so_line = (await db.execute(select(SalesOrderLineItem))).scalar_one()
        from src.models import SalesOrder
        so = (await db.execute(select(SalesOrder))).scalar_one()
        return so_line.tax_rate, so.tax_total, so.subtotal, so.total
    rate, tax, subtotal, total = _run(go)
    assert rate == 8
    assert tax == 8.0
    assert subtotal == 100.0
    assert total == 108.0


def _po(vendor_id, rate):
    async def go(db):
        user = (await db.execute(select(User).where(User.id == "u1"))).scalar_one()
        await create_purchase_order(
            PurchaseOrderCreate(
                vendor_id=vendor_id, vendor_name="V", branch_id="b1", branch_name="Main",
                items=[PurchaseOrderLineIn(item_id="i8", name="Eight", qty=1, cost=50, tax_rate=rate, discount=0)],
                discount=0, notes="t",
            ),
            db=db, user=user,
        )
        return (await db.execute(select(PurchaseOrderLineItem))).scalar_one().tax_rate
    return _run(go)


def test_purchase_order_external_vendor_stale_zero_restored():
    assert _po("vext", 0) == 8


def test_purchase_order_same_gstin_vendor_stays_zero():
    assert _po("vsame", 8) == 0


def test_repair_script_fixes_zeroed_quote_and_skips_internal(monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "repair_zero_gst_lines", Path(__file__).resolve().parents[1] / "scripts" / "repair_zero_gst_lines.py",
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    from src.models import Quotation

    async def go(db):
        for n, cid in (("Q1", "ext"), ("Q2", "int"), ("Q3", "same")):
            q = Quotation(id=n, number=n, customer_id=cid, customer_name=cid, branch_id="b1", date="2026-01-01",
                          subtotal=108, tax_total=0, discount=0, total=108)
            db.add(q)
            db.add(QuotationLineItem(id=f"L{n}", quotation_id=n, item_id="i8", name="Eight", qty=1, price=108,
                                     tax_rate=0, discount=0, line_total=108))
        await db.commit()
        fixed = await mod._repair(db, Quotation, "Quote", ORG_GSTIN, True)
        await db.commit()
        q1 = (await db.execute(select(Quotation).where(Quotation.id == "Q1"))).scalar_one()
        q2 = (await db.execute(select(Quotation).where(Quotation.id == "Q2"))).scalar_one()
        return fixed, q1.tax_total, q1.subtotal, q2.tax_total
    fixed, tax, subtotal, internal_tax = _run(go)
    assert fixed == 1
    assert (tax, subtotal) == (8.0, 100.0)
    assert internal_tax == 0

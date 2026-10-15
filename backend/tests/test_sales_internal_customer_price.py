import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import Customer, Item, Organisation  # noqa: E402
from src.routes.sales import _apply_internal_customer_gst  # noqa: E402

ORG_GSTIN = "33AAZCS1429R1Z1"


async def _apply_for_customer(customer_gstin):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    db = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()
    try:
        db.add_all([
            Organisation(id="org1", name="Org", gstin=ORG_GSTIN),
            Customer(id="c1", name="Customer", gstin=customer_gstin),
            Item(id="item-1", name="Item", cost_price=40, selling_price=55, tax_rate=18),
        ])
        await db.commit()
        items = [
            SimpleNamespace(item_id="item-1", price=55.0, tax_rate=18, line_discount=5),
            SimpleNamespace(item_id=None, price=30.0, tax_rate=18, line_discount=0),
        ]
        await _apply_internal_customer_gst(db, "c1", items, None)
        return items
    finally:
        await db.close()
        await engine.dispose()


def test_external_customer_line_is_unchanged():
    item, _ = asyncio.run(_apply_for_customer(None))
    assert item.price == 55.0
    assert item.tax_rate == 18
    assert item.line_discount == 5


def test_same_gstin_customer_uses_cost_price_with_zero_tax_and_no_discount():
    item, _ = asyncio.run(_apply_for_customer(ORG_GSTIN))
    assert item.price == 40.0
    assert item.tax_rate == 0
    assert item.line_discount == 0


def test_same_gstin_customer_keeps_price_for_free_text_line():
    _, free_text = asyncio.run(_apply_for_customer(ORG_GSTIN))
    assert free_text.price == 30.0
    assert free_text.tax_rate == 0
    assert free_text.line_discount == 0

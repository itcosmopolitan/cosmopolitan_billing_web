import asyncio
from pathlib import Path
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Item,
    Organisation,
    PurchaseOrderLineItem,
    User,
    Vendor,
)
from src.routes.purchases import (  # noqa: E402
    PurchaseOrderCreate,
    PurchaseOrderLineIn,
    create_order,
)

ORG_GSTIN = "33AAZCS1429R1Z1"


async def _create_po_cost(vendor_gstin):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    db = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()
    try:
        db.add_all([
            Branch(id="b1", name="Main", code="MAIN"),
            Vendor(id="v1", name="Vendor", gstin=vendor_gstin),
            Organisation(id="org1", name="Org", gstin=ORG_GSTIN),
            User(id="u1", name="Tester", email="t@example.com", hashed_password="x", all_branches=True),
            Item(id="item-1", name="Item A", cost_price=40, selling_price=60),
        ])
        await db.commit()
        user = (await db.execute(select(User).where(User.id == "u1"))).scalar_one()
        await create_order(
            PurchaseOrderCreate(
                vendor_id="v1",
                vendor_name="Vendor",
                branch_id="b1",
                branch_name="Main",
                items=[PurchaseOrderLineIn(item_id="item-1", name="Item A", qty=2, cost=50, tax_rate=18, discount=0)],
                discount=0,
                notes="cost test",
            ),
            db=db,
            user=user,
        )
        line = (await db.execute(select(PurchaseOrderLineItem))).scalar_one()
        return line.cost, line.tax_rate
    finally:
        await db.close()
        await engine.dispose()


def test_external_vendor_keeps_entered_cost():
    cost, tax_rate = asyncio.run(_create_po_cost(None))
    assert cost == 50
    assert tax_rate == 18


def test_same_gstin_vendor_keeps_entered_cost_with_zero_tax():
    cost, tax_rate = asyncio.run(_create_po_cost(ORG_GSTIN))
    assert cost == 50
    assert tax_rate == 0

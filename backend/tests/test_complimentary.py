import asyncio
import sys
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.document_numbering import DEFAULT_NUMBERING  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    ComplimentaryEntry,
    Customer,
    ComplimentaryLineItem,
    DocumentNumbering,
    Item,
    ItemStock,
    SaleInvoice,
    SaleLineItem,
    StockMovement,
    User,
)
from src.routes.complimentary import (  # noqa: E402
    ComplimentaryCreate,
    ComplimentaryLineIn,
    create_complimentary,
    delete_complimentary,
    get_complimentary,
    list_complimentary,
)


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> User:
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    user = User(id="u-test", name="Test User", username="tester", email="t@example.com",
                hashed_password="x", all_branches=True)
    db.add(user)
    db.add(Item(id="i1", name="Rice 5kg", unit="Bag", cost_price=40, selling_price=75, packaging="Carton"))
    db.add(ItemStock(id="s1", item_id="i1", branch_id="b1", quantity=10))
    for entry in DEFAULT_NUMBERING:
        db.add(DocumentNumbering(**entry))
    await db.commit()
    return user


async def _stock(db: AsyncSession) -> float:
    return float((await db.execute(
        select(ItemStock.quantity).where(ItemStock.item_id == "i1", ItemStock.branch_id == "b1")
    )).scalar_one())


async def _run_complimentary_flow() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)

        created = await create_complimentary(
            ComplimentaryCreate(
                reason="Sample",
                branch_id="b1",
                items=[ComplimentaryLineIn(item_id="i1", qty=3)],
                notes="Trade sample",
            ),
            request=None,
            db=db,
            user=user,
        )
        assert created["number"].startswith("CMP-"), created
        assert created["cost_value"] == 120.0

        assert await _stock(db) == 7

        movement = (await db.execute(
            select(StockMovement).where(StockMovement.source_type == "complimentary_entry")
        )).scalar_one()
        assert movement.movement_type == "complimentary"
        assert movement.delta == -3

        line = (await db.execute(select(ComplimentaryLineItem))).scalar_one()
        assert line.cost_price == 40
        assert line.cost_total == 120

        assert (await db.execute(select(func.count(SaleInvoice.id)))).scalar() == 0
        assert (await db.execute(select(func.count(SaleLineItem.id)))).scalar() == 0

        detail = await get_complimentary(created["id"], db=db, user=user)
        assert detail["reason"] == "Sample"
        assert detail["taxable_amount"] == 0.0
        assert detail["total"] == 0.0
        assert detail["items"][0]["cost_price"] == 40
        assert detail["items"][0]["unit"] == "Bag"
        assert detail["items"][0]["packaging"] == "Carton"

        listing = await list_complimentary(
            branch_id=None, reason=None, search=None, date_from=None, date_to=None,
            skip=0, limit=50, db=db, user=user,
        )
        assert listing["total"] == 1

        deleted = await delete_complimentary(created["id"], request=None, db=db, user=user)
        assert deleted["restored_qty"] == 3
        assert await _stock(db) == 10
        restore = (await db.execute(
            select(StockMovement).where(StockMovement.movement_type == "complimentary_reversal")
        )).scalar_one()
        assert restore.delta == 3
        assert (await db.execute(select(func.count(ComplimentaryEntry.id)))).scalar() == 0
        assert (await db.execute(select(func.count(ComplimentaryLineItem.id)))).scalar() == 0
    finally:
        await db.close()


async def _run_complimentary_list_sort_and_filter() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)
        db.add(Customer(id="c1", name="Acme Traders"))
        await db.commit()

        sample = await create_complimentary(
            ComplimentaryCreate(reason="Sample", branch_id="b1",
                                items=[ComplimentaryLineIn(item_id="i1", qty=1)]),
            request=None, db=db, user=user,
        )
        gift = await create_complimentary(
            ComplimentaryCreate(reason="Complimentary", branch_id="b1", customer_id="c1",
                                items=[ComplimentaryLineIn(item_id="i1", qty=3)]),
            request=None, db=db, user=user,
        )

        async def ids(**kwargs):
            base = dict(branch_id=None, reason=None, search=None, customer_id=None,
                        date_from=None, date_to=None, sort_by=None, sort_order="desc",
                        skip=0, limit=50, db=db, user=user)
            base.update(kwargs)
            return [row["id"] for row in (await list_complimentary(**base))["items"]]

        assert await ids(sort_by="total", sort_order="asc") == [sample["id"], gift["id"]]
        assert await ids(sort_by="total", sort_order="desc") == [gift["id"], sample["id"]]
        assert await ids(reason="Complimentary") == [gift["id"]]
        assert await ids(customer_id="c1") == [gift["id"]]
        assert len(await ids(sort_by="not_a_column")) == 2
    finally:
        await db.close()


async def _run_complimentary_child_counter() -> None:
    db = await _build_session()
    try:
        user = await _seed(db)
        branch = await db.get(Branch, "b1")
        branch.has_child_counters = True
        branch.child_counters = [
            {"id": "cc1", "name": "Counter 1"},
            {"id": "cc2", "name": "Counter 2"},
        ]
        await db.commit()

        def payload(**kwargs):
            return ComplimentaryCreate(
                reason="Sample", branch_id="b1",
                items=[ComplimentaryLineIn(item_id="i1", qty=1)], **kwargs,
            )

        for bad in ({}, {"child_counter_id": "cc9"}):
            try:
                await create_complimentary(payload(**bad), request=None, db=db, user=user)
            except HTTPException as exc:
                assert exc.status_code == 400
            else:
                raise AssertionError(f"expected 400 for {bad}")

        saved = await create_complimentary(
            payload(child_counter_id="cc1"), request=None, db=db, user=user,
        )
        entry = await get_complimentary(saved["id"], db=db, user=user)
        assert entry["child_counter_id"] == "cc1"
        assert entry["child_counter_name"] == "Counter 1"

        other = await create_complimentary(
            payload(child_counter_id="cc2"), request=None, db=db, user=user,
        )

        async def ids(**kwargs):
            base = dict(branch_id=None, reason=None, search=None, customer_id=None,
                        child_counter_id=None, date_from=None, date_to=None, sort_by=None,
                        sort_order="desc", skip=0, limit=50, db=db, user=user)
            base.update(kwargs)
            return sorted(row["id"] for row in (await list_complimentary(**base))["items"])

        assert await ids(child_counter_id="cc1") == [saved["id"]]
        assert await ids(child_counter_id="cc2") == [other["id"]]
        assert len(await ids()) == 2
    finally:
        await db.close()


def test_complimentary_child_counter() -> None:
    asyncio.run(_run_complimentary_child_counter())


def test_complimentary_list_sort_and_filter() -> None:
    asyncio.run(_run_complimentary_list_sort_and_filter())


def test_complimentary_stock_flow() -> None:
    asyncio.run(_run_complimentary_flow())

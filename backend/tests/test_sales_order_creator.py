import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import selectinload, sessionmaker

from src.database import Base
from src.models import Branch, Item, SalesOrder, SalesOrderLineItem, SalesOrderStatus, User
from src.notifications import store as notification_store
from src.routes import sales as sales_routes
from src.routes.sales import SalesOrderCreate, SalesOrderLineIn, _so_dict, create_order, submit_sales_order


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return session_factory()


def test_sales_order_creator_is_authenticated_and_legacy_staff_draft_is_recovered(monkeypatch):
    async def no_op(*args, **kwargs):
        return None

    monkeypatch.setattr(notification_store, "emit_sales_order_pending", no_op)
    monkeypatch.setattr(notification_store, "notify_refresh", no_op)
    monkeypatch.setattr(sales_routes, "can_direct_commit", no_op)

    async def run_test():
        db = await _build_session()
        try:
            db.add(Branch(id="b1", name="Main", code="MAIN"))
            creator = User(
                id="u-creator",
                name="Actual Creator",
                email="creator@example.com",
                hashed_password="x",
                all_branches=True,
                role="cashier",
            )
            other_user = User(
                id="u-other",
                name="Other User",
                email="other@example.com",
                hashed_password="x",
                all_branches=True,
                role="cashier",
            )
            db.add_all([creator, other_user])
            await db.commit()

            result = await create_order(
                SalesOrderCreate(
                    branch_id="b1",
                    items=[SalesOrderLineIn(name="Test item", qty=1, price=10)],
                ),
                db=db,
                user=creator,
            )
            order = await db.get(SalesOrder, result["id"])
            assert order.created_by == creator.name

            order.status = SalesOrderStatus.draft
            order.created_by = "Staff"
            await db.commit()

            with pytest.raises(HTTPException) as exc_info:
                await submit_sales_order(order.id, db=db, user=other_user)
            assert exc_info.value.status_code == 403

            response = await submit_sales_order(order.id, db=db, user=creator)
            assert response["status"] == "pending_approval"
            assert order.created_by == creator.name
        finally:
            await db.close()

    asyncio.run(run_test())


def test_sales_order_number_skips_deleted_gaps():
    from datetime import datetime

    from src.document_numbering import next_free_prefixed_number

    async def run_test():
        db = await _build_session()
        try:
            db.add(Branch(id="b1", name="Main", code="MAIN"))
            await db.commit()
            year = datetime.utcnow().year
            db.add(SalesOrder(
                id="so-a", number=f"SO-{year}-1000",
                branch_id="b1", date="2026-10-06", status=SalesOrderStatus.draft,
            ))
            db.add(SalesOrder(
                id="so-c", number=f"SO-{year}-1002",
                branch_id="b1", date="2026-10-06", status=SalesOrderStatus.draft,
            ))
            await db.commit()
            # COUNT(*) would be 2 → SO-{year}-1002, which already exists.
            next_num = await next_free_prefixed_number(db, SalesOrder, doc_prefix="SO")
            assert next_num == f"SO-{year}-1003"
        finally:
            await db.close()

    asyncio.run(run_test())


def test_sales_order_response_includes_inventory_packing_and_unit():
    async def run_test():
        db = await _build_session()
        try:
            db.add(Branch(id="b1", name="Main", code="MAIN"))
            db.add(Item(id="item-1", name="Almond Flakes", unit="KG", packaging="1x15KG"))
            order = SalesOrder(
                id="so-1", number="SO-0001", branch_id="b1", date="2026-10-06",
                status=SalesOrderStatus.draft,
            )
            db.add(order)
            db.add(SalesOrderLineItem(
                id="line-1", order_id="so-1", item_id="item-1",
                name="Almond Flakes", qty=1, price=257.2,
            ))
            await db.commit()

            loaded_order = (await db.execute(
                select(SalesOrder)
                .options(selectinload(SalesOrder.line_items).selectinload(SalesOrderLineItem.item))
                .where(SalesOrder.id == "so-1")
            )).scalar_one()

            result = _so_dict(loaded_order, loaded_order.line_items)
            assert result["items"][0]["packing"] == "1x15KG"
            assert result["items"][0]["unit"] == "KG"
        finally:
            await db.close()

    asyncio.run(run_test())
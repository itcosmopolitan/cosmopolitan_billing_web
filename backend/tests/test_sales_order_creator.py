import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, SalesOrder, SalesOrderStatus, User
from src.notifications import store as notification_store
from src.routes import sales as sales_routes
from src.routes.sales import SalesOrderCreate, SalesOrderLineIn, create_order, submit_sales_order


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
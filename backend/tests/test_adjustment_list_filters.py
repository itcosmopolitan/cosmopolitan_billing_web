import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import AdjustmentRequest, AdjustmentStatus, Branch, Item
from src.routes import adjustments as adjustments_route
from src.routes.adjustments import (
    AdjustmentBatchCreate,
    AdjustmentBatchLine,
    list_adjustments,
)


def test_adjustment_list_applies_search_reason_and_date_filters():
    async def _run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            db.add(Branch(id="branch-1", name="Main", code="MAIN"))
            db.add_all([
                AdjustmentRequest(
                    id="adj-1",
                    ref_number="ADJ-001",
                    branch_id="branch-1",
                    branch_name="Main",
                    item_id="item-1",
                    item_name="Rice 5kg",
                    before_qty=10,
                    new_qty=8,
                    reason="Physical count",
                    status=AdjustmentStatus.approved,
                    requested_by="Amin",
                    created_at=datetime(2025, 4, 10),
                ),
                AdjustmentRequest(
                    id="adj-2",
                    ref_number="ADJ-002",
                    branch_id="branch-1",
                    branch_name="Main",
                    item_id="item-2",
                    item_name="Sugar",
                    before_qty=10,
                    new_qty=9,
                    reason="Damaged / Spoilage",
                    status=AdjustmentStatus.approved,
                    requested_by="Amin",
                    created_at=datetime(2025, 4, 11),
                ),
            ])
            await db.commit()

            result = await list_adjustments(
                status="approved",
                child_counter_id=None,
                branch_id=None,
                search="rice",
                reason="Physical count",
                date_from="2025-04-10",
                date_to="2025-04-10",
                sort_by=None,
                sort_order="desc",
                skip=0,
                limit=50,
                db=db,
                user=SimpleNamespace(all_branches=True),
            )

            assert result["total"] == 1
            assert result["items"][0]["ref_number"] == "ADJ-001"
        await engine.dispose()

    asyncio.run(_run())


def test_bulk_adjustment_creation_creates_one_request_per_item(monkeypatch):
    async def _run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            db.add_all([
                Branch(id="branch-1", name="Main", code="MAIN"),
                Item(id="item-1", name="Rice"),
                Item(id="item-2", name="Sugar"),
            ])
            await db.commit()

            async def allow_branch_access(*args, **kwargs):
                return None

            async def no_direct_approval(*args, **kwargs):
                return False

            monkeypatch.setattr(adjustments_route, "enforce_branch_access", allow_branch_access)
            monkeypatch.setattr(adjustments_route, "can_direct_commit", no_direct_approval)
            result = await adjustments_route.create_adjustment_batch(
                AdjustmentBatchCreate(
                    branch_id="branch-1",
                    items=[
                        AdjustmentBatchLine(item_id="item-1", item_name="Rice", new_qty=8),
                        AdjustmentBatchLine(item_id="item-2", item_name="Sugar", new_qty=12),
                    ],
                    reason="Physical count",
                ),
                db=db,
                user=SimpleNamespace(
                    all_branches=True,
                    id="staff-1",
                    name="Staff",
                    role="staff",
                    role_id=None,
                ),
            )

            assert len(result["items"]) == 2
            assert all(item["status"] == "draft" for item in result["items"])
            assert len({item["ref_number"] for item in result["items"]}) == 2
            assert await db.scalar(select(func.count(AdjustmentRequest.id))) == 2
        await engine.dispose()

    asyncio.run(_run())


def test_bulk_adjustment_creation_rejects_duplicate_items(monkeypatch):
    async def _run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            db.add(Branch(id="branch-1", name="Main", code="MAIN"))
            await db.commit()

            async def allow_branch_access(*args, **kwargs):
                return None

            monkeypatch.setattr(adjustments_route, "enforce_branch_access", allow_branch_access)
            with pytest.raises(HTTPException) as exc_info:
                await adjustments_route.create_adjustment_batch(
                    AdjustmentBatchCreate(
                        branch_id="branch-1",
                        items=[
                            AdjustmentBatchLine(item_id="item-1", item_name="Rice", new_qty=8),
                            AdjustmentBatchLine(item_id="item-1", item_name="Rice", new_qty=9),
                        ],
                        reason="Physical count",
                    ),
                    db=db,
                    user=SimpleNamespace(all_branches=True, name="Staff"),
                )
            assert exc_info.value.detail == "Each item may only appear once in an adjustment request"
            assert await db.scalar(select(func.count(AdjustmentRequest.id))) == 0
        await engine.dispose()

    asyncio.run(_run())

import asyncio
from datetime import datetime
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import AdjustmentRequest, AdjustmentStatus, Branch
from src.routes.adjustments import list_adjustments


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

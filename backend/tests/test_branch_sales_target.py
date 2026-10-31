from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base, _ensure_columns
from src.models import Branch
from src.routes.dashboard import _sales_target_for_branches
from src.routes._serializers import serialize_branch
from src.routes.branches import BranchCreate, BranchUpdate


def test_branch_target_input_is_non_negative():
    branch = BranchCreate(name="Main", code="MA", monthly_sales_target=1500)
    assert branch.monthly_sales_target == 1500
    with pytest.raises(ValidationError):
        BranchUpdate(monthly_sales_target=-1)


def test_sales_target_sums_active_branches_and_respects_branch_scope():
    asyncio.run(_run_sales_target_scope_test())


async def _run_sales_target_scope_test() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    db = session_factory()
    try:
        db.add_all([
            Branch(id="br-1", name="One", code="ON", monthly_sales_target=2900),
            Branch(id="br-2", name="Two", code="TW", monthly_sales_target=5800),
            Branch(id="br-inactive", name="Inactive", code="IN", active=False, monthly_sales_target=10000),
        ])
        await db.commit()

        all_branches = SimpleNamespace(branch_id=None)
        one_branch = SimpleNamespace(branch_id="br-1")

        assert await _sales_target_for_branches(db, all_branches, None) == 8700
        assert await _sales_target_for_branches(db, one_branch, ["br-1", "br-2"]) == 2900
        assert serialize_branch(await db.get(Branch, "br-1"))["monthly_sales_target"] == 2900
    finally:
        await db.close()
        await engine.dispose()


def test_existing_branch_table_gets_target_column_with_zero_default():
    asyncio.run(_run_additive_column_migration())


async def _run_additive_column_migration() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.execute(text("CREATE TABLE branches (id VARCHAR PRIMARY KEY)"))
            added = await _ensure_columns(connection)
            assert ("branches", "monthly_sales_target") in added
            await connection.execute(text("INSERT INTO branches (id) VALUES ('br-old')"))
            target = await connection.execute(
                text("SELECT monthly_sales_target FROM branches WHERE id = 'br-old'")
            )
            assert target.scalar_one() == 0
    finally:
        await engine.dispose()

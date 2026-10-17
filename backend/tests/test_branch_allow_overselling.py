from __future__ import annotations

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base, _backfill_branch_allow_overselling
from src.models import Branch
from src.routes._serializers import serialize_branch
from src.routes._stock_ledger import get_allow_overselling


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()


def test_get_allow_overselling_reads_each_branch_independently():
    asyncio.run(_run_get_allow_overselling_per_branch())


async def _run_get_allow_overselling_per_branch() -> None:
    db = await _build_session()
    try:
        db.add_all([
            Branch(id="br-on", name="On", code="ON", allow_overselling=True),
            Branch(id="br-off", name="Off", code="OFF", allow_overselling=False),
        ])
        await db.commit()

        assert await get_allow_overselling(db, "br-on") is True
        assert await get_allow_overselling(db, "br-off") is False
    finally:
        await db.close()


def test_get_allow_overselling_fails_closed_for_unknown_branch():
    asyncio.run(_run_get_allow_overselling_unknown_branch())


async def _run_get_allow_overselling_unknown_branch() -> None:
    db = await _build_session()
    try:
        assert await get_allow_overselling(db, "missing") is False
    finally:
        await db.close()


def test_new_branch_defaults_to_overselling_disabled():
    asyncio.run(_run_new_branch_default())


async def _run_new_branch_default() -> None:
    db = await _build_session()
    try:
        db.add(Branch(id="br-new", name="New", code="NEW"))
        await db.commit()
        branch = await db.get(Branch, "br-new")
        assert branch.allow_overselling is False
    finally:
        await db.close()


def test_serialize_branch_emits_allow_overselling():
    branch = Branch(id="br-1", name="Main", code="M", allow_overselling=True)
    assert serialize_branch(branch)["allow_overselling"] is True
    branch.allow_overselling = False
    assert serialize_branch(branch)["allow_overselling"] is False


def test_backfill_copies_org_value_to_all_branches_when_column_added():
    asyncio.run(_run_backfill(org_value=0, added=True, expected=0))


def test_backfill_copies_org_true_to_all_branches():
    asyncio.run(_run_backfill(org_value=1, added=True, expected=1))


def test_backfill_skipped_when_column_already_existed():
    asyncio.run(_run_backfill(org_value=0, added=False, expected=1))


async def _run_backfill(*, org_value: int, added: bool, expected: int) -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "CREATE TABLE organisations (id VARCHAR PRIMARY KEY, allow_overselling BOOLEAN NOT NULL)"
            ))
            await conn.execute(text(
                "CREATE TABLE branches (id VARCHAR PRIMARY KEY, allow_overselling BOOLEAN NOT NULL DEFAULT 0)"
            ))
            await conn.execute(text(
                "INSERT INTO organisations (id, allow_overselling) VALUES ('org-1', :v)"
            ), {"v": org_value})
            await conn.execute(text(
                "INSERT INTO branches (id, allow_overselling) VALUES ('b-1', 1), ('b-2', 1)"
            ))
            added_columns = {("branches", "allow_overselling")} if added else set()
            await _backfill_branch_allow_overselling(conn, added_columns)
            rows = (await conn.execute(text("SELECT allow_overselling FROM branches"))).all()
            assert [int(r[0]) for r in rows] == [expected, expected]
    finally:
        await engine.dispose()

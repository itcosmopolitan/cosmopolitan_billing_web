"""System role startup bootstrapping preserves administrator-edited permissions."""
from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base, _bootstrap_system_roles
from src.models import Role
from src.system_roles import SYSTEM_ROLES


def test_system_role_bootstrap_preserves_permissions_on_existing_roles():
    asyncio.run(_test_system_role_bootstrap_preserves_permissions_on_existing_roles())


async def _test_system_role_bootstrap_preserves_permissions_on_existing_roles():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
            await _bootstrap_system_roles(connection)

        role_id, _, _, _, _, _ = SYSTEM_ROLES[1]
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            role = await db.scalar(select(Role).where(Role.id == role_id))
            assert role is not None
            role.permissions = ["invoices.view", "reports.export"]
            await db.commit()

        async with engine.begin() as connection:
            await _bootstrap_system_roles(connection)

        async with factory() as db:
            role = await db.scalar(select(Role).where(Role.id == role_id))
            assert role is not None
            assert role.permissions == ["invoices.view", "reports.export"]

            new_role_id = SYSTEM_ROLES[-1][0]
            new_role = await db.scalar(select(Role).where(Role.id == new_role_id))
            assert new_role is not None
            assert new_role.permissions == SYSTEM_ROLES[-1][-1]
    finally:
        await engine.dispose()

import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, Role, User, UserBranch
from src.routes.autocomplete import autocomplete_branch


def test_transfer_destination_branch_options_include_unassigned_branches():
    asyncio.run(_test_transfer_destination_branch_options_include_unassigned_branches())


async def _test_transfer_destination_branch_options_include_unassigned_branches():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            role = Role(
                id="transfer-role",
                key="transfer-user",
                label="Transfer user",
                permissions=["transfers.create"],
            )
            user = User(
                id="transfer-user",
                name="Transfer user",
                hashed_password="unused",
                role_id=role.id,
                all_branches=False,
            )
            branches = [
                Branch(id="source", name="Source", code="SRC"),
                Branch(id="assigned", name="Assigned", code="ASG"),
                Branch(id="unassigned", name="Unassigned", code="UNA"),
            ]
            db.add_all([
                role,
                user,
                *branches,
                UserBranch(user_id=user.id, branch_id="source"),
                UserBranch(user_id=user.id, branch_id="assigned"),
            ])
            await db.commit()

            standard_options = await autocomplete_branch(
                for_transfer_destination=False,
                retail_only=False,
                limit=100,
                db=db,
                user=user,
            )
            destination_options = await autocomplete_branch(
                retail_only=False,
                exclude_id="source",
                for_transfer_destination=True,
                limit=100,
                db=db,
                user=user,
            )

            assert {option["id"] for option in standard_options} == {"source", "assigned"}
            assert {option["id"] for option in destination_options} == {"assigned", "unassigned"}
    finally:
        await engine.dispose()


def test_transfer_destination_branch_options_require_transfer_permission():
    asyncio.run(_test_transfer_destination_branch_options_require_transfer_permission())


async def _test_transfer_destination_branch_options_require_transfer_permission():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with factory() as db:
            role = Role(
                id="viewer-role",
                key="transfer-viewer",
                label="Transfer viewer",
                permissions=["transfers.view"],
            )
            user = User(
                id="viewer",
                name="Transfer viewer",
                hashed_password="unused",
                role_id=role.id,
                all_branches=False,
            )
            db.add(role)
            db.add(user)
            await db.commit()

            with pytest.raises(HTTPException) as exc_info:
                await autocomplete_branch(
                    for_transfer_destination=True,
                    db=db,
                    user=user,
                )
            assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()

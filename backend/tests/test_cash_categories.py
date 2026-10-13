import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import Base  # noqa: E402
from src.models import Branch, CashCategory, Organisation, User  # noqa: E402
from src.routes.cash import (  # noqa: E402
    CashCategoryCreate,
    CashCategoryUpdate,
    create_category,
    delete_category,
    list_categories,
    update_category,
)


_REQUEST = SimpleNamespace(state=SimpleNamespace(ip_address=None, device_info=None))


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


async def _seed(db: AsyncSession) -> tuple[User, User]:
    db.add(Organisation(id="org1", name="Cosmo"))
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    db.add(Branch(id="b2", name="Second", code="SECOND"))
    admin = User(id="u-admin", name="Admin", username="admin", email="a@example.com",
                 hashed_password="x", all_branches=True)
    branch_user = User(id="u-b1", name="Branch 1", username="b1user", email="b1@example.com",
                       hashed_password="x", all_branches=False, branch_id="b1")
    db.add_all([admin, branch_user])
    db.add(CashCategory(id="shared", org_id="org1", branch_id=None, name="Shared Expense",
                        direction="out", is_system=False, active=True, sort_order=0))
    await db.commit()
    return admin, branch_user


async def _names(db: AsyncSession, admin: User, branch_id: str) -> list[str]:
    rows = await list_categories(branch_id=branch_id, db=db, current_user=admin)
    return sorted(r["name"] for r in rows)


async def _run_branch_isolation() -> None:
    db = await _build_session()
    try:
        admin, _ = await _seed(db)

        created = await create_category(
            CashCategoryCreate(branch_id="b1", name="Branch One Fuel", direction="out"),
            request=_REQUEST, db=db, current_user=admin,
        )
        assert created["branch_id"] == "b1"

        assert await _names(db, admin, "b1") == ["Branch One Fuel", "Shared Expense"]
        assert await _names(db, admin, "b2") == ["Shared Expense"]

        # Same name is allowed in a different branch
        again = await create_category(
            CashCategoryCreate(branch_id="b2", name="Branch One Fuel", direction="out"),
            request=_REQUEST, db=db, current_user=admin,
        )
        assert again["branch_id"] == "b2"
        assert await _names(db, admin, "b2") == ["Branch One Fuel", "Shared Expense"]

        # Duplicate within the same branch, or against a shared category, is rejected
        with pytest.raises(HTTPException) as dup_same:
            await create_category(
                CashCategoryCreate(branch_id="b1", name="branch one fuel", direction="out"),
                request=_REQUEST, db=db, current_user=admin,
            )
        assert dup_same.value.status_code == 400
        with pytest.raises(HTTPException) as dup_shared:
            await create_category(
                CashCategoryCreate(branch_id="b1", name="shared expense", direction="out"),
                request=_REQUEST, db=db, current_user=admin,
            )
        assert dup_shared.value.status_code == 400
    finally:
        await db.close()


async def _run_access_checks() -> None:
    db = await _build_session()
    try:
        _, branch_user = await _seed(db)

        with pytest.raises(HTTPException) as denied_create:
            await create_category(
                CashCategoryCreate(branch_id="b2", name="Other Branch Cost", direction="out"),
                request=_REQUEST, db=db, current_user=branch_user,
            )
        assert denied_create.value.status_code == 403

        own = await create_category(
            CashCategoryCreate(branch_id="b1", name="Own Branch Cost", direction="out"),
            request=_REQUEST, db=db, current_user=branch_user,
        )

        admin = (await db.get(User, "u-admin"))
        other = await create_category(
            CashCategoryCreate(branch_id="b2", name="Second Branch Cost", direction="out"),
            request=_REQUEST, db=db, current_user=admin,
        )

        with pytest.raises(HTTPException) as denied_update:
            await update_category(other["id"], CashCategoryUpdate(name="Renamed"),
                                  request=_REQUEST, db=db, current_user=branch_user)
        assert denied_update.value.status_code == 403

        with pytest.raises(HTTPException) as denied_delete:
            await delete_category(other["id"], request=_REQUEST, db=db, current_user=branch_user)
        assert denied_delete.value.status_code == 403

        await update_category(own["id"], CashCategoryUpdate(name="Renamed Own"),
                              request=_REQUEST, db=db, current_user=branch_user)
        await delete_category(own["id"], request=_REQUEST, db=db, current_user=branch_user)
        remaining = (await db.execute(
            CashCategory.__table__.select().where(CashCategory.id == own["id"])
        )).first()
        assert remaining is None
    finally:
        await db.close()


def test_cash_category_branch_isolation() -> None:
    asyncio.run(_run_branch_isolation())


def test_cash_category_branch_access_checks() -> None:
    asyncio.run(_run_access_checks())

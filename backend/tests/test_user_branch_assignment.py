import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, User, UserBranch
from src.routes.branches import BranchCreate, create_branch
from src.routes.users import _assign_branches


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return SessionLocal()


@pytest.mark.asyncio
async def test_all_branches_super_admin_inserts_all_branch_rows():
    db = await _build_session()
    try:
        branch_a = Branch(id="b-main", name="Main", code="MA")
        branch_b = Branch(id="b-branch-2", name="Branch 2", code="BR")
        user = User(
            id="u-super",
            name="Super Admin",
            email="super@example.com",
            hashed_password="x",
            all_branches=False,
            role="super_admin",
        )
        db.add_all([branch_a, branch_b, user])
        await db.flush()

        await _assign_branches(
            db,
            user,
            all_branches=True,
            branch_ids=[branch_a.id],
            legacy_single_branch_id=None,
        )
        await db.commit()

        rows = (await db.execute(select(UserBranch).where(UserBranch.user_id == user.id))).scalars().all()

        assert user.all_branches is True
        assert set(row.branch_id for row in rows) == {branch_a.id, branch_b.id}
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_new_branch_auto_adds_super_admins_to_user_branches():
    db = await _build_session()
    try:
        super_admin = User(
            id="u-super-1",
            name="Super Admin",
            email="super1@example.com",
            hashed_password="x",
            all_branches=True,
            role="super_admin",
        )
        normal_user = User(
            id="u-normal",
            name="Normal User",
            email="normal@example.com",
            hashed_password="x",
            all_branches=False,
            role="cashier",
        )
        db.add_all([super_admin, normal_user])
        await db.flush()

        result = await create_branch(
            data=BranchCreate(
                name="New Branch",
                code="NB",
                phone=None,
                address=None,
                street1=None,
                street2=None,
                street3=None,
                city=None,
                state_province=None,
                country=None,
                postal_code=None,
                gstin=None,
                active=True,
            ),
            db=db,
            request=None,
            user=super_admin,
        )

        rows = (await db.execute(select(UserBranch).where(UserBranch.user_id == super_admin.id))).scalars().all()

        assert result["id"]
        assert any(row.branch_id == result["id"] for row in rows)
        assert not any(row.branch_id == result["id"] for row in (await db.execute(select(UserBranch).where(UserBranch.user_id == normal_user.id))).scalars().all())
    finally:
        await db.close()

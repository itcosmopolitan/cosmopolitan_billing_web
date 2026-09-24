"""Invited users stay invited until they change the temp password."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# `src.routes.__init__` imports every router (including customers → openpyxl).
# Pre-register a namespace package so these tests can import only the modules
# they need without pulling the whole API surface.
if "src.routes" not in sys.modules:
    import src  # noqa: F401 — ensure parent package exists

    routes_pkg = types.ModuleType("src.routes")
    routes_pkg.__path__ = [str(ROOT / "src" / "routes")]
    sys.modules["src.routes"] = routes_pkg

from src.database import Base  # noqa: E402
from src.models import (  # noqa: E402
    Branch,
    Role,
    User,
    UserAccountStatus,
    account_status_value,
    apply_account_status,
)
from src.routes._serializers import serialize_user  # noqa: E402
from src.routes.auth import ChangePasswordRequest, LoginRequest, change_password, login  # noqa: E402
from src.routes.users import UserCreate, create_user, toggle_user  # noqa: E402
users_mod = sys.modules["src.routes.users"]
auth_mod = sys.modules["src.routes.auth"]
from src.security import hash_password_async  # noqa: E402


async def _session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()


async def _seed_admin(db: AsyncSession) -> User:
    db.add(Role(id="role-cashier", key="cashier", label="Cashier", permissions=["pos.use"]))
    db.add(Branch(id="b1", name="Main", code="MAIN"))
    admin = User(
        id="u-admin",
        name="Admin",
        email="admin@test.com",
        hashed_password="x",
        role="super_admin",
        all_branches=True,
        active=True,
        status=UserAccountStatus.active.value,
        must_change_password=False,
    )
    db.add(admin)
    await db.commit()
    return admin


@pytest.mark.asyncio
async def test_create_user_starts_invited(monkeypatch):
    monkeypatch.setattr(users_mod, "send_temp_password_email", lambda *a, **k: None)
    db = await _session()
    try:
        admin = await _seed_admin(db)
        result = await create_user(
            data=UserCreate(
                name="New Cashier",
                email="cashier@test.com",
                role="cashier",
                branch_ids=["b1"],
            ),
            db=db,
            request=None,
            user=admin,
        )
        assert result["status"] == "invited"
        assert result["active"] is True
        assert result["must_change_password"] is True
        assert result["email"] == "cashier@test.com"
        assert result["temporary_password"]
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_no_email_creation_returns_one_time_credentials_and_forces_reset(monkeypatch):
    monkeypatch.setattr(users_mod, "send_temp_password_email", lambda *a, **k: None)
    monkeypatch.setattr(auth_mod, "create_access_token", lambda user_id: "test-token")
    db = await _session()
    try:
        admin = await _seed_admin(db)
        result = await create_user(
            data=UserCreate(name="Raghvendra Pratap Singh", role="cashier", branch_ids=["b1"]),
            db=db,
            request=None,
            user=admin,
        )

        assert result["email"] is None
        assert result["username"] == "raghvsi"
        assert result["temporary_password"]
        assert "temporary_password" not in serialize_user(
            (await db.execute(select(User).where(User.username == "raghvsi"))).scalar_one()
        )

        logged_in = await login(
            data=LoginRequest(identifier=result["username"], password=result["temporary_password"]),
            request=type("Request", (), {"state": type("State", (), {})()})(),
            db=db,
        )
        assert logged_in["user"]["must_change_password"] is True

        created = (await db.execute(select(User).where(User.username == result["username"]))).scalar_one()
        changed = await change_password(
            data=ChangePasswordRequest(old_password=result["temporary_password"], new_password="new-pass-99"),
            user=created,
            db=db,
        )
        assert changed["must_change_password"] is False
        assert created.status == UserAccountStatus.active.value
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_change_password_promotes_invited_to_active():
    db = await _session()
    try:
        hashed = await hash_password_async("temp-pass-1")
        user = User(
            id="u-invited",
            name="Invited User",
            email="invited@test.com",
            hashed_password=hashed,
            role="cashier",
            active=True,
            status=UserAccountStatus.invited.value,
            must_change_password=True,
        )
        db.add(user)
        await db.commit()

        result = await change_password(
            data=ChangePasswordRequest(old_password="temp-pass-1", new_password="new-pass-99"),
            user=user,
            db=db,
        )
        await db.refresh(user)

        assert result["must_change_password"] is False
        assert result["status"] == "active"
        assert user.status == "active"
        assert user.active is True
        assert user.must_change_password is False
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_change_password_keeps_active_status_after_reset():
    db = await _session()
    try:
        hashed = await hash_password_async("old-pass-1")
        user = User(
            id="u-active",
            name="Active User",
            email="active@test.com",
            hashed_password=hashed,
            role="cashier",
            active=True,
            status=UserAccountStatus.active.value,
            must_change_password=True,  # forgot-password path
        )
        db.add(user)
        await db.commit()

        result = await change_password(
            data=ChangePasswordRequest(old_password="old-pass-1", new_password="new-pass-99"),
            user=user,
            db=db,
        )
        await db.refresh(user)

        assert result["status"] == "active"
        assert user.status == "active"
        assert user.must_change_password is False
    finally:
        await db.close()


@pytest.mark.asyncio
async def test_toggle_invited_user_goes_inactive_then_back_to_invited():
    db = await _session()
    try:
        admin = await _seed_admin(db)
        user = User(
            id="u-invited-2",
            name="Invited User",
            email="invited2@test.com",
            hashed_password="x",
            role="cashier",
            active=True,
            status=UserAccountStatus.invited.value,
            must_change_password=True,
        )
        db.add(user)
        await db.commit()

        first = await toggle_user(user_id=user.id, db=db, request=None, user=admin)
        await db.refresh(user)
        assert first["status"] == "inactive"
        assert first["active"] is False
        assert user.status == "inactive"

        second = await toggle_user(user_id=user.id, db=db, request=None, user=admin)
        await db.refresh(user)
        assert second["status"] == "invited"
        assert second["active"] is True
        assert user.must_change_password is True
    finally:
        await db.close()


def test_serialize_user_includes_status():
    user = User(
        id="u1",
        name="Pat",
        email="pat@test.com",
        hashed_password="x",
        role="cashier",
        active=True,
        status=UserAccountStatus.invited.value,
        must_change_password=True,
    )
    payload = serialize_user(user)
    assert payload["status"] == "invited"
    assert payload["active"] is True
    assert account_status_value(user) == "invited"


def test_apply_account_status_keeps_invited_users_loginable():
    user = User(
        id="u2",
        name="Pat",
        email="pat2@test.com",
        hashed_password="x",
        role="cashier",
    )
    apply_account_status(user, UserAccountStatus.invited.value)
    assert user.status == "invited"
    assert user.active is True

    apply_account_status(user, UserAccountStatus.inactive.value)
    assert user.status == "inactive"
    assert user.active is False

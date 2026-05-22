"""
Auth routes: real bcrypt verify against users.hashed_password, real JWT issuance.

Replaces the previous demo-dict implementation. See docs/USERS_AND_ROLES.md
§7 (Phase 1.5) for the design and `docs/ISSUES.md` ISS-002 / ISS-003 for what
this change fixes.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import User
from src.security import (
    create_access_token,
    hash_password,
    require_user,
    user_with_permissions,
    verify_password,
)

router = APIRouter()

# Minimum password length enforced on /auth/change-password. Matches the
# starter policy in docs/USERS_AND_ROLES.md §10 Phase 4 ("min 8 characters,
# no other rules"). Bump centrally if the policy changes.
MIN_PASSWORD_LENGTH = 8


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


@router.post("/login")
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    """Verify credentials against `users.hashed_password` (bcrypt) and return
    a real JWT plus the serialized user with their expanded permissions."""
    user = (
        await db.execute(select(User).where(User.email == data.email.lower()))
    ).scalar_one_or_none()

    # Constant message regardless of which check fails — don't leak whether
    # the email exists.
    auth_error = HTTPException(status_code=401, detail="Invalid email or password")
    if not user or not user.active:
        raise auth_error
    if not verify_password(data.password, user.hashed_password or ""):
        raise auth_error

    user.last_login = datetime.utcnow()
    await db.commit()
    await db.refresh(user)

    return {
        "token": create_access_token(user.id),
        "user": await user_with_permissions(user, db),
    }


@router.post("/logout")
async def logout():
    """Token discard happens client-side (no server-side session state).
    Endpoint exists for symmetry / future audit logging."""
    return {"message": "Logged out"}


@router.get("/me")
async def me(
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Always 401 without a valid token — the frontend uses this on app boot
    to rehydrate the session and on refresh to re-fetch permissions."""
    return await user_with_permissions(user, db)


@router.post("/change-password")
async def change_password(
    data: ChangePasswordRequest,
    user: User = Depends(require_user),
    db: AsyncSession = Depends(get_db),
):
    """Self-serve password change. Requires the current (old) password as
    proof — defends against stolen sessions, and doubles as the input the
    forced-first-login flow needs (user types the temp password as 'old').

    On success: hashes + stores the new password, clears the
    `must_change_password` flag, returns 200. JWT is intentionally NOT
    rotated in v1 — see docs/USERS_AND_ROLES.md §10 Phase 4 for the
    token-revocation follow-up.
    """
    if not verify_password(data.old_password, user.hashed_password or ""):
        raise HTTPException(401, "Current password is incorrect")
    if len(data.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(400, f"New password must be at least {MIN_PASSWORD_LENGTH} characters")
    if data.new_password == data.old_password:
        raise HTTPException(400, "New password must be different from the current password")

    user.hashed_password = hash_password(data.new_password)
    user.must_change_password = False
    await db.commit()
    return {"message": "Password changed", "must_change_password": False}

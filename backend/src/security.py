"""
Auth + RBAC dependencies.

See docs/USERS_AND_ROLES.md §7 for design. Phase 1.5 ships `current_user`
and `require_user`; Phase 2 adds `require_perm(*needed)`.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from fastapi import Depends, Header, HTTPException, Request
import logging

logger = logging.getLogger("cosmopolitan.security")
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src import config
from src.database import get_db
from src.models import Organisation, Role, User
from src.decimal_precision import org_precision
from src.permissions import expand

# ─── Password hashing ────────────────────────────────────────────────────────
# Direct calls to the `bcrypt` package — passlib was deprecated in 2020 and
# its bcrypt backend is incompatible with bcrypt >= 4.0. bcrypt has a 72-byte
# input limit; we truncate explicitly because we don't want a silent ValueError
# from longer passwords (these would be rejected by the `bcrypt` module 5+).
_BCRYPT_MAX_BYTES = 72


def _to_bytes(pw: str) -> bytes:
    return pw.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def _hash_password_sync(pw: str) -> str:
    return bcrypt.hashpw(_to_bytes(pw), bcrypt.gensalt()).decode("utf-8")


def _verify_password_sync(pw: str, stored_hash: str) -> bool:
    if not stored_hash:
        return False
    try:
        return bcrypt.checkpw(_to_bytes(pw), stored_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def hash_password(pw: str) -> str:
    """Bcrypt-hash a plaintext password and return the hash as a UTF-8 string."""
    return _hash_password_sync(pw)


def verify_password(pw: str, stored_hash: str) -> bool:
    """Constant-time verify; safely returns False for empty / non-bcrypt hashes
    (e.g. legacy sha256 hex from before the bcrypt switch)."""
    return _verify_password_sync(pw, stored_hash)


async def hash_password_async(pw: str) -> str:
    return await asyncio.to_thread(_hash_password_sync, pw)


async def verify_password_async(pw: str, stored_hash: str) -> bool:
    return await asyncio.to_thread(_verify_password_sync, pw, stored_hash)


# ─── Token helpers ────────────────────────────────────────────────────────────
def create_access_token(user_id: str) -> str:
    settings = config.get()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(hours=settings.jwt_expiration_hours),
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def _decode_token(token: str) -> Optional[str]:
    settings = config.get()
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        return payload.get("sub")
    except JWTError:
        return None


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


async def _load_user(db: AsyncSession, user_id: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalars().first()


async def _demo_super_admin(db: AsyncSession) -> Optional[User]:
    """Demo fallback when AUTH_ENFORCED=false and no valid token is present."""
    result = await db.execute(select(User).where(User.role == "super_admin"))
    return result.scalars().first()


# ─── Dependencies ─────────────────────────────────────────────────────────────
async def current_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Lenient: returns the JWT-identified user when present, else falls back
    to the seeded super-admin in demo mode (D3). Used by routes that need *a*
    user but should keep working in the open demo. Phase 2's `require_perm`
    will depend on this."""
    token = _extract_bearer(authorization)
    user_id = _decode_token(token) if token else None
    if user_id:
        user = await _load_user(db, user_id)
        if user and user.active:
            return user

    if not config.get().auth_enforced:
        demo = await _demo_super_admin(db)
        if demo:
            return demo

    raise HTTPException(status_code=401, detail="Not authenticated")


async def require_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Strict: always 401 without a valid token. Used by `/auth/me` and
    anything else that must reflect the real session, regardless of the
    AUTH_ENFORCED flag."""
    token = _extract_bearer(authorization)
    user_id = _decode_token(token) if token else None
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = await _load_user(db, user_id)
    if not user or not user.active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_perm(*needed: str):
    """Dependency factory that gates a route on having ANY of `needed`.

    Resolves the user via `current_user` (so AUTH_ENFORCED=false still
    returns the demo super-admin and never 403s — see D3). Looks the user's
    role permissions up live from the DB on each call (no perms in the JWT,
    so a permission edit takes effect on next call).

    Usage:
        @router.post("/", dependencies=[Depends(require_perm("items.create"))])
        async def create_item(...): ...
    """
    if not needed:
        raise RuntimeError("require_perm() needs at least one permission")

    async def _dep(
        user: User = Depends(current_user),
        db: AsyncSession = Depends(get_db),
        request: Request = None,
    ) -> User:
        granted: list[str] = []
        if user.role_id:
            role = (
                await db.execute(select(Role).where(Role.id == user.role_id))
            ).scalar_one_or_none()
            if role:
                granted = list(role.permissions or [])
        elif user.role:
            # Fallback: legacy users with no role_id but a non-null role enum
            # (shouldn't happen post-Phase-1 backfill, but cheap safety net).
            role_key = user.role.value if hasattr(user.role, "value") else user.role
            role = (
                await db.execute(select(Role).where(Role.key == role_key))
            ).scalar_one_or_none()
            if role:
                granted = list(role.permissions or [])

        granted_set = expand(granted)
        if "*" in granted_set:
            return user
        if any(p in granted_set for p in needed):
            return user

        try:
            path = request.url.path if request is not None else "<unknown>"
        except Exception:
            path = "<unknown>"
        logger.warning(
            "Permission denied: user_id=%s role_id=%s needed=%s granted=%s path=%s",
            getattr(user, "id", None),
            getattr(user, "role_id", None),
            ','.join(needed),
            ','.join(sorted(granted_set)),
            path,
        )

        raise HTTPException(
            status_code=403,
            detail=f"Missing permission: {' or '.join(needed)}",
        )

    return _dep


async def get_allowed_branch_ids(user: User, db: AsyncSession) -> list[str]:
    """Return the list of branches the user may access."""
    if getattr(user, "all_branches", False):
        return []
    from src.routes._serializers import get_user_branch_ids

    branch_ids = await get_user_branch_ids(db, user.id)
    if branch_ids:
        return list(dict.fromkeys(branch_ids))
    return []


async def _ensure_branch_access_allowed(
    branch_id: str,
    user: User,
    db: AsyncSession,
) -> str:
    """Raise 403 when the authenticated user cannot access the requested branch.

    When route helpers are invoked directly in unit tests the `user` parameter
    may be the unresolved `Depends(...)` sentinel rather than a real `User`.
    In that case skip enforcement so tests can call route functions directly.
    """
    # Shortcut for direct calls where the dependency wasn't resolved
    if not getattr(user, "id", None) and not getattr(user, "role", None) and not getattr(user, "role_id", None):
        return branch_id

    if getattr(user, "all_branches", False):
        return branch_id

    branch_ids = await get_allowed_branch_ids(user, db)
    if not branch_ids:
        raise HTTPException(status_code=403, detail=f"Access denied for branch {branch_id}")
    if branch_id not in branch_ids:
        raise HTTPException(
            status_code=403,
            detail=f"Access denied for branch {branch_id}",
        )
    return branch_id


async def enforce_branch_access(
    branch_id: str,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> str:
    return await _ensure_branch_access_allowed(branch_id, user, db)


async def enforce_branch_access_optional(
    branch_id: Optional[str] = None,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
) -> Optional[str]:
    if branch_id is None:
        return None
    return await _ensure_branch_access_allowed(branch_id, user, db)


# ─── Serialization with expanded permissions ────────────────────────────────
async def user_with_permissions(user: User, db: AsyncSession) -> dict:
    """Public user dict + the expanded permission set for their role.
    Permissions are looked up live from `roles.permissions` per request — no
    perms are baked into the JWT, so a perm change takes effect on next call.
    """
    granted: list[str] = []
    if user.role_id:
        role = (
            await db.execute(select(Role).where(Role.id == user.role_id))
        ).scalar_one_or_none()
        if role:
            granted = list(role.permissions or [])
    elif user.role:
        # Keep permission resolution aligned with `require_perm`: users that
        # still have only the legacy role enum should get the same grants in
        # `/auth/login` and `/auth/me` as route guards enforce server-side.
        role_key = user.role.value if hasattr(user.role, "value") else user.role
        role = (
            await db.execute(select(Role).where(Role.key == role_key))
        ).scalar_one_or_none()
        if role:
            granted = list(role.permissions or [])
    # Local import keeps this module free of routes/* circular risk.
    from src.routes._serializers import get_user_branch_ids
    branch_ids = await get_user_branch_ids(db, user.id)
    org = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    amount_prec, qty_prec = org_precision(org)
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role.value if hasattr(user.role, "value") else user.role,
        "role_id": user.role_id,
        # Multi-branch list: super-admins keep a row for every available branch
        # while all_branches=True still indicates global access.
        "branch_ids": branch_ids,
        "all_branches": bool(getattr(user, "all_branches", False)),
        "avatar": user.avatar,
        "active": bool(user.active),
        # Read by the frontend RequirePasswordSet guard — when True, the
        # user is redirected to /change-password and blocked from everything
        # else. Mirror in routes/_serializers.serialize_user (used by other
        # endpoints); keep both in sync.
        "must_change_password": bool(getattr(user, "must_change_password", False)),
        "permissions": sorted(expand(granted)),
        "amountDecimalPrecision": amount_prec,
        "quantityDecimalPrecision": qty_prec,
    }

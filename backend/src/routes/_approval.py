"""Permission-based maker-checker helpers.

A user with `module.approve` commits directly on create; a user with only
`module.create` raises a pending record for an approver to act on in the
module's own UI (no separate approvals queue).
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Role, User
from src.permissions import expand


async def user_grants(user: User, db: AsyncSession) -> set[str]:
    """Expanded permission set for the user's role."""
    granted: list[str] = []
    if user.role_id:
        role = (
            await db.execute(select(Role).where(Role.id == user.role_id))
        ).scalar_one_or_none()
        if role:
            granted = list(role.permissions or [])
    elif user.role:
        role_key = user.role.value if hasattr(user.role, "value") else user.role
        role = (
            await db.execute(select(Role).where(Role.key == role_key))
        ).scalar_one_or_none()
        if role:
            granted = list(role.permissions or [])
    return expand(granted)


async def user_can(user: User, db: AsyncSession, perm: str) -> bool:
    grants = await user_grants(user, db)
    return "*" in grants or perm in grants


async def can_direct_commit(user: User, db: AsyncSession, approve_perm: str) -> bool:
    """True when the caller may skip the pending-approval queue for this action."""
    return await user_can(user, db, approve_perm)

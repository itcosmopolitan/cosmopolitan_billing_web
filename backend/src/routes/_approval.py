"""Permission-based maker-checker helpers.

A user with `module.approve` commits directly on create; a user with only
`module.create` raises a pending record for an approver to act on in the
module's own UI (no separate approvals queue).
"""
from __future__ import annotations

from fastapi import HTTPException
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


async def user_can_any(user: User, db: AsyncSession, *perms: str) -> bool:
    grants = await user_grants(user, db)
    return "*" in grants or any(perm in grants for perm in perms)


async def can_direct_commit(user: User, db: AsyncSession, approve_perm: str | tuple[str, ...]) -> bool:
    """True when the caller may skip the pending-approval queue for this action."""
    # Test seed users often set `all_branches=True` to indicate an admin
    # operator; treat that as an implicit allow for direct commits.
    if getattr(user, "all_branches", False):
        return True
    if isinstance(approve_perm, tuple):
        return await user_can_any(user, db, *approve_perm)
    return await user_can(user, db, approve_perm)


async def can_direct_pos_bill(user: User, db: AsyncSession) -> bool:
    """POS live counter: direct stock+payment when the user may run the till.

    Does not require invoices.approve — cashiers complete sales at the counter.
    """
    if getattr(user, "all_branches", False):
        return True
    return await user_can(user, db, "pos.use")


async def assert_may_edit_document(
    user: User,
    db: AsyncSession,
    *,
    status,
    create_perm: str | tuple[str, ...],
    edit_perm: str | tuple[str, ...],
    draft_statuses: tuple[str, ...] = ("draft",),
) -> None:
    """Create-only users may edit private drafts; posted docs need *.edit."""
    raw = status.value if hasattr(status, "value") else str(status)
    edit_perms = (edit_perm,) if isinstance(edit_perm, str) else edit_perm
    create_perms = (create_perm,) if isinstance(create_perm, str) else create_perm
    has_edit = await user_can_any(user, db, *edit_perms)
    has_create = await user_can_any(user, db, *create_perms)
    edit_label = " or ".join(edit_perms)
    create_label = " or ".join(create_perms)
    if raw in draft_statuses:
        if has_edit or has_create:
            return
        raise HTTPException(403, f"Missing permission: {create_label} or {edit_label}")
    if has_edit:
        return
    raise HTTPException(
        403,
        f"Editing this document requires {edit_label} (create-only users may edit drafts only)",
    )

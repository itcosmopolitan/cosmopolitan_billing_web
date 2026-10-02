"""Shared stock-pool lookup and permission helpers."""
from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Branch, Item, ItemBatch, ItemStock, Role, StockPool, StockPoolBranch, User
from src.permissions import expand


async def user_has_permission(db: AsyncSession, user: User, permission: str) -> bool:
    role = getattr(user, "role", None)
    role_key = role.value if hasattr(role, "value") else role
    if (
        getattr(user, "all_branches", False)
        or getattr(user, "role_id", None) == "role-super-admin"
        or role_key == "super_admin"
    ):
        return True
    if not user.role_id:
        return False
    permissions = (
        await db.execute(select(Role.permissions).where(Role.id == user.role_id))
    ).scalar_one_or_none()
    return permission in expand(list(permissions or []))


async def active_pool_for_branch(
    db: AsyncSession,
    branch_id: str,
    *,
    lock: bool = False,
) -> Optional[StockPool]:
    stmt = (
        select(StockPool)
        .join(StockPoolBranch, StockPoolBranch.pool_id == StockPool.id)
        .join(Branch, Branch.id == StockPoolBranch.branch_id)
        .where(
            StockPoolBranch.branch_id == branch_id,
            StockPool.active.is_(True),
            Branch.active.is_(True),
        )
    )
    if lock:
        stmt = stmt.with_for_update(of=StockPool)
    return (await db.execute(stmt)).scalar_one_or_none()


async def active_pool_members(
    db: AsyncSession,
    pool_id: str,
    *,
    lock: bool = False,
) -> list[Branch]:
    stmt = (
        select(Branch)
        .join(StockPoolBranch, StockPoolBranch.branch_id == Branch.id)
        .where(StockPoolBranch.pool_id == pool_id, Branch.active.is_(True))
        .order_by(Branch.id)
    )
    if lock:
        stmt = stmt.with_for_update(of=Branch)
    return list((await db.execute(stmt)).scalars().all())


async def pooled_item_quantities(
    db: AsyncSession,
    *,
    item_ids: list[str],
    pool_id: str,
) -> dict[str, float]:
    """Compute non-expired pool availability grouped by item, never persisting it."""
    if not item_ids:
        return {}
    members = (
        select(StockPoolBranch.branch_id)
        .join(Branch, Branch.id == StockPoolBranch.branch_id)
        .where(
            StockPoolBranch.pool_id == pool_id,
            Branch.active.is_(True),
        )
    )
    tracked_ids = set(
        (await db.execute(
            select(Item.id).where(Item.id.in_(item_ids), Item.batch_tracking.is_(True))
        )).scalars().all()
    )
    totals = {item_id: 0.0 for item_id in item_ids}
    untracked_ids = [item_id for item_id in item_ids if item_id not in tracked_ids]
    if untracked_ids:
        rows = (await db.execute(
            select(ItemStock.item_id, func.sum(ItemStock.quantity))
            .where(ItemStock.item_id.in_(untracked_ids), ItemStock.branch_id.in_(members))
            .group_by(ItemStock.item_id)
        )).all()
        for item_id, qty in rows:
            totals[item_id] = max(0.0, float(qty or 0))
    if tracked_ids:
        today = date.today().isoformat()
        rows = (await db.execute(
            select(ItemBatch.item_id, func.sum(ItemBatch.quantity))
            .join(Item, Item.id == ItemBatch.item_id)
            .where(
                ItemBatch.item_id.in_(tracked_ids),
                ItemBatch.branch_id.in_(members),
                ItemBatch.active.is_(True),
                ItemBatch.quantity > 0,
                or_(
                    Item.expiry_tracking.is_(False),
                    ItemBatch.expiry_date.is_(None),
                    ItemBatch.expiry_date == "",
                    ItemBatch.expiry_date >= today,
                ),
            )
            .group_by(ItemBatch.item_id)
        )).all()
        for item_id, qty in rows:
            totals[item_id] = max(0.0, float(qty or 0))
    return totals


async def pool_summary_for_branch(db: AsyncSession, branch_id: str) -> Optional[dict]:
    pool = await active_pool_for_branch(db, branch_id)
    if pool is None:
        return None
    members = await active_pool_members(db, pool.id)
    if len(members) < 2:
        return None
    return {
        "id": pool.id,
        "name": pool.name,
        "active": bool(pool.active),
        "allow_cross_branch_sales": bool(pool.allow_cross_branch_sales),
        "members": [
            {
                "id": branch.id,
                "name": branch.name,
                "gstin": branch.gstin or "",
            }
            for branch in members
        ],
    }

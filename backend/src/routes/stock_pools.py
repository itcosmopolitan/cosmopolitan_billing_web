from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.models import Branch, PoolSaleAllocation, StockPool, StockPoolBranch, User
from src.security import current_user, enforce_branch_access, get_allowed_branch_ids, require_perm
from src.services.audit_service import add_audit_log
from src.stock_pools import active_pool_members, pool_summary_for_branch

router = APIRouter()


class StockPoolCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    active: bool = False
    allow_cross_branch_sales: bool = False


class StockPoolPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    active: Optional[bool] = None
    allow_cross_branch_sales: Optional[bool] = None


class StockPoolBranchCreate(BaseModel):
    branch_id: str


async def _pool_or_404(db: AsyncSession, pool_id: str, *, lock: bool = False) -> StockPool:
    stmt = (
        select(StockPool)
        .options(selectinload(StockPool.branches).selectinload(StockPoolBranch.branch))
        .where(StockPool.id == pool_id)
    )
    if lock:
        stmt = stmt.with_for_update()
    pool = (await db.execute(stmt)).scalar_one_or_none()
    if pool is None:
        raise HTTPException(404, "Stock pool not found")
    return pool


def _serialize_pool(pool: StockPool) -> dict:
    members = sorted(
        (row.branch for row in pool.branches if row.branch is not None),
        key=lambda branch: branch.id,
    )
    return {
        "id": pool.id,
        "name": pool.name,
        "active": bool(pool.active),
        "allow_cross_branch_sales": bool(pool.allow_cross_branch_sales),
        "created_by": pool.created_by,
        "created_at": pool.created_at,
        "updated_at": pool.updated_at,
        "branches": [
            {
                "id": branch.id,
                "name": branch.name,
                "active": bool(branch.active),
                "gstin": branch.gstin or "",
            }
            for branch in members
        ],
        "gstin_mismatch": len({(branch.gstin or "").strip().casefold() for branch in members}) > 1,
    }


async def _audit_pool_change(
    db: AsyncSession,
    *,
    user: User,
    request: Optional[Request],
    pool: StockPool,
    action: str,
    detail: str,
    metadata: Optional[dict] = None,
) -> None:
    add_audit_log(
        db,
        action=action,
        module="Stock Pools",
        reference_id=pool.id,
        detail=detail,
        user=user,
        request=request,
        metadata=metadata or {},
    )


@router.get("/", dependencies=[Depends(require_perm("stock_pools.view"))])
async def list_stock_pools(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    stmt = select(StockPool).options(
        selectinload(StockPool.branches).selectinload(StockPoolBranch.branch)
    ).order_by(StockPool.name, StockPool.id)
    if not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return []
        stmt = stmt.join(StockPoolBranch).where(StockPoolBranch.branch_id.in_(branch_ids)).distinct()
    pools = (await db.execute(stmt)).scalars().unique().all()
    return [_serialize_pool(pool) for pool in pools]


@router.post("/", status_code=201, dependencies=[Depends(require_perm("stock_pools.manage"))])
async def create_stock_pool(
    data: StockPoolCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Pool name is required")
    if data.active:
        raise HTTPException(400, "Add at least two active branches before activating a pool")
    pool = StockPool(
        id=str(uuid.uuid4()),
        name=name,
        active=False,
        allow_cross_branch_sales=data.allow_cross_branch_sales,
        created_by=user.name,
    )
    db.add(pool)
    await db.flush()
    await _audit_pool_change(
        db,
        user=user,
        request=request,
        pool=pool,
        action="Stock pool created",
        detail=f"Created stock pool {pool.name}",
        metadata={"pool_id": pool.id, "allow_cross_branch_sales": pool.allow_cross_branch_sales},
    )
    await db.commit()
    return _serialize_pool(await _pool_or_404(db, pool.id))


@router.get("/{pool_id}", dependencies=[Depends(require_perm("stock_pools.view"))])
async def get_stock_pool(
    pool_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    pool = await _pool_or_404(db, pool_id)
    if not getattr(user, "all_branches", False):
        allowed = set(await get_allowed_branch_ids(user, db))
        if not allowed or not any(row.branch_id in allowed for row in pool.branches):
            raise HTTPException(403, "Access denied for this stock pool")
    return _serialize_pool(pool)


@router.patch("/{pool_id}", dependencies=[Depends(require_perm("stock_pools.manage"))])
async def update_stock_pool(
    pool_id: str,
    data: StockPoolPatch,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    pool = await _pool_or_404(db, pool_id, lock=True)
    before = {
        "name": pool.name,
        "active": bool(pool.active),
        "allow_cross_branch_sales": bool(pool.allow_cross_branch_sales),
    }
    updates = data.model_dump(exclude_unset=True)
    if "name" in updates:
        pool.name = (updates["name"] or "").strip()
        if not pool.name:
            raise HTTPException(400, "Pool name is required")
    if updates.get("active") is True:
        members = await active_pool_members(db, pool.id)
        if len(members) < 2:
            raise HTTPException(409, "A stock pool requires at least two active branches")
    if "active" in updates:
        pool.active = bool(updates["active"])
    if "allow_cross_branch_sales" in updates:
        pool.allow_cross_branch_sales = bool(updates["allow_cross_branch_sales"])
    await _audit_pool_change(
        db,
        user=user,
        request=request,
        pool=pool,
        action="Stock pool updated",
        detail=f"Updated stock pool {pool.name}",
        metadata={"before": before, "after": {
            "name": pool.name,
            "active": bool(pool.active),
            "allow_cross_branch_sales": bool(pool.allow_cross_branch_sales),
        }},
    )
    await db.commit()
    return _serialize_pool(await _pool_or_404(db, pool.id))


@router.delete("/{pool_id}", dependencies=[Depends(require_perm("stock_pools.manage"))])
async def delete_stock_pool(
    pool_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    pool = await _pool_or_404(db, pool_id, lock=True)
    allocation_count = int((await db.execute(
        select(func.count(PoolSaleAllocation.id)).where(PoolSaleAllocation.pool_id == pool_id)
    )).scalar_one() or 0)
    if allocation_count:
        raise HTTPException(409, "Pools with recorded sales cannot be deleted; deactivate the pool instead")
    await _audit_pool_change(
        db,
        user=user,
        request=request,
        pool=pool,
        action="Stock pool deleted",
        detail=f"Deleted stock pool {pool.name}",
        metadata={"pool_id": pool.id, "branches": [row.branch_id for row in pool.branches]},
    )
    await db.delete(pool)
    await db.commit()
    return {"deleted": pool_id}


@router.post("/{pool_id}/branches", status_code=201, dependencies=[Depends(require_perm("stock_pools.manage"))])
async def add_stock_pool_branch(
    pool_id: str,
    data: StockPoolBranchCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    pool = await _pool_or_404(db, pool_id, lock=True)
    await enforce_branch_access(data.branch_id, user=user, db=db)
    branch = (await db.execute(select(Branch).where(Branch.id == data.branch_id))).scalar_one_or_none()
    if branch is None:
        raise HTTPException(404, "Branch not found")
    if not branch.active:
        raise HTTPException(400, "Only active branches can join a stock pool")
    existing = (await db.execute(
        select(StockPoolBranch).where(StockPoolBranch.branch_id == data.branch_id)
    )).scalar_one_or_none()
    if existing:
        if existing.pool_id == pool_id:
            return _serialize_pool(await _pool_or_404(db, pool_id))
        raise HTTPException(409, "Branch already belongs to another stock pool")
    db.add(StockPoolBranch(
        id=str(uuid.uuid4()),
        pool_id=pool_id,
        branch_id=data.branch_id,
        created_by=user.name,
    ))
    await db.flush()
    await _audit_pool_change(
        db,
        user=user,
        request=request,
        pool=pool,
        action="Stock pool branch added",
        detail=f"Added branch {branch.name} to stock pool {pool.name}",
        metadata={"branch_id": branch.id, "branch_name": branch.name},
    )
    await db.commit()
    return _serialize_pool(await _pool_or_404(db, pool_id))


@router.delete(
    "/{pool_id}/branches/{branch_id}",
    dependencies=[Depends(require_perm("stock_pools.manage"))],
)
async def remove_stock_pool_branch(
    pool_id: str,
    branch_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    pool = await _pool_or_404(db, pool_id, lock=True)
    await enforce_branch_access(branch_id, user=user, db=db)
    row = (await db.execute(
        select(StockPoolBranch).where(
            StockPoolBranch.pool_id == pool_id,
            StockPoolBranch.branch_id == branch_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Branch is not a member of this stock pool")
    active_members = await active_pool_members(db, pool_id)
    if pool.active and len(active_members) <= 2:
        raise HTTPException(409, "Deactivate the pool before removing one of its last two active branches")
    branch = (await db.execute(select(Branch).where(Branch.id == branch_id))).scalar_one_or_none()
    await _audit_pool_change(
        db,
        user=user,
        request=request,
        pool=pool,
        action="Stock pool branch removed",
        detail=f"Removed branch {branch.name if branch else branch_id} from stock pool {pool.name}",
        metadata={"branch_id": branch_id},
    )
    await db.delete(row)
    await db.commit()
    return {"removed": branch_id, "pool_id": pool_id}


@router.get("/for-branch/{branch_id}", dependencies=[Depends(require_perm("pos.use"))])
async def get_stock_pool_for_branch(
    branch_id: str = Depends(enforce_branch_access),
    db: AsyncSession = Depends(get_db),
):
    summary = await pool_summary_for_branch(db, branch_id)
    if summary is None:
        return None
    return {
        "id": summary["id"],
        "name": summary["name"],
        "allow_cross_branch_sales": summary["allow_cross_branch_sales"],
    }

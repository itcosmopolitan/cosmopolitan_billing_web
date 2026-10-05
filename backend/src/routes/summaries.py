"""Cross-module status counts for list section tabs."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import (
    AdjustmentRequest,
    AdjustmentStatus,
    Role,
    StockTransfer,
    TransferStatus,
    User,
)
from src.permissions import MODULE_SUMMARY_READ, expand
from src.security import current_user, enforce_branch_access_optional

router = APIRouter()


async def _user_grants(user: User, db: AsyncSession) -> set[str]:
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


async def _transfer_summary(db: AsyncSession, *, branch_id: Optional[str] = None) -> dict[str, int]:
    async def _count(status: TransferStatus, *, side: str) -> int:
        q = select(func.count(StockTransfer.id)).where(StockTransfer.status == status)
        if branch_id:
            if side == "from":
                q = q.where(StockTransfer.from_branch_id == branch_id)
            elif side == "to":
                q = q.where(StockTransfer.to_branch_id == branch_id)
            else:
                q = q.where(
                    or_(
                        StockTransfer.from_branch_id == branch_id,
                        StockTransfer.to_branch_id == branch_id,
                    )
                )
        return int((await db.execute(q)).scalar() or 0)

    # Match list_transfers status scoping for the active branch.
    pending = await _count(TransferStatus.pending, side="from")
    transit = await _count(TransferStatus.transit, side="to")
    received = await _count(TransferStatus.received, side="either")
    rejected = await _count(TransferStatus.rejected, side="from")
    return {
        "pending": pending,
        "transit": transit,
        "received": received,
        "rejected": rejected,
        "total": pending + transit + received + rejected,
    }


async def _adjustment_summary(
    db: AsyncSession, *, branch_id: Optional[str] = None
) -> dict[str, int]:
    base = select(func.count(AdjustmentRequest.id))
    if branch_id:
        base = base.where(AdjustmentRequest.branch_id == branch_id)

    async def _count(status: Optional[AdjustmentStatus]) -> int:
        q = base
        if status is not None:
            q = q.where(AdjustmentRequest.status == status)
        return int((await db.execute(q)).scalar() or 0)

    pending = await _count(AdjustmentStatus.pending)
    approved = await _count(AdjustmentStatus.approved)
    rejected = await _count(AdjustmentStatus.rejected)
    return {
        "pending": pending,
        "approved": approved,
        "rejected": rejected,
        "total": pending + approved + rejected,
    }


@router.get("/")
async def get_module_summary(
    module: str = Query(..., min_length=1),
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Status counts for list section tabs.

    Supported modules: `transfers`, `adjustments`.
    """
    key = module.strip().lower()
    allowed = MODULE_SUMMARY_READ.get(key)
    if not allowed:
        raise HTTPException(400, f"Unknown module: {module}")

    grants = await _user_grants(user, db)
    if "*" not in grants and not any(p in grants for p in allowed):
        raise HTTPException(403, f"Missing permission: {' or '.join(allowed)}")

    if key == "transfers":
        return await _transfer_summary(db, branch_id=branch_id)
    if key == "adjustments":
        return await _adjustment_summary(db, branch_id=branch_id)

    raise HTTPException(400, f"Unknown module: {module}")

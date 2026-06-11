"""Cross-module status counts for list section tabs."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
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
from src.permissions import expand
from src.security import current_user

router = APIRouter()

_MODULE_VIEW_PERM: dict[str, str] = {
    "transfers": "transfers.view",
    "adjustments": "adjustments.view",
}


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


async def _transfer_summary(db: AsyncSession) -> dict[str, int]:
    async def _count(status: Optional[TransferStatus]) -> int:
        q = select(func.count(StockTransfer.id))
        if status is not None:
            q = q.where(StockTransfer.status == status)
        return int((await db.execute(q)).scalar() or 0)

    pending = await _count(TransferStatus.pending)
    transit = await _count(TransferStatus.transit)
    received = await _count(TransferStatus.received)
    rejected = await _count(TransferStatus.rejected)
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
    branch_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Status counts for list section tabs.

    Supported modules: `transfers`, `adjustments`.
    """
    key = module.strip().lower()
    view_perm = _MODULE_VIEW_PERM.get(key)
    if not view_perm:
        raise HTTPException(400, f"Unknown module: {module}")

    grants = await _user_grants(user, db)
    if "*" not in grants and view_perm not in grants:
        raise HTTPException(403, f"Missing permission: {view_perm}")

    if key == "transfers":
        return await _transfer_summary(db)
    if key == "adjustments":
        return await _adjustment_summary(db, branch_id=branch_id)

    raise HTTPException(400, f"Unknown module: {module}")

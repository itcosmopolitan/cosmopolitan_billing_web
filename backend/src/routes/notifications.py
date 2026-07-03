"""In-app notifications — persisted inbox with read state (Phases 6b–6e)."""
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src import config
from src.database import get_db
from src.models import User
from src.notifications.scanner import run_notification_scan
from src.notifications.store import (
    list_for_user,
    mark_all_read,
    mark_read,
    notify_refresh,
    unread_count_for_user,
    unread_ids_for_user,
)
from src.routes._approval import user_grants
from src.security import current_user, enforce_branch_access_optional, require_user

router = APIRouter()


@router.get("/")
async def list_notifications(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    within_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    del within_days  # scanner uses org setting; kept for API compat
    items = await list_for_user(db, user, branch_id=branch_id)
    unread = sum(1 for i in items if not i.get("read"))
    return {"items": items, "unread_count": unread}


@router.get("/count")
async def notification_count(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    within_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    del within_days
    ids = await unread_ids_for_user(db, user, branch_id=branch_id)
    total = await unread_count_for_user(db, user, branch_id=branch_id)
    return {"ids": ids, "total": total, "unread_count": total}


@router.post("/{notification_id}/read")
async def read_notification(
    notification_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
):
    ok = await mark_read(db, user, notification_id)
    if not ok:
        raise HTTPException(404, "Notification not found")
    await db.commit()
    await notify_refresh()
    return {"ok": True}


@router.post("/read-all")
async def read_all_notifications(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_user),
):
    marked = await mark_all_read(db, user, branch_id=branch_id)
    await db.commit()
    await notify_refresh()
    return {"marked": marked}


@router.post("/scan")
async def trigger_scan(
    within_days: Optional[int] = Query(None, ge=1, le=365),
    x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Manual or cron scan. Requires internal token or super_admin role."""
    settings = config.get()
    token_ok = bool(
        settings.notification_internal_token
        and x_internal_token == settings.notification_internal_token
    )
    role_key = user.role.value if hasattr(user.role, "value") else str(user.role or "")
    if not token_ok and role_key != "super_admin":
        grants = await user_grants(user, db)
        if "*" not in grants:
            raise HTTPException(403, "Scan requires super_admin or internal token")
    result = await run_notification_scan(db, within_days=within_days)
    return result

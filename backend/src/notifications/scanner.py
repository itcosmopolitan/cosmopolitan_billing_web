"""Full notification scan — upsert active alerts, resolve stale ones."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src import config
from src.models import Branch, Notification
from src.notifications.evaluator import gather_scan_candidates
from src.notifications.store import notify_refresh, resolve_notification, upsert_from_candidate


async def run_notification_scan(
    db: AsyncSession,
    *,
    within_days: int | None = None,
) -> dict[str, int]:
    """Scan all active branches and sync the notifications table."""
    settings = config.get()
    days = within_days if within_days is not None else settings.notification_expiry_within_days

    branch_ids = (
        await db.execute(select(Branch.id).where(Branch.active == True))  # noqa: E712
    ).scalars().all()
    branch_ids = list(branch_ids)

    candidates = await gather_scan_candidates(db, branch_ids=branch_ids, within_days=days)
    active_keys = {c.id for c in candidates}

    upserted = 0
    for c in candidates:
        await upsert_from_candidate(db, c)
        upserted += 1

    resolved = 0
    rows = (
        await db.execute(select(Notification).where(Notification.resolved_at.is_(None)))
    ).scalars().all()
    for row in rows:
        if row.dedupe_key in active_keys:
            continue
        await resolve_notification(db, row.dedupe_key)
        resolved += 1

    await db.commit()
    await notify_refresh()
    return {"upserted": upserted, "resolved": resolved, "active": len(active_keys)}

"""Persist, resolve, and read notification rows."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Notification, NotificationRead, User
from src.notifications.evaluator import NotificationCandidate, invalidate_notification_cache
from src.notifications.hub import hub
from src.notifications.kinds import SEVERITY_RANK, can_see_kind
from src.routes._approval import user_grants
from src.routes._serializers import get_user_branch_ids


async def upsert_notification(
    db: AsyncSession,
    *,
    dedupe_key: str,
    kind: str,
    severity: str,
    title: str,
    body: Optional[str] = None,
    branch_id: Optional[str] = None,
    module: Optional[str] = None,
    ref_type: Optional[str] = None,
    ref_id: Optional[str] = None,
    href: str = "/",
    exclude_user_name: Optional[str] = None,
) -> Notification:
    row = (
        await db.execute(select(Notification).where(Notification.dedupe_key == dedupe_key))
    ).scalar_one_or_none()
    if row:
        row.kind = kind
        row.severity = severity
        row.title = title
        row.body = body
        row.branch_id = branch_id
        row.module = module
        row.ref_type = ref_type
        row.ref_id = ref_id
        row.href = href or "/"
        row.exclude_user_name = exclude_user_name
        row.resolved_at = None
    else:
        row = Notification(
            id=str(uuid.uuid4()),
            dedupe_key=dedupe_key,
            kind=kind,
            severity=severity,
            title=title,
            body=body,
            branch_id=branch_id,
            module=module,
            ref_type=ref_type,
            ref_id=ref_id,
            href=href or "/",
            exclude_user_name=exclude_user_name,
        )
        db.add(row)
    await db.flush()
    invalidate_notification_cache()
    return row


async def upsert_from_candidate(db: AsyncSession, c: NotificationCandidate) -> Notification:
    module = c.kind.split(".", 1)[0] if "." in c.kind else c.kind
    ref_type = c.kind.split(".", 1)[-1] if "." in c.kind else None
    ref_id = c.id.split(":", 1)[-1] if ":" in c.id else None
    return await upsert_notification(
        db,
        dedupe_key=c.id,
        kind=c.kind,
        severity=c.severity,
        title=c.title,
        body=c.body,
        branch_id=c.branch_id,
        module=module,
        ref_type=ref_type,
        ref_id=ref_id,
        href=c.href,
        exclude_user_name=c.exclude_user_name,
    )


async def resolve_notification(db: AsyncSession, dedupe_key: str) -> None:
    row = (
        await db.execute(select(Notification).where(Notification.dedupe_key == dedupe_key))
    ).scalar_one_or_none()
    if row and row.resolved_at is None:
        row.resolved_at = datetime.utcnow()
        invalidate_notification_cache()


async def notify_refresh() -> None:
    await hub.broadcast_refresh()


async def _accessible_branch_ids(
    db: AsyncSession,
    user: User,
    branch_id: Optional[str],
) -> list[str]:
    if branch_id:
        if getattr(user, "all_branches", False):
            return [branch_id]
        allowed = await get_user_branch_ids(db, user.id)
        return [branch_id] if branch_id in allowed else []
    if getattr(user, "all_branches", False):
        from src.models import Branch

        rows = (
            await db.execute(select(Branch.id).where(Branch.active == True))  # noqa: E712
        ).scalars().all()
        return list(rows)
    return await get_user_branch_ids(db, user.id)


async def _read_ids(db: AsyncSession, user_id: str) -> set[str]:
    rows = (
        await db.execute(
            select(NotificationRead.notification_id).where(NotificationRead.user_id == user_id)
        )
    ).scalars().all()
    return set(rows)


def _serialize_row(n: Notification, *, read: bool) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "severity": n.severity,
        "title": n.title,
        "body": n.body,
        "branch_id": n.branch_id,
        "href": n.href or "/",
        "created_at": (n.created_at or datetime.utcnow()).isoformat() + "Z",
        "read": read,
    }


async def list_for_user(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
    limit: int = 50,
) -> list[dict]:
    branch_ids = await _accessible_branch_ids(db, user, branch_id)
    if branch_id and not branch_ids:
        return []

    grants = await user_grants(user, db)
    conds = [Notification.resolved_at.is_(None)]
    if branch_id:
        conds.append(
            or_(Notification.branch_id.is_(None), Notification.branch_id == branch_id)
        )
    elif branch_ids:
        conds.append(
            or_(Notification.branch_id.is_(None), Notification.branch_id.in_(branch_ids))
        )

    rows = (
        await db.execute(
            select(Notification)
            .where(and_(*conds))
            .order_by(Notification.created_at.desc())
            .limit(limit * 2)
        )
    ).scalars().all()

    read_set = await _read_ids(db, user.id)
    visible: list[tuple[int, dict]] = []
    for n in rows:
        if not can_see_kind(grants, n.kind):
            continue
        if n.exclude_user_name and n.exclude_user_name == user.name:
            continue
        rank = SEVERITY_RANK.get(n.severity or "info", 9)
        visible.append((rank, _serialize_row(n, read=n.id in read_set)))

    visible.sort(key=lambda x: (x[0], x[1]["title"].lower()))
    return [item for _, item in visible[:limit]]


async def unread_count_for_user(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
) -> int:
    items = await list_for_user(db, user, branch_id=branch_id)
    return sum(1 for i in items if not i.get("read"))


async def unread_ids_for_user(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
) -> list[str]:
    items = await list_for_user(db, user, branch_id=branch_id)
    return [i["id"] for i in items if not i.get("read")]


async def mark_read(db: AsyncSession, user: User, notification_id: str) -> bool:
    n = (
        await db.execute(select(Notification).where(Notification.id == notification_id))
    ).scalar_one_or_none()
    if not n or n.resolved_at is not None:
        return False
    existing = (
        await db.execute(
            select(NotificationRead).where(
                NotificationRead.notification_id == notification_id,
                NotificationRead.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if not existing:
        db.add(
            NotificationRead(
                notification_id=notification_id,
                user_id=user.id,
            )
        )
        invalidate_notification_cache()
    return True


async def mark_all_read(
    db: AsyncSession,
    user: User,
    *,
    branch_id: Optional[str] = None,
) -> int:
    items = await list_for_user(db, user, branch_id=branch_id)
    read_set = await _read_ids(db, user.id)
    marked = 0
    for item in items:
        if item["read"] or item["id"] in read_set:
            continue
        db.add(NotificationRead(notification_id=item["id"], user_id=user.id))
        marked += 1
    if marked:
        invalidate_notification_cache()
    return marked


# ─── Transactional emit helpers ─────────────────────────────────────────────

async def emit_adjustment_pending(db: AsyncSession, ar) -> None:
    await upsert_notification(
        db,
        dedupe_key=f"approval.adjustment_pending:{ar.id}",
        kind="approval.adjustment_pending",
        severity="info",
        title=f"Adjustment {ar.ref_number} awaiting approval",
        body=ar.item_name,
        branch_id=ar.branch_id,
        module="adjustments",
        ref_type="adjustment",
        ref_id=ar.id,
        href="/adjustments",
        exclude_user_name=ar.requested_by,
    )


async def emit_transfer_pending(db: AsyncSession, t) -> None:
    await upsert_notification(
        db,
        dedupe_key=f"approval.transfer_pending:{t.id}",
        kind="approval.transfer_pending",
        severity="info",
        title=f"Transfer {t.ref_number} awaiting approval",
        body=f"{t.from_branch_name or ''} → {t.to_branch_name or ''}",
        branch_id=t.from_branch_id,
        module="transfers",
        ref_type="transfer",
        ref_id=t.id,
        href="/transfers",
        exclude_user_name=t.requested_by,
    )


async def emit_transfer_in_transit(db: AsyncSession, t) -> None:
    await upsert_notification(
        db,
        dedupe_key=f"ops.transfer_in_transit:{t.id}",
        kind="ops.transfer_in_transit",
        severity="info",
        title=f"Transfer {t.ref_number} ready to receive",
        body=f"From {t.from_branch_name or ''}",
        branch_id=t.to_branch_id,
        module="transfers",
        ref_type="transfer",
        ref_id=t.id,
        href="/transfers",
    )


async def emit_po_pending(db: AsyncSession, po) -> None:
    await upsert_notification(
        db,
        dedupe_key=f"approval.purchase_order_pending:{po.id}",
        kind="approval.purchase_order_pending",
        severity="info",
        title=f"PO {po.number} awaiting approval",
        body=po.vendor_name,
        branch_id=po.branch_id,
        module="purchases",
        ref_type="purchase_order",
        ref_id=po.id,
        href="/purchases",
        exclude_user_name=po.created_by,
    )


async def emit_item_pending(db: AsyncSession, item) -> None:
    await upsert_notification(
        db,
        dedupe_key=f"approval.item_master_pending:{item.id}",
        kind="approval.item_master_pending",
        severity="info",
        title=f"Item “{item.name}” awaiting approval",
        body=item.sku,
        module="items",
        ref_type="item",
        ref_id=item.id,
        href="/item-master",
        exclude_user_name=item.created_by,
    )

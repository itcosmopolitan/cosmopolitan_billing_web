from __future__ import annotations

from datetime import datetime
import json
from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import ActivityComment, ActivityView, AuditLog, Role, User
from src.permissions import expand
from src.security import current_user

router = APIRouter()

_CANONICAL_RECORD_TYPES = {
    "purchase_bill",
    "purchase_order",
    "grn",
    "vendor_return",
    "sales_invoice",
    "sales_order",
    "quotation",
    "sales_return",
    "stock_transfer",
    "stock_adjustment",
}

_RECORD_TYPE_ALIASES = {
    # Backward compatibility with early Phase C naming.
    "invoice": "sales_invoice",
    "sale": "sales_invoice",
    "purchase": "purchase_bill",
    "purchase_return": "vendor_return",
    "credit_note": "sales_return",
    "transfer": "stock_transfer",
    "adjustment": "stock_adjustment",
}

_ALLOWED_RECORD_TYPES = _CANONICAL_RECORD_TYPES | set(_RECORD_TYPE_ALIASES.keys())

_BLOCKED_RECORD_TYPES = {"purchase_payment", "sales_payment"}


class TimelineQuery(BaseModel):
    record_type: str
    record_id: str
    limit: int = 50


class CommentCreateBody(BaseModel):
    record_type: str
    record_id: str
    body: str = Field(..., min_length=1, max_length=5000)
    is_pinned: bool = False


class CommentPatchBody(BaseModel):
    body: Optional[str] = Field(default=None, min_length=1, max_length=5000)
    is_pinned: Optional[bool] = None


class MarkViewedBody(BaseModel):
    record_type: str
    record_id: str


def _validate_record_type(record_type: str) -> str:
    rt = (record_type or "").strip()
    if not rt:
        raise HTTPException(status_code=400, detail="record_type is required")
    if rt in _BLOCKED_RECORD_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"record_type '{rt}' is excluded for activity timeline",
        )
    # Enforce a strict allowlist: accept only canonical types or known
    # legacy aliases. This preserves the original security/correctness
    # posture where unknown record_type values return 400.
    if rt not in _ALLOWED_RECORD_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported record_type '{rt}'")
    return _RECORD_TYPE_ALIASES.get(rt, rt)


async def _build_timeline_payload(
    db: AsyncSession,
    *,
    record_type: str,
    record_id: str,
    limit: int,
    perms: set[str],
    user: User,
) -> dict[str, Any]:
    history_stmt = (
        select(AuditLog)
        .where(
            and_(
                AuditLog.record_type == record_type,
                AuditLog.record_id == record_id,
            )
        )
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
    )

    comments_stmt = (
        select(ActivityComment, User.name.label("author_name"))
        .join(User, User.id == ActivityComment.author_id)
        .where(
            and_(
                ActivityComment.record_type == record_type,
                ActivityComment.record_id == record_id,
                ActivityComment.deleted_at.is_(None),
            )
        )
        .order_by(ActivityComment.created_at.desc())
        .limit(limit)
    )

    history_rows = []
    comment_rows = []
    events: list[dict[str, Any]] = []

    if "history.view" in perms:
        history_rows = (await db.execute(history_stmt)).scalars().all()
        events.extend(_serialize_history(h) for h in history_rows)

    if "comments.view" in perms:
        comment_rows = (await db.execute(comments_stmt)).all()
        events.extend(_serialize_comment(c, author_name, perms, user) for c, author_name in comment_rows)

    events.sort(key=lambda x: x.get("created_at") or datetime.min, reverse=True)

    return {
        "record_type": record_type,
        "record_id": record_id,
        "events": events[:limit],
    }


async def _permissions_for_user(db: AsyncSession, user: User) -> set[str]:
    granted: list[str] = []
    role = None
    if user.role_id:
        role = (
            await db.execute(select(Role).where(Role.id == user.role_id))
        ).scalar_one_or_none()
    elif user.role:
        role_key = user.role.value if hasattr(user.role, "value") else user.role
        role = (
            await db.execute(select(Role).where(Role.key == role_key))
        ).scalar_one_or_none()

    if role:
        granted = list(role.permissions or [])
    return expand(granted)


async def _require_any_perm(db: AsyncSession, user: User, needed: list[str]) -> set[str]:
    perms = await _permissions_for_user(db, user)
    if "*" in perms or any(p in perms for p in needed):
        return perms
    raise HTTPException(status_code=403, detail=f"Missing permission: {' or '.join(needed)}")


async def _comment_with_author(comment_id: str, db: AsyncSession):
    stmt = (
        select(
            ActivityComment,
            User.name.label("author_name"),
        )
        .join(User, User.id == ActivityComment.author_id)
        .where(ActivityComment.id == comment_id)
    )
    row = (await db.execute(stmt)).first()
    return row


def _serialize_comment(
    comment: ActivityComment,
    author_name: str,
    perms: set[str],
    user: User,
) -> dict[str, Any]:
    is_comment_admin = "*" in perms or "comments.delete_any" in perms
    can_edit_own = "comments.edit_own" in perms
    can_edit = is_comment_admin or (can_edit_own and comment.author_id == user.id)
    can_delete = is_comment_admin or (can_edit_own and comment.author_id == user.id)

    return {
        "id": comment.id,
        "record_type": comment.record_type,
        "record_id": comment.record_id,
        "author_id": comment.author_id,
        "author_name": author_name,
        "body": comment.body,
        "is_pinned": bool(comment.is_pinned),
        "edited_at": comment.edited_at,
        "deleted_at": comment.deleted_at,
        "created_at": comment.created_at,
        "kind": "comment",
        "can_edit": can_edit,
        "can_delete": can_delete,
    }


def _serialize_history(log: AuditLog) -> dict[str, Any]:
    metadata = None
    if log.event_metadata:
        try:
            metadata = json.loads(log.event_metadata)
        except ValueError:
            metadata = log.event_metadata

    return {
        "id": log.id,
        "record_type": log.record_type,
        "record_id": log.record_id,
        "event_type": log.event_type,
        "action": log.action,
        "module": log.module,
        "detail": log.detail,
        "ref": log.ref,
        "risk": log.risk,
        "created_at": log.created_at,
        "user_id": log.user_id,
        "user_name": log.user_name,
        "event_metadata": metadata,
        "kind": "history",
    }


@router.get("/timeline")
async def get_timeline(
    record_type: str,
    record_id: str,
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    rt = _validate_record_type(record_type)
    perms = await _require_any_perm(db, user, ["history.view", "comments.view"])

    return await _build_timeline_payload(
        db,
        record_type=rt,
        record_id=record_id,
        limit=limit,
        perms=perms,
        user=user,
    )


@router.get("/{record_type}/{record_id}")
async def get_timeline_by_path(
    record_type: str,
    record_id: str,
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    rt = _validate_record_type(record_type)
    perms = await _require_any_perm(db, user, ["history.view", "comments.view"])
    return await _build_timeline_payload(
        db,
        record_type=rt,
        record_id=record_id,
        limit=limit,
        perms=perms,
        user=user,
    )


@router.post("/comments")
async def post_comment(
    payload: CommentCreateBody,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    rt = _validate_record_type(payload.record_type)
    await _require_any_perm(db, user, ["comments.add"])

    comment = ActivityComment(
        id=str(uuid4()),
        record_type=rt,
        record_id=payload.record_id,
        author_id=user.id,
        body=payload.body.strip(),
        is_pinned=bool(payload.is_pinned),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    perms = await _permissions_for_user(db, user)
    return _serialize_comment(comment, user.name, perms, user)


@router.patch("/comments/{comment_id}")
async def patch_comment(
    comment_id: str,
    payload: CommentPatchBody,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _comment_with_author(comment_id, db)
    if not row:
        raise HTTPException(status_code=404, detail="Comment not found")

    comment, author_name = row
    _validate_record_type(comment.record_type)

    perms = await _permissions_for_user(db, user)
    is_admin = "*" in perms or "comments.delete_any" in perms
    can_edit_own = "comments.edit_own" in perms

    if not (is_admin or (can_edit_own and comment.author_id == user.id)):
        raise HTTPException(status_code=403, detail="Not allowed to edit this comment")

    changed = False
    if payload.body is not None:
        comment.body = payload.body.strip()
        changed = True
    if payload.is_pinned is not None:
        comment.is_pinned = bool(payload.is_pinned)
        changed = True

    if changed:
        comment.edited_at = datetime.utcnow()
        await db.commit()
        await db.refresh(comment)

    perms = await _permissions_for_user(db, user)
    return _serialize_comment(comment, author_name, perms, user)


@router.delete("/comments/{comment_id}")
async def delete_comment(
    comment_id: str,
    can_delete: Optional[bool] = Query(default=None),
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    # `can_delete` is intentionally ignored; server re-derives permissions.
    _ = can_delete

    row = await _comment_with_author(comment_id, db)
    if not row:
        raise HTTPException(status_code=404, detail="Comment not found")

    comment, _author_name = row
    _validate_record_type(comment.record_type)

    perms = await _permissions_for_user(db, user)
    is_admin = "*" in perms or "comments.delete_any" in perms
    can_edit_own = "comments.edit_own" in perms

    if not (is_admin or (can_edit_own and comment.author_id == user.id)):
        raise HTTPException(status_code=403, detail="Not allowed to delete this comment")

    if comment.deleted_at is None:
        comment.deleted_at = datetime.utcnow()
        await db.commit()

    return {"ok": True}


@router.post("/mark-viewed")
async def mark_viewed(
    payload: MarkViewedBody,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    rt = _validate_record_type(payload.record_type)
    await _require_any_perm(db, user, ["history.view", "comments.view"])

    existing = (
        await db.execute(
            select(ActivityView).where(
                and_(
                    ActivityView.user_id == user.id,
                    ActivityView.record_type == rt,
                    ActivityView.record_id == payload.record_id,
                )
            )
        )
    ).scalar_one_or_none()

    now = datetime.utcnow()
    if existing:
        existing.last_viewed_at = now
    else:
        db.add(
            ActivityView(
                id=str(uuid4()),
                user_id=user.id,
                record_type=rt,
                record_id=payload.record_id,
                last_viewed_at=now,
            )
        )

    await db.commit()
    return {"ok": True, "record_type": rt, "record_id": payload.record_id, "last_viewed_at": now}


@router.get("/unread-summary")
async def unread_summary(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    await _require_any_perm(db, user, ["history.view", "comments.view"])

    history_last = (
        select(
            AuditLog.record_type.label("record_type"),
            AuditLog.record_id.label("record_id"),
            func.max(AuditLog.created_at).label("last_event_at"),
        )
        .where(AuditLog.record_type.in_(list(_CANONICAL_RECORD_TYPES)))
        .group_by(AuditLog.record_type, AuditLog.record_id)
    )

    comments_last = (
        select(
            ActivityComment.record_type.label("record_type"),
            ActivityComment.record_id.label("record_id"),
            func.max(ActivityComment.created_at).label("last_event_at"),
        )
        .where(ActivityComment.deleted_at.is_(None))
        .group_by(ActivityComment.record_type, ActivityComment.record_id)
    )

    union_events = history_last.union_all(comments_last).subquery()

    latest_events = (
        select(
            union_events.c.record_type,
            union_events.c.record_id,
            func.max(union_events.c.last_event_at).label("last_event_at"),
        )
        .group_by(union_events.c.record_type, union_events.c.record_id)
    ).subquery()

    view_sq = (
        select(
            ActivityView.record_type,
            ActivityView.record_id,
            ActivityView.last_viewed_at,
        )
        .where(ActivityView.user_id == user.id)
    ).subquery()

    stmt = (
        select(
            latest_events.c.record_type,
            latest_events.c.record_id,
            latest_events.c.last_event_at,
            view_sq.c.last_viewed_at,
        )
        .select_from(
            latest_events.outerjoin(
                view_sq,
                and_(
                    view_sq.c.record_type == latest_events.c.record_type,
                    view_sq.c.record_id == latest_events.c.record_id,
                ),
            )
        )
        .where(
            or_(
                view_sq.c.last_viewed_at.is_(None),
                latest_events.c.last_event_at > view_sq.c.last_viewed_at,
            )
        )
    )

    rows = (await db.execute(stmt)).all()
    return {
        "total_unread": len(rows),
        "records": [
            {
                "record_type": row.record_type,
                "record_id": row.record_id,
                "last_event_at": row.last_event_at,
                "last_viewed_at": row.last_viewed_at,
            }
            for row in rows
        ],
    }

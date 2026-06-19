"""
Roles CRUD.

Writes (POST/PUT/DELETE) are gated on `users.manage_roles` (Phase 3).
Reads (GET) are intentionally left open so the Sidebar role-label resolver
and any logged-in user can fetch role definitions without needing
admin perms. See docs/USERS_AND_ROLES.md §7 / §10 (Phase 3 notes).
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Role, User
from src.pagination import normalize_limit, normalize_skip, paged_list, pagination_from_page
from src.permissions import filter_valid
from src.security import require_perm

router = APIRouter()


# ─── Schemas ──────────────────────────────────────────────────────────────────
class RoleCreate(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=80)
    description: str = ""
    color: str = "blue"
    permissions: List[str] = Field(default_factory=list)


class RoleUpdate(BaseModel):
    label: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    permissions: Optional[List[str]] = None
    active: Optional[bool] = None


# ─── Helpers ──────────────────────────────────────────────────────────────────
def _serialize(role: Role, user_count: int = 0) -> dict:
    return {
        "id": role.id,
        "key": role.key,
        "label": role.label,
        "description": role.description or "",
        "color": role.color,
        "permissions": list(role.permissions or []),
        "is_system": bool(role.is_system),
        "active": bool(role.active),
        "user_count": user_count,
    }


async def _user_counts(db: AsyncSession, role_ids: list[str]) -> dict[str, int]:
    if not role_ids:
        return {}
    rows = (await db.execute(
        select(User.role_id, func.count(User.id))
        .where(User.role_id.in_(role_ids))
        .group_by(User.role_id)
    )).all()
    return {rid: cnt for rid, cnt in rows}


def _normalize_perms(role_key: str, perms: list[str]) -> list[str]:
    """D1: drop anything not in the catalog. Super-admin always has ['*']."""
    if role_key == "super_admin":
        return ["*"]
    return filter_valid(perms)


# ─── Routes ───────────────────────────────────────────────────────────────────
@router.get("/")
async def list_roles(
    page_no: Optional[int] = Query(None, ge=1),
    per_page: Optional[int] = Query(None, ge=1, le=500),
    skip: Optional[int] = Query(None, ge=0),
    limit: Optional[int] = Query(None, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    if page_no is not None or per_page is not None:
        _, pp, sk, lim = pagination_from_page(page_no, per_page)
    else:
        sk = normalize_skip(skip)
        lim = normalize_limit(limit)
    base_q = select(Role).where(Role.active == True)  # noqa: E712
    total = int((await db.execute(select(func.count(Role.id)).where(Role.active == True))).scalar() or 0)  # noqa: E712
    rows = (
        await db.execute(
            base_q.order_by(Role.is_system.desc(), Role.label).offset(sk).limit(lim)
        )
    ).scalars().all()
    counts = await _user_counts(db, [r.id for r in rows])
    items = [_serialize(r, counts.get(r.id, 0)) for r in rows]
    return paged_list(items, total, sk, lim)


@router.get("/{role_id}")
async def get_role(role_id: str, db: AsyncSession = Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if not role:
        raise HTTPException(404, "Role not found")
    counts = await _user_counts(db, [role.id])
    return _serialize(role, counts.get(role.id, 0))


@router.post("/", status_code=201, dependencies=[Depends(require_perm("users.manage_roles"))])
async def create_role(data: RoleCreate, db: AsyncSession = Depends(get_db)):
    if not data.permissions:
        raise HTTPException(422, "A role must have at least one permission.")
    perms = _normalize_perms(data.key, data.permissions)
    if data.key != "super_admin" and not perms:
        raise HTTPException(422, "A role must have at least one permission.")
    existing = (await db.execute(select(Role).where(Role.key == data.key))).scalar_one_or_none()
    if existing:
        raise HTTPException(409, f"Role key '{data.key}' already exists")
    role = Role(
        id=f"role-{uuid.uuid4().hex[:8]}",
        key=data.key,
        label=data.label,
        description=data.description or "",
        color=data.color or "blue",
        permissions=perms,
        is_system=False,
        active=True,
    )
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return _serialize(role, 0)


@router.put("/{role_id}", dependencies=[Depends(require_perm("users.manage_roles"))])
async def update_role(role_id: str, data: RoleUpdate, db: AsyncSession = Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if not role:
        raise HTTPException(404, "Role not found")
    if data.permissions is not None and len(data.permissions) == 0:
        raise HTTPException(422, "A role must have at least one permission.")
    if data.label is not None:
        role.label = data.label
    if data.description is not None:
        role.description = data.description
    if data.color is not None:
        role.color = data.color
    if data.permissions is not None:
        if len(data.permissions) == 0:
            raise HTTPException(422, "A role must have at least one permission.")
        normalized = _normalize_perms(role.key, data.permissions)
        if role.key != "super_admin" and not normalized:
            raise HTTPException(422, "A role must have at least one permission.")
        role.permissions = normalized
    if data.active is not None and not role.is_system:
        role.active = data.active
    await db.commit()
    await db.refresh(role)
    counts = await _user_counts(db, [role.id])
    return _serialize(role, counts.get(role.id, 0))


@router.delete("/{role_id}", dependencies=[Depends(require_perm("users.manage_roles"))])
async def delete_role(role_id: str, db: AsyncSession = Depends(get_db)):
    role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
    if not role:
        raise HTTPException(404, "Role not found")
    if role.is_system:
        raise HTTPException(400, "System roles cannot be deleted")
    counts = await _user_counts(db, [role.id])
    if counts.get(role.id, 0) > 0:
        raise HTTPException(409, f"Role is in use by {counts[role.id]} user(s); reassign them first")
    await db.delete(role)
    await db.commit()
    return {"message": "Role deleted"}

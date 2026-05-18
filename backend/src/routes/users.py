import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Role, User
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._serializers import serialize_user
from src.security import hash_password, require_perm

router = APIRouter()

class UserCreate(BaseModel):
    name: str
    email: str
    # `role` is the legacy enum string ("cashier", ...). `role_id` is the new
    # FK. Either is accepted on create/update; if both are provided role_id
    # wins. See docs/USERS_AND_ROLES.md §5.2 (role kept as cache for one cycle).
    role: Optional[str] = None
    role_id: Optional[str] = None
    branch_id: Optional[str] = None
    password: str = "changeme123"


class UserUpdate(BaseModel):
    """Typed update body. Only fields a client is allowed to change end up
    here — `data: dict` + setattr would let a client write `hashed_password`
    or `active` directly via the same endpoint. `password`, `role`/`role_id`
    are accepted and routed through the same hashing / role-resolution paths
    as `create_user`."""
    name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None
    role_id: Optional[str] = None
    branch_id: Optional[str] = None
    password: Optional[str] = None
    avatar: Optional[str] = None


async def _resolve_role(
    db: AsyncSession, role_id: Optional[str], role_key: Optional[str]
) -> tuple[Optional[str], Optional[str]]:
    """Returns (role_id, legacy_role_key). One or both may be None.

    If role_id is given and the row exists → returns both.
    If only role_key is given → looks up the matching system role's id.
    """
    if role_id:
        role = (await db.execute(select(Role).where(Role.id == role_id))).scalar_one_or_none()
        if not role:
            raise HTTPException(400, f"Unknown role_id: {role_id}")
        return role.id, role.key
    if role_key:
        role = (await db.execute(select(Role).where(Role.key == role_key))).scalar_one_or_none()
        # Accept the legacy key even if no Role row exists yet (pre-seed boot);
        # role_id will simply stay null until the next backfill.
        return (role.id if role else None), role_key
    return None, None


@router.get("/", dependencies=[Depends(require_perm("users.view"))])
async def list_users(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(select(func.count(User.id)))).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "name": User.name,
            "email": User.email,
            "role": User.role,
            "branch_id": User.branch_id,
            "active": User.active,
            "created_at": User.created_at,
            "last_login": User.last_login,
        },
        default_key="name",
        default_order="asc",
    )
    result = await db.execute(select(User).order_by(sort_expr).offset(sk).limit(lim))
    items = [serialize_user(u) for u in result.scalars().all()]
    return paged(items, total, sk, lim)

@router.post("/", status_code=201, dependencies=[Depends(require_perm("users.create"))])
async def create_user(data: UserCreate, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(select(User).where(User.email == data.email))).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "A user with this email already exists")
    rid, rkey = await _resolve_role(db, data.role_id, data.role)
    u = User(
        id=str(uuid.uuid4()),
        name=data.name,
        email=data.email,
        hashed_password=hash_password(data.password),
        role=rkey or "cashier",
        role_id=rid,
        branch_id=data.branch_id,
        active=True,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return serialize_user(u)


@router.patch("/{user_id}", dependencies=[Depends(require_perm("users.edit"))])
async def update_user(user_id: str, data: UserUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(404, "User not found")

    payload = data.model_dump(exclude_unset=True)
    # Resolve role_id / role together so they stay consistent.
    if "role_id" in payload or "role" in payload:
        rid, rkey = await _resolve_role(db, payload.pop("role_id", None), payload.pop("role", None))
        if rid is not None or rkey is not None:
            u.role_id = rid
            if rkey is not None:
                u.role = rkey

    if "password" in payload:
        pw = payload.pop("password")
        if pw:
            u.hashed_password = hash_password(pw)

    for k, v in payload.items():
        setattr(u, k, v)

    await db.commit()
    return {"message": "Updated"}


@router.patch("/{user_id}/toggle", dependencies=[Depends(require_perm("users.edit"))])
async def toggle_user(user_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(404, "User not found")
    u.active = not u.active
    await db.commit()
    return {"active": u.active}

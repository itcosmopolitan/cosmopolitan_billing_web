import secrets
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Branch, Role, User, UserBranch
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._serializers import attach_branch_ids, serialize_user
from src.security import hash_password, require_perm

router = APIRouter()

# Length of an auto-generated temp password (URL-safe base64 chars ≈ 12 chars
# from 9 bytes ≈ 72 bits of entropy — plenty for a one-use credential that
# expires on first login).
TEMP_PASSWORD_BYTES = 9


def _generate_temp_password() -> str:
    """Cryptographically random URL-safe temp password (~12 chars)."""
    return secrets.token_urlsafe(TEMP_PASSWORD_BYTES)


class UserCreate(BaseModel):
    name: str
    # EmailStr enforces RFC-5322-ish syntax + checks deliverability via
    # email-validator. Same type used in LoginRequest so the create + login
    # paths agree on what counts as a valid address. Direct API callers
    # (curl / scripts) sending a malformed email get a 422 from FastAPI
    # before the handler runs.
    email: EmailStr
    # `role` is the legacy enum string ("cashier", ...). `role_id` is the new
    # FK. Either is accepted on create/update; if both are provided role_id
    # wins. See docs/USERS_AND_ROLES.md §5.2 (role kept as cache for one cycle).
    role: Optional[str] = None
    role_id: Optional[str] = None
    # DEPRECATED for new clients — primary branch is now derived as the first
    # element of `branch_ids`. Still accepted as a single-branch shorthand
    # (older clients) and mirrored into branch_ids on save.
    branch_id: Optional[str] = None
    # Multi-branch assignment (2026-05-18). Empty list + all_branches=False
    # is rejected — caller must either tick all_branches OR pick at least one.
    branch_ids: Optional[List[str]] = None
    all_branches: bool = False
    # If omitted (or empty), the server generates a cryptographically random
    # temp password and returns it in the create response so the admin can
    # share it with the new user. Either way, the user is flagged with
    # must_change_password=True and forced to change on first login.
    password: Optional[str] = None


class UserUpdate(BaseModel):
    """Typed update body. Only fields a client is allowed to change end up
    here — `data: dict` + setattr would let a client write `hashed_password`
    or `active` directly via the same endpoint. `password`, `role`/`role_id`
    are accepted and routed through the same hashing / role-resolution paths
    as `create_user`."""
    name: Optional[str] = None
    # Same EmailStr gate as UserCreate when provided. Optional so PATCHes
    # that don't touch the email field still work.
    email: Optional[EmailStr] = None
    role: Optional[str] = None
    role_id: Optional[str] = None
    branch_id: Optional[str] = None
    branch_ids: Optional[List[str]] = None
    all_branches: Optional[bool] = None
    password: Optional[str] = None
    avatar: Optional[str] = None


async def _assign_branches(
    db: AsyncSession,
    user: User,
    *,
    all_branches: bool,
    branch_ids: Optional[List[str]],
    legacy_single_branch_id: Optional[str] = None,
) -> None:
    """Idempotently set a user's branch assignment.

    Resolves three input shapes from the request:
      1. `all_branches=True` → user has access to every branch. `branch_id`
         is cleared, `user_branches` rows are deleted.
      2. `branch_ids=[...]` → explicit multi-branch list. `branch_id` mirrors
         the first item; `user_branches` is replaced.
      3. Only `legacy_single_branch_id` given (older client that doesn't know
         about the multi-select) → treated as a single-element branch_ids list.

    Raises HTTPException(400) if the result would be ambiguous (no branches
    selected AND all_branches=False), or if any referenced branch_id is
    unknown.
    """
    if all_branches:
        user.all_branches = True
        user.branch_id = None
        await db.execute(delete(UserBranch).where(UserBranch.user_id == user.id))
        return

    # Coalesce branch_ids from either the new field or the legacy single-id
    # shorthand. Strip falsy + dedupe while preserving order (admin's pick of
    # primary).
    ids: List[str] = []
    seen: set[str] = set()
    for bid in list(branch_ids or []) + ([legacy_single_branch_id] if legacy_single_branch_id else []):
        if not bid or bid in seen:
            continue
        ids.append(bid)
        seen.add(bid)

    if not ids:
        # NB: the UI no longer exposes the all_branches=True path (removed
        # 2026-05-18 sixth session) — admins always pick an explicit list.
        # The backend still accepts all_branches=True for any older client
        # or direct API consumer, hence the conditional above; this error
        # only fires when neither route was taken.
        raise HTTPException(400, "Pick at least one branch")

    # Validate every id exists. Single round-trip — `branches` is small.
    rows = (await db.execute(select(Branch.id).where(Branch.id.in_(ids)))).scalars().all()
    valid = set(rows)
    missing = [b for b in ids if b not in valid]
    if missing:
        raise HTTPException(400, f"Unknown branch_id(s): {', '.join(missing)}")

    user.all_branches = False
    # users.branch_id is mirrored from the first entry purely for backwards
    # compat with legacy reads (see User.branch_id docstring). Any consumer
    # is expected to use user_branches instead.
    user.branch_id = ids[0]
    # Replace the join rows wholesale (small table, simpler than diffing).
    await db.execute(delete(UserBranch).where(UserBranch.user_id == user.id))
    for bid in ids:
        db.add(UserBranch(user_id=user.id, branch_id=bid))


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
    users = result.scalars().all()
    items = [serialize_user(u) for u in users]
    # Bulk-fetch all user_branches rows for this page in one round trip
    # (avoids N+1). attach_branch_ids mutates each dict in-place.
    await attach_branch_ids(db, items)
    return paged(items, total, sk, lim)

@router.post("/", status_code=201, dependencies=[Depends(require_perm("users.create"))])
async def create_user(data: UserCreate, db: AsyncSession = Depends(get_db)):
    existing = (await db.execute(select(User).where(User.email == data.email))).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "A user with this email already exists")
    rid, rkey = await _resolve_role(db, data.role_id, data.role)

    # Use admin-supplied password if given, else generate one. The plaintext
    # is included in the response (one-time, post-create) so the admin can
    # share it with the new user out of band.
    temp_password = (data.password or "").strip() or _generate_temp_password()

    u = User(
        id=str(uuid.uuid4()),
        name=data.name,
        email=data.email,
        hashed_password=hash_password(temp_password),
        role=rkey or "cashier",
        role_id=rid,
        active=True,
        must_change_password=True,
    )
    db.add(u)
    # Need to flush so the FK in user_branches can reference u.id without
    # committing the half-built record.
    await db.flush()
    await _assign_branches(
        db, u,
        all_branches=data.all_branches,
        branch_ids=data.branch_ids,
        legacy_single_branch_id=data.branch_id,
    )
    await db.commit()
    await db.refresh(u)

    payload = serialize_user(u)
    await attach_branch_ids(db, [payload])
    return {
        **payload,
        # SECURITY: only included in this create response. /auth/login and
        # /auth/me never echo the password. Admin should treat this as
        # sensitive and share it out of band.
        "temp_password": temp_password,
    }


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

    # Branch assignment touches multiple columns + the join table. Only run
    # if the client actually sent something branch-related (otherwise we'd
    # nuke existing rows on a name-only edit).
    branch_fields_sent = (
        "branch_ids" in payload or "all_branches" in payload or "branch_id" in payload
    )
    if branch_fields_sent:
        await _assign_branches(
            db, u,
            all_branches=bool(payload.pop("all_branches", False)),
            branch_ids=payload.pop("branch_ids", None),
            legacy_single_branch_id=payload.pop("branch_id", None),
        )

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

import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Branch, ItemStock, User
from src.pagination import normalize_limit, normalize_skip, paged_list, pagination_from_page, resolve_sort
from src.routes._serializers import get_user_branch_ids, serialize_branch
from src.security import current_user, enforce_branch_access, require_perm
from src.services.audit_service import add_audit_log

router = APIRouter()


def _normalize_branch_code(value: str) -> str:
    letters = re.sub(r"[^A-Z]", "", (value or "").upper())
    if len(letters) >= 2:
        return letters[:2]
    if letters:
        return letters + letters[-1]
    return "BR"


def _build_branch_code(name: str, existing_codes: Optional[list[str]] = None, existing_code: Optional[str] = None) -> str:
    base_code = _normalize_branch_code(name if name else "Branch")
    if existing_code and existing_code.upper() == base_code:
        return existing_code.upper()

    candidate = re.sub(r"[^A-Z]", "", base_code.upper())
    used_codes = {re.sub(r"[^A-Z]", "", code.upper()) for code in (existing_codes or []) if code}
    if existing_code:
        used_codes.discard(re.sub(r"[^A-Z]", "", existing_code.upper()))

    if candidate not in used_codes:
        return candidate

    first_start = ord(candidate[0]) if len(candidate) > 0 else ord("A")
    second_start = ord(candidate[1]) if len(candidate) > 1 else ord("A")

    for first_offset in range(0, 26):
        first_letter = chr((first_start - ord("A") + first_offset) % 26 + ord("A"))
        for second_offset in range(0, 26):
            second_letter = chr((second_start - ord("A") + second_offset) % 26 + ord("A"))
            alt = f"{first_letter}{second_letter}"
            if alt not in used_codes:
                return alt

    return "ZZ"


class BranchCreate(BaseModel):
    name: str
    code: str
    phone: Optional[str] = None
    address: Optional[str] = None
    street1: Optional[str] = None
    street2: Optional[str] = None
    street3: Optional[str] = None
    city: Optional[str] = None
    state_province: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = None
    gstin: Optional[str] = None
    active: bool = True


class BranchUpdate(BaseModel):
    """Typed update body — restricts client-writeable fields."""
    name: Optional[str] = None
    code: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    street1: Optional[str] = None
    street2: Optional[str] = None
    street3: Optional[str] = None
    city: Optional[str] = None
    state_province: Optional[str] = None
    country: Optional[str] = None
    postal_code: Optional[str] = None
    gstin: Optional[str] = None
    active: Optional[bool] = None

@router.get("/")
async def list_branches(
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    page_no: Optional[int] = Query(None, ge=1),
    per_page: Optional[int] = Query(None, ge=1, le=500),
    skip: Optional[int] = Query(None, ge=0),
    limit: Optional[int] = Query(None, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user = Depends(current_user),
):
    if page_no is not None or per_page is not None:
        _, pp, sk, lim = pagination_from_page(page_no, per_page)
    else:
        sk = normalize_skip(skip)
        lim = normalize_limit(limit)

    accessible = None
    if not getattr(user, "all_branches", False):
        accessible = await get_user_branch_ids(db, user.id)
        if not accessible:
            return paged_list([], 0, sk, lim)

    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "name": Branch.name,
            "code": Branch.code,
            "phone": Branch.phone,
            "active": Branch.active,
            "created_at": Branch.created_at,
        },
        default_key="name",
        default_order="asc",
    )
    query = select(Branch)
    if accessible is not None:
        query = query.where(Branch.id.in_(accessible))
    # Count rows from the query's subquery to avoid joining the outer
    # `branches` table with the subquery (prevents SAWarning about a
    # cartesian product when SQLAlchemy composes FROM elements).
    count_stmt = select(func.count()).select_from(query.subquery())
    total = int((await db.execute(count_stmt)).scalar() or 0)
    result = await db.execute(query.order_by(sort_expr).offset(sk).limit(lim))
    items = [serialize_branch(b) for b in result.scalars().all()]
    return paged_list(items, total, sk, lim)

@router.get("/{branch_id}")
async def get_branch(branch_id: str = Depends(enforce_branch_access), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Branch).where(Branch.id == branch_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Branch not found")
    return serialize_branch(b)

@router.post("/", status_code=201, dependencies=[Depends(require_perm("settings.edit"))])
async def create_branch(
    data: BranchCreate,
    db: AsyncSession = Depends(get_db),
    request: Request = None,
    user: User = Depends(current_user),
):
    existing_codes = [row[0] for row in (await db.execute(select(Branch.code))).all() if row[0]]
    code = _build_branch_code(data.name, existing_codes=existing_codes)
    b = Branch(id=str(uuid.uuid4()), name=data.name, code=code,
               phone=data.phone, address=data.address,
               street1=data.street1, street2=data.street2, street3=data.street3,
               city=data.city, state_province=data.state_province,
               country=data.country, postal_code=data.postal_code,
               gstin=data.gstin, active=data.active)
    db.add(b)
    add_audit_log(
        db,
        action="Branch created",
        module="Settings",
        reference_id=b.id,
        detail=f"Created branch {b.name} ({b.code})",
        user=user,
        request=request,
        metadata={
            "name": b.name,
            "code": b.code,
            "phone": b.phone,
            "address": b.address,
            "street1": b.street1,
            "street2": b.street2,
            "street3": b.street3,
            "city": b.city,
            "state_province": b.state_province,
            "country": b.country,
            "postal_code": b.postal_code,
            "gstin": b.gstin,
            "active": b.active,
        },
    )
    await db.commit()
    return {"id": b.id, "message": "Branch created"}

@router.put("/{branch_id}", dependencies=[Depends(require_perm("settings.edit"))])
async def update_branch(
    branch_id: str,
    data: BranchUpdate,
    db: AsyncSession = Depends(get_db),
    request: Request = None,
    user: User = Depends(current_user),
):
    result = await db.execute(select(Branch).where(Branch.id == branch_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Branch not found")
    payload = data.model_dump(exclude_unset=True)
    if "code" in payload:
        payload.pop("code")
    if "name" in payload:
        b.name = payload.pop("name")
    for k, v in payload.items():
        setattr(b, k, v)
    existing_codes = [row[0] for row in (await db.execute(select(Branch.code))).all() if row[0]]
    b.code = _build_branch_code(b.name, existing_codes=existing_codes, existing_code=b.code)
    add_audit_log(
        db,
        action="Branch updated",
        module="Settings",
        reference_id=b.id,
        detail=f"Updated branch {b.name} ({b.code})",
        user=user,
        request=request,
        metadata=payload,
    )
    await db.commit()
    return {"message": "Updated"}

@router.get("/{branch_id}/stock-summary")
async def stock_summary(
    branch_id: str = Depends(enforce_branch_access),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func
    result = await db.execute(
        select(func.count(ItemStock.id), func.sum(ItemStock.quantity))
        .where(ItemStock.branch_id == branch_id)
    )
    row = result.one()
    return {"branch_id": branch_id, "item_count": row[0] or 0, "total_units": row[1] or 0}

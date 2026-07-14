import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Branch, ItemStock
from src.pagination import normalize_limit, normalize_skip, paged_list, pagination_from_page, resolve_sort
from src.routes._serializers import get_user_branch_ids, serialize_branch
from src.security import current_user, enforce_branch_access, require_perm

router = APIRouter()

class BranchCreate(BaseModel):
    name: str
    code: str
    phone: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    active: bool = True


class BranchUpdate(BaseModel):
    """Typed update body — restricts client-writeable fields."""
    name: Optional[str] = None
    code: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
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
async def create_branch(data: BranchCreate, db: AsyncSession = Depends(get_db)):
    b = Branch(id=str(uuid.uuid4()), name=data.name, code=data.code,
               phone=data.phone, address=data.address,
               gstin=data.gstin, active=data.active)
    db.add(b)
    await db.commit()
    return {"id": b.id, "message": "Branch created"}

@router.put("/{branch_id}", dependencies=[Depends(require_perm("settings.edit"))])
async def update_branch(branch_id: str, data: BranchUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Branch).where(Branch.id == branch_id))
    b = result.scalar_one_or_none()
    if not b:
        raise HTTPException(404, "Branch not found")
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(b, k, v)
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

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import Vendor
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._serializers import serialize_vendor
from src.security import require_perm

router = APIRouter()

class VendorCreate(BaseModel):
    name: str
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: str = "30 days"

class VendorUpdate(BaseModel):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: Optional[str] = None

@router.get("/", dependencies=[Depends(require_perm("vendors.view"))])
async def list_vendors(
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q = select(Vendor)
    cq = select(func.count(Vendor.id))
    if search:
        term = f"%{search}%"
        q = q.where(Vendor.name.ilike(term))
        cq = cq.where(Vendor.name.ilike(term))
    total = int((await db.execute(cq)).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "name": Vendor.name,
            "contact_person": Vendor.contact_person,
            "phone": Vendor.phone,
            "email": Vendor.email,
            "payment_terms": Vendor.payment_terms,
            "outstanding": Vendor.outstanding,
            "total_purchases": Vendor.total_purchases,
            "created_at": Vendor.created_at,
        },
        default_key="name",
        default_order="asc",
    )
    result = await db.execute(q.order_by(sort_expr).offset(sk).limit(lim))
    items = [serialize_vendor(v) for v in result.scalars().all()]
    return paged(items, total, sk, lim)

@router.get("/{vendor_id}", dependencies=[Depends(require_perm("vendors.view"))])
async def get_vendor(vendor_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vendor not found")
    return serialize_vendor(v)

@router.post("/", status_code=201, dependencies=[Depends(require_perm("vendors.create"))])
async def create_vendor(data: VendorCreate, db: AsyncSession = Depends(get_db)):
    v = Vendor(id=str(uuid.uuid4()), name=data.name, contact_person=data.contact_person,
               phone=data.phone, email=data.email, address=data.address,
               gstin=data.gstin, payment_terms=data.payment_terms)
    db.add(v)
    await db.commit()
    await db.refresh(v)
    return serialize_vendor(v)

@router.put("/{vendor_id}", dependencies=[Depends(require_perm("vendors.edit"))])
async def update_vendor(vendor_id: str, data: VendorUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vendor not found")
    for k, val in data.model_dump(exclude_unset=True).items():
        setattr(v, k, val)
    await db.commit()
    await db.refresh(v)
    return serialize_vendor(v)

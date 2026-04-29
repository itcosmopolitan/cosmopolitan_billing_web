from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import Vendor
from src.pagination import paged, normalize_limit, normalize_skip
from pydantic import BaseModel
from typing import Optional
import uuid

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

@router.get("/")
async def list_vendors(
    search: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q = select(Vendor).order_by(Vendor.name)
    cq = select(func.count(Vendor.id))
    if search:
        term = f"%{search}%"
        q = q.where(Vendor.name.ilike(term))
        cq = cq.where(Vendor.name.ilike(term))
    total = int((await db.execute(cq)).scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    items = [_v(v) for v in result.scalars().all()]
    return paged(items, total, sk, lim)

@router.get("/{vendor_id}")
async def get_vendor(vendor_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = result.scalar_one_or_none()
    if not v: raise HTTPException(404, "Vendor not found")
    return _v(v)

@router.post("/", status_code=201)
async def create_vendor(data: VendorCreate, db: AsyncSession = Depends(get_db)):
    v = Vendor(id=str(uuid.uuid4()), name=data.name, contact_person=data.contact_person,
               phone=data.phone, email=data.email, address=data.address,
               gstin=data.gstin, payment_terms=data.payment_terms)
    db.add(v)
    await db.commit()
    await db.refresh(v)
    return _v(v)

@router.put("/{vendor_id}")
async def update_vendor(vendor_id: str, data: VendorUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    v = result.scalar_one_or_none()
    if not v: raise HTTPException(404, "Vendor not found")
    update_data = data.model_dump(exclude_unset=True)
    for k, val in update_data.items():
        setattr(v, k, val)
    await db.commit()
    await db.refresh(v)
    return _v(v)

def _v(v):
    return {
        "id": v.id, "name": v.name, "contact_person": v.contact_person,
        "phone": v.phone, "email": v.email, "address": v.address,
        "gstin": v.gstin, "payment_terms": v.payment_terms,
        "outstanding": v.outstanding, "total_purchases": v.total_purchases,
    }

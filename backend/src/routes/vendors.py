from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import Vendor
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
async def list_vendors(search: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(Vendor)
    if search: q = q.where(Vendor.name.ilike(f"%{search}%"))
    result = await db.execute(q)
    return [_v(v) for v in result.scalars().all()]

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

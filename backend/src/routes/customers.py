from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import Customer
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class CustomerCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gst_in: Optional[str] = None
    branch_id: str = "br-001"
    credit_limit: float = 10000
    customer_type: str = "retail"

@router.get("/")
async def list_customers(
    search: Optional[str] = None,
    customer_type: Optional[str] = None,
    branch_id: Optional[str] = None,
    skip: int = 0, limit: int = 100,
    db: AsyncSession = Depends(get_db)
):
    q = select(Customer)
    if search:        q = q.where(Customer.name.ilike(f"%{search}%"))
    if customer_type: q = q.where(Customer.type == customer_type)
    if branch_id:     q = q.where(Customer.branch_id == branch_id)
    result = await db.execute(q.offset(skip).limit(limit))
    customers = result.scalars().all()
    return [_cust_dict(c) for c in customers]

@router.get("/{customer_id}")
async def get_customer(customer_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Customer).where(Customer.id == customer_id))
    c = result.scalar_one_or_none()
    if not c: raise HTTPException(404, "Customer not found")
    return _cust_dict(c)

@router.post("/", status_code=201)
async def create_customer(data: CustomerCreate, db: AsyncSession = Depends(get_db)):
    print(data)
    c = Customer(id=str(uuid.uuid4()), name=data.name, phone=data.phone,
                 email=data.email, address=data.address, gstin=data.gst_in,
                 branch_id=data.branch_id, credit_limit=data.credit_limit,
                 type=data.customer_type)
    db.add(c)
    await db.commit()
    return {"id": c.id, "message": "Customer created"}

@router.put("/{customer_id}")
async def update_customer(customer_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Customer).where(Customer.id == customer_id))
    c = result.scalar_one_or_none()
    if not c: raise HTTPException(404, "Customer not found")
    for k, v in data.items():
        if hasattr(c, k): setattr(c, k, v)
    await db.commit()
    return {"message": "Updated"}

def _cust_dict(c):
    return {
        "id": c.id, "name": c.name, "phone": c.phone, "email": c.email,
        "address": c.address, "gst_in": c.gstin, "branch_id": c.branch_id,
        "credit_limit": c.credit_limit, "outstanding": c.outstanding,
        "total_purchases": c.total_purchases, "customer_type": c.type,
        "active": c.active,
    }

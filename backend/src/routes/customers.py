from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from src.database import get_db
from src.models import Customer
from src.pagination import paged, normalize_limit, normalize_skip
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
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q = select(Customer)
    cq = select(func.count(Customer.id))
    if search:
        term = f"%{search}%"
        q = q.where(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
        cq = cq.where(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
    if customer_type:
        q = q.where(Customer.type == customer_type)
        cq = cq.where(Customer.type == customer_type)
    if branch_id:
        q = q.where(Customer.branch_id == branch_id)
        cq = cq.where(Customer.branch_id == branch_id)
    total = int((await db.execute(cq)).scalar() or 0)
    conds = []
    if search:
        term = f"%{search}%"
        conds.append(
            or_(
                Customer.name.ilike(term),
                Customer.phone.ilike(term),
                Customer.email.ilike(term),
            )
        )
    if customer_type:
        conds.append(Customer.type == customer_type)
    if branch_id:
        conds.append(Customer.branch_id == branch_id)
    outstanding_total = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(Customer.outstanding), 0)).where(and_(*conds) if conds else True)
            )
        ).scalar()
        or 0
    )
    wb_filter = and_(Customer.outstanding > 0, *conds) if conds else (Customer.outstanding > 0)
    with_balance = int((await db.execute(select(func.count(Customer.id)).where(wb_filter))).scalar() or 0)
    result = await db.execute(q.order_by(Customer.name).offset(sk).limit(lim))
    customers = result.scalars().all()
    items = [_cust_dict(c) for c in customers]
    return paged(
        items,
        total,
        sk,
        lim,
        summary={"outstandingTotal": outstanding_total, "withBalanceCount": with_balance},
    )

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

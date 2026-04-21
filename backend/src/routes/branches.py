from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import Branch, ItemStock
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class BranchCreate(BaseModel):
    name: str
    code: str
    manager: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    active: bool = True

@router.get("/")
async def list_branches(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Branch).order_by(Branch.name))
    return [_b(b) for b in result.scalars().all()]

@router.get("/{branch_id}")
async def get_branch(branch_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Branch).where(Branch.id == branch_id))
    b = result.scalar_one_or_none()
    if not b: raise HTTPException(404, "Branch not found")
    return _b(b)

@router.post("/", status_code=201)
async def create_branch(data: BranchCreate, db: AsyncSession = Depends(get_db)):
    b = Branch(id=str(uuid.uuid4()), name=data.name, code=data.code,
               manager=data.manager, phone=data.phone, address=data.address,
               gstin=data.gstin, active=data.active)
    db.add(b)
    await db.commit()
    return {"id": b.id, "message": "Branch created"}

@router.put("/{branch_id}")
async def update_branch(branch_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Branch).where(Branch.id == branch_id))
    b = result.scalar_one_or_none()
    if not b: raise HTTPException(404, "Branch not found")
    for k, v in data.items():
        if hasattr(b, k): setattr(b, k, v)
    await db.commit()
    return {"message": "Updated"}

@router.get("/{branch_id}/stock-summary")
async def stock_summary(branch_id: str, db: AsyncSession = Depends(get_db)):
    from src.models import Item
    from sqlalchemy import func
    result = await db.execute(
        select(func.count(ItemStock.id), func.sum(ItemStock.quantity))
        .where(ItemStock.branch_id == branch_id)
    )
    row = result.one()
    return {"branch_id": branch_id, "item_count": row[0] or 0, "total_units": row[1] or 0}

def _b(b):
    return {
        "id": b.id, "name": b.name, "code": b.code,
        "manager": b.manager, "phone": b.phone,
        "address": b.address, "gstin": b.gstin, "active": b.active,
    }

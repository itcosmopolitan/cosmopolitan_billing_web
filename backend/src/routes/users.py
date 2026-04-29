from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import User
from src.pagination import paged, normalize_limit, normalize_skip
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class UserCreate(BaseModel):
    name: str
    email: str
    role: str
    branch_id: Optional[str] = None
    password: str = "changeme123"

@router.get("/")
async def list_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(select(func.count(User.id)))).scalar() or 0)
    result = await db.execute(select(User).order_by(User.name).offset(sk).limit(lim))
    items = [_u(u) for u in result.scalars().all()]
    return paged(items, total, sk, lim)

@router.post("/", status_code=201)
async def create_user(data: UserCreate, db: AsyncSession = Depends(get_db)):
    u = User(id=str(uuid.uuid4()), name=data.name, email=data.email,
             role=data.role, branch_id=data.branch_id, active=True)
    db.add(u)
    await db.commit()
    return {"id": u.id, "message": "User created"}

@router.patch("/{user_id}")
async def update_user(user_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u: raise HTTPException(404, "User not found")
    for k, v in data.items():
        if hasattr(u, k): setattr(u, k, v)
    await db.commit()
    return {"message": "Updated"}

@router.patch("/{user_id}/toggle")
async def toggle_user(user_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u: raise HTTPException(404, "User not found")
    u.active = not u.active
    await db.commit()
    return {"active": u.active}

def _u(u):
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role,
            "branch_id": u.branch_id, "active": u.active}

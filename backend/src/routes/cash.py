from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import CashEntry
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import uuid

router = APIRouter()

class CashEntryCreate(BaseModel):
    type: str  # 'in' | 'out'
    category: str
    description: str
    amount: float
    ref: Optional[str] = None
    date: Optional[str] = None
    by: str = "Staff"

class DayCloseRequest(BaseModel):
    physical_count: float
    notes: Optional[str] = None
    closed_by: str

@router.get("/{branch_id}/entries")
async def get_entries(branch_id: str, date: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(CashEntry).where(CashEntry.branch_id == branch_id)
    if date:
        q = q.where(CashEntry.date == date)
    q = q.order_by(CashEntry.created_at)
    result = await db.execute(q)
    entries = result.scalars().all()
    return [_e(e) for e in entries]

@router.get("/{branch_id}/summary")
async def get_summary(branch_id: str, date: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(CashEntry).where(CashEntry.branch_id == branch_id)
    if date:
        q = q.where(CashEntry.date == date)
    result = await db.execute(q)
    entries = result.scalars().all()
    opening  = sum(e.amount for e in entries if e.category == "Opening Balance")
    cash_in  = sum(e.amount for e in entries if e.type == "in")
    cash_out = sum(e.amount for e in entries if e.type == "out")
    expected = opening + cash_in - cash_out
    return {"branch_id": branch_id, "date": date, "opening": opening,
            "cash_in": cash_in, "cash_out": cash_out, "expected": expected, "actual": expected, "variance": 0}

@router.post("/{branch_id}/entries", status_code=201)
async def add_entry(branch_id: str, data: CashEntryCreate, db: AsyncSession = Depends(get_db)):
    today = datetime.now().strftime("%Y-%m-%d")
    entry = CashEntry(
        id=str(uuid.uuid4()), branch_id=branch_id, type=data.type,
        category=data.category, description=data.description, amount=data.amount,
        ref=data.ref, date=data.date or today,
        time=datetime.now().strftime("%H:%M"), by=data.by,
    )
    db.add(entry)
    await db.commit()
    return {"id": entry.id, "message": "Entry recorded"}

@router.post("/{branch_id}/close")
async def close_day(branch_id: str, data: DayCloseRequest, db: AsyncSession = Depends(get_db)):
    return {"message": f"Day closed for branch {branch_id}", "physical_count": data.physical_count,
            "closed_by": data.closed_by, "timestamp": datetime.now().isoformat()}

def _e(e):
    return {"id": e.id, "branch_id": e.branch_id, "type": e.type, "category": e.category,
            "description": e.description, "amount": e.amount, "ref": e.ref,
            "date": e.date, "time": e.time, "by": e.by}

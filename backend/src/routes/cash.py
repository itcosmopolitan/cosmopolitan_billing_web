"""Cash Control — daily petty cash register, entries, and day-close reconciliation."""
from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import AuditLog, Branch, CashCategory, CashDayClose, CashEntry, Organisation, User
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._serializers import serialize_cash_day_close, serialize_cash_entry
from src.security import enforce_branch_access, current_user, require_perm

router = APIRouter()

# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class CashEntryCreate(BaseModel):
    type: str                          # 'in' | 'out'
    category: str
    description: str
    amount: float
    ref: Optional[str] = None
    date: Optional[str] = None
    by: Optional[str] = "Staff"

class CashEntryUpdate(BaseModel):
    description: Optional[str] = None
    category: Optional[str] = None
    amount: Optional[float] = None
    ref: Optional[str] = None

class VoidRequest(BaseModel):
    reason: str

class DayCloseRequest(BaseModel):
    date: Optional[str] = None
    physical_count: float
    variance_reason: Optional[str] = None
    notes: Optional[str] = None
    closed_by: str

class UnlockRequest(BaseModel):
    reason: str

class CashCategoryCreate(BaseModel):
    name: str
    direction: str   # in | out | both
    sort_order: int = 0

class CashCategoryUpdate(BaseModel):
    name: Optional[str] = None
    direction: Optional[str] = None
    active: Optional[bool] = None
    sort_order: Optional[int] = None


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _get_branch(db: AsyncSession, branch_id: str) -> Branch:
    branch = (await db.execute(select(Branch).where(Branch.id == branch_id))).scalar_one_or_none()
    if branch is None:
        raise HTTPException(404, f"Branch {branch_id} not found")
    return branch


async def _get_day_close(db: AsyncSession, branch_id: str, date: str) -> Optional[CashDayClose]:
    return (
        await db.execute(
            select(CashDayClose).where(
                CashDayClose.branch_id == branch_id,
                CashDayClose.date == date,
            )
        )
    ).scalar_one_or_none()


async def _opening_balance(db: AsyncSession, branch: Branch, date: str) -> float:
    """Return the opening balance for a given date at a branch.

    Logic:
      1. If branch.cash_opening_mode == 'fixed', return branch.cash_fixed_float.
      2. Check for a manually-entered 'Opening Balance' category entry for this
         date — lets cashiers record the drawer float on days with no prior close.
      3. Otherwise, carry forward the most recent CashDayClose.physical_count.
      4. If no prior close exists, return 0.
    """
    if branch.cash_opening_mode == "fixed":
        return float(branch.cash_fixed_float or 0)
    manual = (
        await db.execute(
            select(CashEntry)
            .where(
                CashEntry.branch_id == branch.id,
                CashEntry.date == date,
                CashEntry.category == "Opening Balance",
                CashEntry.type == "in",
                CashEntry.is_voided == False,
            )
            .order_by(CashEntry.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if manual:
        return float(manual.amount)
    prior = (
        await db.execute(
            select(CashDayClose)
            .where(CashDayClose.branch_id == branch.id, CashDayClose.date < date)
            .order_by(CashDayClose.date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return float(prior.physical_count) if prior else 0


async def _next_entry_number(db: AsyncSession, branch_id: str, date: str) -> str:
    date_tag = date.replace("-", "")[2:]
    prefix = f"CE-{date_tag}-"
    result = await db.execute(
        select(func.count(CashEntry.id))
        .where(CashEntry.branch_id == branch_id, CashEntry.date == date)
    )
    seq = (result.scalar() or 0) + 1
    return f"{prefix}{seq}"


def _build_summary(entries: list, opening: float, close: Optional[CashDayClose]) -> dict:
    active = [e for e in entries if not e.is_voided]
    cash_in = sum(e.amount for e in active if e.type == "in" and e.category != "Opening Balance")
    cash_out = sum(e.amount for e in active if e.type == "out")
    expected = opening + cash_in - cash_out
    breakdown_in = _breakdown(active, "in")
    breakdown_out = _breakdown(active, "out")
    return {
        "opening_balance": opening,
        "cash_in": cash_in,
        "cash_out": cash_out,
        "expected_balance": round(expected, 2),
        "physical_count": float(close.physical_count) if close else None,
        "variance": float(close.variance) if close else None,
        "breakdown_in": breakdown_in,
        "breakdown_out": breakdown_out,
    }


def _breakdown(entries: list, entry_type: str) -> list:
    totals: dict = defaultdict(float)
    for e in entries:
        if e.type == entry_type and e.category != "Opening Balance":
            totals[e.category or "Uncategorised"] += e.amount
    return [{"category": k, "amount": round(v, 2)} for k, v in sorted(totals.items(), key=lambda x: -x[1])]


# ─── Categories ───────────────────────────────────────────────────────────────

SYSTEM_CATEGORIES = [
    ("Sale — Cash",            "in",   True,  1),
    ("Sale Return — Refund",   "out",  True,  2),
    ("Purchase — Cash Payment","out",  True,  3),
    ("Vendor Advance — Cash",  "out",  True,  4),
    ("Opening Balance",        "in",   True,  5),
    ("Bank to Cash (Top-up)",  "in",   True,  6),
    ("Cash to Bank (Deposit)", "out",  True,  7),
    ("Petty Cash Expense",     "out",  True,  8),
    ("Salary / Wages (Cash)",  "out",  True,  9),
    ("Miscellaneous In",       "in",   True, 10),
    ("Miscellaneous Out",      "out",  True, 11),
]


async def _ensure_categories(db: AsyncSession, org_id: str) -> None:
    """Seed system categories for an org if they don't exist yet."""
    existing = (
        await db.execute(
            select(CashCategory.name).where(
                CashCategory.org_id == org_id, CashCategory.is_system == True
            )
        )
    ).scalars().all()
    existing_names = set(existing)
    for name, direction, is_system, order in SYSTEM_CATEGORIES:
        if name not in existing_names:
            db.add(CashCategory(
                id=str(uuid.uuid4()),
                org_id=org_id,
                name=name,
                direction=direction,
                is_system=is_system,
                sort_order=order,
            ))


@router.get("/categories", dependencies=[Depends(require_perm("settings.view"))])
async def list_categories(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(current_user),
):
    # Resolve org_id from the first org (single-org assumption)
    org = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    if org:
        await _ensure_categories(db, org.id)
        await db.commit()
    q = select(CashCategory).order_by(CashCategory.sort_order, CashCategory.name)
    if org:
        q = q.where(CashCategory.org_id == org.id)
    rows = (await db.execute(q)).scalars().all()
    return [
        {"id": c.id, "name": c.name, "direction": c.direction,
         "is_system": c.is_system, "active": c.active, "sort_order": c.sort_order}
        for c in rows
    ]


@router.post("/categories", dependencies=[Depends(require_perm("settings.edit"))], status_code=201)
async def create_category(
    data: CashCategoryCreate,
    db: AsyncSession = Depends(get_db),
):
    org = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    if not org:
        raise HTTPException(400, "Organisation not configured")
    cat = CashCategory(
        id=str(uuid.uuid4()), org_id=org.id,
        name=data.name, direction=data.direction,
        is_system=False, sort_order=data.sort_order,
    )
    db.add(cat)
    await db.commit()
    return {"id": cat.id, "message": "Category created"}


@router.put("/categories/{cat_id}", dependencies=[Depends(require_perm("settings.edit"))])
async def update_category(
    cat_id: str,
    data: CashCategoryUpdate,
    db: AsyncSession = Depends(get_db),
):
    cat = (await db.execute(select(CashCategory).where(CashCategory.id == cat_id))).scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")
    if cat.is_system and (data.name or data.direction):
        raise HTTPException(400, "System categories cannot be renamed or redirected")
    if data.name is not None:
        cat.name = data.name
    if data.direction is not None:
        cat.direction = data.direction
    if data.active is not None:
        cat.active = data.active
    if data.sort_order is not None:
        cat.sort_order = data.sort_order
    await db.commit()
    return {"message": "Category updated"}


@router.delete("/categories/{cat_id}", dependencies=[Depends(require_perm("settings.edit"))])
async def delete_category(cat_id: str, db: AsyncSession = Depends(get_db)):
    cat = (await db.execute(select(CashCategory).where(CashCategory.id == cat_id))).scalar_one_or_none()
    if not cat:
        raise HTTPException(404, "Category not found")
    if cat.is_system:
        raise HTTPException(400, "System categories cannot be deleted")
    await db.delete(cat)
    await db.commit()
    return {"message": "Category deleted"}


# ─── Entries ──────────────────────────────────────────────────────────────────

@router.get("/{branch_id}/entries", dependencies=[Depends(require_perm("cash.view"))])
async def get_entries(
    branch_id: str = Depends(enforce_branch_access),
    date: Optional[str] = None,
    type: Optional[str] = None,
    category: Optional[str] = None,
    source_type: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    target_date = date or datetime.now().strftime("%Y-%m-%d")
    q = select(CashEntry).where(CashEntry.branch_id == branch_id, CashEntry.date == target_date)
    cq = select(func.count(CashEntry.id)).where(CashEntry.branch_id == branch_id, CashEntry.date == target_date)
    if type:
        q = q.where(CashEntry.type == type)
        cq = cq.where(CashEntry.type == type)
    if category:
        q = q.where(CashEntry.category == category)
        cq = cq.where(CashEntry.category == category)
    if source_type:
        q = q.where(CashEntry.source_type == source_type)
        cq = cq.where(CashEntry.source_type == source_type)
    sort_expr = resolve_sort(
        sort_by, sort_order,
        {"date": CashEntry.date, "type": CashEntry.type, "amount": CashEntry.amount,
         "category": CashEntry.category, "created_at": CashEntry.created_at},
        default_key="created_at", default_order="asc",
    )
    q = q.order_by(sort_expr)
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(cq)).scalar() or 0)
    entries = (await db.execute(q.offset(sk).limit(lim))).scalars().all()
    close = await _get_day_close(db, branch_id, target_date)
    return {
        **paged([serialize_cash_entry(e) for e in entries], total, sk, lim),
        "day_status": "closed" if (close and close.is_locked) else "open",
        "date": target_date,
    }


@router.post("/{branch_id}/entries", status_code=201, dependencies=[Depends(require_perm("cash.entry"))])
async def add_entry(
    data: CashEntryCreate,
    branch_id: str = Depends(enforce_branch_access),
    current_user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    target_date = data.date or datetime.now().strftime("%Y-%m-%d")
    close = await _get_day_close(db, branch_id, target_date)
    if close and close.is_locked:
        raise HTTPException(409, "Day is locked. Contact an admin to unlock.")
    if data.amount <= 0:
        raise HTTPException(400, "Amount must be greater than zero")
    if not data.description or len(data.description.strip()) < 3:
        raise HTTPException(400, "Description must be at least 3 characters")
    entry_number = await _next_entry_number(db, branch_id, target_date)
    entry = CashEntry(
        id=str(uuid.uuid4()),
        branch_id=branch_id,
        type=data.type,
        category=data.category,
        description=data.description,
        amount=data.amount,
        ref=data.ref,
        date=target_date,
        time=datetime.now().strftime("%H:%M"),
        by=data.by or current_user.name,
        entry_number=entry_number,
        source_type="manual",
        is_system=False,
    )
    db.add(entry)
    await db.commit()
    return serialize_cash_entry(entry)


@router.patch("/{branch_id}/entries/{entry_id}", dependencies=[Depends(require_perm("cash.edit"))])
async def update_entry(
    entry_id: str,
    data: CashEntryUpdate,
    branch_id: str = Depends(enforce_branch_access),
    db: AsyncSession = Depends(get_db),
):
    entry = (await db.execute(select(CashEntry).where(CashEntry.id == entry_id, CashEntry.branch_id == branch_id))).scalar_one_or_none()
    if not entry:
        raise HTTPException(404, "Entry not found")
    if entry.is_system:
        raise HTTPException(400, "System entries cannot be edited — use void instead")
    close = await _get_day_close(db, branch_id, entry.date)
    if close and close.is_locked:
        raise HTTPException(409, "Day is locked. Contact an admin to unlock.")
    if data.description is not None:
        entry.description = data.description
    if data.category is not None:
        entry.category = data.category
    if data.amount is not None:
        if data.amount <= 0:
            raise HTTPException(400, "Amount must be greater than zero")
        entry.amount = data.amount
    if data.ref is not None:
        entry.ref = data.ref
    await db.commit()
    return serialize_cash_entry(entry)


@router.delete("/{branch_id}/entries/{entry_id}", dependencies=[Depends(require_perm("cash.edit"))])
async def delete_entry(
    entry_id: str,
    branch_id: str = Depends(enforce_branch_access),
    db: AsyncSession = Depends(get_db),
):
    entry = (await db.execute(select(CashEntry).where(CashEntry.id == entry_id, CashEntry.branch_id == branch_id))).scalar_one_or_none()
    if not entry:
        raise HTTPException(404, "Entry not found")
    if entry.is_system:
        raise HTTPException(400, "System entries cannot be deleted — use void instead")
    if entry.is_voided:
        raise HTTPException(400, "Entry is already voided")
    close = await _get_day_close(db, branch_id, entry.date)
    if close and close.is_locked:
        raise HTTPException(409, "Day is locked. Contact an admin to unlock.")
    await db.delete(entry)
    await db.commit()
    return {"message": "Entry deleted"}


@router.post("/{branch_id}/entries/{entry_id}/void", dependencies=[Depends(require_perm("cash.edit"))])
async def void_entry(
    entry_id: str,
    data: VoidRequest,
    branch_id: str = Depends(enforce_branch_access),
    current_user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = (await db.execute(select(CashEntry).where(CashEntry.id == entry_id, CashEntry.branch_id == branch_id))).scalar_one_or_none()
    if not entry:
        raise HTTPException(404, "Entry not found")
    if entry.is_voided:
        raise HTTPException(400, "Entry is already voided")
    close = await _get_day_close(db, branch_id, entry.date)
    if close and close.is_locked:
        raise HTTPException(409, "Day is locked. Contact an admin to unlock.")
    now = datetime.now()
    entry.is_voided = True
    entry.voided_at = now
    entry.voided_by = current_user.name
    entry.void_reason = data.reason
    reversal_type = "out" if entry.type == "in" else "in"
    entry_number = await _next_entry_number(db, branch_id, entry.date)
    reversal = CashEntry(
        id=str(uuid.uuid4()),
        branch_id=branch_id,
        type=reversal_type,
        category=entry.category,
        description=f"Void: {entry.entry_number or entry.id}",
        amount=entry.amount,
        ref=entry.ref,
        date=entry.date,
        time=now.strftime("%H:%M"),
        by=current_user.name,
        entry_number=entry_number,
        source_type="void",
        source_id=entry.id,
        is_system=True,
    )
    db.add(reversal)
    await db.commit()
    return {"message": "Entry voided", "reversal_id": reversal.id}


# ─── Summary ──────────────────────────────────────────────────────────────────

@router.get("/{branch_id}/summary", dependencies=[Depends(require_perm("cash.view"))])
async def get_summary(
    branch_id: str = Depends(enforce_branch_access),
    date: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    target_date = date or datetime.now().strftime("%Y-%m-%d")
    branch = await _get_branch(db, branch_id)
    entries = (await db.execute(
        select(CashEntry).where(CashEntry.branch_id == branch_id, CashEntry.date == target_date)
    )).scalars().all()
    opening = await _opening_balance(db, branch, target_date)
    close = await _get_day_close(db, branch_id, target_date)
    summary = _build_summary(entries, opening, close)
    return {
        "date": target_date,
        "day_status": "closed" if (close and close.is_locked) else "open",
        "close_details": serialize_cash_day_close(close) if close else None,
        **summary,
        # Legacy fields kept for backwards compat with existing frontend
        "opening": opening,
        "cash_in": summary["cash_in"],
        "cash_out": summary["cash_out"],
        "expected": summary["expected_balance"],
        "actual": float(close.physical_count) if close else summary["expected_balance"],
        "variance": float(close.variance) if close else 0,
    }


# ─── Day Close ────────────────────────────────────────────────────────────────

@router.post("/{branch_id}/close", dependencies=[Depends(require_perm("cash.close"))])
async def close_day(
    data: DayCloseRequest,
    branch_id: str = Depends(enforce_branch_access),
    current_user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    target_date = data.date or datetime.now().strftime("%Y-%m-%d")
    existing = await _get_day_close(db, branch_id, target_date)
    if existing and existing.is_locked:
        raise HTTPException(409, "Day is already closed. Use unlock to re-open.")
    branch = await _get_branch(db, branch_id)
    entries = (await db.execute(
        select(CashEntry).where(CashEntry.branch_id == branch_id, CashEntry.date == target_date)
    )).scalars().all()
    opening = await _opening_balance(db, branch, target_date)
    summary = _build_summary(entries, opening, None)
    expected = summary["expected_balance"]
    variance = round(data.physical_count - expected, 2)
    threshold = float(branch.cash_variance_threshold or 500)
    if abs(variance) > threshold and not (data.variance_reason or "").strip():
        raise HTTPException(
            400,
            f"Variance of MVR{abs(variance):.2f} exceeds threshold MVR{threshold:.2f}. Please provide a variance_reason."
        )
    if existing:
        # Re-closing an unlocked day — update in place
        existing.physical_count = data.physical_count
        existing.variance = variance
        existing.variance_reason = data.variance_reason
        existing.notes = data.notes
        existing.closed_by = data.closed_by
        existing.closed_by_id = current_user.id
        existing.closed_at = datetime.now()
        existing.is_locked = True
        existing.opening_balance = opening
        existing.total_cash_in = summary["cash_in"]
        existing.total_cash_out = summary["cash_out"]
        existing.expected_balance = expected
        close = existing
    else:
        close = CashDayClose(
            id=str(uuid.uuid4()),
            branch_id=branch_id,
            date=target_date,
            opening_balance=opening,
            total_cash_in=summary["cash_in"],
            total_cash_out=summary["cash_out"],
            expected_balance=expected,
            physical_count=data.physical_count,
            variance=variance,
            variance_reason=data.variance_reason,
            notes=data.notes,
            closed_by=data.closed_by,
            closed_by_id=current_user.id,
            is_locked=True,
        )
        db.add(close)
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        action="close_day",
        user_id=current_user.id,
        user_name=current_user.name,
        module="cash",
        ref=f"{branch_id}:{target_date}",
        detail=f"Day closed. Physical={data.physical_count}, Variance={variance}",
        risk="low",
    ))
    await db.commit()
    return {
        **serialize_cash_day_close(close),
        "message": f"Day closed. Opening balance for next day: MVR{data.physical_count:,.2f}",
    }


# ─── Admin Unlock ─────────────────────────────────────────────────────────────

@router.post("/{branch_id}/close/{close_id}/unlock", dependencies=[Depends(require_perm("cash.unlock"))])
async def unlock_day(
    close_id: str,
    data: UnlockRequest,
    branch_id: str = Depends(enforce_branch_access),
    current_user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    close = (await db.execute(select(CashDayClose).where(CashDayClose.id == close_id, CashDayClose.branch_id == branch_id))).scalar_one_or_none()
    if not close:
        raise HTTPException(404, "Day close record not found")
    if not close.is_locked:
        raise HTTPException(400, "Day is already unlocked")
    close.is_locked = False
    close.unlocked_by = current_user.name
    close.unlocked_at = datetime.now()
    close.unlock_reason = data.reason
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        action="unlock_day",
        user_id=current_user.id,
        user_name=current_user.name,
        module="cash",
        ref=f"{branch_id}:{close.date}",
        detail=f"Day unlocked. Reason: {data.reason}",
        risk="high",
    ))
    await db.commit()
    return {"message": "Day unlocked", "close": serialize_cash_day_close(close)}


# ─── History ──────────────────────────────────────────────────────────────────

@router.get("/{branch_id}/history", dependencies=[Depends(require_perm("cash.view"))])
async def get_history(
    branch_id: str = Depends(enforce_branch_access),
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(30, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    q = select(CashDayClose).where(CashDayClose.branch_id == branch_id)
    cq = select(func.count(CashDayClose.id)).where(CashDayClose.branch_id == branch_id)
    if from_date:
        q = q.where(CashDayClose.date >= from_date)
        cq = cq.where(CashDayClose.date >= from_date)
    if to_date:
        q = q.where(CashDayClose.date <= to_date)
        cq = cq.where(CashDayClose.date <= to_date)
    q = q.order_by(CashDayClose.date.desc())
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    total = int((await db.execute(cq)).scalar() or 0)
    closes = (await db.execute(q.offset(sk).limit(lim))).scalars().all()
    return paged([serialize_cash_day_close(c) for c in closes], total, sk, lim)


@router.get("/{branch_id}/history/{date}", dependencies=[Depends(require_perm("cash.view"))])
async def get_history_day(
    date: str,
    branch_id: str = Depends(enforce_branch_access),
    db: AsyncSession = Depends(get_db),
):
    branch = await _get_branch(db, branch_id)
    close = await _get_day_close(db, branch_id, date)
    entries = (await db.execute(
        select(CashEntry).where(CashEntry.branch_id == branch_id, CashEntry.date == date)
        .order_by(CashEntry.created_at)
    )).scalars().all()
    opening = await _opening_balance(db, branch, date)
    summary = _build_summary(entries, opening, close)
    return {
        "date": date,
        "close": serialize_cash_day_close(close) if close else None,
        "entries": [serialize_cash_entry(e) for e in entries],
        "summary": summary,
    }


# ─── Branch Monitor (admin / manager multi-branch view) ───────────────────────

@router.get("/monitor", dependencies=[Depends(require_perm("cash.monitor"))])
async def monitor(
    date: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(current_user),
):
    target_date = date or datetime.now().strftime("%Y-%m-%d")
    branches_q = select(Branch).where(Branch.active == True)
    # Non-superusers are restricted to their assigned branches
    if not current_user.all_branches:
        from src.models import UserBranch
        branch_ids = (await db.execute(
            select(UserBranch.branch_id).where(UserBranch.user_id == current_user.id)
        )).scalars().all()
        branches_q = branches_q.where(Branch.id.in_(branch_ids))
    branches = (await db.execute(branches_q)).scalars().all()

    result_items = []
    total_branches = len(branches)
    closed_count = open_count = not_started_count = variance_count = 0

    for branch in branches:
        entries = (await db.execute(
            select(CashEntry).where(CashEntry.branch_id == branch.id, CashEntry.date == target_date)
        )).scalars().all()
        close = await _get_day_close(db, branch.id, target_date)
        opening = await _opening_balance(db, branch, target_date)
        summary = _build_summary(entries, opening, close)

        if close and close.is_locked:
            day_status = "closed"
            closed_count += 1
        elif entries:
            day_status = "open"
            open_count += 1
        else:
            day_status = "not_started"
            not_started_count += 1

        variance = float(close.variance) if close else None
        threshold = float(branch.cash_variance_threshold or 500)
        if variance is not None and abs(variance) > 0:
            variance_count += 1

        if variance is None:
            variance_flag = "ok"
        elif abs(variance) == 0:
            variance_flag = "ok"
        elif abs(variance) <= threshold:
            variance_flag = "amber"
        else:
            variance_flag = "red"

        result_items.append({
            "branch_id": branch.id,
            "branch_name": branch.name,
            "day_status": day_status,
            "opening_balance": opening,
            "cash_in": summary["cash_in"],
            "cash_out": summary["cash_out"],
            "expected_balance": summary["expected_balance"],
            "physical_count": float(close.physical_count) if close else None,
            "variance": variance,
            "variance_flag": variance_flag,
            "entry_count": len(entries),
            "closed_by": close.closed_by if close else None,
            "closed_at": close.closed_at.isoformat() if close and close.closed_at else None,
        })

    return {
        "date": target_date,
        "branches": result_items,
        "summary": {
            "total_branches": total_branches,
            "closed_count": closed_count,
            "open_count": open_count,
            "not_started_count": not_started_count,
            "branches_with_variance": variance_count,
        },
    }

"""Complimentary / sample issues.

Stock given away free. Stored in its own tables so it never appears in
sale_invoices or any sales, tax, revenue or customer report. Stock still
leaves inventory through the stock ledger under movement_type
"complimentary" (reversed as "complimentary_reversal" on delete).
"""
import json
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.document_numbering import allocate_number, resolve_number
from src.models import (
    Branch,
    ComplimentaryEntry,
    ComplimentaryLineItem,
    ComplimentaryReason,
    Customer,
    Item,
    User,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.permissions import SALES_DOCUMENT_READ
from src.qty import as_qty
from src.routes._approval import can_direct_commit
from src.routes._child_counters import validate_child_counter
from src.routes._stock_ledger import get_allow_overselling
from src.routes.sales import (
    BatchAllocationEntry,
    LineItemIn,
    _coerce_qty_value,
    _consume_sale_line_stock,
    _load_items_by_id,
    _resolve_branch_scope,
    _resolve_item_transfer_cost,
    _restock_invoice_lines,
)
from src.security import current_user, enforce_branch_access_optional, get_allowed_branch_ids, require_perm
from src.services.audit_service import add_audit_log

router = APIRouter()

COMPLIMENTARY_REASONS = ("Complimentary", "Sample")
STOCK_MOVEMENT_TYPE = "complimentary"
STOCK_REVERSAL_MOVEMENT_TYPE = "complimentary_reversal"
STOCK_SOURCE_TYPE = "complimentary_entry"
COMPLIMENTARY_APPROVE_PERM = "complimentary.approve"
STATUS_DRAFT = "draft"
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"


class ComplimentaryLineIn(BaseModel):
    item_id: str
    qty: float = Field(..., gt=0)
    unit: Optional[str] = None
    packaging: Optional[str] = None
    batch_allocation: Optional[List[BatchAllocationEntry]] = None
    batch_id: Optional[str] = None

    @field_validator("qty", mode="before")
    @classmethod
    def _coerce_qty(cls, value):
        return _coerce_qty_value(value, field_name="qty")


class ComplimentaryReject(BaseModel):
    rejection_notes: Optional[str] = Field(None, max_length=1000)


def _actor_name(user: User) -> str:
    return getattr(user, "name", None) or getattr(user, "username", None) or "Staff"


def _dump_requested_allocation(allocation: Optional[List[BatchAllocationEntry]]) -> Optional[str]:
    if not allocation:
        return None
    return json.dumps([entry.model_dump() for entry in allocation])


def _load_requested_allocation(raw: Optional[str]) -> Optional[List[BatchAllocationEntry]]:
    if not raw:
        return None
    try:
        rows = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return [BatchAllocationEntry(**row) for row in rows] or None


async def _load_entry(db: AsyncSession, entry_id: str, *, lock: bool = False) -> ComplimentaryEntry:
    q = (
        select(ComplimentaryEntry)
        .options(selectinload(ComplimentaryEntry.line_items))
        .where(ComplimentaryEntry.id == entry_id)
    )
    if lock:
        q = q.with_for_update()
    entry = (await db.execute(q)).scalar_one_or_none()
    if entry is None:
        raise HTTPException(404, "Complimentary entry not found")
    return entry


def _clean_reason(value: str) -> str:
    reason = value.strip()
    if not reason:
        raise ValueError("Reason cannot be empty")
    return reason


def _merge_reasons(custom: List[str]) -> List[str]:
    """Built-in reasons first, then custom ones; case-insensitive de-duplication."""
    merged: List[str] = []
    seen = set()
    for reason in [*COMPLIMENTARY_REASONS, *custom]:
        key = reason.strip().lower()
        if key and key not in seen:
            seen.add(key)
            merged.append(reason)
    return merged


class ComplimentaryReasonCreate(BaseModel):
    branch_id: str
    reason: str = Field(..., min_length=1, max_length=100)

    @field_validator("reason")
    @classmethod
    def _clean_reason_value(cls, value: str) -> str:
        return _clean_reason(value)


class ComplimentaryCreate(BaseModel):
    number: Optional[str] = None
    reason: str = Field(..., min_length=1, max_length=100)
    branch_id: str
    child_counter_id: Optional[str] = None
    child_counter_name: Optional[str] = None
    customer_id: Optional[str] = None
    date: Optional[str] = None
    notes: Optional[str] = None
    items: List[ComplimentaryLineIn]

    @field_validator("reason")
    @classmethod
    def _clean_reason_value(cls, value: str) -> str:
        return _clean_reason(value)


def _line_dict(li: ComplimentaryLineItem, item: Optional[Item] = None) -> dict:
    lots = []
    if li.batch_allocation:
        try:
            lots = json.loads(li.batch_allocation)
        except (ValueError, TypeError):
            lots = []
    return {
        "id": li.id,
        "item_id": li.item_id,
        "name": li.name,
        "unit": li.unit or "",
        "qty": li.qty,
        "cost_price": round(float(li.cost_price or 0), 2),
        "cost_total": round(float(li.cost_total or 0), 2),
        "lots": lots,
        # Saved line value wins; item master is the fallback for older entries.
        "packaging": (li.packaging if li.packaging is not None else (item.packaging if item else None)) or "",
        "packing": item.packaging_quantity if item else None,
    }


def _entry_dict(entry: ComplimentaryEntry, line_items=None, item_map=None) -> dict:
    lines = line_items if line_items is not None else entry.line_items
    item_map = item_map or {}
    return {
        "id": entry.id,
        "number": entry.number,
        "reason": entry.reason,
        "customer_id": entry.customer_id,
        "customer_name": entry.customer_name or "Walk-in",
        "branch_id": entry.branch_id,
        "branch_name": entry.branch_name,
        "child_counter_id": entry.child_counter_id,
        "child_counter_name": entry.child_counter_name,
        "created_by": entry.created_by,
        "date": entry.date,
        "notes": entry.notes or "",
        "status": entry.status or STATUS_APPROVED,
        "requested_by": entry.requested_by,
        "approved_by": entry.approved_by,
        "rejected_by": entry.rejected_by,
        "rejection_notes": entry.rejection_notes or "",
        "resolved_at": entry.resolved_at.isoformat() if entry.resolved_at else None,
        "line_count": len(lines),
        "total_qty": round(sum(float(li.qty or 0) for li in lines), 4),
        "cost_value": round(float(entry.total_cost or 0), 2),
        # Complimentary and sample entries carry no taxable value by design.
        "taxable_amount": 0.0,
        "total": 0.0,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "items": [_line_dict(li, item_map.get(li.item_id)) for li in lines],
    }


@router.post("/", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_complimentary(
    data: ComplimentaryCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Issue complimentary or sample stock.

    Users who can approve complimentary issues deduct stock on save. Everyone
    else saves a private draft; stock moves only when an approver approves it.
    """
    if not data.items:
        raise HTTPException(400, "Add at least one item")

    await _resolve_branch_scope(user, db, data.branch_id)
    branch = (await db.execute(select(Branch).where(Branch.id == data.branch_id))).scalar_one_or_none()
    if branch is None:
        raise HTTPException(400, "Branch not found")
    child_counter_id, child_counter_name = await validate_child_counter(
        db, branch.id, data.child_counter_id, data.child_counter_name,
    )

    customer = None
    if data.customer_id:
        customer = (await db.execute(select(Customer).where(Customer.id == data.customer_id))).scalar_one_or_none()
        if customer is None:
            raise HTTPException(400, "Customer not found")

    number = await resolve_number(
        db,
        requested=data.number,
        model=ComplimentaryEntry,
        allocate=lambda: allocate_number(db, "complimentary", branch_id=data.branch_id),
    )

    direct = await can_direct_commit(user, db, COMPLIMENTARY_APPROVE_PERM)
    item_map = await _load_items_by_id(db, {line.item_id for line in data.items})
    allow_oversell = await get_allow_overselling(db, data.branch_id)

    entry = ComplimentaryEntry(
        id=str(uuid.uuid4()),
        number=number,
        reason=data.reason,
        customer_id=customer.id if customer else None,
        customer_name=customer.name if customer else "Walk-in",
        branch_id=branch.id,
        branch_name=branch.name,
        child_counter_id=child_counter_id,
        child_counter_name=child_counter_name,
        created_by=getattr(user, "username", None) or getattr(user, "name", None),
        date=data.date or datetime.now().strftime("%Y-%m-%d"),
        notes=data.notes,
        total_cost=0,
        status=STATUS_APPROVED if direct else STATUS_DRAFT,
        requested_by=_actor_name(user),
        approved_by=_actor_name(user) if direct else None,
        resolved_at=datetime.utcnow() if direct else None,
    )
    db.add(entry)
    await db.flush()

    total_cost = 0.0
    for line in data.items:
        item = item_map.get(line.item_id)
        if item is None:
            raise HTTPException(400, f"Item not found: {line.item_id}")
        cost = await _resolve_item_transfer_cost(db, item.id, branch.id)
        qty = as_qty(line.qty)
        li = ComplimentaryLineItem(
            id=str(uuid.uuid4()),
            entry_id=entry.id,
            item_id=item.id,
            name=item.name,
            unit=line.unit if line.unit is not None else (item.unit or ""),
            packaging=line.packaging,
            qty=qty,
            cost_price=round(cost, 2),
            cost_total=round(cost * qty, 2),
            preferred_batch_id=line.batch_id,
            requested_allocation=_dump_requested_allocation(line.batch_allocation),
        )
        db.add(li)
        total_cost += cost * qty

        if direct:
            await _consume_sale_line_stock(
                db,
                item=LineItemIn(
                    item_id=item.id,
                    name=item.name,
                    qty=line.qty,
                    price=cost,
                    batch_allocation=line.batch_allocation,
                    batch_id=line.batch_id,
                ),
                li=li,
                branch_id=branch.id,
                invoice_id=entry.id,
                invoice_number=entry.number,
                allow_oversell=allow_oversell,
                movement_type=STOCK_MOVEMENT_TYPE,
                source_type=STOCK_SOURCE_TYPE,
            )

    entry.total_cost = round(total_cost, 2)
    add_audit_log(
        db,
        action="create_complimentary",
        module="Sales",
        reference_id=entry.number,
        detail=(
            f"Issued {entry.reason.lower()} stock {entry.number} ({len(data.items)} lines)"
            if direct
            else f"Saved {entry.reason.lower()} draft {entry.number} ({len(data.items)} lines)"
        ),
        user=user,
        request=request,
        branch_id=branch.id,
        metadata={
            "reason": entry.reason,
            "cost_value": entry.total_cost,
            "line_count": len(data.items),
            "status": entry.status,
        },
    )
    await db.commit()
    await db.refresh(entry)
    return {
        "id": entry.id,
        "number": entry.number,
        "reason": entry.reason,
        "cost_value": entry.total_cost,
        "status": entry.status,
    }


@router.get("/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_complimentary(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    reason: Optional[str] = None,
    status: Optional[str] = None,
    child_counter_id: Optional[str] = None,
    search: Optional[str] = None,
    customer_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = []
    if reason:
        conds.append(ComplimentaryEntry.reason == reason)
    if status:
        conds.append(ComplimentaryEntry.status == status)
    if child_counter_id:
        conds.append(ComplimentaryEntry.child_counter_id == child_counter_id)
    if customer_id:
        conds.append(ComplimentaryEntry.customer_id == customer_id)
    if search:
        conds.append(or_(
            ComplimentaryEntry.number.ilike(f"%{search}%"),
            ComplimentaryEntry.customer_name.ilike(f"%{search}%"),
        ))
    if date_from:
        conds.append(ComplimentaryEntry.date >= date_from)
    if date_to:
        conds.append(ComplimentaryEntry.date <= date_to)
    if branch_id:
        conds.append(ComplimentaryEntry.branch_id == branch_id)
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, sk, lim)
        conds.append(ComplimentaryEntry.branch_id.in_(branch_ids))

    q = select(ComplimentaryEntry).options(selectinload(ComplimentaryEntry.line_items))
    q_count = select(func.count(ComplimentaryEntry.id))
    if conds:
        q = q.where(*conds)
        q_count = q_count.where(*conds)
    total = int((await db.execute(q_count)).scalar() or 0)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "number": ComplimentaryEntry.number,
            "customer_name": ComplimentaryEntry.customer_name,
            "branch_id": ComplimentaryEntry.branch_id,
            "date": ComplimentaryEntry.date,
            "reason": ComplimentaryEntry.reason,
            "cashier": ComplimentaryEntry.created_by,
            "total": ComplimentaryEntry.total_cost,
            "created_at": ComplimentaryEntry.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    result = await db.execute(
        q.order_by(sort_expr, ComplimentaryEntry.id.desc()).offset(sk).limit(lim)
    )
    entries = result.scalars().all()
    return paged([_entry_dict(e) for e in entries], total, sk, lim)


@router.get("/reasons", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_complimentary_reasons(
    branch_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Built-in and branch-saved complimentary reasons for the Reason dropdown."""
    await _resolve_branch_scope(user, db, branch_id)
    custom = (
        await db.execute(
            select(ComplimentaryReason.reason)
            .where(ComplimentaryReason.branch_id == branch_id)
            .order_by(ComplimentaryReason.created_at)
        )
    ).scalars().all()
    return {"reasons": _merge_reasons(list(custom))}


@router.post("/reasons", status_code=201, dependencies=[Depends(require_perm("invoices.create"))])
async def create_complimentary_reason(
    data: ComplimentaryReasonCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Save a custom complimentary reason for a branch."""
    await _resolve_branch_scope(user, db, data.branch_id)
    reason = data.reason
    if reason.lower() in {r.lower() for r in COMPLIMENTARY_REASONS}:
        raise HTTPException(400, "This complimentary reason already exists")

    existing = (
        await db.execute(
            select(ComplimentaryReason).where(
                ComplimentaryReason.branch_id == data.branch_id,
                func.lower(ComplimentaryReason.reason) == func.lower(reason),
            )
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "This complimentary reason already exists for this branch")

    row = ComplimentaryReason(id=str(uuid.uuid4()), branch_id=data.branch_id, reason=reason)
    db.add(row)
    add_audit_log(
        db,
        action="Complimentary reason added",
        module="Sales",
        reference_id=row.id,
        detail=f"Added complimentary reason: {reason}",
        user=user,
        request=request,
        branch_id=data.branch_id,
        metadata={"reason": reason},
    )
    await db.commit()
    return {"id": row.id, "reason": reason}


@router.delete("/reasons", dependencies=[Depends(require_perm("invoices.create"))])
async def delete_complimentary_reason(
    request: Request,
    branch_id: str = Query(...),
    reason: str = Query(..., min_length=1, max_length=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Remove a custom complimentary reason from a branch. Built-in reasons cannot be removed."""
    await _resolve_branch_scope(user, db, branch_id)
    name = reason.strip()
    if name.lower() in {r.lower() for r in COMPLIMENTARY_REASONS}:
        raise HTTPException(400, "Built-in complimentary reasons cannot be deleted")

    row = (
        await db.execute(
            select(ComplimentaryReason).where(
                ComplimentaryReason.branch_id == branch_id,
                func.lower(ComplimentaryReason.reason) == func.lower(name),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Complimentary reason not found")

    deleted_name = row.reason
    await db.delete(row)
    add_audit_log(
        db,
        action="Complimentary reason deleted",
        module="Sales",
        reference_id=row.id,
        detail=f"Deleted complimentary reason: {deleted_name}",
        user=user,
        request=request,
        branch_id=branch_id,
        metadata={"reason": deleted_name},
    )
    await db.commit()
    return {"message": "Reason deleted"}


@router.get("/{entry_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_complimentary(
    entry_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    entry = await _load_entry(db, entry_id)
    await _resolve_branch_scope(user, db, entry.branch_id)
    item_map = await _load_items_by_id(db, {li.item_id for li in entry.line_items})
    return _entry_dict(entry, item_map=item_map)


@router.delete("/{entry_id}", dependencies=[Depends(require_perm("invoices.delete"))])
async def delete_complimentary(
    entry_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Delete an entry. Only approved entries have stock out, so only they are restocked."""
    entry = await _load_entry(db, entry_id, lock=True)
    await _resolve_branch_scope(user, db, entry.branch_id)

    restored = 0
    if entry.status == STATUS_APPROVED:
        restored = await _restock_invoice_lines(
            db,
            entry,
            entry.line_items,
            reversal_movement_type=STOCK_REVERSAL_MOVEMENT_TYPE,
            source_type=STOCK_SOURCE_TYPE,
        )
    number = entry.number
    branch_id = entry.branch_id
    was_pending = entry.status == STATUS_PENDING
    entry_id_value = entry.id
    await db.delete(entry)
    if was_pending:
        from src.notifications.store import resolve_notification

        await resolve_notification(db, f"approval.complimentary_pending:{entry_id_value}")
    add_audit_log(
        db,
        action="delete_complimentary",
        module="Sales",
        reference_id=number,
        detail=f"Deleted complimentary entry {number}; restored {restored} units",
        user=user,
        request=request,
        branch_id=branch_id,
        metadata={"restored_qty": restored},
    )
    await db.commit()
    from src.notifications.store import notify_refresh

    await notify_refresh()
    return {"ok": True, "number": number, "restored_qty": restored}


@router.post("/{entry_id}/submit", dependencies=[Depends(require_perm("invoices.create"))])
async def submit_complimentary(
    entry_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Creator sends a draft to the approvers. No stock moves yet."""
    entry = await _load_entry(db, entry_id, lock=True)
    await _resolve_branch_scope(user, db, entry.branch_id)
    if entry.status == STATUS_PENDING:
        return {"status": STATUS_PENDING, "number": entry.number, "already_processed": True}
    if entry.status != STATUS_DRAFT:
        raise HTTPException(400, f"Only draft entries can be submitted (status={entry.status})")
    actor = _actor_name(user)
    if entry.requested_by and entry.requested_by != actor and not await can_direct_commit(
        user, db, COMPLIMENTARY_APPROVE_PERM,
    ):
        raise HTTPException(403, "Only the creator can submit this draft for approval")

    entry.status = STATUS_PENDING
    from src.notifications.store import emit_complimentary_pending, notify_refresh

    await emit_complimentary_pending(db, entry)
    add_audit_log(
        db,
        action="submit_complimentary",
        module="Sales",
        reference_id=entry.number,
        detail=f"Complimentary entry {entry.number} submitted for approval",
        user=user,
        request=request,
        branch_id=entry.branch_id,
        metadata={"status": STATUS_PENDING},
    )
    await db.commit()
    await notify_refresh()
    return {"status": STATUS_PENDING, "number": entry.number}


@router.post("/{entry_id}/approve", dependencies=[Depends(require_perm(COMPLIMENTARY_APPROVE_PERM))])
async def approve_complimentary(
    entry_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Approver accepts a pending entry. Stock is deducted now, at current costs."""
    entry = await _load_entry(db, entry_id, lock=True)
    await _resolve_branch_scope(user, db, entry.branch_id)
    if entry.status == STATUS_APPROVED:
        return {"status": STATUS_APPROVED, "number": entry.number, "already_processed": True}
    if entry.status != STATUS_PENDING:
        raise HTTPException(400, f"Only pending entries can be approved (status={entry.status})")
    actor = _actor_name(user)
    if entry.requested_by and entry.requested_by == actor:
        raise HTTPException(403, "You cannot approve your own complimentary entry")

    item_map = await _load_items_by_id(db, {li.item_id for li in entry.line_items})
    allow_oversell = await get_allow_overselling(db, entry.branch_id)
    total_cost = 0.0
    for li in entry.line_items:
        item = item_map.get(li.item_id)
        if item is None:
            raise HTTPException(400, f"Item not found: {li.item_id}")
        cost = await _resolve_item_transfer_cost(db, item.id, entry.branch_id)
        qty = as_qty(li.qty)
        li.cost_price = round(cost, 2)
        li.cost_total = round(cost * qty, 2)
        total_cost += cost * qty

        await _consume_sale_line_stock(
            db,
            item=LineItemIn(
                item_id=item.id,
                name=item.name,
                qty=li.qty,
                price=cost,
                batch_allocation=_load_requested_allocation(li.requested_allocation),
                batch_id=li.preferred_batch_id,
            ),
            li=li,
            branch_id=entry.branch_id,
            invoice_id=entry.id,
            invoice_number=entry.number,
            allow_oversell=allow_oversell,
            movement_type=STOCK_MOVEMENT_TYPE,
            source_type=STOCK_SOURCE_TYPE,
        )

    entry.total_cost = round(total_cost, 2)
    entry.status = STATUS_APPROVED
    entry.approved_by = actor
    entry.resolved_at = datetime.utcnow()
    add_audit_log(
        db,
        action="approve_complimentary",
        module="Sales",
        reference_id=entry.number,
        detail=f"Complimentary entry {entry.number} approved by {actor}",
        user=user,
        request=request,
        branch_id=entry.branch_id,
        metadata={
            "status": STATUS_APPROVED,
            "requested_by": entry.requested_by,
            "cost_value": entry.total_cost,
        },
    )
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.complimentary_pending:{entry.id}")
    await db.commit()
    await notify_refresh()
    return {"status": STATUS_APPROVED, "number": entry.number, "approved_by": actor}


@router.post("/{entry_id}/reject", dependencies=[Depends(require_perm(COMPLIMENTARY_APPROVE_PERM))])
async def reject_complimentary(
    entry_id: str,
    request: Request,
    body: Optional[ComplimentaryReject] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Approver declines a pending entry. No stock moves."""
    entry = await _load_entry(db, entry_id, lock=True)
    await _resolve_branch_scope(user, db, entry.branch_id)
    if entry.status == STATUS_REJECTED:
        return {"status": STATUS_REJECTED, "number": entry.number, "already_processed": True}
    if entry.status != STATUS_PENDING:
        raise HTTPException(400, f"Only pending entries can be rejected (status={entry.status})")

    actor = _actor_name(user)
    notes = body.rejection_notes if body else None
    entry.status = STATUS_REJECTED
    entry.rejected_by = actor
    entry.rejection_notes = notes
    entry.resolved_at = datetime.utcnow()
    add_audit_log(
        db,
        action="reject_complimentary",
        module="Sales",
        reference_id=entry.number,
        detail=f"Complimentary entry {entry.number} rejected by {actor}",
        user=user,
        request=request,
        branch_id=entry.branch_id,
        metadata={
            "status": STATUS_REJECTED,
            "requested_by": entry.requested_by,
            "rejection_notes": notes,
        },
    )
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.complimentary_pending:{entry.id}")
    await db.commit()
    await notify_refresh()
    return {"status": STATUS_REJECTED, "number": entry.number, "rejected_by": actor}

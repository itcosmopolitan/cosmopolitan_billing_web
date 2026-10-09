"""Complimentary / sample issues.

Stock given away free. Stored in its own tables so it never appears in
sale_invoices or any sales, tax, revenue or customer report. Stock still
leaves inventory through the stock ledger under movement_type
"complimentary" (reversed as "complimentary_reversal" on delete).
"""
import json
import uuid
from datetime import datetime
from typing import List, Literal, Optional

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
    Customer,
    Item,
    User,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.permissions import SALES_DOCUMENT_READ
from src.qty import as_qty
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


class ComplimentaryLineIn(BaseModel):
    item_id: str
    qty: float = Field(..., gt=0)
    batch_allocation: Optional[List[BatchAllocationEntry]] = None
    batch_id: Optional[str] = None

    @field_validator("qty", mode="before")
    @classmethod
    def _coerce_qty(cls, value):
        return _coerce_qty_value(value, field_name="qty")


class ComplimentaryCreate(BaseModel):
    number: Optional[str] = None
    reason: Literal["Complimentary", "Sample"]
    branch_id: str
    child_counter_id: Optional[str] = None
    child_counter_name: Optional[str] = None
    customer_id: Optional[str] = None
    date: Optional[str] = None
    notes: Optional[str] = None
    items: List[ComplimentaryLineIn]


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
        # Packaging lives on the item, so it is only known when the item is loaded.
        "packaging": (item.packaging if item else None) or "",
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
    """Issue complimentary or sample stock. Stock is deducted on save."""
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

    item_map = await _load_items_by_id(db, {line.item_id for line in data.items})
    allow_oversell = await get_allow_overselling(db)

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
            unit=item.unit or "",
            qty=qty,
            cost_price=round(cost, 2),
            cost_total=round(cost * qty, 2),
        )
        db.add(li)
        total_cost += cost * qty

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
        detail=f"Issued {entry.reason.lower()} stock {entry.number} ({len(data.items)} lines)",
        user=user,
        request=request,
        branch_id=branch.id,
        metadata={"reason": entry.reason, "cost_value": entry.total_cost, "line_count": len(data.items)},
    )
    await db.commit()
    await db.refresh(entry)
    return {"id": entry.id, "number": entry.number, "reason": entry.reason, "cost_value": entry.total_cost}


@router.get("/", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def list_complimentary(
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    reason: Optional[str] = None,
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
        if reason not in COMPLIMENTARY_REASONS:
            raise HTTPException(400, "Invalid reason")
        conds.append(ComplimentaryEntry.reason == reason)
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


@router.get("/{entry_id}", dependencies=[Depends(require_perm(*SALES_DOCUMENT_READ))])
async def get_complimentary(
    entry_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    entry = (await db.execute(
        select(ComplimentaryEntry)
        .options(selectinload(ComplimentaryEntry.line_items))
        .where(ComplimentaryEntry.id == entry_id)
    )).scalar_one_or_none()
    if entry is None:
        raise HTTPException(404, "Complimentary entry not found")
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
    """Delete an entry and return its stock to the branch."""
    entry = (await db.execute(
        select(ComplimentaryEntry)
        .options(selectinload(ComplimentaryEntry.line_items))
        .where(ComplimentaryEntry.id == entry_id)
    )).scalar_one_or_none()
    if entry is None:
        raise HTTPException(404, "Complimentary entry not found")
    await _resolve_branch_scope(user, db, entry.branch_id)

    restored = await _restock_invoice_lines(
        db,
        entry,
        entry.line_items,
        reversal_movement_type=STOCK_REVERSAL_MOVEMENT_TYPE,
        source_type=STOCK_SOURCE_TYPE,
    )
    number = entry.number
    branch_id = entry.branch_id
    await db.delete(entry)
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
    return {"ok": True, "number": number, "restored_qty": restored}

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
from src.document_numbering import allocate_number
from src.models import AuditLog, Branch, ItemBranchConfig, StockTransfer, TransferLineItem, TransferStatus, User
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.qty import as_qty, coerce_qty_value
from src.routes._atomic import (
    add_batch_atomic,
    adjust_stock_atomic,
    clamp_stock_to_zero_with_ledger,
    consume_batches_atomic,
    is_tracked,
)
from src.routes.items import _upsert_branch_config
from src.routes._serializers import get_user_branch_ids, serialize_transfer
from src.routes._child_counters import validate_child_counter
from src.routes._approval import can_direct_commit
from src.permissions import TRANSFER_DOCUMENT_READ
from src.security import (
    current_user,
    enforce_branch_access,
    enforce_branch_access_optional,
    get_allowed_branch_ids,
    require_perm,
)
from src.services.audit_service import build_audit_entry

router = APIRouter()

class TransferAllocationEntry(BaseModel):
    """One source-batch entry of an explicit per-line split. Sum of `qty`
    must equal the line's qty when the operator pre-allocates.

    `qty > 0` enforced at the schema layer — see BatchAllocationEntry in
    sales.py for why (negative qty sneaking past the sum-check would corrupt
    the SUM(batches) == item_stock invariant on approve).
    """
    batch_id: str
    qty: float = Field(..., gt=0)

    @field_validator("qty", mode="before")
    @classmethod
    def _coerce_qty(cls, value):
        return coerce_qty_value(value, field_name="qty")


class TransferLine(BaseModel):
    item_id: str
    item_name: str
    qty: float = Field(..., gt=0)
    cost_price: Optional[float] = Field(None, ge=0)
    # ── Source batch hints (precedence: allocation > batch_id > auto) ──
    # `batch_allocation`: explicit per-line split set by the operator in the
    # New Transfer modal. Honored as-is on approve.
    # `batch_id`: legacy single-batch shortcut (consumed first, rest auto).
    batch_allocation: Optional[List[TransferAllocationEntry]] = None
    batch_id: Optional[str] = None

    @field_validator("qty", mode="before")
    @classmethod
    def _coerce_qty(cls, value):
        return coerce_qty_value(value, field_name="qty")

class TransferCreate(BaseModel):
    from_branch_id: str
    to_branch_id: str
    child_counter_id: Optional[str] = None
    child_counter_name: Optional[str] = None
    requested_by: str
    items: List[TransferLine]
    priority: str = "Normal"
    notes: Optional[str] = None
    expected_date: Optional[str] = None


class TransferUpdate(BaseModel):
    ref_number: str
    from_branch_id: str
    to_branch_id: str
    child_counter_id: Optional[str] = None
    child_counter_name: Optional[str] = None
    items: List[TransferLine]
    priority: str = "Normal"
    notes: Optional[str] = None
    expected_date: Optional[str] = None


class TransferApprove(BaseModel):
    approved_by: str = "Manager"
    ref_number: str


class TransferReject(BaseModel):
    rejected_by: str = "Manager"
    rejection_notes: Optional[str] = None
    ref_number: str


class TransferReceive(BaseModel):
    received_by: str = "Staff"
    ref_number: str


async def _lock_transfer(
    db: AsyncSession, transfer_id: str, *, ref_number: str
) -> StockTransfer:
    """Load a transfer row with FOR UPDATE to block concurrent actions."""
    t = (
        await db.execute(
            select(StockTransfer)
            .where(StockTransfer.id == transfer_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    if t.ref_number != ref_number:
        raise HTTPException(400, "Transfer reference number does not match")
    return t

@router.get("/", dependencies=[Depends(require_perm(*TRANSFER_DOCUMENT_READ))])
async def list_transfers(
    status: Optional[str] = None,
    branch_id: Optional[str] = Query(None),
    child_counter_id: Optional[str] = None,
    from_branch: Optional[str] = Query(None, alias="from_branch_id"),
    to_branch: Optional[str] = Query(None, alias="to_branch_id"),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    branch_id = await enforce_branch_access_optional(branch_id, user=user, db=db)
    from_branch = await enforce_branch_access_optional(from_branch, user=user, db=db)
    to_branch = await enforce_branch_access_optional(to_branch, user=user, db=db)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "ref_number": StockTransfer.ref_number,
            "from_branch_id": StockTransfer.from_branch_id,
            "to_branch_id": StockTransfer.to_branch_id,
            "status": StockTransfer.status,
            "requested_by": StockTransfer.requested_by,
            "created_at": StockTransfer.created_at,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = select(StockTransfer).options(
        selectinload(StockTransfer.items).selectinload(TransferLineItem.item)
    ).order_by(sort_expr)
    cq = select(func.count(StockTransfer.id))
    if status:
        q = q.where(StockTransfer.status == status)
        cq = cq.where(StockTransfer.status == status)
    if child_counter_id:
        q = q.where(StockTransfer.child_counter_id == child_counter_id)
        cq = cq.where(StockTransfer.child_counter_id == child_counter_id)
    if branch_id:
        # Role of the active branch depends on status:
        #   draft/pending/rejected → source (from) owns approve/edit
        #   transit → destination (to) owns receive
        #   received / all → either side of the route
        status_key = (status or "").strip().lower()
        if status_key in {"draft", "pending", "rejected"}:
            branch_scope = StockTransfer.from_branch_id == branch_id
        elif status_key == "transit":
            branch_scope = StockTransfer.to_branch_id == branch_id
        else:
            branch_scope = or_(
                StockTransfer.from_branch_id == branch_id,
                StockTransfer.to_branch_id == branch_id,
            )
        q = q.where(branch_scope)
        cq = cq.where(branch_scope)
    if from_branch:
        q = q.where(StockTransfer.from_branch_id == from_branch)
        cq = cq.where(StockTransfer.from_branch_id == from_branch)
    if to_branch:
        q = q.where(StockTransfer.to_branch_id == to_branch)
        cq = cq.where(StockTransfer.to_branch_id == to_branch)
    if not branch_id and not from_branch and not to_branch and not getattr(user, "all_branches", False):
        branch_ids = await get_allowed_branch_ids(user, db)
        if not branch_ids:
            return paged([], 0, sk, lim)
        q = q.where(
            or_(
                StockTransfer.from_branch_id.in_(branch_ids),
                StockTransfer.to_branch_id.in_(branch_ids),
            )
        )
        cq = cq.where(
            or_(
                StockTransfer.from_branch_id.in_(branch_ids),
                StockTransfer.to_branch_id.in_(branch_ids),
            )
        )
    total = int((await db.execute(cq)).scalar() or 0)
    br_result = await db.execute(select(Branch))
    branch_map = {b.id: b.name for b in br_result.scalars().all()}
    result = await db.execute(q.offset(sk).limit(lim))
    transfers = result.unique().scalars().all()
    out = []
    for t in transfers:
        lines = t.items or []
        d = serialize_transfer(t)
        d["from_branch_name"] = branch_map.get(t.from_branch_id, t.from_branch_id)
        d["to_branch_name"] = branch_map.get(t.to_branch_id, t.to_branch_id)
        d["items"] = [_line_dict(ln) for ln in lines]
        out.append(d)
    return paged(out, total, sk, lim)


def _line_dict(ln: TransferLineItem, cost_price: Optional[float] = None) -> dict:
    """Serialize a transfer line, including any persisted batch manifest so
    the detail view can show:
      • `requested_allocation` — operator's pre-approval split (if any).
      • `batches` — the actual lots drained on approve (post-approve only).
    """
    import json as _json

    def _safe_parse(raw):
        if not raw:
            return []
        try:
            v = _json.loads(raw)
            return v if isinstance(v, list) else []
        except Exception:
            return []

    if cost_price is None:
        cost_price = float(ln.item.cost_price or 0) if ln.item else 0

    return {
        "item_id":              ln.item_id,
        "name":                 ln.item_name,
        "packing":              ln.item.packaging if ln.item else "",
        "unit":                 ln.item.unit if ln.item else "",
        "qty":                  ln.qty,
        "cost_price":           ln.cost_price if ln.cost_price is not None else cost_price,
        "preferred_batch_id":   ln.preferred_batch_id,
        "requested_allocation": _safe_parse(ln.requested_allocation),
        "batches":              _safe_parse(ln.batch_allocation),
    }


async def _branch_names(
    db: AsyncSession, from_id: str, to_id: str
) -> tuple[str, str]:
    from_branch = (
        await db.execute(select(Branch).where(Branch.id == from_id))
    ).scalar_one_or_none()
    to_branch = (
        await db.execute(select(Branch).where(Branch.id == to_id))
    ).scalar_one_or_none()
    return (
        from_branch.name if from_branch else from_id,
        to_branch.name if to_branch else to_id,
    )


def _transfer_branch_label(name: Optional[str], branch_id: Optional[str]) -> str:
    label = (name or "").strip()
    return label or (branch_id or "Unknown branch")


def _format_qty_label(qty) -> str:
    n = as_qty(qty or 0)
    if float(n).is_integer():
        return str(int(n))
    return f"{n:g}"


def _transfer_lines_audit(lines) -> tuple[str, list[dict], float]:
    """Human line summary + structured rows for transfer audit metadata."""
    parts: list[str] = []
    rows: list[dict] = []
    total = 0.0
    for line in lines or []:
        name = (
            getattr(line, "item_name", None)
            or getattr(line, "name", None)
            or "Item"
        )
        qty = as_qty(getattr(line, "qty", 0) or 0)
        total += qty
        qty_label = _format_qty_label(qty)
        parts.append(f"{name} × {qty_label}")
        rows.append({
            "item_id": getattr(line, "item_id", None),
            "item_name": name,
            "qty": qty,
        })
    summary = ", ".join(parts) if parts else "no line items"
    return summary, rows, as_qty(total)


def _transfer_route_meta(
    *,
    from_branch_id: str,
    from_branch_name: str,
    to_branch_id: str,
    to_branch_name: str,
    lines=None,
    extra: Optional[dict] = None,
) -> dict:
    line_summary, line_rows, qty_total = _transfer_lines_audit(lines or [])
    meta = {
        "from_branch_id": from_branch_id,
        "from_branch_name": from_branch_name,
        "to_branch_id": to_branch_id,
        "to_branch_name": to_branch_name,
        "qty_total": qty_total,
        "line_count": len(line_rows),
        "lines": line_rows,
        "line_summary": line_summary,
    }
    if extra:
        meta.update(extra)
    return meta


async def _load_transfer_lines(db: AsyncSession, transfer_id: str) -> list[TransferLineItem]:
    return list(
        (
            await db.execute(
                select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id)
            )
        ).scalars().all()
    )


async def _resolve_branch_scope(user: User, db: AsyncSession, branch_id: Optional[str]) -> Optional[list[str]]:
    if not getattr(user, "id", None):
        try:
            user = await current_user(authorization=None, db=db)
        except RuntimeError:
            return None
    if getattr(user, "all_branches", False):
        return None
    branch_ids = await get_allowed_branch_ids(user, db)
    if branch_ids:
        if branch_id and branch_id not in branch_ids:
            raise HTTPException(403, "Branch is outside your transfers scope")
        return branch_ids
    if getattr(user, "branch_id", None):
        if branch_id and branch_id != user.branch_id:
            raise HTTPException(403, "Branch is outside your transfers scope")
        return [user.branch_id]
    if branch_id:
        raise HTTPException(403, "Branch is outside your transfers scope")
    return []


def _add_transfer_lines(transfer_id: str, items: List[TransferLine]) -> None:
    import json as _json

    for item in items:
        requested = (
            _json.dumps([e.model_dump() for e in item.batch_allocation])
            if item.batch_allocation else None
        )
        line = TransferLineItem(
            id=str(uuid.uuid4()),
            transfer_id=transfer_id,
            item_id=item.item_id,
            item_name=item.item_name,
            qty=item.qty,
            cost_price=item.cost_price,
            preferred_batch_id=item.batch_id,
            requested_allocation=requested,
        )
        # Caller adds via db.add — this helper returns objects for tests;
        # we inline db.add in callers instead.
        yield line


def _log_transfer_history(
    db: AsyncSession,
    *,
    user: User,
    transfer_id: str,
    transfer_number: str,
    event_type: str,
    action: str,
    detail: str,
    metadata: Optional[dict] = None,
    risk: str = "low",
) -> None:
    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="stock_transfer",
        record_id=transfer_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action,
        user_id=getattr(user, "id", None),
        user_name=getattr(user, "name", None),
        module="inventory",
        ref=transfer_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


async def _write_post_commit_audit(
    db: AsyncSession,
    *,
    action: str,
    reference_id: str,
    detail: str,
    user: User,
    request: Request,
    branch_id: Optional[str],
    metadata: Optional[dict] = None,
) -> None:
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    payload = build_audit_entry(
        action=action,
        module="Inventory",
        reference_id=reference_id,
        detail=detail,
        user_id=user.id,
        user_name=user.name,
        user_role=role,
        ip_address=getattr(request.state, "ip_address", None),
        device_info=getattr(request.state, "device_info", None),
        branch_id=branch_id,
        metadata=metadata,
    )
    db.add(AuditLog(id=str(uuid.uuid4()), **payload))
    await db.commit()


def _summarize_transfer_item_changes(old_lines: list[TransferLineItem], new_items: list[TransferLine]) -> list[dict]:
    old_by_key: dict[tuple[str, str], list[TransferLineItem]] = {}
    for line in old_lines or []:
        key = (str(line.item_id or ""), str(line.item_name or "").strip().lower())
        old_by_key.setdefault(key, []).append(line)

    consumed: dict[tuple[str, str], int] = {}
    changes: list[dict] = []
    for item in new_items or []:
        key = (str(item.item_id or ""), str(item.item_name or "").strip().lower())
        idx = consumed.get(key, 0)
        consumed[key] = idx + 1
        existing = old_by_key.get(key, [])
        prev = existing[idx] if idx < len(existing) else None

        if prev is None:
            changes.append({
                "item_id": str(item.item_id),
                "item_name": item.item_name,
                "fields": ["added"],
                "changes": [{"field": "qty", "old": None, "new": as_qty(item.qty or 0)}],
                "detail": f"{item.item_name}: added (qty {item.qty})",
            })
            continue

        line_changes: list[dict] = []
        if as_qty(prev.qty or 0) != as_qty(item.qty or 0):
            line_changes.append({"field": "qty", "old": as_qty(prev.qty or 0), "new": as_qty(item.qty or 0)})
        if (
            prev.cost_price is None and item.cost_price is not None
        ) or (
            prev.cost_price is not None and float(prev.cost_price) != float(item.cost_price or 0)
        ):
            line_changes.append({
                "field": "cost_price",
                "old": float(prev.cost_price) if prev.cost_price is not None else None,
                "new": float(item.cost_price or 0),
            })
        if (prev.item_name or "") != item.item_name:
            line_changes.append({"field": "item_name", "old": str(prev.item_name or ""), "new": item.item_name})

        if line_changes:
            changes.append({
                "item_id": str(item.item_id),
                "item_name": item.item_name,
                "fields": [c["field"] for c in line_changes],
                "changes": line_changes,
                "detail": f"{item.item_name}: updated {', '.join(c['field'] for c in line_changes)}",
            })

    for key, existing in old_by_key.items():
        removed_count = len(existing) - consumed.get(key, 0)
        if removed_count > 0:
            for removed in existing[consumed.get(key, 0):]:
                changes.append({
                    "item_id": str(removed.item_id),
                    "item_name": removed.item_name,
                    "fields": ["removed"],
                    "changes": [{"field": "qty", "old": as_qty(removed.qty or 0), "new": None}],
                    "detail": f"{removed.item_name}: removed (qty {removed.qty})",
                })

    return changes


async def _serialize_transfer_detail(
    db: AsyncSession, t: StockTransfer
) -> dict:
    br_result = await db.execute(select(Branch))
    branch_map = {b.id: b.name for b in br_result.scalars().all()}
    lines = t.items or []
    d = serialize_transfer(t)
    d["from_branch_name"] = branch_map.get(t.from_branch_id, t.from_branch_name or t.from_branch_id)
    d["to_branch_name"] = branch_map.get(t.to_branch_id, t.to_branch_name or t.to_branch_id)
    d["expected_date"] = t.request_date
    item_ids = {ln.item_id for ln in lines}
    branch_costs = {}
    if item_ids:
        cost_rows = await db.execute(
            select(ItemBranchConfig.item_id, ItemBranchConfig.cost_price).where(
                ItemBranchConfig.branch_id == t.from_branch_id,
                ItemBranchConfig.item_id.in_(item_ids),
            )
        )
        branch_costs = {
            item_id: cost_price
            for item_id, cost_price in cost_rows.all()
            if cost_price is not None
        }
    d["items"] = [
        _line_dict(ln, branch_costs.get(ln.item_id))
        for ln in lines
    ]
    return d


@router.get("/{transfer_id}", dependencies=[Depends(require_perm(*TRANSFER_DOCUMENT_READ))])
async def get_transfer(transfer_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(
        select(StockTransfer)
        .where(StockTransfer.id == transfer_id)
        .options(selectinload(StockTransfer.items).selectinload(TransferLineItem.item))
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    await _ensure_user_can_view_transfer(user, db, t)
    return await _serialize_transfer_detail(db, t)


async def _ensure_user_can_view_transfer(user: User, db: AsyncSession, t: StockTransfer) -> None:
    if getattr(user, "all_branches", False):
        return
    branch_ids = await get_allowed_branch_ids(user, db)
    if t.from_branch_id not in branch_ids and t.to_branch_id not in branch_ids:
        raise HTTPException(403, "Access denied for transfer")


@router.post("/", status_code=201, dependencies=[Depends(require_perm("transfers.create"))])
async def create_transfer(
    data: TransferCreate,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    if data.from_branch_id == data.to_branch_id:
        raise HTTPException(400, "Source and destination branches must differ")
    # Validate requested branches are within the user's scope
    await _resolve_branch_scope(user, db, data.from_branch_id)
    await _resolve_branch_scope(user, db, data.to_branch_id)
    child_counter_id, child_counter_name = await validate_child_counter(
        db, data.from_branch_id, data.child_counter_id, data.child_counter_name,
    )
    if not data.items:
        raise HTTPException(400, "At least one line item is required")
    tid = str(uuid.uuid4())
    ref = await allocate_number(
        db, "stock_transfer", branch_id=data.from_branch_id
    )

    from_name, to_name = await _branch_names(db, data.from_branch_id, data.to_branch_id)
    direct = await can_direct_commit(user, db, "transfers.approve")

    t = StockTransfer(
        id=tid, ref_number=ref,
        from_branch_id=data.from_branch_id,
        from_branch_name=from_name,
        to_branch_id=data.to_branch_id,
        to_branch_name=to_name,
        child_counter_id=child_counter_id,
        child_counter_name=child_counter_name,
        requested_by=data.requested_by or user.name,
        status=TransferStatus.pending if direct else TransferStatus.draft,
        priority=data.priority,
        notes=data.notes,
        request_date=data.expected_date,
    )
    db.add(t)
    for line in _add_transfer_lines(tid, data.items):
        db.add(line)

    line_summary, _line_rows, qty_total = _transfer_lines_audit(data.items)
    from_label = _transfer_branch_label(from_name, data.from_branch_id)
    to_label = _transfer_branch_label(to_name, data.to_branch_id)
    create_detail = (
        f"Created transfer {ref} from {from_label} to {to_label}. "
        f"Items ({_format_qty_label(qty_total)} total): {line_summary}. "
        f"No stock moved yet"
        + (" — pending approval." if not direct else " — will dispatch immediately.")
    )
    _log_transfer_history(
        db,
        user=user,
        transfer_id=tid,
        transfer_number=ref,
        event_type="created",
        action="Transfer created",
        detail=create_detail,
        metadata=_transfer_route_meta(
            from_branch_id=data.from_branch_id,
            from_branch_name=from_label,
            to_branch_id=data.to_branch_id,
            to_branch_name=to_label,
            lines=data.items,
            extra={
                "priority": data.priority,
                "status": "pending" if direct else "draft",
                "stock_reduced": 0,
                "stock_increased": 0,
            },
        ),
    )
    await db.flush()
    if direct:
        result = await _dispatch_transfer(
            db,
            t,
            tid,
            user=user,
            approved_by=user.name,
            request=Request(scope={"type": "http"}, receive=lambda: None),
        )
        await db.commit()
        return {"id": tid, "ref_number": ref, **result}
    # Draft stays private — notification fires on submit.
    await db.commit()
    return {"id": tid, "ref_number": ref, "status": "draft"}


@router.put("/{transfer_id}", dependencies=[Depends(require_perm("transfers.create"))])
async def update_transfer(
    transfer_id: str,
    data: TransferUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Replace a pending transfer's route, lines, and notes.

    Only pending requests may be edited — in-transit and received transfers
    have already affected stock.
    """
    if data.from_branch_id == data.to_branch_id:
        raise HTTPException(400, "Source and destination branches must differ")
    if not data.items:
        raise HTTPException(400, "At least one line item is required")

    t = await _lock_transfer(db, transfer_id, ref_number=data.ref_number)
    if t.status not in (TransferStatus.pending, TransferStatus.draft):
        raise HTTPException(
            400,
            f"Only draft/pending transfers can be edited; this transfer is {t.status.value}",
        )

    # Validate the requested branches are within the user's scope
    await _resolve_branch_scope(user, db, data.from_branch_id)
    await _resolve_branch_scope(user, db, data.to_branch_id)
    child_counter_id, child_counter_name = await validate_child_counter(
        db, data.from_branch_id, data.child_counter_id, data.child_counter_name,
    )

    from_name, to_name = await _branch_names(db, data.from_branch_id, data.to_branch_id)
    t.from_branch_id = data.from_branch_id
    t.from_branch_name = from_name
    t.to_branch_id = data.to_branch_id
    t.to_branch_name = to_name
    t.child_counter_id = child_counter_id
    t.child_counter_name = child_counter_name
    t.priority = data.priority
    t.notes = data.notes
    t.request_date = data.expected_date

    existing = (
        await db.execute(
            select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id)
        )
    ).scalars().all()
    item_changes = _summarize_transfer_item_changes(existing, data.items)
    for ln in existing:
        await db.delete(ln)

    for line in _add_transfer_lines(transfer_id, data.items):
        db.add(line)

    line_summary, _line_rows, qty_total = _transfer_lines_audit(data.items)
    from_label = _transfer_branch_label(from_name, data.from_branch_id)
    to_label = _transfer_branch_label(to_name, data.to_branch_id)
    route_meta = _transfer_route_meta(
        from_branch_id=data.from_branch_id,
        from_branch_name=from_label,
        to_branch_id=data.to_branch_id,
        to_branch_name=to_label,
        lines=data.items,
        extra={"stock_reduced": 0, "stock_increased": 0, "status": t.status.value},
    )
    if item_changes:
        change_bits = [c.get("detail") for c in item_changes[:20] if c.get("detail")]
        change_text = "; ".join(change_bits) if change_bits else f"{len(item_changes)} line change(s)"
        _log_transfer_history(
            db,
            user=user,
            transfer_id=transfer_id,
            transfer_number=t.ref_number,
            event_type="item_changed",
            action="Transfer items updated",
            detail=(
                f"Updated items on transfer {t.ref_number} "
                f"({from_label} → {to_label}): {change_text}"
            ),
            metadata={**route_meta, "changes": item_changes[:20]},
        )

    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="updated",
        action="Transfer updated",
        detail=(
            f"Updated transfer {t.ref_number}: route {from_label} → {to_label}. "
            f"Items ({_format_qty_label(qty_total)} total): {line_summary}. "
            f"No stock moved yet."
        ),
        metadata=route_meta,
    )
    await db.commit()
    return {"id": transfer_id, "ref_number": t.ref_number, "status": t.status.value}

@router.post("/{transfer_id}/submit", dependencies=[Depends(require_perm("transfers.create"))])
async def submit_transfer(
    transfer_id: str,
    ref_number: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Creator submits a private draft transfer for approval."""
    t = await _lock_transfer(db, transfer_id, ref_number=ref_number)
    if t.status == TransferStatus.pending:
        return {"status": "pending", "ref_number": t.ref_number, "already_processed": True}
    if t.status != TransferStatus.draft:
        raise HTTPException(400, f"Only draft transfers can be submitted (status={t.status.value})")
    if t.requested_by and t.requested_by != user.name and not await can_direct_commit(user, db, "transfers.approve"):
        raise HTTPException(403, "Only the creator can submit this draft for approval")
    t.status = TransferStatus.pending
    from src.notifications.store import emit_transfer_pending, notify_refresh
    await emit_transfer_pending(db, t)
    lines = await _load_transfer_lines(db, transfer_id)
    from_label = _transfer_branch_label(t.from_branch_name, t.from_branch_id)
    to_label = _transfer_branch_label(t.to_branch_name, t.to_branch_id)
    line_summary, _line_rows, qty_total = _transfer_lines_audit(lines)
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="submitted",
        action="Transfer submitted",
        detail=(
            f"Submitted transfer {t.ref_number} for approval: "
            f"{from_label} → {to_label}. "
            f"Items ({_format_qty_label(qty_total)} total): {line_summary}. "
            f"Stock will be reduced at {from_label} on approve/dispatch."
        ),
        metadata=_transfer_route_meta(
            from_branch_id=t.from_branch_id,
            from_branch_name=from_label,
            to_branch_id=t.to_branch_id,
            to_branch_name=to_label,
            lines=lines,
            extra={"stock_reduced": 0, "stock_increased": 0, "status": "pending"},
        ),
    )
    await db.commit()
    await notify_refresh()
    return {"status": "pending", "ref_number": t.ref_number}


@router.post("/{transfer_id}/approve", dependencies=[Depends(require_perm("transfers.approve"))])
async def approve_transfer(
    transfer_id: str,
    body: TransferApprove,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Approve & dispatch a transfer."""
    t = await _lock_transfer(db, transfer_id, ref_number=body.ref_number)
    # Dispatch deducts stock at the source — only source-branch users may approve.
    await enforce_branch_access(t.from_branch_id, user=user, db=db)

    if (
        t.requested_by
        and t.requested_by == user.name
        and t.status == TransferStatus.pending
    ):
        raise HTTPException(403, "You cannot approve your own transfer request")

    result = await _dispatch_transfer(
        db,
        t,
        transfer_id,
        user=user,
        approved_by=body.approved_by or user.name,
        request=request,
    )
    from src.notifications.store import notify_refresh

    await db.commit()
    await notify_refresh()
    return result


async def _dispatch_transfer(
    db: AsyncSession,
    t: StockTransfer,
    transfer_id: str,
    *,
    user: User,
    approved_by: str,
    request: Request,
) -> dict:
    """Approve & dispatch a transfer — consume source stock and mark in transit."""
    import json

    from sqlalchemy import text as _text

    if t.status == TransferStatus.transit:
        return {
            "status": "transit",
            "ref_number": t.ref_number,
            "approved_by": t.approved_by,
            "already_processed": True,
        }
    if t.status != TransferStatus.pending:
        raise HTTPException(400, f"Transfer is already {t.status.value}")

    t.status = TransferStatus.transit
    t.approved_by = approved_by

    from src.notifications.store import emit_transfer_in_transit, resolve_notification

    await resolve_notification(db, f"approval.transfer_pending:{transfer_id}")
    await emit_transfer_in_transit(db, t)

    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        tracked, expiry_tracked = await is_tracked(db, line.item_id)
        if tracked:
            strategy = "fefo" if expiry_tracked else "fifo"
            explicit = None
            if line.requested_allocation:
                try:
                    parsed = json.loads(line.requested_allocation)
                    if isinstance(parsed, list) and parsed:
                        explicit = parsed
                except Exception:
                    explicit = None
            try:
                consumed = await consume_batches_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=t.from_branch_id,
                    qty=line.qty,
                    strategy=strategy,
                    preferred_batch_id=line.preferred_batch_id,
                    explicit_allocation=explicit,
                    movement_type="transfer",
                    source_type="transfer",
                    source_ref=transfer_id,
                )
            except ValueError:
                consumed = []
                if explicit:
                    try:
                        consumed = await consume_batches_atomic(
                            db,
                            item_id=line.item_id,
                            branch_id=t.from_branch_id,
                            qty=line.qty,
                            strategy=strategy,
                            preferred_batch_id=line.preferred_batch_id,
                            explicit_allocation=None,
                            movement_type="transfer",
                            source_type="transfer",
                            source_ref=transfer_id,
                        )
                    except ValueError:
                        consumed = []
                if not consumed:
                    await db.execute(
                        _text(
                            "UPDATE item_batches SET quantity = 0 "
                            "WHERE item_id = :i AND branch_id = :b"
                        ),
                        {"i": line.item_id, "b": t.from_branch_id},
                    )
                    await clamp_stock_to_zero_with_ledger(
                        db,
                        item_id=line.item_id,
                        branch_id=t.from_branch_id,
                        movement_type="transfer",
                        source_type="transfer",
                        source_ref=transfer_id,
                        notes=f"Transfer {t.ref_number} source clamp",
                    )
            line.batch_allocation = json.dumps(consumed)
        else:
            try:
                await adjust_stock_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=t.from_branch_id,
                    delta=-line.qty,
                    movement_type="transfer",
                    source_type="transfer",
                    source_ref=transfer_id,
                )
            except ValueError:
                await clamp_stock_to_zero_with_ledger(
                    db,
                    item_id=line.item_id,
                    branch_id=t.from_branch_id,
                    movement_type="transfer",
                    source_type="transfer",
                    source_ref=transfer_id,
                    notes=f"Transfer {t.ref_number} source clamp",
                )
    lines = await _load_transfer_lines(db, transfer_id)
    from_label = _transfer_branch_label(t.from_branch_name, t.from_branch_id)
    to_label = _transfer_branch_label(t.to_branch_name, t.to_branch_id)
    line_summary, _line_rows, qty_total = _transfer_lines_audit(lines)
    dispatch_detail = (
        f"Approved and dispatched transfer {t.ref_number} by {approved_by}: "
        f"{from_label} → {to_label}. "
        f"Stock reduced at {from_label}: {line_summary} "
        f"(total {_format_qty_label(qty_total)}). "
        f"Stock at {to_label} will increase by the same quantities on receive."
    )
    dispatch_meta = _transfer_route_meta(
        from_branch_id=t.from_branch_id,
        from_branch_name=from_label,
        to_branch_id=t.to_branch_id,
        to_branch_name=to_label,
        lines=lines,
        extra={
            "stock_reduced": qty_total,
            "stock_increased": 0,
            "stock_reduced_at": from_label,
            "stock_pending_at": to_label,
            "status": "transit",
            "approved_by": approved_by,
            "approver_id": user.id,
        },
    )
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="transit",
        action="Transfer dispatched",
        detail=dispatch_detail,
        metadata=dispatch_meta,
    )
    await db.commit()
    await _write_post_commit_audit(
        db,
        action="Stock Transfer Approved",
        reference_id=t.ref_number,
        detail=dispatch_detail,
        user=user,
        request=request,
        branch_id=t.from_branch_id,
        metadata={
            "transfer_id": transfer_id,
            **dispatch_meta,
            "stock_value": 0,
            "requester_id": None,
        },
    )
    return {"status": "transit", "ref_number": t.ref_number, "approved_by": approved_by}


@router.post("/{transfer_id}/reject", dependencies=[Depends(require_perm("transfers.approve"))])
async def reject_transfer(
    transfer_id: str,
    body: TransferReject,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    t = await _lock_transfer(db, transfer_id, ref_number=body.ref_number)
    await enforce_branch_access(t.from_branch_id, user=user, db=db)

    if t.status == TransferStatus.rejected:
        await db.commit()
        return {
            "status": "rejected",
            "ref_number": t.ref_number,
            "already_processed": True,
        }
    if t.status != TransferStatus.pending:
        raise HTTPException(400, f"Transfer is already {t.status.value}")

    t.status = TransferStatus.rejected
    if body.rejection_notes:
        prefix = f"[Rejected by {body.rejected_by}] "
        t.notes = f"{prefix}{body.rejection_notes}" + (f"\n{t.notes}" if t.notes else "")

    lines = await _load_transfer_lines(db, transfer_id)
    from_label = _transfer_branch_label(t.from_branch_name, t.from_branch_id)
    to_label = _transfer_branch_label(t.to_branch_name, t.to_branch_id)
    line_summary, _line_rows, qty_total = _transfer_lines_audit(lines)
    reject_note = f" Reason: {body.rejection_notes}." if body.rejection_notes else ""
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="rejected",
        action="Transfer rejected",
        detail=(
            f"Rejected transfer {t.ref_number} by {body.rejected_by}: "
            f"{from_label} → {to_label}. "
            f"Items ({_format_qty_label(qty_total)} total): {line_summary}. "
            f"No stock was moved.{reject_note}"
        ),
        metadata=_transfer_route_meta(
            from_branch_id=t.from_branch_id,
            from_branch_name=from_label,
            to_branch_id=t.to_branch_id,
            to_branch_name=to_label,
            lines=lines,
            extra={
                "stock_reduced": 0,
                "stock_increased": 0,
                "status": "rejected",
                "rejected_by": body.rejected_by,
                "rejection_notes": body.rejection_notes,
            },
        ),
    )
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.transfer_pending:{transfer_id}")
    await db.commit()
    await notify_refresh()
    return {"status": "rejected", "ref_number": t.ref_number}


@router.post("/{transfer_id}/receive", dependencies=[Depends(require_perm("transfers.receive"))])
async def receive_transfer(
    transfer_id: str,
    body: TransferReceive,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Receive a dispatched transfer.

    Replays each line's persisted allocation manifest: every source batch
    that was drained on approve is recreated at the destination with the same
    lot number / expiry / cost so FIFO/FEFO ordering carries across branches.
    Untracked items just bump the destination aggregate.
    """
    import json

    from src.models import ItemBatch

    t = await _lock_transfer(db, transfer_id, ref_number=body.ref_number)
    # Stock lands at the destination — only destination-branch users may receive.
    await enforce_branch_access(t.to_branch_id, user=user, db=db)

    if t.status == TransferStatus.received:
        await db.commit()
        return {
            "status": "received",
            "ref_number": t.ref_number,
            "already_processed": True,
        }
    if t.status != TransferStatus.transit:
        raise HTTPException(400, "Transfer must be in transit to receive")
    t.status = TransferStatus.received

    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"ops.transfer_in_transit:{transfer_id}")

    lines_result = await db.execute(select(TransferLineItem).where(TransferLineItem.transfer_id == transfer_id))
    for line in lines_result.scalars().all():
        tracked, _expiry = await is_tracked(db, line.item_id)
        allocation: list = []
        if tracked and line.batch_allocation:
            try:
                parsed = json.loads(line.batch_allocation)
                if isinstance(parsed, list):
                    allocation = parsed
            except Exception:
                allocation = []

        if tracked and allocation:
            for entry in allocation:
                # Look up the source batch row by id to copy its metadata
                # 1:1 onto the new destination batch.
                src_res = await db.execute(
                    select(ItemBatch).where(ItemBatch.id == entry["batch_id"])
                )
                src = src_res.scalar_one_or_none()
                await add_batch_atomic(
                    db,
                    item_id=line.item_id,
                    branch_id=t.to_branch_id,
                    qty=as_qty(entry.get("consumed") or 0),
                    batch_number=(src.batch_number if src else entry.get("batch_number")),
                    mfg_date=(src.mfg_date if src else None),
                    expiry_date=(src.expiry_date if src else entry.get("expiry_date")),
                    cost_price=(src.cost_price if src else 0),
                    vendor_id=(src.vendor_id if src else None),
                    source_type="transfer",
                    source_ref=transfer_id,
                    received_date=(src.received_date if src else None),
                )
            # Ensure destination branch is listed for this item after receive
            await _upsert_branch_config(db, item_id=line.item_id, branch_id=t.to_branch_id, is_available=True)    
        elif tracked:
            # No allocation persisted (e.g. legacy transfer approved before
            # this column existed). Create a single transfer batch carrying
            # the line qty so destination stock at least balances.
            await add_batch_atomic(
                db,
                item_id=line.item_id,
                branch_id=t.to_branch_id,
                qty=line.qty,
                source_type="transfer",
                source_ref=transfer_id,
            )
            # Ensure destination branch is listed for this item after receive
            await _upsert_branch_config(db, item_id=line.item_id, branch_id=t.to_branch_id, is_available=True)
        else:
            await adjust_stock_atomic(
                db,
                item_id=line.item_id,
                branch_id=t.to_branch_id,
                delta=line.qty,
                movement_type="transfer",
                source_type="transfer",
                source_ref=transfer_id,
            )
            # Ensure destination branch is listed for this item after receive
            await _upsert_branch_config(db, item_id=line.item_id, branch_id=t.to_branch_id, is_available=True)

    lines = await _load_transfer_lines(db, transfer_id)
    from_label = _transfer_branch_label(t.from_branch_name, t.from_branch_id)
    to_label = _transfer_branch_label(t.to_branch_name, t.to_branch_id)
    line_summary, _line_rows, qty_total = _transfer_lines_audit(lines)
    receive_detail = (
        f"Received transfer {t.ref_number} by {body.received_by}: "
        f"{from_label} → {to_label}. "
        f"Stock increased at {to_label}: {line_summary} "
        f"(total {_format_qty_label(qty_total)}). "
        f"These quantities were previously reduced at {from_label} on dispatch."
    )
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="received",
        action="Transfer received",
        detail=receive_detail,
        metadata=_transfer_route_meta(
            from_branch_id=t.from_branch_id,
            from_branch_name=from_label,
            to_branch_id=t.to_branch_id,
            to_branch_name=to_label,
            lines=lines,
            extra={
                "stock_reduced": qty_total,
                "stock_increased": qty_total,
                "stock_reduced_at": from_label,
                "stock_increased_at": to_label,
                "status": "received",
                "received_by": body.received_by,
            },
        ),
    )
    await db.commit()
    await notify_refresh()
    return {"status": "received", "ref_number": t.ref_number, "received_by": body.received_by}


@router.delete("/{transfer_id}", dependencies=[Depends(require_perm("transfers.delete"))])
async def delete_transfer(
    transfer_id: str,
    ref_number: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Remove a pending transfer request.

    Only pending requests may be deleted — in-transit transfers have already
    deducted source stock; received transfers are complete audit records.
    """
    t = await _lock_transfer(db, transfer_id, ref_number=ref_number)
    if t.status != TransferStatus.pending:
        status = t.status.value if hasattr(t.status, "value") else str(t.status)
        if t.status == TransferStatus.transit:
            raise HTTPException(
                400,
                "In-transit transfers cannot be deleted — stock was already "
                "deducted at the source branch.",
            )
        if t.status == TransferStatus.received:
            raise HTTPException(
                400,
                "Received transfers cannot be deleted — stock was already "
                "updated at the destination branch.",
            )
        raise HTTPException(
            400,
            f"Only pending transfers can be deleted; this transfer is {status}",
        )

    lines = await _load_transfer_lines(db, transfer_id)
    from_label = _transfer_branch_label(t.from_branch_name, t.from_branch_id)
    to_label = _transfer_branch_label(t.to_branch_name, t.to_branch_id)
    line_summary, _line_rows, qty_total = _transfer_lines_audit(lines)
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="cancelled",
        action="Transfer deleted",
        detail=(
            f"Deleted transfer {t.ref_number}: {from_label} → {to_label}. "
            f"Items ({_format_qty_label(qty_total)} total): {line_summary}. "
            f"No stock was moved."
        ),
        metadata=_transfer_route_meta(
            from_branch_id=t.from_branch_id,
            from_branch_name=from_label,
            to_branch_id=t.to_branch_id,
            to_branch_name=to_label,
            lines=lines,
            extra={
                "stock_reduced": 0,
                "stock_increased": 0,
                "status": "deleted",
                "reason": "deleted",
            },
        ),
        risk="medium",
    )
    await db.delete(t)
    await db.commit()
    return {"status": "deleted", "ref_number": ref_number}

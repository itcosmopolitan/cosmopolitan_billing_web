import json
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.database import get_db
from src.document_numbering import allocate_number
from src.models import AuditLog, Branch, StockTransfer, TransferLineItem, TransferStatus, User
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._atomic import (
    add_batch_atomic,
    adjust_stock_atomic,
    clamp_stock_to_zero_with_ledger,
    consume_batches_atomic,
    is_tracked,
)
from src.routes.items import _upsert_branch_config
from src.routes._serializers import get_user_branch_ids, serialize_transfer
from src.routes._approval import can_direct_commit
from src.permissions import TRANSFER_DOCUMENT_READ
from src.security import current_user, enforce_branch_access, enforce_branch_access_optional, require_perm

router = APIRouter()

class TransferAllocationEntry(BaseModel):
    """One source-batch entry of an explicit per-line split. Sum of `qty`
    must equal the line's qty when the operator pre-allocates.

    `qty > 0` enforced at the schema layer — see BatchAllocationEntry in
    sales.py for why (negative qty sneaking past the sum-check would corrupt
    the SUM(batches) == item_stock invariant on approve).
    """
    batch_id: str
    qty: int = Field(..., gt=0)


class TransferLine(BaseModel):
    item_id: str
    item_name: str
    qty: int
    # ── Source batch hints (precedence: allocation > batch_id > auto) ──
    # `batch_allocation`: explicit per-line split set by the operator in the
    # New Transfer modal. Honored as-is on approve.
    # `batch_id`: legacy single-batch shortcut (consumed first, rest auto).
    batch_allocation: Optional[List[TransferAllocationEntry]] = None
    batch_id: Optional[str] = None

class TransferCreate(BaseModel):
    from_branch_id: str
    to_branch_id: str
    requested_by: str
    items: List[TransferLine]
    priority: str = "Normal"
    notes: Optional[str] = None
    expected_date: Optional[str] = None


class TransferUpdate(BaseModel):
    ref_number: str
    from_branch_id: str
    to_branch_id: str
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
    from_branch: Optional[str] = Depends(enforce_branch_access_optional),
    to_branch: Optional[str] = Depends(enforce_branch_access_optional),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
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
    q = select(StockTransfer).options(selectinload(StockTransfer.items)).order_by(sort_expr)
    cq = select(func.count(StockTransfer.id))
    if status:
        q = q.where(StockTransfer.status == status)
        cq = cq.where(StockTransfer.status == status)
    if from_branch:
        q = q.where(StockTransfer.from_branch_id == from_branch)
        cq = cq.where(StockTransfer.from_branch_id == from_branch)
    if to_branch:
        q = q.where(StockTransfer.to_branch_id == to_branch)
        cq = cq.where(StockTransfer.to_branch_id == to_branch)
    if not from_branch and not to_branch and not getattr(user, "all_branches", False):
        branch_ids = await get_user_branch_ids(db, user.id)
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


def _line_dict(ln: TransferLineItem) -> dict:
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

    return {
        "item_id":              ln.item_id,
        "name":                 ln.item_name,
        "qty":                  ln.qty,
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
        user_id=user.id if user is not None else None,
        user_name=user.name if user is not None else None,
        module="inventory",
        ref=transfer_number,
        detail=detail,
        risk=risk,
        ip_address=None,
    ))


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
                "changes": [{"field": "qty", "old": None, "new": int(item.qty or 0)}],
                "detail": f"{item.item_name}: added (qty {item.qty})",
            })
            continue

        line_changes: list[dict] = []
        if int(prev.qty or 0) != int(item.qty or 0):
            line_changes.append({"field": "qty", "old": int(prev.qty or 0), "new": int(item.qty or 0)})
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
                    "changes": [{"field": "qty", "old": int(removed.qty or 0), "new": None}],
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
    d["items"] = [_line_dict(ln) for ln in lines]
    return d


@router.get("/{transfer_id}", dependencies=[Depends(require_perm(*TRANSFER_DOCUMENT_READ))])
async def get_transfer(transfer_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    result = await db.execute(
        select(StockTransfer)
        .where(StockTransfer.id == transfer_id)
        .options(selectinload(StockTransfer.items))
    )
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Transfer not found")
    if not getattr(user, "all_branches", False):
        branch_ids = await get_user_branch_ids(db, user.id)
        if t.from_branch_id not in branch_ids and t.to_branch_id not in branch_ids:
            raise HTTPException(403, "Access denied for transfer")
    return await _serialize_transfer_detail(db, t)


@router.post("/", status_code=201, dependencies=[Depends(require_perm("transfers.create"))])
async def create_transfer(data: TransferCreate, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    if data.from_branch_id == data.to_branch_id:
        raise HTTPException(400, "Source and destination branches must differ")
    await enforce_branch_access(data.from_branch_id, user=user, db=db)
    await enforce_branch_access(data.to_branch_id, user=user, db=db)
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
        requested_by=data.requested_by or user.name,
        status=TransferStatus.pending,
        priority=data.priority,
        notes=data.notes,
        request_date=data.expected_date,
    )
    db.add(t)
    for line in _add_transfer_lines(tid, data.items):
        db.add(line)

    _log_transfer_history(
        db,
        user=user,
        transfer_id=tid,
        transfer_number=ref,
        event_type="created",
        action="Transfer created",
        detail=f"Created transfer request {ref} from {data.from_branch_id} to {data.to_branch_id}",
        metadata={
            "from_branch_id": data.from_branch_id,
            "to_branch_id": data.to_branch_id,
            "priority": data.priority,
        },
    )
    await db.flush()
    if direct:
        result = await _dispatch_transfer(
            db, t, tid, user=user, approved_by=user.name,
        )
        await db.commit()
        return {"id": tid, "ref_number": ref, **result}
    await db.commit()
    return {"id": tid, "ref_number": ref, "status": "pending"}


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
    if t.status != TransferStatus.pending:
        raise HTTPException(
            400,
            f"Only pending transfers can be edited; this transfer is {t.status.value}",
        )

    from_name, to_name = await _branch_names(db, data.from_branch_id, data.to_branch_id)
    t.from_branch_id = data.from_branch_id
    t.from_branch_name = from_name
    t.to_branch_id = data.to_branch_id
    t.to_branch_name = to_name
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

    if item_changes:
        _log_transfer_history(
            db,
            user=user,
            transfer_id=transfer_id,
            transfer_number=t.ref_number,
            event_type="item_changed",
            action="Transfer items updated",
            detail=f"Updated transfer line items for {t.ref_number}",
            metadata={"line_count": len(data.items), "changes": item_changes[:20]},
        )

    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="updated",
        action="Transfer updated",
        detail=f"Edited transfer route, items, or notes for {t.ref_number}",
    )
    await db.commit()
    return {"id": transfer_id, "ref_number": t.ref_number, "status": "pending"}

@router.post("/{transfer_id}/approve", dependencies=[Depends(require_perm("transfers.approve"))])
async def approve_transfer(
    transfer_id: str,
    body: TransferApprove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    """Approve & dispatch a transfer."""
    t = await _lock_transfer(db, transfer_id, ref_number=body.ref_number)

    if (
        t.requested_by
        and t.requested_by == user.name
        and t.status == TransferStatus.pending
    ):
        raise HTTPException(403, "You cannot approve your own transfer request")

    result = await _dispatch_transfer(
        db, t, transfer_id, user=user, approved_by=body.approved_by or user.name,
    )
    await db.commit()
    return result


async def _dispatch_transfer(
    db: AsyncSession,
    t: StockTransfer,
    transfer_id: str,
    *,
    user: User,
    approved_by: str,
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
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="transit",
        action="Transfer dispatched",
        detail=f"Transfer approved and dispatched by {approved_by}",
    )
    await db.commit()
    return {"status": "transit", "ref_number": t.ref_number, "approved_by": approved_by}


@router.post("/{transfer_id}/reject", dependencies=[Depends(require_perm("transfers.approve"))])
async def reject_transfer(
    transfer_id: str,
    body: TransferReject,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    t = await _lock_transfer(db, transfer_id, ref_number=body.ref_number)

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

    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="rejected",
        action="Transfer rejected",
        detail=f"Transfer rejected by {body.rejected_by}",
    )
    await db.commit()
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
                    qty=int(entry.get("consumed") or 0),
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
    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="received",
        action="Transfer received",
        detail=f"Transfer received by {body.received_by}",
    )
    await db.commit()
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

    _log_transfer_history(
        db,
        user=user,
        transfer_id=transfer_id,
        transfer_number=t.ref_number,
        event_type="cancelled",
        action="delete_transfer",
        detail=f"Transfer {t.ref_number} deleted",
        metadata={"reason": "deleted"},
        risk="medium",
    )
    await db.delete(t)
    await db.commit()
    return {"status": "deleted", "ref_number": ref_number}

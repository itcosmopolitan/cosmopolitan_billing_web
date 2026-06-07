import re
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.document_numbering import (
    _counter_key,
    allocate_number,
    get_config,
)
from src.models import DocumentNumberCounter
from src.models import (
    AdjustmentRequest,
    AdjustmentStatus,
    Branch,
    ItemBatch,
    ItemStock,
    StockAdjustment,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._stock_adjust_apply import apply_stock_adjustment
from src.security import require_perm

router = APIRouter()


class AdjustmentCreate(BaseModel):
    branch_id: str
    item_id: str
    item_name: str
    new_qty: int
    reason: str
    notes: Optional[str] = None
    batch_id: Optional[str] = None
    requested_by: str = "Staff"


class AdjustmentReject(BaseModel):
    rejected_by: str = "Manager"
    rejection_notes: Optional[str] = None
    ref_number: str


class AdjustmentApprove(BaseModel):
    approved_by: str = "Manager"
    ref_number: str


def _serialize(ar: AdjustmentRequest) -> dict:
    status = ar.status.value if hasattr(ar.status, "value") else str(ar.status)
    created = ar.created_at
    resolved = ar.resolved_at
    resolved_by = None
    if status == "approved":
        resolved_by = ar.approved_by
    elif status == "rejected":
        resolved_by = ar.rejected_by
    return {
        "id": ar.id,
        "ref_number": ar.ref_number,
        "number": ar.ref_number,
        "branch_id": ar.branch_id,
        "branch_name": ar.branch_name,
        "item_id": ar.item_id,
        "item_name": ar.item_name,
        "before_qty": ar.before_qty,
        "new_qty": ar.new_qty,
        "delta": (ar.new_qty or 0) - (ar.before_qty or 0),
        "reason": ar.reason,
        "notes": ar.notes,
        "batch_id": ar.batch_id,
        "status": status,
        "requested_by": ar.requested_by,
        "requested_at": created.isoformat() if created else None,
        "approved_by": ar.approved_by,
        "rejected_by": ar.rejected_by,
        "resolved_by": resolved_by,
        "resolved_at": resolved.isoformat() if resolved else None,
        "rejection_notes": ar.rejection_notes,
        "created_at": created.isoformat() if created else None,
        "date": created.strftime("%Y-%m-%d") if created else None,
    }


_VALID_STATUSES = {s.value for s in AdjustmentStatus}


_REF_SEQ_TAIL = re.compile(r"(\d+)$")


def _max_adj_seq_from_refs(refs: list[str]) -> int:
    max_seq = 0
    for ref in refs:
        m = _REF_SEQ_TAIL.search(ref or "")
        if m:
            max_seq = max(max_seq, int(m.group(1)))
    return max_seq


async def _sync_adjustment_counter(db: AsyncSession, branch_id: str) -> None:
    """Bump this branch's ADJ counter past its existing refs."""
    cfg = await get_config(db, "stock_adjustment")
    if not cfg:
        return
    scope = cfg.scope or "per_branch"
    rows = (
        await db.execute(
            select(AdjustmentRequest.ref_number).where(
                AdjustmentRequest.branch_id == branch_id
            )
        )
    ).scalars().all()
    max_seq = _max_adj_seq_from_refs(list(rows))
    if max_seq == 0:
        return
    key = _counter_key("stock_adjustment", scope, branch_id)
    counter = (
        await db.execute(
            select(DocumentNumberCounter).where(DocumentNumberCounter.id == key)
        )
    ).scalar_one_or_none()
    next_needed = max_seq + 1
    branch_key = None if scope == "centralised" else branch_id
    if not counter:
        counter = DocumentNumberCounter(
            id=key,
            doc_type="stock_adjustment",
            branch_id=branch_key,
            next_seq=next_needed,
        )
        db.add(counter)
    elif int(counter.next_seq or 1) <= max_seq:
        counter.next_seq = next_needed
    await db.flush()


async def _ref_number_taken(
    db: AsyncSession, branch_id: str, ref_number: str
) -> bool:
    row = await db.execute(
        select(AdjustmentRequest.id)
        .where(
            AdjustmentRequest.branch_id == branch_id,
            AdjustmentRequest.ref_number == ref_number,
        )
        .limit(1)
    )
    return row.scalar_one_or_none() is not None


async def _allocate_adjustment_ref(db: AsyncSession, branch_id: str) -> str:
    """Reserve an ADJ reference number unique within the branch."""
    await _sync_adjustment_counter(db, branch_id)
    for _ in range(30):
        ref = await allocate_number(db, "stock_adjustment", branch_id=branch_id)
        if not await _ref_number_taken(db, branch_id, ref):
            return ref
        await _sync_adjustment_counter(db, branch_id)
    raise HTTPException(
        500,
        "Could not allocate a unique adjustment reference number",
    )


async def _lock_request(
    db: AsyncSession, request_id: str, *, ref_number: str
) -> AdjustmentRequest:
    """Load a request row with FOR UPDATE to block concurrent approve/reject/delete."""
    ar = (
        await db.execute(
            select(AdjustmentRequest)
            .where(AdjustmentRequest.id == request_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if not ar:
        raise HTTPException(404, "Adjustment request not found")
    if ar.ref_number != ref_number:
        raise HTTPException(400, "Adjustment reference number does not match")
    return ar


async def _snapshot_before_qty(
    db: AsyncSession, *, item_id: str, branch_id: str, batch_id: Optional[str]
) -> int:
    if batch_id:
        row = await db.execute(
            select(ItemBatch.quantity).where(ItemBatch.id == batch_id)
        )
        return int(row.scalar() or 0)
    row = await db.execute(
        select(ItemStock.quantity).where(
            ItemStock.item_id == item_id,
            ItemStock.branch_id == branch_id,
        )
    )
    return int(row.scalar() or 0)


@router.get("/", dependencies=[Depends(require_perm("adjustments.view"))])
async def list_adjustments(
    status: Optional[str] = None,
    branch_id: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    if status is not None and status not in _VALID_STATUSES:
        raise HTTPException(400, f"Invalid status; use one of: {', '.join(sorted(_VALID_STATUSES))}")

    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    sort_expr = resolve_sort(
        sort_by,
        sort_order,
        {
            "ref_number": AdjustmentRequest.ref_number,
            "branch_id": AdjustmentRequest.branch_id,
            "status": AdjustmentRequest.status,
            "requested_by": AdjustmentRequest.requested_by,
            "created_at": AdjustmentRequest.created_at,
            "item_name": AdjustmentRequest.item_name,
        },
        default_key="created_at",
        default_order="desc",
    )
    q = select(AdjustmentRequest).order_by(sort_expr)
    cq = select(func.count(AdjustmentRequest.id))
    if status:
        q = q.where(AdjustmentRequest.status == status)
        cq = cq.where(AdjustmentRequest.status == status)
    if branch_id:
        q = q.where(AdjustmentRequest.branch_id == branch_id)
        cq = cq.where(AdjustmentRequest.branch_id == branch_id)
    total = int((await db.execute(cq)).scalar() or 0)
    rows = (await db.execute(q.offset(sk).limit(lim))).scalars().all()
    return paged([_serialize(ar) for ar in rows], total, sk, lim)


@router.post("/", status_code=201, dependencies=[Depends(require_perm("adjustments.create"))])
async def create_adjustment(data: AdjustmentCreate, db: AsyncSession = Depends(get_db)):
    if data.new_qty < 0:
        raise HTTPException(400, "new_qty must be >= 0")

    branch_name = (
        await db.execute(
            select(Branch.name).where(Branch.id == data.branch_id)
        )
    ).scalar_one_or_none()
    if not branch_name:
        raise HTTPException(400, "Branch not found")

    before = await _snapshot_before_qty(
        db,
        item_id=data.item_id,
        branch_id=data.branch_id,
        batch_id=data.batch_id,
    )

    last_err: Exception | None = None
    for _attempt in range(5):
        rid = str(uuid.uuid4())
        try:
            ref = await _allocate_adjustment_ref(db, data.branch_id)
        except HTTPException:
            raise
        ar = AdjustmentRequest(
            id=rid,
            ref_number=ref,
            branch_id=data.branch_id,
            branch_name=branch_name,
            item_id=data.item_id,
            item_name=data.item_name,
            before_qty=before,
            new_qty=int(data.new_qty),
            reason=data.reason,
            notes=data.notes,
            batch_id=data.batch_id,
            status=AdjustmentStatus.pending,
            requested_by=data.requested_by,
        )
        db.add(ar)
        try:
            await db.commit()
            return {"id": rid, "ref_number": ref, "status": "pending"}
        except IntegrityError as exc:
            await db.rollback()
            last_err = exc
            if "ref_number" not in str(exc).lower() and "unique" not in str(
                exc
            ).lower():
                raise HTTPException(409, "Adjustment request already exists") from exc

    raise HTTPException(
        500,
        "Could not allocate a unique adjustment reference number",
    ) from last_err


@router.post("/{request_id}/approve", dependencies=[Depends(require_perm("adjustments.approve"))])
async def approve_adjustment(
    request_id: str,
    body: AdjustmentApprove,
    db: AsyncSession = Depends(get_db),
):
    ar = await _lock_request(db, request_id, ref_number=body.ref_number)

    if ar.status == AdjustmentStatus.approved:
        await db.commit()
        return {
            "status": "approved",
            "ref_number": ar.ref_number,
            "approved_by": ar.approved_by,
            "already_processed": True,
        }
    if ar.status != AdjustmentStatus.pending:
        raise HTTPException(400, f"Request is already {ar.status.value}")

    try:
        await apply_stock_adjustment(
            db,
            item_id=ar.item_id,
            branch_id=ar.branch_id,
            new_qty=ar.new_qty,
            reason=ar.reason or "Adjustment",
            notes=ar.notes,
            batch_id=ar.batch_id,
        )
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    audit = StockAdjustment(
        id=str(uuid.uuid4()),
        item_id=ar.item_id,
        branch_id=ar.branch_id,
        before_qty=ar.before_qty,
        after_qty=ar.new_qty,
        reason=ar.reason,
        notes=ar.notes,
        adjusted_by=body.approved_by,
        request_id=ar.id,
    )
    db.add(audit)
    ar.status = AdjustmentStatus.approved
    ar.approved_by = body.approved_by
    ar.resolved_at = datetime.utcnow()
    await db.commit()
    return {"status": "approved", "ref_number": ar.ref_number, "approved_by": body.approved_by}


@router.post("/{request_id}/reject", dependencies=[Depends(require_perm("adjustments.approve"))])
async def reject_adjustment(
    request_id: str,
    body: AdjustmentReject,
    db: AsyncSession = Depends(get_db),
):
    ar = await _lock_request(db, request_id, ref_number=body.ref_number)

    if ar.status == AdjustmentStatus.rejected:
        await db.commit()
        return {
            "status": "rejected",
            "ref_number": ar.ref_number,
            "already_processed": True,
        }
    if ar.status != AdjustmentStatus.pending:
        raise HTTPException(400, f"Request is already {ar.status.value}")

    ar.status = AdjustmentStatus.rejected
    ar.rejected_by = body.rejected_by
    ar.rejection_notes = body.rejection_notes
    ar.resolved_at = datetime.utcnow()
    await db.commit()
    return {"status": "rejected", "ref_number": ar.ref_number}


@router.delete("/{request_id}", dependencies=[Depends(require_perm("adjustments.delete"))])
async def delete_adjustment(
    request_id: str,
    ref_number: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
):
    """Remove a pending adjustment request.

    Only pending requests may be deleted — approved requests have already
    changed stock and have an audit log; rejected requests are kept for history.
    """
    ar = await _lock_request(db, request_id, ref_number=ref_number)
    if ar.status != AdjustmentStatus.pending:
        status = ar.status.value if hasattr(ar.status, "value") else str(ar.status)
        if ar.status == AdjustmentStatus.approved:
            raise HTTPException(
                400,
                "Approved adjustments cannot be deleted — stock was already updated. "
                "Submit a new adjustment to reverse if needed.",
            )
        raise HTTPException(
            400,
            f"Only pending adjustments can be deleted; this request is {status}",
        )

    await db.delete(ar)
    await db.commit()
    return {"status": "deleted", "ref_number": ref_number}

import json
import re
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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
    AuditLog,
    Branch,
    ItemBatch,
    ItemStock,
    StockAdjustment,
    User,
)
from src.pagination import normalize_limit, normalize_skip, paged, resolve_sort
from src.routes._stock_adjust_apply import apply_stock_adjustment
from src.routes._approval import can_direct_commit
from src.security import current_user, enforce_branch_access, enforce_branch_access_optional, require_perm
from src.routes._serializers import get_user_branch_ids
from src.services.audit_service import build_audit_entry

router = APIRouter()

_REF_SEQ_TAIL = re.compile(r"(\d+)$")
_VALID_STATUSES = {status.value for status in AdjustmentStatus}


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


def _log_adjustment_history(
    db: AsyncSession,
    *,
    user: User,
    adjustment_id: str,
    adjustment_number: str,
    event_type: str,
    action: str,
    detail: str,
    branch_id: Optional[str] = None,
    metadata: Optional[dict] = None,
    risk: str = "low",
) -> None:
    role = None
    if user is not None:
        role = user.role.value if hasattr(user.role, "value") else str(user.role)

    db.add(AuditLog(
        id=str(uuid.uuid4()),
        record_type="stock_adjustment",
        record_id=adjustment_id,
        event_type=event_type,
        event_metadata=json.dumps(metadata or {}, default=str),
        action=action,
        user_id=user.id if user is not None else None,
        user_name=user.name if user is not None else None,
        user_role=role or "unknown",
        module="inventory",
        reference_id=adjustment_number,
        ref=adjustment_number,
        detail=detail,
        risk=risk,
        branch_id=branch_id,
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


def _raise_adjustment_integrity_error(exc: IntegrityError) -> None:
    """Map low-level DB integrity errors to actionable API responses."""
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    constraint = (getattr(diag, "constraint_name", "") or "").lower()
    msg = str(exc).lower()

    if (
        "uq_adj_branch_ref" in constraint
        or "uq_adj_branch_ref" in msg
        or ("unique" in msg and "ref_number" in msg)
    ):
        raise HTTPException(
            409,
            "Duplicate adjustment reference generated. Please retry.",
        ) from exc

    if (
        "adjustment_requests_branch_id_fkey" in constraint
        or ("foreign key" in msg and "branch_id" in msg)
    ):
        raise HTTPException(400, "Branch not found") from exc

    if (
        "adjustment_requests_item_id_fkey" in constraint
        or ("foreign key" in msg and "item_id" in msg)
    ):
        raise HTTPException(400, "Item not found") from exc

    raise HTTPException(
        400,
        "Could not create adjustment request due to invalid data",
    ) from exc


@router.get("/", dependencies=[Depends(require_perm("adjustments.view"))])
async def list_adjustments(
    status: Optional[str] = None,
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "desc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
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
    elif not getattr(user, "all_branches", False):
        branch_ids = await get_user_branch_ids(db, user.id)
        if not branch_ids:
            return paged([], 0, sk, lim)
        q = q.where(AdjustmentRequest.branch_id.in_(branch_ids))
        cq = cq.where(AdjustmentRequest.branch_id.in_(branch_ids))
    total = int((await db.execute(cq)).scalar() or 0)
    rows = (await db.execute(q.offset(sk).limit(lim))).scalars().all()
    return paged([_serialize(ar) for ar in rows], total, sk, lim)


async def _approve_adjustment_record(
    db: AsyncSession,
    ar: AdjustmentRequest,
    *,
    approved_by: str,
) -> dict:
    """Apply stock and mark an adjustment request approved."""
    if ar.status == AdjustmentStatus.approved:
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
        adjusted_by=approved_by,
        request_id=ar.id,
    )
    db.add(audit)
    ar.status = AdjustmentStatus.approved
    ar.approved_by = approved_by
    ar.resolved_at = datetime.utcnow()
    return {"status": "approved", "ref_number": ar.ref_number, "approved_by": approved_by}


@router.post("/", status_code=201, dependencies=[Depends(require_perm("adjustments.create"))])
async def create_adjustment(
    data: AdjustmentCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    if data.new_qty < 0:
        raise HTTPException(400, "new_qty must be >= 0")

    await enforce_branch_access(data.branch_id, user=user, db=db)

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
            requested_by=data.requested_by or user.name,
        )
        db.add(ar)
        _log_adjustment_history(
            db,
            user=user,
            adjustment_id=rid,
            adjustment_number=ref,
            event_type="created",
            action="Adjustment request created",
            detail=f"Created adjustment request {ref} for {data.item_name} at branch {branch_name}",
            branch_id=data.branch_id,
            metadata={
                "branch_id": data.branch_id,
                "item_name": data.item_name,
                "branch_name": branch_name,
                "reason": data.reason,
            },
        )
        try:
            await db.flush()
            if await can_direct_commit(user, db, "adjustments.approve"):
                result = await _approve_adjustment_record(
                    db, ar, approved_by=user.name,
                )
                await db.commit()
                return {"id": rid, "ref_number": ref, **result}
            from src.notifications.store import emit_adjustment_pending, notify_refresh

            await emit_adjustment_pending(db, ar)
            await db.commit()
            await notify_refresh()
            return {"id": rid, "ref_number": ref, "status": "pending"}
        except IntegrityError as exc:
            await db.rollback()
            last_err = exc
            msg = str(exc).lower()
            if "uq_adj_branch_ref" in msg or (
                "ref_number" in msg and "unique" in msg
            ):
                continue
            _raise_adjustment_integrity_error(exc)

    raise HTTPException(
        409,
        "Could not allocate a unique adjustment reference number. Please retry.",
    ) from last_err


@router.post("/{request_id}/approve", dependencies=[Depends(require_perm("adjustments.approve"))])
async def approve_adjustment(
    request_id: str,
    body: AdjustmentApprove,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    ar = await _lock_request(db, request_id, ref_number=body.ref_number)

    if ar.requested_by and ar.requested_by == user.name and ar.status == AdjustmentStatus.pending:
        raise HTTPException(403, "You cannot approve your own adjustment request")

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
    await _write_post_commit_audit(
        db,
        action="Stock Adjustment",
        reference_id=ar.ref_number,
        detail=f"Adjustment {ar.ref_number} for {ar.item_name} approved by {body.approved_by}",
        user=user,
        request=request,
        branch_id=ar.branch_id,
        metadata={
            "adjustment_id": request_id,
            "adjustment_number": ar.ref_number,
            "event_type": "approved",
            "item_id": ar.item_id,
        },
    )
    _log_adjustment_history(
        db,
        user=user,
        adjustment_id=request_id,
        adjustment_number=ar.ref_number,
        event_type="qty_changed",
        action="Adjustment quantity changed",
        detail=f"Adjustment {ar.ref_number} qty changed from {ar.before_qty} to {ar.new_qty}",
        metadata={"field": "qty", "old": ar.before_qty, "new": ar.new_qty},
    )
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.adjustment_pending:{ar.id}")
    await db.commit()
    await notify_refresh()
    return {"status": "approved", "ref_number": ar.ref_number, "approved_by": body.approved_by}


@router.post("/{request_id}/reject", dependencies=[Depends(require_perm("adjustments.approve"))])
async def reject_adjustment(
    request_id: str,
    body: AdjustmentReject,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
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

    _log_adjustment_history(
        db,
        user=user,
        adjustment_id=request_id,
        adjustment_number=ar.ref_number,
        event_type="rejected",
        action="Adjustment rejected",
        detail=f"Adjustment {ar.ref_number} for {ar.item_name} rejected by {body.rejected_by}",
        branch_id=ar.branch_id,
        metadata={
            "item_name": ar.item_name,
            "branch_name": ar.branch_name,
            "reason": ar.reason,
            "rejection_notes": body.rejection_notes,
        },
    )
    from src.notifications.store import notify_refresh, resolve_notification

    await resolve_notification(db, f"approval.adjustment_pending:{ar.id}")
    await db.commit()
    await notify_refresh()
    return {"status": "rejected", "ref_number": ar.ref_number}


@router.delete("/{request_id}", dependencies=[Depends(require_perm("adjustments.delete"))])
async def delete_adjustment(
    request_id: str,
    ref_number: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
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

    _log_adjustment_history(
        db,
        user=user,
        adjustment_id=request_id,
        adjustment_number=ar.ref_number,
        event_type="cancelled",
        action="delete_adjustment",
        detail=f"Adjustment {ar.ref_number} for {ar.item_name} deleted",
        branch_id=ar.branch_id,
        metadata={
            "item_name": ar.item_name,
            "branch_name": ar.branch_name,
            "reason": "deleted",
        },
        risk="medium",
    )
    await db.delete(ar)
    await db.commit()
    return {"status": "deleted", "ref_number": ref_number}

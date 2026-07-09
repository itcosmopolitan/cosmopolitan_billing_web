from __future__ import annotations

import json
import csv
import io
import uuid
from datetime import date, datetime, time, timedelta
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import AuditLog, User
from src.schemas.audit import AuditLogCreate, AuditLogListResponse, AuditLogRead
from src.security import current_user, require_perm
from src.services.audit_service import build_audit_entry

router = APIRouter()


def _as_read_model(log: AuditLog) -> AuditLogRead:
    event_metadata = None
    if log.event_metadata:
        try:
            event_metadata = json.loads(log.event_metadata)
        except ValueError:
            event_metadata = None

    return AuditLogRead(
        id=str(log.id),
        action=log.action,
        user_id=log.user_id,
        user_name=log.user_name,
        user_role=log.user_role,
        module=log.module,
        reference_id=log.reference_id or log.ref,
        detail=log.detail,
        risk=(log.risk or "LOW").upper(),
        ip_address=log.ip_address,
        device_info=log.device_info,
        branch_id=log.branch_id,
        event_metadata=event_metadata if isinstance(event_metadata, dict) else None,
        metadata_=log.metadata_ if isinstance(log.metadata_, dict) else None,
        created_at=log.created_at,
    )


def _to_datetime_bounds(date_from: Optional[date], date_to: Optional[date]) -> Tuple[Optional[datetime], Optional[datetime]]:
    start_dt = None
    end_dt = None
    if date_from:
        start_dt = datetime.combine(date_from, time.min)
    if date_to:
        end_dt = datetime.combine(date_to + timedelta(days=1), time.min)
    return start_dt, end_dt


def _build_operation_type_filter(operation_type: str):
    key = operation_type.strip().lower()
    action = func.lower(AuditLog.action)
    if key == "created":
        return or_(action.ilike("%create%"), action.ilike("%created%"))
    if key == "deleted":
        return or_(action.ilike("%delete%"), action.ilike("%deleted%"))
    if key == "edited" or key == "updated":
        return or_(action.ilike("%edit%"), action.ilike("%edited%"), action.ilike("%update%"), action.ilike("%updated%"))
    return action == key


@router.get("/", response_model=AuditLogListResponse, dependencies=[Depends(require_perm("audit.view"))])
async def list_audit_logs(
    module: Optional[str] = Query(None),
    risk: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    branch_id: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    operation_type: Optional[str] = Query(None),
    operation_type_not: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(AuditLog)
    count_stmt = select(func.count()).select_from(AuditLog)

    filters = []

    if module:
        filters.append(func.lower(AuditLog.module) == module.lower())
    if risk:
        filters.append(func.upper(AuditLog.risk) == risk.upper())
    if user_id:
        filters.append(AuditLog.user_id == user_id)
    if branch_id:
        filters.append(AuditLog.branch_id == branch_id)

    start_dt, end_dt = _to_datetime_bounds(date_from, date_to)
    if start_dt is not None:
        filters.append(AuditLog.created_at >= start_dt)
    if end_dt is not None:
        filters.append(AuditLog.created_at < end_dt)

    if operation_type:
        filters.append(_build_operation_type_filter(operation_type))
    if operation_type_not:
        filters.append(~_build_operation_type_filter(operation_type_not))

    if search:
        pattern = f"%{search.strip()}%"
        filters.append(
            or_(
                AuditLog.action.ilike(pattern),
                AuditLog.detail.ilike(pattern),
                AuditLog.reference_id.ilike(pattern),
                AuditLog.ref.ilike(pattern),
                AuditLog.user_name.ilike(pattern),
            )
        )

    if filters:
        stmt = stmt.where(*filters)
        count_stmt = count_stmt.where(*filters)

    total = (await db.execute(count_stmt)).scalar_one()
    rows = (
        (
            await db.execute(
                stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
                .offset((page - 1) * limit)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    return AuditLogListResponse(
        total=total,
        page=page,
        limit=limit,
        results=[_as_read_model(row) for row in rows],
    )


@router.get("/export/csv", dependencies=[Depends(require_perm("audit.view"))])
async def export_csv(
    module: Optional[str] = Query(None),
    risk: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    branch_id: Optional[str] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    # Reuse the same server-side filtering semantics as list endpoint.
    response = await list_audit_logs(
        module=module,
        risk=risk,
        user_id=user_id,
        branch_id=branch_id,
        date_from=date_from,
        date_to=date_to,
        search=search,
        page=1,
        limit=200,
        db=db,
    )

    def _iter_csv_rows():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(
            [
                "id",
                "created_at",
                "action",
                "user_name",
                "user_role",
                "module",
                "reference_id",
                "detail",
                "risk",
                "ip_address",
                "device_info",
            ]
        )
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for item in response.results:
            writer.writerow(
                [
                    item.id,
                    item.created_at.isoformat(),
                    item.action,
                    item.user_name,
                    item.user_role,
                    item.module,
                    item.reference_id,
                    item.detail,
                    item.risk,
                    item.ip_address,
                    item.device_info,
                ]
            )
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    return StreamingResponse(
        _iter_csv_rows(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=audit_log.csv"},
    )


@router.get("/{log_id}", response_model=AuditLogRead, dependencies=[Depends(require_perm("audit.view"))])
async def get_audit_log(log_id: str, db: AsyncSession = Depends(get_db)):
    row = (await db.execute(select(AuditLog).where(AuditLog.id == log_id))).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Audit log not found")

    return _as_read_model(row)


@router.post("/", response_model=AuditLogRead, status_code=201)
async def create_audit_log(
    payload: AuditLogCreate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(current_user),
):
    # Internal-only behavior: authenticated users with audit.view can write;
    # risk is always re-classified server-side and never trusted from payload.
    user_role = actor.role.value if hasattr(actor.role, "value") else str(actor.role)
    if user_role not in {"super_admin", "branch_manager", "finance", "purchase_admin"}:
        raise HTTPException(status_code=403, detail="Not allowed to write audit entries")

    entry_data = build_audit_entry(
        action=payload.action,
        module=payload.module.value if hasattr(payload.module, "value") else str(payload.module),
        reference_id=payload.reference_id,
        detail=payload.detail,
        user_id=payload.user_id,
        user_name=payload.user_name,
        user_role=payload.user_role,
        ip_address=payload.ip_address,
        device_info=payload.device_info,
        branch_id=payload.branch_id,
        metadata=payload.metadata_,
    )

    log = AuditLog(id=str(uuid.uuid4()), **entry_data)
    db.add(log)
    await db.commit()
    await db.refresh(log)
    return _as_read_model(log)

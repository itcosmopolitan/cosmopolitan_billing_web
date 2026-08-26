from __future__ import annotations

import json
import csv
import io
import uuid
from datetime import date, datetime, time, timedelta
from typing import Any, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.models import AuditLog, User
from src.schemas.audit import AuditLogCreate, AuditLogListResponse, AuditLogRead
from src.security import current_user, enforce_branch_access, enforce_branch_access_optional, get_allowed_branch_ids, require_perm
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


def _coerce_query_value(value):
    """FastAPI can hand routed Query(...)/Depends(...) objects to internal calls.
    When a route function is invoked directly, normalize those placeholders to
    their default values so internal callers can reuse the same logic safely.
    """
    if hasattr(value, "default") and value.default is not None:
        return value.default
    if hasattr(value, "default") and value.default is None:
        return None
    return value


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


def _build_text_field_filter(column, condition: str, value: str):
    condition = (condition or "contains").strip().lower()
    value = (value or "").strip()
    if condition == "is empty":
        return or_(column.is_(None), column == "")
    if not value:
        return None
    if condition == "contains":
        return column.ilike(f"%{value}%")
    if condition == "is":
        return func.lower(column) == value.lower()
    if condition == "starts with":
        return column.ilike(f"{value}%")
    return None


def _build_criteria_row_filter(row: dict[str, Any]):
    field = (row.get("field") or "").strip()
    condition = (row.get("condition") or "is").strip().lower()
    value = (row.get("value") or "").strip()

    if field == "module":
        if not value and condition != "is empty":
            return None
        col = func.lower(AuditLog.module)
        if condition == "is":
            return col == value.lower()
        if condition == "is not":
            return col != value.lower()
        return None

    if field == "risk":
        if not value and condition != "is empty":
            return None
        col = func.upper(AuditLog.risk)
        if condition == "is":
            return col == value.upper()
        if condition == "is not":
            return col != value.upper()
        return None

    if field == "action":
        if not value and condition != "is empty":
            return None
        if condition == "is":
            return _build_operation_type_filter(value)
        if condition == "is not":
            return ~_build_operation_type_filter(value)
        return None

    if field == "user_name":
        return _build_text_field_filter(AuditLog.user_name, condition, value)

    if field in {"customer_name", "vendor_name"}:
        return _build_text_field_filter(AuditLog.detail, condition, value)

    return None


def _parse_criteria_payload(raw: Optional[str]) -> Optional[dict[str, Any]]:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    rows = parsed.get("rows")
    if not isinstance(rows, list) or not rows:
        return None
    joiners = parsed.get("joiners") or []
    if not isinstance(joiners, list):
        joiners = []
    return {"rows": rows, "joiners": joiners}


def _combine_criteria_filters(rows: list[dict[str, Any]], joiners: list[Any]):
    result = None

    for index, row in enumerate(rows):
        clause = _build_criteria_row_filter(row)
        if clause is None:
            continue
        if result is None:
            result = clause
            continue

        joiner = "and"
        if index > 0 and (index - 1) < len(joiners):
            joiner = str(joiners[index - 1]).strip().lower()
        if joiner == "or":
            result = or_(result, clause)
        else:
            result = and_(result, clause)

    return result


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
    criteria: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    module = _coerce_query_value(module)
    risk = _coerce_query_value(risk)
    user_id = _coerce_query_value(user_id)
    branch_id = _coerce_query_value(branch_id)
    date_from = _coerce_query_value(date_from)
    date_to = _coerce_query_value(date_to)
    operation_type = _coerce_query_value(operation_type)
    operation_type_not = _coerce_query_value(operation_type_not)
    criteria = _coerce_query_value(criteria)
    search = _coerce_query_value(search)

    criteria_payload = _parse_criteria_payload(criteria)

    if branch_id:
        branch_id = await enforce_branch_access_optional(branch_id, user=user, db=db)

    stmt = select(AuditLog)
    count_stmt = select(func.count()).select_from(AuditLog)

    filters = []

    if criteria_payload:
        criteria_filter = _combine_criteria_filters(criteria_payload["rows"], criteria_payload["joiners"])
        if criteria_filter is not None:
            filters.append(criteria_filter)
    else:
        if module:
            filters.append(func.lower(AuditLog.module) == module.lower())
        if risk:
            filters.append(func.upper(AuditLog.risk) == risk.upper())

        if operation_type:
            filters.append(_build_operation_type_filter(operation_type))
        if operation_type_not:
            filters.append(~_build_operation_type_filter(operation_type_not))
    if user_id:
        filters.append(AuditLog.user_id == user_id)
    if branch_id:
        filters.append(AuditLog.branch_id == branch_id)

    start_dt, end_dt = _to_datetime_bounds(date_from, date_to)
    if start_dt is not None:
        filters.append(AuditLog.created_at >= start_dt)
    if end_dt is not None:
        filters.append(AuditLog.created_at < end_dt)

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
    branch_id: Optional[str] = Depends(enforce_branch_access_optional),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    operation_type: Optional[str] = Query(None),
    operation_type_not: Optional[str] = Query(None),
    criteria: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(current_user),
):
    # Reuse the same server-side filtering semantics as list endpoint.
    response = await list_audit_logs(
        module=module,
        risk=risk,
        user_id=user_id,
        branch_id=branch_id,
        date_from=date_from,
        date_to=date_to,
        operation_type=operation_type,
        operation_type_not=operation_type_not,
        criteria=criteria,
        search=search,
        page=1,
        limit=200,
        db=db,
        user=user,
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
async def get_audit_log(log_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(current_user)):
    row = (await db.execute(select(AuditLog).where(AuditLog.id == log_id))).scalars().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Audit log not found")
    if row.branch_id:
        await enforce_branch_access(row.branch_id, user=user, db=db)
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

    if payload.branch_id:
        await enforce_branch_access(payload.branch_id, user=actor, db=db)

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

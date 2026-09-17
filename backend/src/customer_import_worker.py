"""Database-backed worker for asynchronous customer imports."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta
from io import BytesIO

import openpyxl
from sqlalchemy import and_, or_, select

from src.database import get_async_session, init_schema
from src.models import Customer, CustomerImportJob
from src.routes.customers import (
    _compose_address_from_parts,
    _normalize_classification,
    _normalize_customer_type,
)
from src.routes._serializers import _build_customer_code

logger = logging.getLogger("cosmopolitan.customer_import_worker")

_MAP_KEYS = {
    "name": "name", "customer name": "name", "phone": "phone", "email": "email",
    "gst reg no": "gst_in", "gst number": "gst_in", "gstin": "gst_in",
    "street 1": "street1", "street1": "street1", "street 2": "street2", "street2": "street2",
    "street 3": "street3", "street3": "street3", "city": "city",
    "state/province": "state_province", "state province": "state_province",
    "country": "country", "postal code": "postal_code", "postal_code": "postal_code",
    "credit limit": "credit_limit", "customer type": "customer_type",
    "classification": "classification", "internal/external": "classification",
    "key account manager": "key_account_manager", "credit terms": "credit_terms",
}


def _as_text(value):
    if value is None:
        return None
    return value.strip() if isinstance(value, str) else str(value).strip()


async def claim_job() -> CustomerImportJob | None:
    session_factory = get_async_session()
    stale_before = datetime.utcnow() - timedelta(minutes=5)
    async with session_factory() as db:
        async with db.begin():
            result = await db.execute(
                select(CustomerImportJob)
                .where(
                    or_(
                        CustomerImportJob.status == "queued",
                        and_(
                            CustomerImportJob.status == "processing",
                            or_(
                                CustomerImportJob.started_at.is_(None),
                                CustomerImportJob.started_at < stale_before,
                            ),
                        ),
                    )
                )
                .order_by(CustomerImportJob.created_at)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            job = result.scalar_one_or_none()
            if not job:
                return None
            job.status = "processing"
            job.started_at = datetime.utcnow()
            await db.flush()
            await db.refresh(job)
            return job


async def update_progress(job_id: str, **values) -> None:
    session_factory = get_async_session()
    async with session_factory() as db:
        job = await db.get(CustomerImportJob, job_id)
        if not job:
            return
        for key, value in values.items():
            setattr(job, key, value)
        if values.get("status") not in {"completed", "failed"}:
            job.started_at = datetime.utcnow()
        await db.commit()


async def process_customer_import(job: CustomerImportJob, db, progress_callback) -> dict:
    try:
        workbook = await asyncio.to_thread(
            openpyxl.load_workbook, BytesIO(job.file_data), data_only=True
        )
        rows = list(workbook.active.iter_rows(values_only=True))
    except Exception as exc:
        raise RuntimeError(f"Failed to read Excel file: {exc}") from exc

    if not rows or len(rows) < 2:
        raise RuntimeError("Spreadsheet must have a header row and at least one data row")

    headers = [str(value).strip().lower() if value is not None else None for value in rows[0]]
    total_rows = len(rows) - 1
    branch_id = job.branch_id
    created = 0
    errors = []
    await progress_callback(processed_rows=0, total_rows=total_rows, created=0, skipped=0, errors=[])

    for idx, row in enumerate(rows[1:], start=2):
        try:
            data = {}
            for col_idx, cell in enumerate(row):
                key = headers[col_idx] if col_idx < len(headers) else None
                mapped = _MAP_KEYS.get(key) if key else None
                if mapped:
                    data[mapped] = cell

            name = _as_text(data.get("name"))
            if not name:
                raise ValueError("Customer name is required")
            city = _as_text(data.get("city"))
            if not city:
                raise ValueError("Required field(s) missing: city")

            customer_type = _normalize_customer_type(_as_text(data.get("customer_type")) or "retail")
            classification = _normalize_classification(_as_text(data.get("classification")) or "external")
            if customer_type == "retail":
                credit_limit = 0.0
                credit_terms = None
            else:
                credit_limit = float(data.get("credit_limit") if data.get("credit_limit") not in (None, "") else 10000)
                credit_terms = _as_text(data.get("credit_terms")) or None

            customer_id = str(uuid.uuid4())
            customer = Customer(
                id=customer_id,
                name=name,
                phone=_as_text(data.get("phone")) or None,
                email=_as_text(data.get("email")) or None,
                gstin=_as_text(data.get("gst_in")) or None,
                branch_id=branch_id,
                credit_limit=credit_limit,
                type=customer_type,
                classification=classification,
                key_account_manager=_as_text(data.get("key_account_manager")) or None,
                credit_terms=credit_terms,
                street1=_as_text(data.get("street1")) or None,
                street2=_as_text(data.get("street2")) or None,
                street3=_as_text(data.get("street3")) or None,
                city=city,
                state_province=_as_text(data.get("state_province")) or None,
                country=_as_text(data.get("country")) or None,
                postal_code=_as_text(data.get("postal_code")) or None,
            )
            customer.address = _compose_address_from_parts(customer)
            customer.customer_code = _build_customer_code(customer_id)
            db.add(customer)
            await db.flush()
            await db.commit()
            created += 1
        except Exception as exc:
            await db.rollback()
            errors.append({"row": idx, "error": str(exc)})

        await progress_callback(
            processed_rows=idx - 1,
            total_rows=total_rows,
            created=created,
            skipped=len(errors),
            errors=errors,
        )

    return {"total_rows": total_rows, "created": created, "skipped": len(errors), "errors": errors}


async def run_job(job: CustomerImportJob) -> None:
    session_factory = get_async_session()
    async with session_factory() as db:
        job = await db.get(CustomerImportJob, job.id)
        if not job:
            raise RuntimeError("Customer import job no longer exists")
        job_id = job.id

        async def progress_callback(**values):
            await update_progress(job_id, **values)

        result = await process_customer_import(job, db, progress_callback)
        job.status = "completed"
        job.total_rows = result["total_rows"]
        job.processed_rows = result["total_rows"]
        job.created_count = result["created"]
        job.skipped_count = result["skipped"]
        job.errors = result["errors"]
        job.completed_at = datetime.utcnow()
        await db.commit()


async def worker_loop(initialize_schema: bool = True) -> None:
    if initialize_schema:
        await init_schema()
    logger.info("Customer import worker started")
    while True:
        job = await claim_job()
        if not job:
            await asyncio.sleep(2)
            continue
        try:
            await run_job(job)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("Customer import job %s failed", job.id)
            await update_progress(job.id, status="failed", error_message=str(exc), completed_at=datetime.utcnow())


async def run_import_worker_loop() -> None:
    await worker_loop(initialize_schema=False)

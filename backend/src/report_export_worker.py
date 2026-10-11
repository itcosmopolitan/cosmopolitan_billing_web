"""Database-backed worker that builds full-dataset report exports (.xlsx).

Each job pages through the existing report endpoint in fixed-size pages so the
file contains every matching row, not just the page on screen. The finished
workbook is stored on the job row and kept for EXPORT_RETENTION.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi.encoders import jsonable_encoder
from sqlalchemy import and_, case, delete, or_, select

from src.database import get_async_session, init_schema
from src.models import ReportExportJob, User
from src.report_export import (
    EXPORT_RETENTION,
    ReportExportError,
    ReportExportRequest,
    apply_search,
    build_export_table,
    build_handler_kwargs,
    build_workbook,
    resolve_report_handler,
)

logger = logging.getLogger("cosmopolitan.report_export_worker")

PAGE_SIZE = 500
MAX_ATTEMPTS = 3
STALE_AFTER = timedelta(minutes=15)
CLEANUP_INTERVAL_SECONDS = 600


def _max_export_rows() -> int:
    return int(os.getenv("REPORT_EXPORT_MAX_ROWS", "100000"))


def _export_timeout_seconds() -> int:
    return int(os.getenv("REPORT_EXPORT_TIMEOUT_SECONDS", "900"))


async def claim_job() -> Optional[str]:
    session_factory = get_async_session()
    now = datetime.utcnow()
    stale_before = now - STALE_AFTER
    async with session_factory() as db:
        async with db.begin():
            result = await db.execute(
                select(ReportExportJob)
                .where(
                    or_(
                        ReportExportJob.status == "queued",
                        and_(
                            ReportExportJob.status == "processing",
                            or_(
                                ReportExportJob.started_at.is_(None),
                                ReportExportJob.started_at < stale_before,
                            ),
                        ),
                    )
                )
                .order_by(
                    case((ReportExportJob.status == "queued", 0), else_=1),
                    ReportExportJob.created_at,
                )
                .with_for_update(skip_locked=True)
                .limit(1)
            )
            job = result.scalar_one_or_none()
            if not job:
                return None
            if job.attempts >= MAX_ATTEMPTS:
                job.status = "failed"
                job.error_message = "The export was interrupted repeatedly. Please try again."
                job.completed_at = now
                await db.flush()
                return None
            job.status = "processing"
            job.attempts = (job.attempts or 0) + 1
            job.started_at = now
            await db.flush()
            return job.id


async def update_progress(job_id: str, **values: Any) -> None:
    session_factory = get_async_session()
    async with session_factory() as db:
        job = await db.get(ReportExportJob, job_id)
        if not job:
            return
        for key, value in values.items():
            setattr(job, key, value)
        if values.get("status") not in {"completed", "failed"}:
            job.started_at = datetime.utcnow()
        await db.commit()


async def _fetch_all_rows(db, endpoint, params: dict[str, Any], user: User, job_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    skip = 0
    expected_total: Optional[int] = None
    max_rows = _max_export_rows()
    while True:
        kwargs = build_handler_kwargs(
            endpoint, params, skip=skip, limit=PAGE_SIZE, db=db, user=user,
        )
        result = endpoint(**kwargs)
        if inspect.isawaitable(result):
            result = await result
        page = jsonable_encoder(result)
        if isinstance(page, list):
            rows.extend(page)
            break
        items = page.get("items") or []
        total = int(page.get("total") or 0)
        if expected_total is None:
            if total > max_rows:
                raise ReportExportError(
                    f"This report has {total:,} rows, which is over the export limit of {max_rows:,}. "
                    "Narrow the date range or filters and try again."
                )
            expected_total = total
        elif total != expected_total:
            raise ReportExportError(
                "The report changed while it was being exported. Please try again."
            )
        rows.extend(items)
        skip += PAGE_SIZE
        await update_progress(job_id, processed_rows=len(rows), total_rows=expected_total)
        if not items or skip >= expected_total:
            break
    return rows


async def run_job(job_id: str) -> None:
    session_factory = get_async_session()
    async with session_factory() as db:
        job = await db.get(ReportExportJob, job_id)
        if not job:
            raise ReportExportError("The export job no longer exists.")
        request = ReportExportRequest.model_validate(job.request_json)
        user = await db.get(User, job.user_id)
        if not user:
            raise ReportExportError("The user who requested this export no longer exists.")

        endpoint = resolve_report_handler(request.report_api)
        params = {k: v for k, v in request.params.items() if k not in {"skip", "limit"}}
        rows = await asyncio.wait_for(
            _fetch_all_rows(db, endpoint, params, user, job_id),
            timeout=_export_timeout_seconds(),
        )

    matched = apply_search(rows, request.search)
    if not matched:
        raise ReportExportError("No data available to export.")

    headers, body = build_export_table(matched, request.columns)
    payload = await asyncio.to_thread(build_workbook, headers, body, request.title, request.subtitle)

    completed_at = datetime.utcnow()
    await update_progress(
        job_id,
        status="completed",
        total_rows=len(matched),
        processed_rows=len(rows),
        file_data=payload,
        error_message=None,
        completed_at=completed_at,
        expires_at=completed_at + EXPORT_RETENTION,
    )


async def fail_job(job_id: str, message: str) -> None:
    await update_progress(
        job_id,
        status="failed",
        error_message=message,
        file_data=None,
        completed_at=datetime.utcnow(),
    )


async def cleanup_expired_exports() -> int:
    session_factory = get_async_session()
    async with session_factory() as db:
        result = await db.execute(
            delete(ReportExportJob).where(
                ReportExportJob.expires_at.is_not(None),
                ReportExportJob.expires_at < datetime.utcnow(),
            )
        )
        await db.commit()
        return result.rowcount or 0


async def worker_loop(initialize_schema: bool = True) -> None:
    if initialize_schema:
        await init_schema()
    logger.info("Report export worker started")
    loop = asyncio.get_running_loop()
    next_cleanup_at = 0.0
    while True:
        try:
            if loop.time() >= next_cleanup_at:
                removed = await cleanup_expired_exports()
                if removed:
                    logger.info("Removed %s expired report export(s)", removed)
                next_cleanup_at = loop.time() + CLEANUP_INTERVAL_SECONDS
            job_id = await claim_job()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Report export worker failed while claiming a job; retrying")
            await asyncio.sleep(5)
            continue
        if not job_id:
            await asyncio.sleep(2)
            continue
        logger.info("Processing report export job %s", job_id)
        try:
            await run_job(job_id)
            logger.info("Completed report export job %s", job_id)
        except asyncio.CancelledError:
            raise
        except ReportExportError as exc:
            logger.warning("Report export job %s rejected: %s", job_id, exc)
            await fail_job(job_id, str(exc))
        except Exception:
            logger.exception("Report export job %s failed", job_id)
            await fail_job(job_id, "The export failed. Please try again.")


async def run_report_export_worker_loop() -> None:
    """Run the job loop inside an already-started FastAPI worker process."""
    await worker_loop(initialize_schema=False)

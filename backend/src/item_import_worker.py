"""Database-backed worker for asynchronous item-master imports."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta

from sqlalchemy import and_, case, or_, select

from src import config
from src.database import get_async_session, init_schema
from src.models import ItemImportJob, User
from src.routes.items import process_item_import

logger = logging.getLogger("cosmopolitan.item_import_worker")
logging.basicConfig(level=logging.INFO)


async def claim_job() -> ItemImportJob | None:
    session_factory = get_async_session()
    stale_before = datetime.utcnow() - timedelta(minutes=10)
    async with session_factory() as db:
        async with db.begin():
            result = await db.execute(
                select(ItemImportJob)
                .where(
                    or_(
                        ItemImportJob.status == "queued",
                        and_(
                            ItemImportJob.status == "processing",
                            or_(
                                ItemImportJob.started_at.is_(None),
                                ItemImportJob.started_at < stale_before,
                            ),
                        ),
                    )
                )
                .order_by(
                    case((ItemImportJob.status == "queued", 0), else_=1),
                    ItemImportJob.created_at,
                )
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
        job = await db.get(ItemImportJob, job_id)
        if not job:
            return
        for key, value in values.items():
            setattr(job, key, value)
        if values.get("status") not in {"completed", "failed"}:
            job.started_at = datetime.utcnow()
        await db.commit()


async def run_job(job: ItemImportJob) -> None:
    session_factory = get_async_session()
    async with session_factory() as db:
        job = await db.get(ItemImportJob, job.id)
        if not job:
            raise RuntimeError("Item import job no longer exists")
        job_id = job.id
        file_data = job.file_data
        user = await db.get(User, job.user_id)
        if not user:
            raise RuntimeError("The user who created this import no longer exists")

        async def progress_callback(*, processed_rows, total_rows, created, errors):
            await update_progress(
                job_id,
                processed_rows=processed_rows,
                total_rows=total_rows,
                created_count=created,
                errors=errors,
            )

        timeout_seconds = int(os.getenv("ITEM_IMPORT_TIMEOUT_SECONDS", "900"))
        result = await asyncio.wait_for(
            process_item_import(
                file_data,
                db,
                user,
                progress_callback=progress_callback,
            ),
            timeout=timeout_seconds,
        )
        await update_progress(
            job_id,
            status="completed",
            total_rows=result.get("total_rows", 0),
            processed_rows=result.get("total_rows", 0),
            created_count=result.get("created", 0),
            errors=result.get("errors", []),
            completed_at=datetime.utcnow(),
        )


async def worker_loop(initialize_schema: bool = True) -> None:
    if initialize_schema:
        await init_schema()
    logger.info("Item import worker started")
    while True:
        try:
            job = await claim_job()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Item import worker failed while claiming a job; retrying")
            await asyncio.sleep(5)
            continue
        if not job:
            await asyncio.sleep(2)
            continue
        job_id = job.id
        logger.info("Processing item import job %s", job_id)
        try:
            await run_job(job)
            logger.info("Completed item import job %s", job_id)
        except Exception as exc:
            logger.exception("Item import job %s failed", job_id)
            await update_progress(
                job_id,
                status="failed",
                error_message=str(exc),
                completed_at=datetime.utcnow(),
            )


async def run_import_worker_loop() -> None:
    """Run the job loop inside an already-started FastAPI worker process."""
    await worker_loop(initialize_schema=False)


if __name__ == "__main__":
    config.load()
    asyncio.run(worker_loop())

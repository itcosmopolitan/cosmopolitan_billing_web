"""Full-dataset report export: formatting parity, worker paging, and job endpoints."""
from __future__ import annotations

import asyncio
import io
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from openpyxl import load_workbook
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src import report_export, report_export_worker  # noqa: E402
from src.database import Base  # noqa: E402
from src.models import Branch, ReportExportJob, User  # noqa: E402
from src.report_export import (  # noqa: E402
    REPORT_EXPORT_PATHS,
    ReportExportColumn,
    ReportExportError,
    ReportExportRequest,
    apply_search,
    build_export_table,
    build_handler_kwargs,
    build_workbook,
    export_cell_value,
    export_column_label,
    format_date,
    format_status,
    resolve_report_handler,
    safe_export_filename,
)
from src.routes import reports as reports_routes  # noqa: E402


def _col(key, label=None, format=None, summable=False):
    return ReportExportColumn(key=key, label=label or key, format=format, summable=summable)


def test_date_format_matches_frontend_display():
    assert format_date("2026-03-31T10:00:00Z") == "31 Mar 2026"
    assert format_date("2026-03-31") == "31 Mar 2026"
    assert format_date("not a date") == "not a date"
    assert format_date(None) == "N/S"


def test_status_uses_label_map():
    key = next(iter(report_export.STATUS_LABELS))
    assert format_status(key) == report_export.STATUS_LABELS[key]


def test_export_column_label_overrides_and_currency_suffix():
    assert export_column_label(_col("profit", "Profit")) == "Margin"
    assert export_column_label(_col("amount", "Amount", "currency")) == "Amount (MVR)"
    assert export_column_label(_col("amount", "Amount (MVR)", "currency")) == "Amount (MVR)"
    assert export_column_label(_col("qty", "Qty", "qty")) == "Qty"


def test_not_set_and_not_applicable_export_as_blank():
    column = _col("date", "Date", "date")
    assert export_cell_value(column, {"date": None}) == ""
    assert export_cell_value(_col("ref", "Ref"), {"ref": "N/A"}) == ""


def test_numeric_cells_are_numbers_and_blank_when_missing():
    column = _col("amount", "Amount", "currency", summable=True)
    assert export_cell_value(column, {"amount": "12.5"}) == 12.5
    assert export_cell_value(column, {"amount": None}) is None


def test_search_matches_json_text_case_insensitively():
    rows = [{"name": "Silver Spoon", "qty": 2.0}, {"name": "Other", "qty": 3}]
    assert [r["name"] for r in apply_search(rows, "  SILVER ")] == ["Silver Spoon"]
    # Integral floats serialize without ".0", matching JSON.stringify on the page.
    assert [r["name"] for r in apply_search(rows, "2")] == ["Silver Spoon"]
    assert apply_search(rows, "2.0") == []
    assert apply_search(rows, "") == rows


def test_export_table_adds_total_row_with_label_column():
    columns = [
        _col("no", "No"),
        _col("name", "Name"),
        _col("amount", "Amount", "currency", summable=True),
    ]
    rows = [{"no": 1, "name": "A", "amount": 10}, {"no": 2, "name": "B", "amount": "2.5"}]
    headers, body = build_export_table(rows, columns)
    assert headers == ["No", "Name", "Amount (MVR)"]
    assert body[0] == [1, "A", 10.0]
    assert body[-1] == ["Total", None, 12.5]


def test_export_table_without_summable_columns_has_no_total_row():
    columns = [_col("name", "Name")]
    headers, body = build_export_table([{"name": "A"}], columns)
    assert body == [["A"]]


def test_workbook_keeps_equals_text_as_text_and_writes_title_block():
    payload = build_workbook(
        headers=["Name"],
        body=[["=SUM(A1:A2)"], [{"nested": 1}]],
        title="Sales",
        subtitle="Date range: 01 Mar 2026 to 31 Mar 2026",
    )
    sheet = load_workbook(io.BytesIO(payload)).active
    assert sheet.title == "Report"
    assert sheet["A1"].value == "Sales"
    assert sheet["A2"].value.startswith("Date range")
    assert sheet["A4"].value == "Name"
    assert sheet["A5"].value == "=SUM(A1:A2)"
    assert sheet["A5"].data_type == "s"
    assert sheet["A6"].value == '{"nested":1}'


def test_safe_export_filename():
    assert safe_export_filename('Sales/Report: "Q1"') == "SalesReport Q1.xlsx"
    assert safe_export_filename("sales.xlsx") == "sales.xlsx"
    assert safe_export_filename("") == "report.xlsx"


def test_every_export_path_resolves_to_a_get_route():
    for report_api in REPORT_EXPORT_PATHS:
        assert callable(resolve_report_handler(report_api)), report_api
    assert "profitLoss" not in REPORT_EXPORT_PATHS


def test_handler_kwargs_inject_context_and_ignore_unknown_params():
    async def endpoint(skip: int = 0, limit: int = 50, branch_id: str | None = None, db=None, user=None):
        return None

    kwargs = build_handler_kwargs(
        endpoint,
        {"branch_id": "b1", "unknown": "x", "skip": "9"},
        skip=500,
        limit=500,
        db="DB",
        user="USER",
    )
    assert kwargs == {"skip": 500, "limit": 500, "branch_id": "b1", "db": "DB", "user": "USER"}


def test_handler_kwargs_use_declared_defaults_for_missing_params():
    async def endpoint(branch_id: str | None = None, sort_order: str = "desc", db=None, user=None):
        return None

    kwargs = build_handler_kwargs(endpoint, {}, skip=0, limit=500, db=None, user=None)
    assert kwargs["branch_id"] is None
    assert kwargs["sort_order"] == "desc"


async def _build_session(tmp_path) -> tuple[AsyncSession, sessionmaker]:
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'exports.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as db:
        db.add_all([
            User(id="u-export", name="Exporter", email="exp@example.com", hashed_password="x", all_branches=True),
            User(id="u-other", name="Other", email="other@example.com", hashed_password="x", all_branches=True),
            Branch(id="b1", name="Main", code="MAIN"),
        ])
        await db.commit()
    return factory


def _request(report_api="salesRegister"):
    return ReportExportRequest(
        report_api=report_api,
        params={"branch_id": "b1"},
        columns=[
            _col("id", "No"),
            _col("name", "Name"),
            _col("amount", "Amount", "currency", summable=True),
            _col("status", "Status"),
            _col("date", "Date", "date"),
        ],
        title="Sales",
        subtitle="Date range: 01 Mar 2026 to 31 Mar 2026",
        filename="sales.xlsx",
    )


def _fake_report(total: int, drift_on_page: int | None = None):
    calls = {"n": 0}

    async def endpoint(skip: int = 0, limit: int = 50, branch_id: str | None = None, db=None, user=None):
        calls["n"] += 1
        reported_total = total
        if drift_on_page is not None and calls["n"] == drift_on_page:
            reported_total = total + 1
        end = min(skip + limit, total)
        items = [
            {
                "id": i,
                "name": f"Item {i}",
                "amount": float(i),
                "status": "completed",
                "date": "2026-03-31T00:00:00Z",
            }
            for i in range(skip, end)
        ]
        return {"items": items, "total": reported_total, "skip": skip, "limit": limit}

    return endpoint


async def _create_job(factory, user_id="u-export", request=None):
    request = request or _request()
    now = datetime.utcnow()
    async with factory() as db:
        job = ReportExportJob(
            id=f"job-{user_id}-{now.timestamp()}",
            status="queued",
            report_api=request.report_api,
            filename=request.filename,
            request_json=request.model_dump(mode="json"),
            user_id=user_id,
            created_at=now,
            expires_at=now + timedelta(hours=24),
        )
        db.add(job)
        await db.commit()
        return job.id


async def _load_job(factory, job_id):
    async with factory() as db:
        return await db.get(ReportExportJob, job_id)


def test_worker_exports_every_row_not_just_one_page(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        monkeypatch.setattr(report_export_worker, "resolve_report_handler", lambda _api: _fake_report(1234))
        job_id = await _create_job(factory)

        await report_export_worker.run_job(job_id)

        job = await _load_job(factory, job_id)
        assert job.status == "completed"
        assert job.total_rows == 1234
        assert job.expires_at - job.completed_at == timedelta(hours=24)
        sheet = load_workbook(io.BytesIO(job.file_data)).active
        # title, subtitle, blank, header, 1234 data rows, total row
        assert sheet.max_row == 4 + 1234 + 1
        assert sheet.cell(row=sheet.max_row, column=1).value == "Total"
        assert sheet.cell(row=sheet.max_row, column=3).value == sum(range(1234))

    asyncio.run(scenario())


def test_worker_fails_when_row_count_changes_mid_export(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        monkeypatch.setattr(
            report_export_worker, "resolve_report_handler", lambda _api: _fake_report(1200, drift_on_page=2)
        )
        job_id = await _create_job(factory)
        with pytest.raises(ReportExportError, match="changed while it was being exported"):
            await report_export_worker.run_job(job_id)

    asyncio.run(scenario())


def test_worker_rejects_exports_over_the_row_cap(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        monkeypatch.setattr(report_export_worker, "resolve_report_handler", lambda _api: _fake_report(600))
        monkeypatch.setenv("REPORT_EXPORT_MAX_ROWS", "500")
        job_id = await _create_job(factory)
        with pytest.raises(ReportExportError, match="over the export limit"):
            await report_export_worker.run_job(job_id)

    asyncio.run(scenario())


def test_worker_reports_empty_results_as_no_data(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        monkeypatch.setattr(report_export_worker, "resolve_report_handler", lambda _api: _fake_report(0))
        job_id = await _create_job(factory)
        with pytest.raises(ReportExportError, match="No data available to export"):
            await report_export_worker.run_job(job_id)

    asyncio.run(scenario())


def test_claim_marks_queued_job_processing_and_counts_attempts(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        job_id = await _create_job(factory)

        claimed = await report_export_worker.claim_job()
        assert claimed == job_id
        job = await _load_job(factory, job_id)
        assert job.status == "processing"
        assert job.attempts == 1
        assert await report_export_worker.claim_job() is None

    asyncio.run(scenario())


def test_claim_gives_up_after_max_attempts(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        job_id = await _create_job(factory)
        async with factory() as db:
            job = await db.get(ReportExportJob, job_id)
            job.status = "processing"
            job.attempts = report_export_worker.MAX_ATTEMPTS
            job.started_at = datetime.utcnow() - timedelta(hours=1)
            await db.commit()

        assert await report_export_worker.claim_job() is None
        job = await _load_job(factory, job_id)
        assert job.status == "failed"

    asyncio.run(scenario())


def test_cleanup_removes_expired_exports(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        job_id = await _create_job(factory)
        async with factory() as db:
            job = await db.get(ReportExportJob, job_id)
            job.expires_at = datetime.utcnow() - timedelta(minutes=1)
            await db.commit()

        assert await report_export_worker.cleanup_expired_exports() == 1
        assert await _load_job(factory, job_id) is None

    asyncio.run(scenario())


def _actor(id_="u-export"):
    return User(id=id_, name="x", email=f"{id_}@example.com", hashed_password="x", all_branches=True)


def test_export_endpoints_enforce_ownership_status_and_expiry(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        async with factory() as db:
            owner = await db.get(User, "u-export")
            other = await db.get(User, "u-other")
            created = await reports_routes.create_report_export(body=_request(), db=db, user=owner)
            assert created["status"] == "queued"
            job_id = created["job_id"]

            with pytest.raises(HTTPException) as not_ready:
                await reports_routes.download_report_export(job_id=job_id, db=db, user=owner)
            assert not_ready.value.status_code == 409

            with pytest.raises(HTTPException) as hidden:
                await reports_routes.get_report_export(job_id=job_id, db=db, user=other)
            assert hidden.value.status_code == 404

            job = await db.get(ReportExportJob, job_id)
            job.status = "completed"
            job.file_data = b"PK-fake"
            job.completed_at = datetime.utcnow()
            job.expires_at = datetime.utcnow() + timedelta(hours=1)
            await db.commit()

            response = await reports_routes.download_report_export(job_id=job_id, db=db, user=owner)
            assert response.body == b"PK-fake"
            assert "sales.xlsx" in response.headers["content-disposition"]

            job.expires_at = datetime.utcnow() - timedelta(seconds=1)
            await db.commit()
            with pytest.raises(HTTPException) as expired:
                await reports_routes.download_report_export(job_id=job_id, db=db, user=owner)
            assert expired.value.status_code == 410

    asyncio.run(scenario())


def test_create_export_rejects_unknown_report(tmp_path):
    async def scenario():
        factory = await _build_session(tmp_path)
        async with factory() as db:
            owner = await db.get(User, "u-export")
            with pytest.raises(HTTPException) as rejected:
                await reports_routes.create_report_export(
                    body=_request(report_api="notAReport"), db=db, user=owner
                )
            assert rejected.value.status_code == 400

    asyncio.run(scenario())

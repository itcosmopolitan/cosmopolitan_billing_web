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

from src import config, report_export, report_export_worker  # noqa: E402
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
    assert safe_export_filename("Stock Transfers.pdf", "pdf") == "Stock Transfers.pdf"


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


def test_worker_renders_list_pdf_in_background_and_discards_html(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        rendered = {}

        async def fake_render_pdf(html, mode, timeout_seconds=None):
            rendered["html"] = html
            rendered["mode"] = mode
            return b"%PDF-1.4 async"

        monkeypatch.setattr(report_export_worker, "render_pdf", fake_render_pdf)
        request = ReportExportRequest(
            report_api="list_pdf",
            format="pdf",
            pdf_html="<html><body><h1>Transfers</h1><script>alert(1)</script></body></html>",
            total_rows=12,
            title="Transfers",
            filename="Stock Transfers.pdf",
        )
        job_id = await _create_job(factory, request=request)

        await report_export_worker.run_job(job_id)

        job = await _load_job(factory, job_id)
        assert job.status == "completed"
        assert job.file_data == b"%PDF-1.4 async"
        assert job.total_rows == 12
        assert job.processed_rows == 12
        assert job.request_json["pdf_html"] is None
        assert "<script>" not in rendered["html"]
        assert "Transfers" in rendered["html"]
        assert rendered["mode"].value == "export"

    asyncio.run(scenario())


def test_invoice_pdf_worker_pages_twenty_thousand_rows_and_renders_escaped_values(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(report_export_worker, "get_async_session", lambda: factory)
        calls = []

        async def invoice_rows(
            branch_id=None, search=None, skip=0, limit=500, db=None, user=None,
        ):
            calls.append((skip, limit, branch_id, search, user.id))
            end = min(skip + limit, 20_000)
            return {
                "items": [
                    {
                        "number": f"INV-{index}",
                        "customerName": "<script>alert(1)</script>" if index == 0 else f"Customer {index}",
                        "date": "2026-03-31",
                        "total": 125.5,
                        "paidAmount": 25,
                        "balanceDue": 100.5,
                        "status": "paid",
                    }
                    for index in range(skip, end)
                ],
                "total": 20_000,
                "skip": skip,
                "limit": limit,
            }

        from src.routes import sales as sales_routes

        monkeypatch.setattr(sales_routes, "list_invoice_pdf_export_rows", invoice_rows)
        rendered = {}

        async def fake_render_pdf(html, mode, timeout_seconds=None):
            rendered["html"] = html
            rendered["timeout_seconds"] = timeout_seconds
            return b"%PDF-1.4 invoice export"

        monkeypatch.setattr(report_export_worker, "render_pdf", fake_render_pdf)
        request = ReportExportRequest(
            report_api="sales_invoices_pdf",
            format="pdf",
            pdf_html=(
                '<html><body><table><tbody data-list-export-rows=""></tbody></table>'
                '<div class="list-export-count" data-list-export-count="">0 records</div></body></html>'
            ),
            params={"branch_id": "b1", "search": "INV"},
            columns=[
                _col("number", "Invoice Number"),
                _col("customerName", "Customer"),
                _col("date", "Date", "date"),
                _col("total", "Amount (MVR)", "currency"),
                _col("status", "Status", "status"),
            ],
            title="Invoices",
            filename="Invoices.pdf",
        )
        job_id = await _create_job(factory, request=request)

        await report_export_worker.run_job(job_id)

        job = await _load_job(factory, job_id)
        assert job.status == "completed"
        assert job.total_rows == 20_000
        assert job.processed_rows == 20_000
        assert len(calls) == 40
        assert calls[0] == (0, 500, "b1", "INV", "u-export")
        assert calls[-1][:2] == (19_500, 500)
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in rendered["html"]
        assert "<script>alert(1)</script>" not in rendered["html"]
        assert "20000 records" in rendered["html"]
        assert "125.50" in rendered["html"]
        assert rendered["timeout_seconds"] == 900

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


def test_list_pdf_export_uses_report_job_download_endpoints(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(
            config,
            "get",
            lambda: type("Settings", (), {"pdf_max_payload_bytes": 5 * 1024 * 1024})(),
        )
        async with factory() as db:
            owner = await db.get(User, "u-export")
            created = await reports_routes.create_list_pdf_export(
                body=ReportExportRequest(
                    report_api="list_pdf",
                    format="pdf",
                    pdf_html="<html><body>List report</body></html>",
                    total_rows=4,
                    title="Transfers",
                    filename="Stock Transfers.pdf",
                ),
                db=db,
                user=owner,
            )
            assert created["status"] == "queued"
            assert created["filename"] == "Stock Transfers.pdf"
            assert (await reports_routes.get_list_pdf_export(
                job_id=created["job_id"],
                db=db,
                user=owner,
            ))["status"] == "queued"

            job = await db.get(ReportExportJob, created["job_id"])
            job.status = "completed"
            job.file_data = b"%PDF-1.4 fake"
            await db.commit()
            response = await reports_routes.download_list_pdf_export(
                job_id=created["job_id"],
                db=db,
                user=owner,
            )
            assert response.body == b"%PDF-1.4 fake"
            assert response.media_type == "application/pdf"
            assert "Stock Transfers.pdf" in response.headers["content-disposition"]

    asyncio.run(scenario())


def test_invoice_pdf_job_accepts_filters_for_worker_side_fetch(tmp_path, monkeypatch):
    async def scenario():
        factory = await _build_session(tmp_path)
        monkeypatch.setattr(
            config,
            "get",
            lambda: type("Settings", (), {"pdf_max_payload_bytes": 5 * 1024 * 1024})(),
        )
        async with factory() as db:
            owner = await db.get(User, "u-export")
            created = await reports_routes.create_list_pdf_export(
                body=ReportExportRequest(
                    report_api="sales_invoices_pdf",
                    format="pdf",
                    pdf_html="<html><tbody data-list-export-rows></tbody></html>",
                    params={},
                    columns=[_col("number", "Invoice Number")],
                    title="Invoices",
                    filename="Invoices.pdf",
                ),
                db=db,
                user=owner,
            )

            assert created["status"] == "queued"
            status = await reports_routes.get_list_pdf_export(
                job_id=created["job_id"], db=db, user=owner,
            )
            assert status["total_rows"] == 0

    asyncio.run(scenario())

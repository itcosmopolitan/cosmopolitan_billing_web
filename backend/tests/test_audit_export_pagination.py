"""The audit CSV export must include every matching row, not just the first page."""

import asyncio
from datetime import datetime
from types import SimpleNamespace

from src.routes import audit


def _fake_row(i):
    return SimpleNamespace(
        id=f"log-{i}",
        created_at=datetime(2026, 1, 1, 12, 0, 0),
        action="update",
        user_name="tester",
        user_role="admin",
        module="sales",
        reference_id=f"ref-{i}",
        detail="detail",
        risk="low",
        ip_address="127.0.0.1",
        device_info="device",
    )


def test_audit_csv_export_includes_rows_beyond_first_page(monkeypatch):
    rows = [_fake_row(i) for i in range(620)]
    calls = []

    async def fake_list_audit_logs(*, page, limit, **_kwargs):
        calls.append((page, limit))
        start = (page - 1) * limit
        return SimpleNamespace(total=len(rows), results=rows[start:start + limit])

    monkeypatch.setattr(audit, "list_audit_logs", fake_list_audit_logs)

    async def run_export():
        response = await audit.export_csv(
            module=None,
            risk=None,
            user_id=None,
            branch_id=None,
            date_from=None,
            date_to=None,
            operation_type=None,
            operation_type_not=None,
            criteria=None,
            search=None,
            db=None,
            user=None,
        )
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk if isinstance(chunk, str) else chunk.decode())
        return "".join(chunks)

    body = asyncio.run(run_export())
    lines = [line for line in body.splitlines() if line]

    assert calls == [(1, 500), (2, 500)]
    assert len(lines) == 1 + 620
    assert lines[-1].startswith("log-619,")

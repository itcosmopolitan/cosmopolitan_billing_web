import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from src.routes.adjustments import _merge_adjustment_rows
from src.routes.dashboard import _resolve_branch_scope as resolve_dashboard_branch_scope
from src.routes.reports import _resolve_branch_scope as resolve_reports_branch_scope
from src.routes.cash import _resolve_branch_scope as resolve_cash_branch_scope
from src.routes.sales import _resolve_branch_scope as resolve_sales_branch_scope
from src.routes.transfers import (
    _resolve_branch_scope as resolve_transfers_branch_scope,
    _ensure_user_can_view_transfer,
)
from src.security import _ensure_branch_access_allowed, get_allowed_branch_ids


def test_rejects_branch_outside_user_scope(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)

    with pytest.raises(HTTPException) as exc:
        import asyncio

        asyncio.run(_ensure_branch_access_allowed("br-999", user, object()))

    assert exc.value.status_code == 403


def test_returns_allowed_branch_ids_for_user(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001", "br-002"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)
    branch_ids = asyncio.run(get_allowed_branch_ids(user, object()))

    assert branch_ids == ["br-001", "br-002"]


def test_dashboard_branch_scope_uses_user_allowed_branches(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001", "br-002"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)
    branch_ids = asyncio.run(resolve_dashboard_branch_scope(user, object()))

    assert branch_ids == ["br-001", "br-002"]


def test_reports_branch_scope_uses_user_allowed_branches(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001", "br-002"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)
    branch_ids = asyncio.run(resolve_reports_branch_scope(user, object(), None))

    assert branch_ids == ["br-001", "br-002"]


def test_cash_branch_scope_uses_user_allowed_branches(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001", "br-002"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)
    branch_ids = asyncio.run(resolve_cash_branch_scope(user, object(), None))

    assert branch_ids == ["br-001", "br-002"]


def test_cash_branch_scope_rejects_explicit_branch_outside_scope(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_ensure_branch_access_allowed("br-999", user, object()))

    assert exc.value.status_code == 403


def test_sales_branch_scope_uses_user_allowed_branches(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001", "br-002"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)
    branch_ids = asyncio.run(resolve_sales_branch_scope(user, object(), None))

    assert branch_ids == ["br-001", "br-002"]


def test_transfers_branch_scope_and_visibility(monkeypatch):
    async def fake_get_user_branch_ids(db, user_id):
        return ["br-001"]

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", fake_get_user_branch_ids)

    user = SimpleNamespace(id="u1", all_branches=False)
    branch_ids = asyncio.run(resolve_transfers_branch_scope(user, object(), None))
    assert branch_ids == ["br-001"]

    # Transfer visible when user has access to either side
    t = SimpleNamespace(from_branch_id="br-002", to_branch_id="br-001")
    asyncio.run(_ensure_user_can_view_transfer(user, object(), t))

    # Transfer denied when user has no access to either side
    async def no_branches(db, user_id):
        return []

    monkeypatch.setattr("src.routes._serializers.get_user_branch_ids", no_branches)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_ensure_user_can_view_transfer(user, object(), t))
    assert exc.value.status_code == 403


def test_merge_adjustment_rows_includes_legacy_approved_stock_adjustments():
    request_row = SimpleNamespace(
        id="req-1",
        ref_number="ADJ-1001",
        branch_id="br-001",
        branch_name="Downtown",
        child_counter_id=None,
        child_counter_name=None,
        item_id="item-1",
        item_name="Rice",
        before_qty=10,
        new_qty=12,
        reason="Physical count",
        notes="Counted",
        batch_id=None,
        status="approved",
        requested_by="John",
        approved_by="Manager",
        rejected_by=None,
        rejection_notes=None,
        resolved_by="Manager",
        resolved_at=None,
        created_at=None,
    )
    legacy_row = SimpleNamespace(
        id="sa-legacy-1",
        item_id="item-1",
        branch_id="br-001",
        before_qty=12,
        after_qty=15,
        reason="Physical count",
        notes="Manual fix",
        adjusted_by="Manager",
        request_id=None,
        created_at=None,
    )

    rows = _merge_adjustment_rows([request_row], [legacy_row], status=None, sort_order='desc')

    assert len(rows) == 2
    assert rows[0]["ref_number"] == "ADJ-1001"
    assert rows[1]["status"] == "approved"
    assert rows[1]["ref_number"].startswith("ADJ-LEGACY")

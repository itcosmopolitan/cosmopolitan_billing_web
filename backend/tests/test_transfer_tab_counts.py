import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Branch, StockTransfer, TransferStatus
from src.routes import transfers as transfers_routes
from src.routes.summaries import _transfer_summary

A, B, C = "br-a", "br-b", "br-c"
CC = "cc-1"

# (ref, status, from, to, counter)
ROWS = [
    ("TR-1", TransferStatus.draft, A, B, CC),
    ("TR-2", TransferStatus.draft, B, A, CC),
    ("TR-3", TransferStatus.pending, A, B, CC),
    ("TR-4", TransferStatus.pending, B, A, CC),
    ("TR-5", TransferStatus.transit, A, B, CC),
    ("TR-6", TransferStatus.transit, B, A, CC),
    ("TR-7", TransferStatus.received, A, B, CC),
    ("TR-8", TransferStatus.received, B, C, CC),
    ("TR-9", TransferStatus.rejected, A, B, CC),
    ("TR-10", TransferStatus.rejected, B, A, CC),
    ("TR-11", TransferStatus.approved, A, B, CC),
    ("TR-12", TransferStatus.draft, A, B, None),
]

TABS = [None, "draft", "pending", "transit", "received", "rejected"]


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    db = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)()
    for bid, name in ((A, "Alpha"), (B, "Beta"), (C, "Gamma")):
        db.add(Branch(id=bid, name=name, code=name[:3].upper()))
    for ref, status, src, dst, counter in ROWS:
        db.add(StockTransfer(
            id=f"id-{ref}", ref_number=ref, status=status,
            from_branch_id=src, to_branch_id=dst,
            child_counter_id=counter, child_counter_name=counter,
            request_date="2025-01-01", created_at=datetime.utcnow(),
        ))
    await db.commit()
    return db


async def _list_total(db, *, status, branch_id, child_counter_id):
    result = await transfers_routes.list_transfers(
        status=status,
        branch_id=branch_id,
        child_counter_id=child_counter_id,
        from_branch=None,
        to_branch=None,
        sort_by=None,
        sort_order="desc",
        skip=0,
        limit=500,
        db=db,
        user=SimpleNamespace(all_branches=True),
    )
    return result["total"]


@pytest.fixture
def passthrough_branch_access(monkeypatch):
    async def _allow(branch_id, *, user, db):
        return branch_id

    monkeypatch.setattr(transfers_routes, "enforce_branch_access_optional", _allow)


def test_summary_tab_counts_match_list_totals(passthrough_branch_access):
    asyncio.run(_run_summary_matches_list())


async def _run_summary_matches_list() -> None:
    db = await _build_session()
    try:
        for branch_id in (None, A, B):
            for child_counter_id in (None, CC):
                summary = await _transfer_summary(
                    db, branch_id=branch_id, child_counter_id=child_counter_id,
                )
                for tab in TABS:
                    expected = await _list_total(
                        db, status=tab, branch_id=branch_id,
                        child_counter_id=child_counter_id,
                    )
                    key = tab or "total"
                    assert summary[key] == expected, (
                        f"branch={branch_id} counter={child_counter_id} tab={key}: "
                        f"summary={summary[key]} list={expected}"
                    )
    finally:
        await db.close()


def test_summary_counts_for_selected_counter_and_branch(passthrough_branch_access):
    asyncio.run(_run_expected_counts())


async def _run_expected_counts() -> None:
    db = await _build_session()
    try:
        summary = await _transfer_summary(db, branch_id=A, child_counter_id=CC)
        # Alpha is source for draft/pending/rejected and destination for transit.
        assert summary == {
            "draft": 1,
            "pending": 1,
            "transit": 1,
            "received": 1,
            "rejected": 1,
            "total": 10,
        }
    finally:
        await db.close()

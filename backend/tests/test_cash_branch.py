"""Cash ledger entries must never persist a blank branch_id."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "src.routes" not in sys.modules:
    import src  # noqa: F401 — ensure parent package exists

    routes_pkg = types.ModuleType("src.routes")
    routes_pkg.__path__ = [str(ROOT / "src" / "routes")]
    sys.modules["src.routes"] = routes_pkg

from src.models import CashDayClose, CashEntry, PettyCashDayClose  # noqa: E402
from src.routes._cash_ledger import first_nonempty, require_cash_branch_id  # noqa: E402
from src.routes.cash import _cash_ledger_filter, _day_close_model  # noqa: E402


def test_first_nonempty_skips_blanks():
    assert first_nonempty(None, "", "  ", "br-001") == "br-001"
    assert first_nonempty() is None


def test_require_cash_branch_id_rejects_blank():
    with pytest.raises(HTTPException) as exc:
        require_cash_branch_id(None, "")
    assert exc.value.status_code == 400
    assert require_cash_branch_id("", " br-002 ") == "br-002"


def test_sales_and_petty_ledgers_keep_manual_and_system_cash_separate():
    engine = create_engine("sqlite:///:memory:")
    CashEntry.__table__.create(engine)
    rows = [
        {
            "id": "sale", "branch_id": "br-001", "type": "in", "category": "Sale — Cash",
            "description": "Cash sale", "amount": 100, "date": "2026-10-05",
            "source_type": "sale_invoice", "source_id": "invoice-1", "is_system": True,
        },
        {
            "id": "purchase", "branch_id": "br-001", "type": "out", "category": "Purchase — Cash",
            "description": "Cash purchase", "amount": 40, "date": "2026-10-05",
            "source_type": "purchase_payment", "source_id": "payment-1", "is_system": True,
        },
        {
            "id": "petty", "branch_id": "br-001", "type": "out", "category": "Utilities",
            "description": "Petty expense", "amount": 10, "date": "2026-10-05",
            "source_type": "manual", "source_id": None, "is_system": False,
        },
        {
            "id": "sales-void", "branch_id": "br-001", "type": "out", "category": "Sale — Cash",
            "description": "Void sale", "amount": 100, "date": "2026-10-05",
            "source_type": "void", "source_id": "sale", "is_system": True,
        },
        {
            "id": "petty-void", "branch_id": "br-001", "type": "in", "category": "Utilities",
            "description": "Void petty expense", "amount": 10, "date": "2026-10-05",
            "source_type": "void", "source_id": "petty", "is_system": True,
        },
        {
            "id": "opening", "branch_id": "br-001", "type": "in", "category": "Opening Balance",
            "description": "Opening float", "amount": 50, "date": "2026-10-05",
            "source_type": "manual", "source_id": None, "is_system": False,
        },
        {
            "id": "opening-void", "branch_id": "br-001", "type": "out", "category": "Opening Balance",
            "description": "Void opening float", "amount": 50, "date": "2026-10-05",
            "source_type": "void", "source_id": "opening", "is_system": True,
        },
    ]
    with engine.begin() as connection:
        connection.execute(CashEntry.__table__.insert(), rows)
        sales_ids = set(connection.execute(
            select(CashEntry.id).where(CashEntry.branch_id == "br-001", _cash_ledger_filter("sales"))
        ).scalars())
        petty_ids = set(connection.execute(
            select(CashEntry.id).where(CashEntry.branch_id == "br-001", _cash_ledger_filter("petty"))
        ).scalars())

    assert sales_ids == {"sale", "purchase", "sales-void", "opening", "opening-void"}
    assert petty_ids == {"petty", "petty-void"}


def test_sales_and_petty_cash_have_independent_day_close_records():
    engine = create_engine("sqlite:///:memory:")
    CashDayClose.__table__.create(engine)
    PettyCashDayClose.__table__.create(engine)
    fields = {
        "branch_id": "br-001",
        "date": "2026-10-05",
        "opening_balance": 0,
        "total_cash_in": 0,
        "total_cash_out": 0,
        "expected_balance": 0,
        "physical_count": 0,
        "variance": 0,
        "closed_by": "cashier",
    }
    with engine.begin() as connection:
        connection.execute(CashDayClose.__table__.insert(), {"id": "sales-close", **fields})
        connection.execute(PettyCashDayClose.__table__.insert(), {"id": "petty-close", **fields})
        sales_rows = connection.execute(select(CashDayClose.id)).scalars().all()
        petty_rows = connection.execute(select(PettyCashDayClose.id)).scalars().all()

    assert sales_rows == ["sales-close"]
    assert petty_rows == ["petty-close"]
    assert _day_close_model("sales") is CashDayClose
    assert _day_close_model("petty") is PettyCashDayClose

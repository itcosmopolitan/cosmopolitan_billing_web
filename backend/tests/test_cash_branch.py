"""Cash ledger entries must never persist a blank branch_id."""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "src.routes" not in sys.modules:
    import src  # noqa: F401 — ensure parent package exists

    routes_pkg = types.ModuleType("src.routes")
    routes_pkg.__path__ = [str(ROOT / "src" / "routes")]
    sys.modules["src.routes"] = routes_pkg

from src.routes._cash_ledger import first_nonempty, require_cash_branch_id  # noqa: E402


def test_first_nonempty_skips_blanks():
    assert first_nonempty(None, "", "  ", "br-001") == "br-001"
    assert first_nonempty() is None


def test_require_cash_branch_id_rejects_blank():
    with pytest.raises(HTTPException) as exc:
        require_cash_branch_id(None, "")
    assert exc.value.status_code == 400
    assert require_cash_branch_id("", " br-002 ") == "br-002"

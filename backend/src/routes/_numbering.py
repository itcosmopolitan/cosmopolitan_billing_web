"""Document numbering — org-configurable prefixes for POS receipts vs invoices."""
from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Organisation, SaleInvoice

DEFAULT_NUMBERING: dict[str, dict[str, Any]] = {
    "pos": {"prefix": "POS", "start": 1000},
    "invoice": {"prefix": "INV", "start": 2000},
}


def parse_numbering_config(raw: Optional[str]) -> dict[str, dict[str, Any]]:
    """Merge stored JSON with defaults; tolerate bad/missing data."""
    out = deepcopy(DEFAULT_NUMBERING)
    if not raw:
        return out
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return out
    if not isinstance(data, dict):
        return out
    for key in ("pos", "invoice"):
        entry = data.get(key)
        if not isinstance(entry, dict):
            continue
        prefix = str(entry.get("prefix") or "").strip()
        if prefix:
            out[key]["prefix"] = prefix.upper()
        try:
            out[key]["start"] = int(entry.get("start", out[key]["start"]))
        except (TypeError, ValueError):
            pass
    return out


def serialize_numbering_config(cfg: dict[str, dict[str, Any]]) -> str:
    merged = parse_numbering_config(json.dumps(cfg))
    return json.dumps(merged)


async def get_org_numbering(db: AsyncSession) -> dict[str, dict[str, Any]]:
    org = (await db.execute(select(Organisation).limit(1))).scalar_one_or_none()
    raw = getattr(org, "numbering_config", None) if org else None
    return parse_numbering_config(raw)


async def next_sale_invoice_number(db: AsyncSession, origin: Optional[str] = None) -> str:
    """POS receipts vs back-office invoices share year-scoped sequences."""
    numbering = await get_org_numbering(db)
    year = datetime.now().year
    if (origin or "").strip().lower() == "pos":
        cfg = numbering["pos"]
    else:
        cfg = numbering["invoice"]
    prefix = str(cfg["prefix"])
    base = int(cfg["start"])
    pattern = f"{prefix}-{year}-%"
    count = int(
        (await db.execute(
            select(func.count(SaleInvoice.id)).where(SaleInvoice.number.like(pattern))
        )).scalar()
        or 0
    )
    return f"{prefix}-{year}-{base + count}"

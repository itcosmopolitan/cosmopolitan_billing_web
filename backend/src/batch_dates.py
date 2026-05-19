"""Batch date validation used by items, purchases, and any path that
creates or edits ItemBatch metadata."""

from __future__ import annotations

from datetime import datetime
from typing import Optional


def _today() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def validate_batch_dates(
    *,
    mfg_date: Optional[str] = None,
    expiry_date: Optional[str] = None,
    received_date: Optional[str] = None,
    require_expiry: bool = False,
    allow_past_expiry: bool = False,
) -> list[str]:
    """Return a list of human-readable errors. Empty list => OK.

    Set ``allow_past_expiry=True`` when validating a metadata-only patch that
    leaves an already-expired lot unchanged (mfg / notes / batch number edits).
    """
    today = _today()
    mfg = (mfg_date or "").strip()
    exp = (expiry_date or "").strip()
    recv = (received_date or "").strip()
    errors: list[str] = []

    if mfg and mfg > today:
        errors.append("Manufacturing date cannot be in the future")
    if recv and recv > today:
        errors.append("Received date cannot be in the future")
    if require_expiry and not exp:
        errors.append("Expiry date is required for this item")
    if exp and not allow_past_expiry and exp < today:
        errors.append("Expiry date cannot be in the past for new or updated stock")
    if mfg and exp and mfg >= exp:
        errors.append("Manufacturing date must be before the expiry date")

    return errors

"""Org-level display precision for amounts and quantities (default 2)."""
from __future__ import annotations

from typing import Any, Optional

DEFAULT_DECIMAL_PRECISION = 2
MIN_DECIMAL_PRECISION = 0
MAX_DECIMAL_PRECISION = 6


def clamp_precision(value: Any, default: int = DEFAULT_DECIMAL_PRECISION) -> int:
    if value is None or value == "":
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(MIN_DECIMAL_PRECISION, min(MAX_DECIMAL_PRECISION, n))


def org_precision(org: Optional[object]) -> tuple[int, int]:
    if org is None:
        return DEFAULT_DECIMAL_PRECISION, DEFAULT_DECIMAL_PRECISION
    amount = clamp_precision(getattr(org, "amount_decimal_precision", None))
    quantity = clamp_precision(getattr(org, "quantity_decimal_precision", None))
    return amount, quantity

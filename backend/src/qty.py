"""Quantity helpers — org precision allows fractional weights (kg, etc.)."""
from __future__ import annotations

from typing import Any

# Match organisations.quantity_decimal_precision upper bound.
QTY_DECIMALS = 6
_QTY_EPS = 10 ** -QTY_DECIMALS


def as_qty(value: Any) -> float:
    """Coerce a quantity to a finite float rounded to 6 decimal places."""
    if value is None or value is False:
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if n != n or n in (float("inf"), float("-inf")):  # NaN / inf
        return 0.0
    return round(n, QTY_DECIMALS)


def qty_eq(a: Any, b: Any) -> bool:
    return abs(as_qty(a) - as_qty(b)) < _QTY_EPS

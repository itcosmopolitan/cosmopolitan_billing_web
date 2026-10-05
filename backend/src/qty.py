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


def coerce_qty_value(value: Any, *, field_name: str = "qty") -> float:
    """Pydantic-friendly qty parse — accepts ints/floats/numeric strings."""
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{field_name} must be a number")
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            raise ValueError(f"{field_name} is required")
        try:
            value = float(stripped)
        except ValueError as exc:
            raise ValueError(f"{field_name} must be a number") from exc
    if isinstance(value, (int, float)):
        n = float(value)
        if n != n or n in (float("inf"), float("-inf")):
            raise ValueError(f"{field_name} must be a number")
        return as_qty(n)
    raise ValueError(f"{field_name} must be a number")

"""Resolve per-branch item listing and pricing from Item + ItemBranchConfig."""
from __future__ import annotations

from typing import Any, Optional


def effective_selling_price(
    default_price: float,
    branch_price: Optional[float],
) -> float:
    if branch_price is not None:
        return float(branch_price)
    return float(default_price or 0)


def effective_reorder_level(
    default_level: int,
    branch_level: Optional[int],
) -> int:
    if branch_level is not None:
        return int(branch_level)
    return int(default_level or 0)


def effective_cost_price(
    default_cost: float,
    branch_cost: Optional[float],
) -> float:
    if branch_cost is not None:
        return float(branch_cost)
    return float(default_cost or 0)


def _normalize_category_pricing_mode(mode) -> str:
    raw = str(mode or "").strip().lower()
    return "price" if raw in {"price", "amount", "fixed", "fixed_price", "fixed price"} else "pct"


def effective_category_pricing(item: Any, cfg: Any = None) -> dict:
    """Catalog wholesale/staff, with optional per-branch overrides.

    A branch override applies when ``*_pricing_mode`` is set on the config;
    otherwise that side inherits the item catalog values.
    """
    wholesale_mode = _normalize_category_pricing_mode(
        getattr(item, "wholesale_pricing_mode", None) or "pct"
    )
    wholesale_pct = float(getattr(item, "wholesale_discount_pct", 0) or 0)
    wholesale_price = float(getattr(item, "wholesale_price", 0) or 0)
    staff_mode = _normalize_category_pricing_mode(
        getattr(item, "staff_pricing_mode", None) or "pct"
    )
    staff_pct = float(getattr(item, "staff_discount_pct", 0) or 0)
    staff_price = float(getattr(item, "staff_price", 0) or 0)

    if cfg is not None and getattr(cfg, "wholesale_pricing_mode", None):
        wholesale_mode = _normalize_category_pricing_mode(cfg.wholesale_pricing_mode)
        wholesale_pct = float(getattr(cfg, "wholesale_discount_pct", 0) or 0)
        wholesale_price = float(getattr(cfg, "wholesale_price", 0) or 0)
        if wholesale_mode == "price":
            wholesale_pct = 0.0
        else:
            wholesale_price = 0.0

    if cfg is not None and getattr(cfg, "staff_pricing_mode", None):
        staff_mode = _normalize_category_pricing_mode(cfg.staff_pricing_mode)
        staff_pct = float(getattr(cfg, "staff_discount_pct", 0) or 0)
        staff_price = float(getattr(cfg, "staff_price", 0) or 0)
        if staff_mode == "price":
            staff_pct = 0.0
        else:
            staff_price = 0.0

    return {
        "wholesale_pricing_mode": wholesale_mode,
        "wholesale_discount_pct": wholesale_pct,
        "wholesale_price": wholesale_price,
        "staff_pricing_mode": staff_mode,
        "staff_discount_pct": staff_pct,
        "staff_price": staff_price,
    }

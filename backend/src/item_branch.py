"""Resolve per-branch item listing and pricing from Item + ItemBranchConfig."""
from __future__ import annotations

from typing import Optional


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

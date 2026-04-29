"""Shared list pagination: allowed page sizes and response envelope."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

DEFAULT_PAGE_SIZE = 50
ALLOWED_PAGE_SIZES = (50, 100, 200, 500)


def normalize_limit(limit: Optional[int]) -> int:
    if limit is None:
        return DEFAULT_PAGE_SIZE
    try:
        li = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_PAGE_SIZE
    return li if li in ALLOWED_PAGE_SIZES else DEFAULT_PAGE_SIZE


def normalize_skip(skip: Optional[int]) -> int:
    if skip is None:
        return 0
    try:
        s = int(skip)
    except (TypeError, ValueError):
        return 0
    return max(0, s)


def paged(items: List[Any], total: int, skip: int, limit: int, **extra: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "items": items,
        "total": total,
        "skip": skip,
        "limit": limit,
    }
    out.update(extra)
    return out

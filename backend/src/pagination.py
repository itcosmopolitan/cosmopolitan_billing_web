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


def normalize_sort_order(sort_order: Optional[str], default: str = "asc") -> str:
    """Normalize a `sort_order` query string to either 'asc' or 'desc'."""
    so = (sort_order or default or "asc").strip().lower()
    return "desc" if so == "desc" else "asc"


def resolve_sort(
    sort_by: Optional[str],
    sort_order: Optional[str],
    allowed: Dict[str, Any],
    default_key: str,
    default_order: str = "asc",
) -> Any:
    """Resolve a (sort_by, sort_order) pair into a SQLAlchemy ORDER BY expression.

    `allowed` is an explicit allow-list of `{client_key: column_or_expr}` so the
    client can never request an arbitrary attribute (no SQL injection surface, no
    accidental sort on a sensitive column). Unknown keys silently fall back to
    `default_key`; unknown orders fall back to `default_order` (then 'asc').
    """
    key = sort_by if sort_by in allowed else default_key
    order = normalize_sort_order(sort_order, default_order)
    col = allowed[key]
    return col.desc() if order == "desc" else col.asc()

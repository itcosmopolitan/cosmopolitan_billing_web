from datetime import date
from typing import Optional, Tuple

from fastapi import HTTPException

MAX_DASHBOARD_DATE_RANGE_DAYS = 180
MAX_REPORT_DATE_RANGE_DAYS = 365


def parse_date_range(
    date_from: Optional[str],
    date_to: Optional[str],
    default_start: date,
    default_end: date,
    max_days: int,
) -> tuple[date, date]:
    """Parse and validate a date range from query parameters."""
    start_str = date_from or default_start.isoformat()
    end_str = date_to or default_end.isoformat()
    try:
        start = date.fromisoformat(start_str)
        end = date.fromisoformat(end_str)
    except ValueError:
        raise HTTPException(400, "Invalid date range. Use YYYY-MM-DD format.")
    if end < start:
        raise HTTPException(400, "Date range 'to' must be on or after 'from'.")
    days = (end - start).days + 1
    if days > max_days:
        raise HTTPException(400, f"Date range cannot exceed {max_days} days.")
    return start, end

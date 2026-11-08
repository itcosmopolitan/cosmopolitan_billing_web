from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from src import config

MAX_DASHBOARD_DATE_RANGE_DAYS = 180
MAX_REPORT_DATE_RANGE_DAYS = 365


def _report_business_timezone() -> ZoneInfo:
    try:
        settings = config.get()
    except RuntimeError:
        settings = config.Settings()
    return ZoneInfo(settings.business_timezone)


def business_today() -> date:
    return datetime.now(_report_business_timezone()).date()


def business_day_bounds_utc(day: date) -> tuple[datetime, datetime]:
    business_tz = _report_business_timezone()
    start_local = datetime.combine(day, time.min, tzinfo=business_tz)
    next_start_local = datetime.combine(day + timedelta(days=1), time.min, tzinfo=business_tz)
    return (
        start_local.astimezone(timezone.utc).replace(tzinfo=None),
        next_start_local.astimezone(timezone.utc).replace(tzinfo=None),
    )


def business_timezone() -> ZoneInfo:
    """Return the configured timezone used for dashboard calendar boundaries."""
    try:
        timezone_name = config.get().dashboard_business_timezone
    except RuntimeError:
        timezone_name = config.Settings().dashboard_business_timezone
    return ZoneInfo(timezone_name)


def business_now() -> datetime:
    return datetime.now(business_timezone())


def dashboard_business_today() -> date:
    return business_now().date()


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

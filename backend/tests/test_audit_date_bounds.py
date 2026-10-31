from datetime import date, datetime

from src.routes.audit import BUSINESS_TIMEZONE, _this_month_date_bounds, _to_datetime_bounds


def test_audit_date_bounds_convert_maldives_local_dates_to_utc():
    start, end = _to_datetime_bounds(date(2026, 11, 1), date(2026, 11, 1))

    assert start == datetime(2026, 10, 31, 19, 0)
    assert end == datetime(2026, 11, 1, 19, 0)


def test_default_audit_date_bounds_use_business_local_month():
    first, last = _this_month_date_bounds()
    today = datetime.now(BUSINESS_TIMEZONE).date()

    assert first == today.replace(day=1)
    assert last.month == today.month
    assert last.year == today.year

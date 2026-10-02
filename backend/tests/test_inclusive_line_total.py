from src.routes.sales import _inclusive_from_stored_line_total


def test_inclusive_discounted_line_total_not_reinflated():
    # 300 incl. 8% GST, 10% disc → stored inclusive 270 must stay 270
    assert _inclusive_from_stored_line_total(1, 300, 8, 270, 10) == 270.0


def test_legacy_taxable_line_total_is_inflated():
    # Legacy write stored taxable 250 after 10% disc → inflate to 270
    assert _inclusive_from_stored_line_total(1, 300, 8, 250, 10) == 270.0


def test_full_inclusive_unchanged():
    assert _inclusive_from_stored_line_total(1, 300, 8, 300, 0) == 300.0


def test_legacy_taxable_no_discount_inflated():
    assert _inclusive_from_stored_line_total(1, 300, 8, 277.78, 0) == 300.0

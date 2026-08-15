from src.tax_calc import (
    allocate_flat_amount,
    line_tax_amount,
    rollup_inclusive_lines,
)


def test_allocate_flat_amount_remainder_on_last_line():
    shares = allocate_flat_amount([10.0, 20.0, 30.0], 10.0)
    assert round(sum(shares), 2) == 10.0
    assert shares[0] == 1.67
    assert shares[1] == 3.33
    assert shares[2] == 5.00


def test_line_discount_then_entity_discount_then_tax():
    # 108 inclusive @ 8% GST, 10% line disc → 97.20, then 10 MVR bill disc.
    after_line = round(108 * 0.9, 2)
    assert after_line == 97.20
    rows, subtotal, tax_total, total = rollup_inclusive_lines(
        [after_line], [8.0], entity_discount=10.0,
    )
    after_all, taxable, tax = rows[0]
    assert after_all == 87.20
    assert total == 87.20
    assert tax == line_tax_amount(87.20, 8.0)
    assert taxable == round(87.20 - tax, 2)
    assert subtotal == taxable
    assert tax_total == tax
    # Tax must be lower than extracting from the pre-entity amount.
    assert tax < line_tax_amount(after_line, 8.0)


def test_entity_discount_reduces_tax_on_inclusive_price():
    rows, subtotal, tax_total, total = rollup_inclusive_lines(
        [108.0], [8.0], entity_discount=10.80,
    )
    after, taxable, tax = rows[0]
    assert after == 97.20
    assert total == 97.20
    assert tax == line_tax_amount(97.20, 8.0)
    assert tax == 7.20
    assert taxable == 90.00
    assert subtotal == 90.00
    assert tax_total == 7.20

"""Shared GST line/cart math for inclusive vs exclusive pricing."""

from __future__ import annotations

VALID_TAX_PRICING_MODES = frozenset({"inclusive", "exclusive"})


def normalize_tax_pricing_mode(mode: str | None) -> str:
    if mode in VALID_TAX_PRICING_MODES:
        return mode
    return "inclusive"


def line_tax_amount(line_amount: float, tax_rate: float, mode: str) -> float:
    """Tax component for a discounted line amount.

    * inclusive — `line_amount` is GST-inclusive; extract tax from it.
    * exclusive — `line_amount` is pre-tax; tax is added on top.
    """
    if tax_rate <= 0 or line_amount <= 0:
        return 0.0
    if normalize_tax_pricing_mode(mode) == "inclusive":
        return round(line_amount * tax_rate / (100 + tax_rate), 2)
    return round(line_amount * tax_rate / 100, 2)


def line_taxable_amount(line_amount: float, tax_rate: float, mode: str) -> float:
    """Pre-tax (taxable) portion of the line."""
    tax = line_tax_amount(line_amount, tax_rate, mode)
    if normalize_tax_pricing_mode(mode) == "inclusive":
        return round(line_amount - tax, 2)
    return round(line_amount, 2)

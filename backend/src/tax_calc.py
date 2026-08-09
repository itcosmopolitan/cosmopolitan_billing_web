"""Shared GST line math — shelf/line amounts are always tax-inclusive."""

from __future__ import annotations

# Kept for callers that still pass a mode; exclusive is no longer supported.
VALID_TAX_PRICING_MODES = frozenset({"inclusive"})


def normalize_tax_pricing_mode(mode: str | None) -> str:
    """Always inclusive — org preference removed."""
    return "inclusive"


def line_tax_amount(line_amount: float, tax_rate: float, mode: str | None = None) -> float:
    """Tax component extracted from a GST-inclusive discounted line amount."""
    if tax_rate <= 0 or line_amount <= 0:
        return 0.0
    return round(line_amount * tax_rate / (100 + tax_rate), 2)


def line_taxable_amount(line_amount: float, tax_rate: float, mode: str | None = None) -> float:
    """Pre-tax (taxable) portion of an inclusive line amount."""
    tax = line_tax_amount(line_amount, tax_rate, mode)
    return round(line_amount - tax, 2)

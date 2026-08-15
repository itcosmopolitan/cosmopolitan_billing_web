"""Shared GST line math — shelf/line amounts are always tax-inclusive.

Discounts (line-item and document-level) are applied to the inclusive
amount first; GST is then extracted from what remains.
"""

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


def allocate_flat_amount(amounts: list[float], flat: float) -> list[float]:
    """Split a document-level discount across inclusive line amounts.

    Proportional by line size; the last positive line absorbs remainder so
    shares sum to ``min(flat, sum(amounts))``.
    """
    n = len(amounts)
    if n == 0:
        return []
    disc = round(max(0.0, float(flat or 0)), 2)
    total = round(sum(max(0.0, float(a or 0)) for a in amounts), 2)
    if disc <= 0 or total <= 0:
        return [0.0] * n
    disc = min(disc, total)
    shares = [0.0] * n
    last_idx = 0
    for i, raw in enumerate(amounts):
        if float(raw or 0) > 0:
            last_idx = i
    allocated = 0.0
    for i, raw in enumerate(amounts):
        if i == last_idx:
            continue
        amount = max(0.0, float(raw or 0))
        if amount <= 0:
            continue
        share = min(amount, round(amount / total * disc, 2))
        shares[i] = share
        allocated += share
    remainder = round(disc - allocated, 2)
    last_cap = max(0.0, float(amounts[last_idx] or 0))
    shares[last_idx] = min(last_cap, max(0.0, remainder))
    return shares


def rollup_inclusive_lines(
    line_inclusives: list[float],
    tax_rates: list[float],
    entity_discount: float = 0.0,
) -> tuple[list[tuple[float, float, float]], float, float, float]:
    """Apply document discount, then extract GST from remaining inclusive amounts.

    Line-item discounts must already be reflected in ``line_inclusives``.

    Returns:
        rows: (inclusive_after_entity, taxable, tax) per input line
        subtotal: sum of taxable (after all discounts)
        tax_total: sum of tax (after all discounts)
        total: subtotal + tax_total (= payable inclusive amount)
    """
    shares = allocate_flat_amount(list(line_inclusives), entity_discount)
    rows: list[tuple[float, float, float]] = []
    subtotal = 0.0
    tax_total = 0.0
    for amount, rate, share in zip(line_inclusives, tax_rates, shares):
        after = round(max(0.0, float(amount or 0) - share), 2)
        tax = line_tax_amount(after, rate or 0)
        taxable = line_taxable_amount(after, rate or 0)
        rows.append((after, taxable, tax))
        subtotal += taxable
        tax_total += tax
    subtotal = round(subtotal, 2)
    tax_total = round(tax_total, 2)
    return rows, subtotal, tax_total, round(subtotal + tax_total, 2)

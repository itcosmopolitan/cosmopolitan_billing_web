"""Report-level GST display mode: GST-inclusive (default) or GST-exclusive amounts.

Stored sale and purchase amounts are GST-inclusive. In exclusive mode, those money
columns are restated net of GST:
- line-level amounts use the line's tax rate: amount * 100 / (100 + rate)
- document-level amounts use the document ratio: amount * (total - tax) / total

Cost is always GST-exclusive, so cost columns (cost price, cost value, cost of sales,
stock value) are never restated. GST columns themselves (tax amounts) and quantities /
percentages are never restated either.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from sqlalchemy import case, func

GST_MODE_INCLUSIVE = "inclusive"
GST_MODE_EXCLUSIVE = "exclusive"


def is_exclusive(gst_mode: Optional[str]) -> bool:
    return (gst_mode or "").strip().lower() == GST_MODE_EXCLUSIVE


def excl_amount(amount: Any, tax_rate: Any) -> float:
    value = float(amount or 0)
    rate = float(tax_rate or 0)
    if rate <= 0:
        return round(value, 2)
    return round(value * 100.0 / (100.0 + rate), 2)


def excl_line_expr(amount_col, tax_rate_col):
    """SQL: GST-inclusive line amount → GST-exclusive amount at the line rate."""
    rate = func.coalesce(tax_rate_col, 0.0)
    amount = func.coalesce(amount_col, 0.0)
    return case(
        (rate <= 0, amount),
        else_=(amount * 100.0) / (100.0 + rate),
    )


def excl_ratio_expr(total_col, tax_total_col):
    """SQL: taxable / total share of a document, used to restate document-level amounts."""
    total = func.coalesce(total_col, 0.0)
    return case(
        (total == 0, 1.0),
        else_=(total - func.coalesce(tax_total_col, 0.0)) / total,
    )


def line_amount_expr(amount_col, tax_rate_col, exclusive: bool):
    return excl_line_expr(amount_col, tax_rate_col) if exclusive else amount_col


def doc_amount_expr(amount_col, total_col, tax_total_col, exclusive: bool):
    return amount_col * excl_ratio_expr(total_col, tax_total_col) if exclusive else amount_col


def scale_doc_rows(
    rows: Iterable[dict[str, Any]],
    keys: Iterable[str],
    *,
    total_key: str = "total",
    tax_key: str = "tax",
) -> None:
    """Restate document-level amount columns in place by each row's taxable / total ratio."""
    key_list = list(keys)
    for row in rows:
        total = float(row.get(total_key) or 0)
        tax = float(row.get(tax_key) or 0)
        ratio = ((total - tax) / total) if total else 1.0
        for key in key_list:
            if row.get(key) is not None:
                row[key] = round(float(row[key]) * ratio, 2)

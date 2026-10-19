"""Full-dataset report export: request contract, JS-parity formatting, and xlsx output.

Formatting mirrors the Reports page export (`exportColumnValue`, `formatLabel`,
`humanizeValue`, `statusLabel`, `fmtDate`) so the file matches what the user
saw on screen, but applied to every row instead of the current page.
"""

from __future__ import annotations

import inspect
import io
import json
import math
import re
from datetime import datetime, timedelta
from typing import Any, Callable, Literal, Optional, Union

from openpyxl import Workbook
from pydantic import BaseModel, Field
from pydantic.fields import FieldInfo
from pydantic_core import PydanticUndefined

EXPORT_RETENTION = timedelta(hours=24)

NOT_SET = "N/S"
NOT_APPLICABLE = "N/A"

# Frontend `reportsAPI` key -> reports router path (without the /reports prefix).
REPORT_EXPORT_PATHS: dict[str, str] = {
    "salesSummary": "sales-summary",
    "purchaseSummary": "purchase-summary",
    "taxSummary": "tax-summary",
    "taxSummaryDetail": "tax-summary-detail",
    "stockMovement": "stock-movement",
    "poolIssues": "pool-issues",
    "salesRegister": "sales-register",
    "salesLines": "sales-lines",
    "dailySales": "daily-sales",
    "dailySalesReturns": "daily-sales-returns",
    "productSales": "product-sales",
    "categorySales": "category-sales",
    "paymentSales": "payment-sales",
    "branchSales": "branch-sales",
    "cashierSales": "cashier-sales",
    "customerSales": "customer-sales",
    "purchaseRegister": "purchase-register",
    "purchaseLines": "purchase-lines",
    "dailyPurchaseReturns": "daily-purchase-returns",
    "vendorPurchases": "vendor-purchases",
    "productPurchases": "product-purchases",
    "currentStock": "current-stock",
    "lowStock": "low-stock",
    "outOfStock": "out-of-stock",
    "stockTransfers": "stock-transfers",
    "spoilageDamage": "spoilage-damage",
    "complimentaryIssues": "complimentary-issues",
    "expiryBatches": "expiry-batches",
    "dailyTax": "daily-tax",
    "monthlyTax": "monthly-tax",
    "quarterlyTax": "quarterly-tax",
    "gstSummary": "gst-summary",
    "outstandingReceivables": "outstanding-receivables",
    "salesAging": "sales-aging",
    "salesAgingDetail": "sales-aging-detail",
    "outstandingPayables": "outstanding-payables",
    "purchaseAging": "purchase-aging",
    "purchaseAgingDetail": "purchase-aging-detail",
    "pettyCash": "petty-cash",
    "topCustomers": "top-customers",
    "vendorOutstanding": "vendor-outstanding",
    "branchCompare": "branch-comparison",
    "marginAnalysis": "margin-analysis",
    "documentTrail": "document-trail",
}

NUMERIC_EXPORT_FORMATS = {"currency", "currency_blank", "qty", "number", "pct"}

EXPORT_LABEL_OVERRIDES = {"profit": "Margin"}

LABEL_ACRONYM_EXCEPTIONS = {
    "ACH", "API", "BIC", "CN", "GST", "HSN", "IBAN", "ID", "IFSC", "MVR", "NEFT", "OTP",
    "PAN", "PO", "QR", "RTGS", "SKU", "SO", "UPI", "URL", "UUID", "VAT",
}

HUMANIZE_MAP = {
    "true": "Yes", "false": "No", "yes": "Yes", "no": "No", "on": "On", "off": "Off",
    "enabled": "Enabled", "disabled": "Disabled", "intransit": "In Transit",
    "in_progress": "In Progress", "inprogress": "In Progress", "transit": "In Transit",
    "receive": "Receive", "received": "Received", "pending_approval": "Pending Approval",
    "pendingapproval": "Pending Approval", "approved": "Approved", "rejected": "Rejected",
    "cancelled": "Cancelled", "canceled": "Cancelled", "draft": "Draft",
    "partial": "Partially Paid", "overdue": "Overdue", "active": "Active",
    "inactive": "Inactive", "paid": "Paid", "unpaid": "Unpaid", "pending": "Pending",
    "confirmed": "Confirmed", "low": "Low", "out": "Out", "low_stock": "Low Stock",
    "out_of_stock": "Out of Stock",
}

STATUS_LABELS = {
    "paid": "Paid", "active": "Active", "pending": "Pending", "overdue": "Overdue",
    "draft": "Draft", "partial": "Partially Paid", "transit": "In Transit",
    "intransit": "In Transit", "in_progress": "In Progress", "inprogress": "In Progress",
    "receive": "Receive", "received": "Received", "low": "Low Stock", "out": "Out of Stock",
    "cancelled": "Cancelled", "canceled": "Cancelled", "inactive": "Inactive",
    "pending_approval": "Pending Approval", "confirmed": "Confirmed", "invited": "Invited",
    "credit_note": "Credit Note", "processed": "Processed",
}

PAYMENT_MODE_LABELS = {
    "cash": "Cash", "card": "Card", "upi": "UPI", "bank_transfer": "Bank Transfer", "credit": "Credit",
}

TRANSACTION_TYPE_LABELS = {
    "invoice": "Invoice", "credit_note": "Credit Note", "bill": "Bill", "debit_note": "Debit Note",
}

_NUMBER_RE = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")


class ReportExportError(Exception):
    """Raised for export failures that should be shown to the user as-is."""


class ReportExportColumn(BaseModel):
    key: str = Field(min_length=1, max_length=100)
    label: str = Field(default="", max_length=200)
    format: Optional[str] = Field(default=None, max_length=30)
    summable: bool = False


class ReportExportRequest(BaseModel):
    report_api: Optional[str] = Field(default=None, max_length=100)
    format: Literal["xlsx", "pdf"] = "xlsx"
    pdf_html: Optional[str] = Field(default=None, max_length=5 * 1024 * 1024)
    total_rows: int = Field(default=0, ge=0, le=100_000)
    params: dict[str, Optional[Union[str, int, float, bool]]] = Field(default_factory=dict)
    search: Optional[str] = Field(default=None, max_length=200)
    columns: list[ReportExportColumn] = Field(default_factory=list, max_length=80)
    title: str = Field(default="Report", max_length=200)
    subtitle: Optional[str] = Field(default=None, max_length=300)
    filename: str = Field(default="report.xlsx", max_length=200)


def _to_js_number(value: Any) -> Optional[float]:
    """Mirror `typeof v === 'number' ? v : Number(v)` followed by a finite check."""
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        num = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not _NUMBER_RE.fullmatch(text):
            return None
        num = float(text)
    else:
        return None
    return num if math.isfinite(num) else None


def _js_number_text(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def humanize_value(value: Any) -> str:
    if value is None or value == "":
        return NOT_SET
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (int, float)):
        return _js_number_text(value)
    if isinstance(value, str):
        normalized = value.strip()
        if normalized == "":
            return NOT_SET
        mapped = HUMANIZE_MAP.get(normalized.lower())
        return mapped if mapped is not None else format_label(normalized)
    if isinstance(value, list):
        if not value:
            return "[]"
        return ", ".join(humanize_value(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return str(value)


def format_label(value: Any) -> str:
    if value is None or value == "":
        return ""
    text = str(value).strip()
    if text == "":
        return ""
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    normalized = re.sub(r"[_-]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return ""
    tokens = []
    for token in normalized.split(" "):
        if not token:
            tokens.append("")
            continue
        upper = token.upper()
        if upper in LABEL_ACRONYM_EXCEPTIONS:
            tokens.append(upper)
            continue
        cleaned = re.sub(r"[^A-Za-z0-9]", "", token)
        if not cleaned:
            tokens.append(token)
            continue
        if cleaned.upper() in LABEL_ACRONYM_EXCEPTIONS:
            tokens.append(cleaned.upper())
            continue
        tokens.append(cleaned[0].upper() + cleaned[1:].lower())
    return " ".join(tokens)


def status_label(status: str) -> str:
    mapped = STATUS_LABELS.get(status)
    return mapped if mapped is not None else humanize_value(status)


def format_status(value: Any) -> str:
    text = str(value).strip().lower() if value else ""
    return status_label(text)


def format_payment_mode(value: Any) -> Any:
    key = str(value).strip().lower() if value else ""
    return PAYMENT_MODE_LABELS.get(key) or (value if value else NOT_SET)


def format_transaction_type(value: Any) -> Any:
    key = re.sub(r"\s+", "_", str(value).strip().lower()) if value else ""
    return TRANSACTION_TYPE_LABELS.get(key) or (value if value else NOT_SET)


VALUE_FORMATTERS: dict[str, Callable[[Any], Any]] = {
    "payment_mode": format_payment_mode,
    "transaction_type": format_transaction_type,
    "status": format_status,
}


def _parse_iso_datetime(text: str) -> Optional[datetime]:
    value = text.strip()
    if value[-1:] in ("Z", "z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def format_date(value: Any) -> Any:
    if not value:
        return NOT_SET
    if isinstance(value, str):
        parsed = _parse_iso_datetime(value)
        if parsed is None:
            return value
        return parsed.strftime("%d %b %Y")
    return value


def export_column_label(column: ReportExportColumn) -> str:
    label = EXPORT_LABEL_OVERRIDES.get(column.key) or column.label or column.key
    if column.format in ("currency", "currency_blank") and not re.search(r"\(MVR\)", label, re.IGNORECASE):
        return f"{label} (MVR)"
    return label


def export_cell_value(column: ReportExportColumn, row: dict[str, Any]) -> Any:
    value = row.get(column.key)
    if column.format in NUMERIC_EXPORT_FORMATS:
        if value is None or value == "":
            return None
        return _to_js_number(value)
    if column.key in VALUE_FORMATTERS:
        formatted = VALUE_FORMATTERS[column.key](value)
    elif column.format == "date":
        formatted = format_date(value)
    else:
        formatted = value
    if formatted is None or formatted in (NOT_SET, NOT_APPLICABLE):
        return ""
    return formatted


def _normalize_for_json(value: Any) -> Any:
    """Match JS JSON.stringify: integral floats print without '.0', non-finite becomes null."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {k: _normalize_for_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize_for_json(v) for v in value]
    return value


def apply_search(rows: list[dict[str, Any]], query: Optional[str]) -> list[dict[str, Any]]:
    """Same semantics as the page's `searchReportRows`: match against the row's JSON text."""
    needle = (query or "").strip().lower()
    if not needle:
        return rows
    matched = []
    for row in rows:
        if row is None:
            continue
        text = json.dumps(_normalize_for_json(row), separators=(",", ":"), ensure_ascii=False).lower()
        if needle in text:
            matched.append(row)
    return matched


def compute_totals(rows: list[dict[str, Any]], columns: list[ReportExportColumn]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for column in columns:
        if not column.summable:
            continue
        total = 0.0
        counted = 0
        for row in rows:
            raw = row.get(column.key)
            if raw is None or raw == "":
                continue
            num = _to_js_number(raw)
            if num is None:
                continue
            total += num
            counted += 1
        if counted:
            totals[column.key] = total
    return totals


def build_export_table(
    rows: list[dict[str, Any]],
    columns: list[ReportExportColumn],
    search: Optional[str] = None,
) -> tuple[list[str], list[list[Any]]]:
    """Return (headers, body rows) with a trailing totals row when any column is summable."""
    filtered = apply_search(rows, search)
    headers = [export_column_label(column) for column in columns]
    body = [[export_cell_value(column, row) for column in columns] for row in filtered]
    totals = compute_totals(filtered, columns)
    if totals:
        label_key = next((c.key for c in columns if c.key not in totals), columns[0].key)
        total_row: list[Any] = []
        for column in columns:
            if column.key in totals:
                total_row.append(export_cell_value(column, {column.key: totals[column.key]}))
            elif column.key == label_key:
                total_row.append("Total")
            else:
                total_row.append(None)
        body.append(total_row)
    return headers, body


def _write_row(sheet, row_index: int, values: list[Any]) -> None:
    for column_index, value in enumerate(values, start=1):
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            value = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
        cell = sheet.cell(row=row_index, column=column_index, value=value)
        # Text that starts with "=" must stay text, not become a formula.
        if isinstance(value, str) and value.startswith("="):
            cell.data_type = "s"


def build_workbook(
    headers: list[str],
    body: list[list[Any]],
    title: Optional[str] = None,
    subtitle: Optional[str] = None,
) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Report"
    row_index = 1
    if title:
        _write_row(sheet, row_index, [title])
        row_index += 1
    if subtitle:
        _write_row(sheet, row_index, [subtitle])
        row_index += 1
    if title or subtitle:
        row_index += 1
    _write_row(sheet, row_index, headers)
    row_index += 1
    for values in body:
        _write_row(sheet, row_index, values)
        row_index += 1
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def safe_export_filename(name: str, file_format: Literal["xlsx", "pdf"] = "xlsx") -> str:
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "", name or "").strip()
    base = base[:120].rstrip(". ") or "report"
    extension = f".{file_format}"
    if not base.lower().endswith(extension):
        base = f"{base}{extension}"
    return base


def resolve_report_handler(report_api: str) -> Callable[..., Any]:
    path = REPORT_EXPORT_PATHS.get(report_api)
    if path is None:
        raise ReportExportError(f"Unsupported report for export: {report_api}")
    # Imported lazily: the routes module imports this module for the export endpoints.
    from src.routes import reports as reports_routes

    target = f"/{path}"
    for route in reports_routes.router.routes:
        if getattr(route, "path", None) == target and "GET" in getattr(route, "methods", set()):
            return route.endpoint
    raise ReportExportError(f"Report endpoint not found for export: {report_api}")


def build_handler_kwargs(
    endpoint: Callable[..., Any],
    params: dict[str, Any],
    *,
    skip: int,
    limit: int,
    db: Any,
    user: Any,
) -> dict[str, Any]:
    """Build kwargs the way FastAPI would for a GET request.

    Unknown params are ignored, as an HTTP query string would be. Params the
    endpoint declares but the request omits fall back to their declared default.
    """
    kwargs: dict[str, Any] = {}
    for name, parameter in inspect.signature(endpoint).parameters.items():
        if name == "db":
            kwargs[name] = db
        elif name == "user":
            kwargs[name] = user
        elif name == "skip":
            kwargs[name] = skip
        elif name == "limit":
            kwargs[name] = limit
        elif name in params:
            kwargs[name] = params[name]
        else:
            default = parameter.default
            if isinstance(default, FieldInfo):
                default = default.default
            if default is inspect.Parameter.empty or default is PydanticUndefined or default is Ellipsis:
                default = None
            kwargs[name] = default
    return kwargs

"""Canonical list-table column catalogs for Customize Columns.

Source of truth for which columns exist on each list page. User prefs
(order / hidden) are stored separately and merged at read time.
Frontend only renders columns present in this catalog.
"""
from __future__ import annotations

from typing import Any


def _col(id: str, label: str, *, locked: bool = False, default_hidden: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"id": id, "label": label}
    if locked:
        out["locked"] = True
    if default_hidden:
        out["defaultHidden"] = True
    return out


# table_key → ordered column definitions
COLUMN_CATALOG: dict[str, list[dict[str, Any]]] = {
    "customers.list": [
        _col("customer", "Customer", locked=True),
        _col("contact", "Contact"),
        _col("pricing", "Pricing"),
        _col("classification", "Customer type"),
        _col("kam", "KAM"),
        _col("branch", "Branch"),
        _col("credit_terms", "Credit Terms"),
        _col("account_limit", "Account Limit"),
        _col("outstanding", "Outstanding"),
        _col("store_credit", "Store Credit"),
        _col("limit_used", "Limit Used"),
        _col("total_purchases", "Total Purchases"),
        _col("status", "Status", locked=True),
    ],
    "vendors.list": [
        _col("vendor", "Vendor", locked=True),
        _col("contact", "Contact"),
        _col("gstin", "GST Reg No"),
        _col("payment_terms", "Payment Terms"),
        _col("outstanding", "Outstanding"),
        _col("credit", "Credit"),
        _col("total_purchases", "Total Purchases"),
        _col("status", "Status", locked=True),
    ],
    "items.list": [
        _col("item", "Item", locked=True),
        _col("sku", "SKU / Barcode"),
        _col("category", "Category"),
        _col("cost", "Cost"),
        _col("price", "Price"),
        _col("gst", "GST"),
        _col("stock", "Stock"),
        _col("status", "Status", locked=True),
    ],
    "item_master.list": [
        _col("item", "Item", locked=True),
        _col("sku", "SKU / Barcode"),
        _col("category", "Category"),
        _col("cost", "Default Cost"),
        _col("price", "Default Price"),
        _col("branches", "Branches"),
        _col("gst", "GST"),
    ],
    "transfers.list": [
        _col("ref_number", "Transfer #", locked=True),
        _col("route", "From → To"),
        _col("items", "Items"),
        _col("status", "Status", locked=True),
        _col("date", "Date"),
    ],
    "adjustments.list": [
        _col("ref_number", "Adjustment #", locked=True),
        _col("branch", "Branch"),
        _col("item", "Item"),
        _col("qty_change", "Qty change"),
        _col("status", "Status", locked=True),
        _col("requested", "Requested"),
        _col("resolved", "Approved / Rejected"),
    ],
    "sales.invoices": [
        _col("number", "Invoice #", locked=True),
        _col("customer", "Customer"),
        _col("branch", "Branch"),
        _col("date", "Date"),
        _col("cashier", "Cashier"),
        _col("amount", "Amount"),
        _col("paid", "Paid"),
        _col("mode", "Mode"),
        _col("status", "Status", locked=True),
        _col("returns", "Returns"),
    ],
    "sales.quotes": [
        _col("number", "Quote #", locked=True),
        _col("customer", "Customer"),
        _col("date", "Date"),
        _col("valid_until", "Valid Till"),
        _col("amount", "Amount"),
        _col("status", "Status", locked=True),
    ],
    "sales.orders": [
        _col("number", "Order #", locked=True),
        _col("customer", "Customer"),
        _col("date", "Date"),
        _col("expected", "Expected"),
        _col("amount", "Amount"),
        _col("status", "Status", locked=True),
    ],
    "sales.returns": [
        _col("number", "Credit Note #", locked=True),
        _col("invoice", "Invoice"),
        _col("customer", "Customer"),
        _col("date", "Date"),
        _col("total", "Total"),
        _col("credited", "Credited"),
        _col("refund", "Refund"),
        _col("reason", "Reason"),
        _col("status", "Status", locked=True),
    ],
    "sales.payments": [
        _col("number", "Payment #", locked=True),
        _col("customer", "Customer"),
        _col("date", "Date"),
        _col("method", "Method"),
        _col("invoices", "Invoices"),
        _col("total", "Total Amount"),
        _col("store_credit", "Store Credit"),
        _col("status", "Status", locked=True),
    ],
    "purchases.bills": [
        _col("number", "Bill #", locked=True),
        _col("vendor", "Vendor"),
        _col("date", "Date"),
        _col("due_date", "Due Date"),
        _col("total", "Total"),
        _col("paid", "Paid"),
        _col("balance", "Balance"),
        _col("mode", "Mode"),
        _col("status", "Status", locked=True),
        _col("returns", "Returns"),
    ],
    "purchases.orders": [
        _col("number", "PO #", locked=True),
        _col("vendor", "Vendor"),
        _col("date", "Date"),
        _col("expected", "Expected"),
        _col("total", "Total"),
        _col("status", "Status", locked=True),
    ],
    "purchases.grns": [
        _col("number", "GRN #", locked=True),
        _col("po", "PO #"),
        _col("vendor", "Vendor"),
        _col("date", "Date"),
        _col("total", "Total"),
        _col("status", "Status", locked=True),
        _col("bill", "Bill"),
    ],
    "purchases.returns": [
        _col("number", "Return #", locked=True),
        _col("bill", "Bill #"),
        _col("vendor", "Vendor"),
        _col("date", "Date"),
        _col("total", "Total"),
        _col("reason", "Reason"),
        _col("status", "Status", locked=True),
    ],
    "purchases.payments": [
        _col("number", "Payment #", locked=True),
        _col("vendor", "Vendor"),
        _col("date", "Date"),
        _col("method", "Method"),
        _col("bills", "Bills"),
        _col("total", "Total Amount"),
        _col("reference", "Reference"),
        _col("status", "Status", locked=True),
    ],
    "cash.entries": [
        _col("entry_number", "#", locked=True),
        _col("time", "Time"),
        _col("type", "Type", locked=True),
        _col("category", "Category"),
        _col("description", "Description"),
        _col("ref", "Ref"),
        _col("by", "By"),
        _col("amount", "Amount"),
    ],
    "audit.list": [
        _col("action", "Action", locked=True),
        _col("user", "User"),
        _col("module", "Module"),
        _col("reference", "Reference"),
        _col("detail", "Detail"),
        _col("risk", "Risk"),
        _col("time", "Time"),
    ],
}


def default_prefs_for_columns(columns: list[dict[str, Any]]) -> dict[str, list[str]]:
    order = [c["id"] for c in columns]
    hidden = [c["id"] for c in columns if c.get("defaultHidden") and not c.get("locked")]
    return {"order": order, "hidden": hidden}


def resolve_table_prefs(
    columns: list[dict[str, Any]],
    stored: dict[str, Any] | None,
) -> dict[str, list[str]]:
    """Merge user order/hidden with catalog; locked columns cannot be hidden."""
    defaults = default_prefs_for_columns(columns)
    def_ids = [c["id"] for c in columns]
    def_set = set(def_ids)
    locked = {c["id"] for c in columns if c.get("locked")}

    order = [i for i in (stored or {}).get("order") or [] if i in def_set]
    for i in def_ids:
        if i not in order:
            order.append(i)
    if not order:
        order = list(defaults["order"])

    hidden_src = (stored or {}).get("hidden")
    if hidden_src is None:
        hidden_src = defaults["hidden"]
    hidden = [i for i in hidden_src if i in def_set and i not in locked]

    return {"order": order, "hidden": hidden}


def build_column_tables(user_prefs: dict[str, dict[str, list[str]]] | None = None) -> dict[str, dict[str, Any]]:
    """Full boot payload: every table with columns + resolved order/hidden."""
    prefs = user_prefs or {}
    tables: dict[str, dict[str, Any]] = {}
    for table_key, columns in COLUMN_CATALOG.items():
        resolved = resolve_table_prefs(columns, prefs.get(table_key))
        tables[table_key] = {
            "columns": columns,
            "order": resolved["order"],
            "hidden": resolved["hidden"],
        }
    return tables

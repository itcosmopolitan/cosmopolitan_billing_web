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
        _col("wholesale", "Wholesale", default_hidden=True),
        _col("staff", "Staff", default_hidden=True),
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
        _col("wholesale", "Wholesale", default_hidden=True),
        _col("staff", "Staff", default_hidden=True),
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
        _col("linked", "Linked"),
    ],
    "sales.orders": [
        _col("number", "Order #", locked=True),
        _col("customer", "Customer"),
        _col("date", "Date"),
        _col("expected", "Expected"),
        _col("amount", "Amount"),
        _col("status", "Status", locked=True),
        _col("linked", "Linked"),
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
        _col("linked", "Linked"),
    ],
    "purchases.grns": [
        _col("number", "GRN #", locked=True),
        _col("po", "PO #"),
        _col("vendor", "Vendor"),
        _col("date", "Date"),
        _col("total", "Total"),
        _col("status", "Status", locked=True),
        _col("bill", "Bill #"),
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
    # Reports (table_key = reports.<report-id>)
    "reports.sales-register": [
        _col("invoice_number", "Invoice Number", locked=True),
        _col("invoice_date", "Invoice Date"),
        _col("customer", "Customer"),
        _col("branch", "Branch"),
        _col("cashier", "Cashier"),
        _col("taxable_amount", "Taxable Amount"),
        _col("tax_amount", "Tax Amount"),
        _col("discount", "Discount"),
        _col("net_amount", "Net Amount"),
        _col("payment_mode", "Payment Mode"),
        _col("status", "Status"),
    ],
    "reports.daily-sales": [
        _col("date", "Date", locked=True),
        _col("invoice_count", "Invoice Count"),
        _col("quantity_sold", "Quantity Sold"),
        _col("gross_sales", "Gross Sales"),
        _col("discounts", "Discounts"),
        _col("tax", "Tax"),
        _col("net_sales", "Net Sales"),
    ],
    "reports.product-sales": [
        _col("product_code", "Product Code", locked=True),
        _col("product_name", "Product Name"),
        _col("category", "Category"),
        _col("quantity_sold", "Quantity Sold"),
        _col("sales_value", "Sales Value"),
        _col("cost_value", "Cost Value"),
        _col("profit", "Profit"),
    ],
    "reports.payment-sales": [
        _col("payment_method", "Payment Method", locked=True),
        _col("invoice_count", "Invoice Count"),
        _col("quantity_sold", "Quantity Sold"),
        _col("sales_amount", "Sales Amount"),
        _col("tax_amount", "Tax Amount"),
        _col("net_sales", "Net Sales"),
    ],
    "reports.category-sales": [
        _col("category", "Category", locked=True),
        _col("quantity_sold", "Quantity Sold"),
        _col("sales_value", "Sales Value"),
        _col("cost_value", "Cost Value"),
        _col("profit", "Profit"),
    ],
    "reports.branch-sales": [
        _col("branch", "Branch", locked=True),
        _col("invoice_count", "Invoice Count"),
        _col("sales_amount", "Sales Amount"),
        _col("tax_amount", "Tax Amount"),
        _col("discount_amount", "Discount Amount"),
        _col("net_sales", "Net Sales"),
    ],
    "reports.cashier-sales": [
        _col("cashier", "Cashier", locked=True),
        _col("invoice_count", "Invoice Count"),
        _col("sales_amount", "Sales Amount"),
        _col("tax_amount", "Tax Amount"),
        _col("discount_amount", "Discount Amount"),
    ],
    "reports.purchase-register": [
        _col("bill_number", "Bill Number", locked=True),
        _col("bill_date", "Bill Date"),
        _col("vendor", "Vendor"),
        _col("branch", "Branch"),
        _col("subtotal", "Subtotal"),
        _col("tax", "Tax"),
        _col("total", "Total"),
        _col("paid", "Paid"),
        _col("balance", "Balance"),
        _col("status", "Status"),
    ],
    "reports.vendor-purchases": [
        _col("vendor", "Vendor", locked=True),
        _col("purchase_count", "Purchase Count"),
        _col("purchase_amount", "Purchase Amount"),
        _col("paid_amount", "Paid Amount"),
        _col("outstanding_amount", "Outstanding Amount"),
    ],
    "reports.product-purchases": [
        _col("product", "Product", locked=True),
        _col("quantity_purchased", "Quantity Purchased"),
        _col("purchase_cost", "Purchase Cost"),
        _col("average_cost", "Average Cost"),
    ],
    "reports.current-stock": [
        _col("product_code", "Product Code", locked=True),
        _col("product_name", "Product Name"),
        _col("category", "Category"),
        _col("branch", "Branch"),
        _col("available_stock", "Available Stock"),
        _col("reserved_stock", "Reserved Stock"),
        _col("stock_value", "Stock Value"),
    ],
    "reports.stock-movement": [
        _col("date", "Date", locked=True),
        _col("product", "Product"),
        _col("movement_type", "Movement Type"),
        _col("quantity", "Quantity"),
        _col("reference_number", "Reference Number"),
        _col("branch", "Branch"),
    ],
    "reports.low-stock": [
        _col("product", "Product", locked=True),
        _col("available_quantity", "Available Quantity"),
        _col("reorder_level", "Reorder Level"),
        _col("branch", "Branch"),
    ],
    "reports.out-of-stock": [
        _col("product", "Product", locked=True),
        _col("category", "Category"),
        _col("branch", "Branch"),
    ],
    "reports.stock-transfers": [
        _col("transfer_number", "Transfer Number", locked=True),
        _col("from_branch", "From Branch"),
        _col("to_branch", "To Branch"),
        _col("product", "Product"),
        _col("quantity", "Quantity"),
        _col("transfer_date", "Transfer Date"),
    ],
    "reports.spoilage-damage": [
        _col("date", "Date", locked=True),
        _col("reference_number", "Reference"),
        _col("product_code", "Product Code"),
        _col("product", "Product"),
        _col("branch", "Branch"),
        _col("before_qty", "Before Qty"),
        _col("after_qty", "After Qty"),
        _col("quantity_lost", "Qty Lost"),
        _col("reason", "Reason"),
        _col("notes", "Notes"),
        _col("adjusted_by", "Adjusted By"),
    ],
    "reports.expiry-batches": [
        _col("product_code", "Product Code", locked=True),
        _col("product", "Product"),
        _col("batch_number", "Batch"),
        _col("branch", "Branch"),
        _col("mfg_date", "Mfg Date"),
        _col("expiry_date", "Expiry Date"),
        _col("days_to_expiry", "Days Left"),
        _col("status", "Status"),
        _col("quantity", "Qty On Hand"),
        _col("stock_value", "Stock Value"),
    ],
    "reports.outstanding-receivables": [
        _col("customer", "Customer", locked=True),
        _col("invoice_number", "Invoice Number"),
        _col("invoice_date", "Invoice Date"),
        _col("due_date", "Due Date"),
        _col("outstanding_amount", "Outstanding Amount"),
    ],
    "reports.outstanding-payables": [
        _col("vendor", "Vendor", locked=True),
        _col("bill_number", "Bill Number"),
        _col("bill_date", "Bill Date"),
        _col("due_date", "Due Date"),
        _col("outstanding_amount", "Outstanding Amount"),
    ],
    "reports.profit-loss": [
        _col("account", "ACCOUNT", locked=True),
        _col("total", "TOTAL"),
    ],
    "reports.petty-cash": [
        _col("date", "Date", locked=True),
        _col("expense_category", "Expense Category"),
        _col("description", "Description"),
        _col("amount", "Amount"),
        _col("branch", "Branch"),
    ],
    "reports.top-customers": [
        _col("customer", "Customer", locked=True),
        _col("invoice_count", "Invoice Count"),
        _col("purchase_amount", "Purchase Amount"),
        _col("outstanding_amount", "Outstanding Amount"),
    ],
    "reports.vendor-outstanding": [
        _col("vendor", "Vendor", locked=True),
        _col("purchase_count", "Purchase Count"),
        _col("purchase_amount", "Purchase Amount"),
        _col("outstanding_amount", "Outstanding Amount"),
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

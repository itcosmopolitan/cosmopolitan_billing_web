"""Canonical Reports Center catalog (categories + report list metadata).

Source of truth for report tabs shown in the UI. Column customize catalogs
live in column_catalog.py under reports.<id>; labels here should stay in sync.
"""
from __future__ import annotations

from typing import Any


def _col(
    key: str,
    label: str,
    *,
    align: str | None = None,
    sortable: bool = True,
    format: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {"key": key, "label": label, "sortable": sortable}
    if align:
        out["align"] = align
    if format:
        out["format"] = format
    return out


def _report(
    id: str,
    label: str,
    *,
    api: str,
    default_sort: str,
    columns: list[dict[str, Any]],
    detail_type: str | None = None,
    list_hidden: bool = False,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": id,
        "label": label,
        "api": api,
        "defaultSort": default_sort,
        "columns": columns,
    }
    if detail_type:
        out["detailType"] = detail_type
    if list_hidden:
        out["listHidden"] = True
    return out


_SALES_INVOICE_COLUMNS = [
    _col("invoice_number", "Invoice Number"),
    _col("invoice_date", "Invoice Date", format="date"),
    _col("customer", "Customer"),
    _col("branch", "Branch"),
    _col("cashier", "Cashier"),
    _col("taxable_amount", "Taxable Amount", align="right", format="currency"),
    _col("tax_amount", "Tax Amount", align="right", format="currency"),
    _col("discount", "Discount", align="right", format="currency"),
    _col("net_amount", "Net Amount", align="right", format="currency"),
    _col("payment_mode", "Payment Mode"),
    _col("status", "Status"),
]

_SALES_LINE_COLUMNS = [
    _col("invoice_number", "Invoice Number"),
    _col("invoice_date", "Invoice Date", format="date"),
    _col("product_code", "Product Code"),
    _col("product_name", "Product Name"),
    _col("customer", "Customer"),
    _col("branch", "Branch"),
    _col("cashier", "Cashier"),
    _col("quantity", "Quantity", align="right", format="qty"),
    _col("unit_price", "Unit Price", align="right", format="currency"),
    _col("discount", "Discount", align="right", format="currency"),
    _col("line_total", "Line Total", align="right", format="currency"),
    _col("payment_mode", "Payment Mode"),
    _col("status", "Status"),
]

_PURCHASE_BILL_COLUMNS = [
    _col("bill_number", "Bill Number"),
    _col("bill_date", "Bill Date", format="date"),
    _col("vendor", "Vendor"),
    _col("branch", "Branch"),
    _col("subtotal", "Subtotal", align="right", format="currency"),
    _col("tax", "Tax", align="right", format="currency"),
    _col("total", "Total", align="right", format="currency"),
    _col("paid", "Paid", align="right", format="currency"),
    _col("balance", "Balance", align="right", format="currency"),
    _col("status", "Status"),
]

_PURCHASE_LINE_COLUMNS = [
    _col("bill_number", "Bill Number"),
    _col("bill_date", "Bill Date", format="date"),
    _col("product", "Product"),
    _col("vendor", "Vendor"),
    _col("branch", "Branch"),
    _col("quantity", "Quantity", align="right", format="qty"),
    _col("unit_cost", "Unit Cost", align="right", format="currency"),
    _col("discount", "Discount", align="right", format="currency"),
    _col("line_total", "Line Total", align="right", format="currency"),
    _col("status", "Status"),
]


def _invoice_detail(report_id: str, label: str) -> dict[str, Any]:
    return _report(
        report_id, label, api="salesRegister", default_sort="invoice_date",
        detail_type="invoice", list_hidden=True, columns=list(_SALES_INVOICE_COLUMNS),
    )


def _sales_line_detail(report_id: str, label: str) -> dict[str, Any]:
    return _report(
        report_id, label, api="salesLines", default_sort="invoice_date",
        detail_type="invoice", list_hidden=True, columns=list(_SALES_LINE_COLUMNS),
    )


def _bill_detail(report_id: str, label: str) -> dict[str, Any]:
    return _report(
        report_id, label, api="purchaseRegister", default_sort="bill_date",
        detail_type="bill", list_hidden=True, columns=list(_PURCHASE_BILL_COLUMNS),
    )


def _purchase_line_detail(report_id: str, label: str) -> dict[str, Any]:
    return _report(
        report_id, label, api="purchaseLines", default_sort="bill_date",
        detail_type="bill", list_hidden=True, columns=list(_PURCHASE_LINE_COLUMNS),
    )


# category_id → category definition (ordered)
REPORT_CATEGORIES: list[dict[str, Any]] = [
    {
        "id": "sales",
        "label": "Sales",
        "reports": [
            _report(
                "sales-register",
                "Sales Register",
                api="salesRegister",
                default_sort="invoice_date",
                detail_type="invoice",
                columns=[
                    _col("invoice_number", "Invoice Number"),
                    _col("invoice_date", "Invoice Date", format="date"),
                    _col("customer", "Customer"),
                    _col("branch", "Branch"),
                    _col("cashier", "Cashier"),
                    _col("taxable_amount", "Taxable Amount", align="right", format="currency"),
                    _col("tax_amount", "Tax Amount", align="right", format="currency"),
                    _col("discount", "Discount", align="right", format="currency"),
                    _col("net_amount", "Net Amount", align="right", format="currency"),
                    _col("payment_mode", "Payment Mode"),
                    _col("status", "Status"),
                ],
            ),
            _report(
                "daily-sales",
                "Daily Sales",
                api="dailySales",
                default_sort="date",
                columns=[
                    _col("date", "Date", format="date"),
                    _col("invoice_count", "Invoice Count", align="right", format="number"),
                    _col("quantity_sold", "Quantity Sold", align="right", format="qty"),
                    _col("gross_sales", "Gross Sales", align="right", format="currency"),
                    _col("discounts", "Discounts", align="right", format="currency"),
                    _col("tax", "Tax", align="right", format="currency"),
                    _col("net_sales", "Net Sales", align="right", format="currency"),
                ],
            ),
            _invoice_detail("daily-sales-detail", "Daily Sales Detail"),
            _report(
                "product-sales",
                "Product-wise Sales",
                api="productSales",
                default_sort="sales_value",
                columns=[
                    _col("product_code", "Product Code"),
                    _col("product_name", "Product Name"),
                    _col("category", "Category"),
                    _col("quantity_sold", "Quantity Sold", align="right", format="qty"),
                    _col("sales_value", "Sales Value", align="right", format="currency"),
                    _col("cost_value", "Cost Value", align="right", format="currency"),
                    _col("profit", "Profit", align="right", format="currency"),
                ],
            ),
            _sales_line_detail("product-sales-detail", "Product Sales Detail"),
            _report(
                "payment-sales",
                "Payment Method Sales",
                api="paymentSales",
                default_sort="sales_amount",
                columns=[
                    _col("payment_method", "Payment Method"),
                    _col("invoice_count", "Invoice Count", align="right", format="number"),
                    _col("quantity_sold", "Quantity Sold", align="right", format="qty"),
                    _col("sales_amount", "Sales Amount", align="right", format="currency"),
                    _col("tax_amount", "Tax Amount", align="right", format="currency"),
                    _col("net_sales", "Net Sales", align="right", format="currency"),
                ],
            ),
            _invoice_detail("payment-sales-detail", "Payment Method Detail"),
            _report(
                "category-sales",
                "Category-wise Sales",
                api="categorySales",
                default_sort="sales_value",
                columns=[
                    _col("category", "Category"),
                    _col("quantity_sold", "Quantity Sold", align="right", format="qty"),
                    _col("sales_value", "Sales Value", align="right", format="currency"),
                    _col("cost_value", "Cost Value", align="right", format="currency"),
                    _col("profit", "Profit", align="right", format="currency"),
                ],
            ),
            _sales_line_detail("category-sales-detail", "Category Sales Detail"),
            _report(
                "branch-sales",
                "Branch-wise Sales",
                api="branchSales",
                default_sort="sales_amount",
                columns=[
                    _col("branch", "Branch"),
                    _col("invoice_count", "Invoice Count", align="right", format="number"),
                    _col("sales_amount", "Sales Amount", align="right", format="currency"),
                    _col("tax_amount", "Tax Amount", align="right", format="currency"),
                    _col("discount_amount", "Discount Amount", align="right", format="currency"),
                    _col("net_sales", "Net Sales", align="right", format="currency"),
                ],
            ),
            _invoice_detail("branch-sales-detail", "Branch Sales Detail"),
            _report(
                "cashier-sales",
                "Cashier-wise Sales",
                api="cashierSales",
                default_sort="sales_amount",
                columns=[
                    _col("cashier", "Cashier"),
                    _col("invoice_count", "Invoice Count", align="right", format="number"),
                    _col("sales_amount", "Sales Amount", align="right", format="currency"),
                    _col("tax_amount", "Tax Amount", align="right", format="currency"),
                    _col("discount_amount", "Discount Amount", align="right", format="currency"),
                ],
            ),
            _invoice_detail("cashier-sales-detail", "Cashier Sales Detail"),
        ],
    },
    {
        "id": "purchase",
        "label": "Purchase",
        "reports": [
            _report(
                "purchase-register",
                "Purchase Register",
                api="purchaseRegister",
                default_sort="bill_date",
                detail_type="bill",
                columns=[
                    _col("bill_number", "Bill Number"),
                    _col("bill_date", "Bill Date", format="date"),
                    _col("vendor", "Vendor"),
                    _col("branch", "Branch"),
                    _col("subtotal", "Subtotal", align="right", format="currency"),
                    _col("tax", "Tax", align="right", format="currency"),
                    _col("total", "Total", align="right", format="currency"),
                    _col("paid", "Paid", align="right", format="currency"),
                    _col("balance", "Balance", align="right", format="currency"),
                    _col("status", "Status"),
                ],
            ),
            _report(
                "vendor-purchases",
                "Vendor-wise Purchase",
                api="vendorPurchases",
                default_sort="purchase_amount",
                columns=[
                    _col("vendor", "Vendor"),
                    _col("purchase_count", "Purchase Count", align="right", format="number"),
                    _col("purchase_amount", "Purchase Amount", align="right", format="currency"),
                    _col("paid_amount", "Paid Amount", align="right", format="currency"),
                    _col("outstanding_amount", "Outstanding Amount", align="right", format="currency"),
                ],
            ),
            _bill_detail("vendor-purchases-detail", "Vendor Purchase Detail"),
            _report(
                "product-purchases",
                "Product-wise Purchase",
                api="productPurchases",
                default_sort="quantity_purchased",
                columns=[
                    _col("product", "Product"),
                    _col("quantity_purchased", "Quantity Purchased", align="right", format="qty"),
                    _col("purchase_cost", "Purchase Cost", align="right", format="currency"),
                    _col("average_cost", "Average Cost", align="right", format="currency"),
                ],
            ),
            _purchase_line_detail("product-purchases-detail", "Product Purchase Detail"),
        ],
    },
    {
        "id": "inventory",
        "label": "Inventory",
        "reports": [
            _report(
                "current-stock",
                "Current Stock",
                api="currentStock",
                default_sort="product_code",
                columns=[
                    _col("product_code", "Product Code"),
                    _col("product_name", "Product Name"),
                    _col("category", "Category"),
                    _col("branch", "Branch"),
                    _col("available_stock", "Available Stock", align="right", format="qty"),
                    _col("reserved_stock", "Reserved Stock", align="right", format="qty"),
                    _col("stock_value", "Stock Value", align="right", format="currency"),
                ],
            ),
            _report(
                "stock-movement",
                "Stock Movement",
                api="stockMovement",
                default_sort="date",
                columns=[
                    _col("date", "Date", format="date"),
                    _col("product", "Product"),
                    _col("movement_type", "Movement Type"),
                    _col("quantity", "Quantity", align="right", format="qty"),
                    _col("reference_number", "Reference Number"),
                    _col("branch", "Branch"),
                ],
            ),
            _report(
                "low-stock",
                "Low Stock",
                api="lowStock",
                default_sort="product_name",
                columns=[
                    _col("product", "Product"),
                    _col("available_quantity", "Available Quantity", align="right", format="qty"),
                    _col("reorder_level", "Reorder Level", align="right", format="qty"),
                    _col("branch", "Branch"),
                ],
            ),
            _report(
                "out-of-stock",
                "Out of Stock",
                api="outOfStock",
                default_sort="product",
                columns=[
                    _col("product", "Product"),
                    _col("category", "Category"),
                    _col("branch", "Branch"),
                ],
            ),
            _report(
                "stock-transfers",
                "Stock Transfer",
                api="stockTransfers",
                default_sort="transfer_date",
                detail_type="transfer",
                columns=[
                    _col("transfer_number", "Transfer Number"),
                    _col("from_branch", "From Branch"),
                    _col("to_branch", "To Branch"),
                    _col("product", "Product"),
                    _col("quantity", "Quantity", align="right", format="qty"),
                    _col("transfer_date", "Transfer Date", format="date"),
                ],
            ),
            _report(
                "spoilage-damage",
                "Spoilage / Damage",
                api="spoilageDamage",
                default_sort="date",
                columns=[
                    _col("date", "Date", format="date"),
                    _col("reference_number", "Reference"),
                    _col("product_code", "Product Code"),
                    _col("product", "Product"),
                    _col("branch", "Branch"),
                    _col("before_qty", "Before Qty", align="right", format="qty"),
                    _col("after_qty", "After Qty", align="right", format="qty"),
                    _col("quantity_lost", "Qty Lost", align="right", format="qty"),
                    _col("reason", "Reason"),
                    _col("notes", "Notes", sortable=False),
                    _col("adjusted_by", "Adjusted By"),
                ],
            ),
            _report(
                "expiry-batches",
                "Expired / Near Expiry",
                api="expiryBatches",
                default_sort="expiry_date",
                columns=[
                    _col("product_code", "Product Code"),
                    _col("product", "Product"),
                    _col("batch_number", "Batch"),
                    _col("branch", "Branch"),
                    _col("mfg_date", "Mfg Date", format="date"),
                    _col("expiry_date", "Expiry Date", format="date"),
                    _col("days_to_expiry", "Days Left", align="right", sortable=False, format="number"),
                    _col("status", "Status"),
                    _col("quantity", "Qty On Hand", align="right", format="qty"),
                    _col("stock_value", "Stock Value", align="right", format="currency"),
                ],
            ),
        ],
    },
    {
        "id": "financial",
        "label": "Financial",
        "reports": [
            _report(
                "outstanding-receivables",
                "Outstanding Receivables",
                api="outstandingReceivables",
                default_sort="due_date",
                detail_type="invoice",
                columns=[
                    _col("customer", "Customer"),
                    _col("invoice_number", "Invoice Number"),
                    _col("invoice_date", "Invoice Date", format="date"),
                    _col("due_date", "Due Date", format="date"),
                    _col("outstanding_amount", "Outstanding Amount", align="right", format="currency"),
                ],
            ),
            _report(
                "outstanding-payables",
                "Outstanding Payables",
                api="outstandingPayables",
                default_sort="due_date",
                detail_type="bill",
                columns=[
                    _col("vendor", "Vendor"),
                    _col("bill_number", "Bill Number"),
                    _col("bill_date", "Bill Date", format="date"),
                    _col("due_date", "Due Date", format="date"),
                    _col("outstanding_amount", "Outstanding Amount", align="right", format="currency"),
                ],
            ),
            _report(
                "profit-loss",
                "Profit & Loss",
                api="profitLoss",
                default_sort="sort_order",
                columns=[
                    _col("account", "ACCOUNT", sortable=False),
                    _col("total", "TOTAL", align="right", sortable=False, format="currency_blank"),
                ],
            ),
            _report(
                "petty-cash",
                "Petty Cash",
                api="pettyCash",
                default_sort="date",
                columns=[
                    _col("date", "Date", format="date"),
                    _col("expense_category", "Expense Category"),
                    _col("description", "Description"),
                    _col("amount", "Amount", align="right", format="currency"),
                    _col("branch", "Branch"),
                ],
            ),
        ],
    },
    {
        "id": "taxes",
        "label": "Taxes",
        "reports": [
            _report(
                "tax-summary",
                "Tax Summary",
                api="taxSummary",
                default_sort="tax_name",
                columns=[
                    _col("tax_name", "Tax Name"),
                    _col("tax_percentage", "Tax Percentage", align="right", format="number"),
                    _col("taxable_amount", "Taxable Amount", align="right", format="currency"),
                    _col("tax_amount", "Tax Amount", align="right", format="currency"),
                ],
            ),
            _report(
                "tax-summary-detail",
                "Tax Summary Detail",
                api="taxSummaryDetail",
                default_sort="date",
                detail_type="tax_txn",
                list_hidden=True,
                columns=[
                    _col("date", "Date", format="date"),
                    _col("entry_number", "Entry#"),
                    _col("transaction_type", "Transaction Type"),
                    _col("transaction_amount", "Transaction Amount", align="right", format="currency"),
                    _col("tax_amount", "Tax Amount", align="right", format="currency"),
                ],
            ),
        ],
    },
    {
        "id": "customers",
        "label": "Customers",
        "reports": [
            _report(
                "top-customers",
                "Top Customers",
                api="topCustomers",
                default_sort="purchase_amount",
                columns=[
                    _col("customer", "Customer"),
                    _col("invoice_count", "Invoice Count", align="right", format="number"),
                    _col("purchase_amount", "Purchase Amount", align="right", format="currency"),
                    _col("outstanding_amount", "Outstanding Amount", align="right", format="currency"),
                ],
            ),
            _invoice_detail("top-customers-detail", "Customer Sales Detail"),
        ],
    },
    {
        "id": "vendors",
        "label": "Vendors",
        "reports": [
            _report(
                "vendor-outstanding",
                "Vendor Outstanding",
                api="vendorOutstanding",
                default_sort="outstanding_amount",
                columns=[
                    _col("vendor", "Vendor"),
                    _col("purchase_count", "Purchase Count", align="right", format="number"),
                    _col("purchase_amount", "Purchase Amount", align="right", format="currency"),
                    _col("outstanding_amount", "Outstanding Amount", align="right", format="currency"),
                ],
            ),
            _bill_detail("vendor-outstanding-detail", "Vendor Outstanding Detail"),
        ],
    },
]


def known_report_ids() -> set[str]:
    ids: set[str] = set()
    for category in REPORT_CATEGORIES:
        for report in category.get("reports") or []:
            rid = report.get("id")
            if isinstance(rid, str) and rid:
                ids.add(rid)
    return ids


def normalize_favorite_ids(raw: Any) -> list[str]:
    """Keep order, drop unknowns / duplicates."""
    known = known_report_ids()
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        if item is None:
            continue
        rid = str(item).strip()
        if not rid or rid not in known or rid in seen:
            continue
        seen.add(rid)
        out.append(rid)
    return out


def build_catalog_payload(favorite_ids: list[str] | None = None) -> dict[str, Any]:
    return {
        "categories": REPORT_CATEGORIES,
        "favorites": normalize_favorite_ids(favorite_ids or []),
    }

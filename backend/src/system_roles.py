"""
The 6 system roles, defined once and imported by both:
  - seed.py (full destructive seed)
  - database.py (idempotent boot-time bootstrap, so existing demo DBs that
    weren't re-seeded still get the system roles when pulling this branch)

Permission strings come from src/permissions.py PERMISSIONS catalog.
"""
from __future__ import annotations

# (id, key, label, color, description, permissions)
SYSTEM_ROLES: list[tuple[str, str, str, str, str, list[str]]] = [
    ("role-super-admin",       "super_admin",       "Super Admin",        "purple",
        "Full access to all modules and settings.",
        ["*"]),
    ("role-branch-manager",    "branch_manager",    "Branch Manager",     "blue",
        "Manage branch operations, sales, and inventory.",
        # 2026-05-25: added `purchases.*` so branch managers can record +
        # delete bills, POs, vendor returns, and vendor payments. Was a
        # gap — they had invoices.* but no purchases at all, so the new
        # bulk-delete UX wouldn't work for them on the purchases side.
        ["dashboard.*", "pos.*", "invoices.*",
         "items.view", "items.edit", "items.adjust", "items.export",
         "transfers.create", "transfers.approve", "transfers.delete",
         "adjustments.view", "adjustments.create", "adjustments.approve", "adjustments.delete",
         "customers.*", "vendors.view",
         "purchases.*",
         "cash.view", "cash.edit",
         "reports.*"]),
    ("role-cashier",           "cashier",           "Cashier",            "teal",
        "Process sales and manage cash transactions.",
        ["dashboard.view", "dashboard.billing.view",
         "pos.use", "pos.hold_bill", "pos.split_payment",
         "invoices.create", "invoices.view", "invoices.cancel",
         "cash.view", "cash.entry",
         "customers.view"]),
    ("role-inventory-manager", "inventory_manager", "Inventory Manager",  "amber",
        "Manage inventory, stock transfers, and purchasing.",
        ["dashboard.view", "dashboard.inventory.view",
         "items.*", "transfers.*", "adjustments.*",
         "purchases.view", "purchases.create",
         "reports.*"]),
    ("role-finance",           "finance",           "Finance",            "green",
        "View and manage financial reports and cash flows.",
        ["dashboard.*",
         "invoices.view", "invoices.export",
         "purchases.view", "purchases.export",
         "cash.*", "reports.*"]),
    ("role-purchase-admin",    "purchase_admin",    "Purchase Admin",     "coral",
        "Manage vendor relationships and purchase orders.",
        ["dashboard.view", "dashboard.inventory.view",
         "purchases.*", "vendors.*", "reports.view"]),
]

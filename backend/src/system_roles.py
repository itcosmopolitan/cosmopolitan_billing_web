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
        ["dashboard.*", "pos.*", "invoices.*",
         "items.view", "items.edit", "items.adjust", "items.export",
         "transfers.create", "transfers.approve",
         "adjustments.view", "adjustments.create", "adjustments.approve",
         "customers.*", "vendors.view",
         "cash.view", "cash.edit",
         "reports.*"]),
    ("role-cashier",           "cashier",           "Cashier",            "teal",
        "Process sales and manage cash transactions.",
        ["dashboard.view",
         "pos.use", "pos.hold_bill", "pos.split_payment",
         "invoices.create", "invoices.view", "invoices.cancel",
         "cash.view", "cash.entry",
         "customers.view"]),
    ("role-inventory-manager", "inventory_manager", "Inventory Manager",  "amber",
        "Manage inventory, stock transfers, and purchasing.",
        ["dashboard.view", "items.*", "transfers.*", "adjustments.*",
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
        ["dashboard.view", "purchases.*", "vendors.*", "reports.view"]),
]

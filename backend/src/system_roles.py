"""
System roles — imported by seed.py and database.py bootstrap.

Three operational tiers (+ Super Admin) for branch deployments. Approval is
permission-driven: `module.create` raises pending records; `module.approve`
commits directly and can approve others' submissions in each module's UI.
"""
from __future__ import annotations

# (id, key, label, color, description, permissions)
SYSTEM_ROLES: list[tuple[str, str, str, str, str, list[str]]] = [
    ("role-super-admin", "super_admin", "Super Admin", "purple",
        "Full access to all modules and settings.",
        ["*"]),
    ("role-branch-manager", "branch_manager", "Branch Manager", "blue",
        "Final approver; manages branch operations, sales, inventory, and purchases.",
        ["dashboard.*", "pos.*", "invoices.*",
         "item_master.*", "items.*",
         "transfers.*", "adjustments.*",
         "customers.*", "vendors.*",
         "purchases.*",
         "cash.*", "reports.*"]),
    ("role-branch-supervisor", "branch_supervisor", "Branch Supervisor", "amber",
        "Day-to-day operations; raises transactions for manager approval.",
        ["dashboard.view", "dashboard.sales.view", "dashboard.inventory.view",
         "dashboard.billing.view", "dashboard.operations.view",
         "pos.use", "pos.discount", "pos.hold_bill", "pos.split_payment",
         "pos.open_till", "pos.close_till",
         "invoices.view", "invoices.create", "invoices.edit", "invoices.cancel",
         "invoices.export",
         "items.view", "items.export", "items.adjust",
         "item_master.view", "item_master.create", "item_master.edit",
         "item_master.export",
         "transfers.view", "transfers.create", "transfers.receive",
         "adjustments.view", "adjustments.create",
         "customers.view", "customers.create", "customers.edit",
         "purchases.view", "purchases.create", "purchases.edit",
         "vendors.view",
         "cash.view", "cash.entry", "cash.close",
         "reports.view"]),
    ("role-cashier", "cashier", "Cashier", "teal",
        "Process POS sales and cash transactions.",
        ["dashboard.view", "dashboard.billing.view",
         "pos.use", "pos.hold_bill", "pos.split_payment",
         "pos.open_till", "pos.close_till",
         "invoices.create", "invoices.view",
         "cash.view", "cash.entry", "cash.close",
         "customers.view"]),
]

# Legacy system roles removed on boot (users migrated to branch_supervisor first).
LEGACY_SYSTEM_ROLE_IDS: frozenset[str] = frozenset({
    "role-inventory-manager",
    "role-finance",
    "role-purchase-admin",
})

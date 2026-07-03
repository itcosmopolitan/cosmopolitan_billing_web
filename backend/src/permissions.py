"""
Permission catalog — single source of truth for the RBAC system.

See docs/USERS_AND_ROLES.md for the full design and decisions.

Adding a new permission:
    1. Add it to PERMISSIONS below.
    2. (Optional) Grant it to a system role in seed.py SYSTEM_ROLES.
    3. (Optional) Grant it to existing custom roles via the Roles editor UI.
    4. Use Depends(require_perm("module.action")) on the route in Phase 2+.
"""
from __future__ import annotations

PERMISSIONS: dict[str, list[str]] = {
    "dashboard": [
        "view",
        "sales.view",
        "inventory.view",
        "billing.view",
        "operations.view",
        "profit.view",
        "staff_performance.view",
        "export",
    ],
    "item_master": ["view", "create", "edit", "delete", "export", "approve"],
    # Branch Items & Stock — view stock, batches; qty changes go via adjustments.*
    "items":       ["view", "export", "adjust"],
    "invoices":  ["view", "create", "edit", "delete", "cancel", "export", "approve"],
    "pos":       ["use", "discount", "override_price", "refund", "approve_refund",
                  "hold_bill", "split_payment", "open_till", "close_till"],
    "purchases": ["view", "create", "edit", "delete", "export", "approve"],
    "transfers":   ["view", "create", "approve", "receive", "delete"],
    "adjustments": ["view", "create", "approve", "delete"],
    "customers": ["view", "create", "edit", "delete"],
    "vendors":   ["view", "create", "edit", "delete"],
    "cash":      ["view", "entry", "edit", "close", "export", "unlock", "monitor", "approve_close"],
    "reports":   ["view", "export"],
    "users":     ["view", "create", "edit", "delete", "manage_roles"],
    "settings":  ["view", "edit"],
    "audit":     ["view"],
    "history":   ["view"],
    "comments":  ["view", "add", "edit_own", "delete_any"],
}

# ─── Operational read bundles ────────────────────────────────────────────────
# Read-only endpoints that transactional UIs depend on. Routes use
# `Depends(require_perm(*BUNDLE))` — any one permission in the bundle grants access.

# Item list / batch lookups for billing, purchases, and stock workflows.
ITEM_CATALOG_READ: tuple[str, ...] = (
    "items.view",
    "item_master.view",
    "pos.use",
    "invoices.create",
    "invoices.edit",
    "invoices.view",
    "purchases.create",
    "purchases.edit",
    "transfers.create",
    "transfers.receive",
    "adjustments.create",
)

# Customer picker and credit check during POS / invoice flows.
CUSTOMER_PICKER_READ: tuple[str, ...] = (
    "customers.view",
    "pos.use",
    "invoices.create",
    "invoices.edit",
)

# Vendor picker in purchase order / bill forms.
VENDOR_PICKER_READ: tuple[str, ...] = (
    "vendors.view",
    "purchases.create",
    "purchases.edit",
)

# Organisation profile and invoice print template (POS, receipts, billing).
BILLING_SETTINGS_READ: tuple[str, ...] = (
    "settings.view",
    "pos.use",
    "invoices.create",
    "invoices.view",
)

# Cash entry category list (configured under Settings, used on Cash page).
CASH_CATEGORIES_READ: tuple[str, ...] = (
    "settings.view",
    "cash.view",
    "cash.entry",
    "cash.edit",
    "cash.close",
)

# Status tab counts on list pages — allow creators/approvers without full view.
MODULE_SUMMARY_READ: dict[str, tuple[str, ...]] = {
    "transfers": (
        "transfers.view",
        "transfers.create",
        "transfers.approve",
        "transfers.receive",
    ),
    "adjustments": (
        "adjustments.view",
        "adjustments.create",
        "adjustments.approve",
    ),
}

# Read sales documents (lists, detail) needed by create/edit/convert/refund flows.
SALES_DOCUMENT_READ: tuple[str, ...] = (
    "invoices.view",
    "invoices.create",
    "invoices.edit",
    "pos.use",
    "pos.refund",
    "pos.approve_refund",
)

# Read purchase documents for bill/GRN/PO create and conversion flows.
PURCHASE_DOCUMENT_READ: tuple[str, ...] = (
    "purchases.view",
    "purchases.create",
    "purchases.edit",
)

# Read transfer records for create/edit form preload.
TRANSFER_DOCUMENT_READ: tuple[str, ...] = (
    "transfers.view",
    "transfers.create",
    "transfers.approve",
    "transfers.receive",
)


def all_perms() -> list[str]:
    """Flat list of every concrete `module.action` string."""
    return [f"{m}.{a}" for m, acts in PERMISSIONS.items() for a in acts]


def is_valid(perm: str) -> bool:
    """True if the string is `*`, `module.*`, or a concrete `module.action` in the catalog."""
    if perm == "*":
        return True
    if "." not in perm:
        return False
    module, action = perm.split(".", 1)
    if module not in PERMISSIONS:
        return False
    if action == "*":
        return True
    return action in PERMISSIONS[module]


def filter_valid(perms: list[str]) -> list[str]:
    """Drop unknown perms (D1: custom roles can only pick from the catalog)."""
    seen: set[str] = set()
    out: list[str] = []
    for p in perms or []:
        if is_valid(p) and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def expand(granted: list[str]) -> set[str]:
    """Expand `*` and `module.*` wildcards into the concrete permission set."""
    out: set[str] = set()
    if not granted:
        return out
    if "*" in granted:
        return set(all_perms())
    for p in granted:
        if p.endswith(".*"):
            module = p[:-2]
            for action in PERMISSIONS.get(module, []):
                out.add(f"{module}.{action}")
        else:
            out.add(p)
    return out

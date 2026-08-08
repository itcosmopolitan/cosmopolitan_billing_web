"""Notification kind → permission mapping (shared across store/service)."""

KIND_PERMS: dict[str, tuple[str, ...]] = {
    "inventory.low_stock": ("items.view", "item_master.view", "adjustments.create"),
    "inventory.out_of_stock": ("items.view", "item_master.view", "adjustments.create"),
    "batch.near_expiry": ("items.view", "item_master.view"),
    "batch.expired": ("items.view", "item_master.view"),
    "approval.adjustment_pending": ("adjustments.approve",),
    "approval.transfer_pending": ("transfers.approve",),
    "approval.purchase_order_pending": ("purchases.approve",),
    "approval.bill_pending": ("purchases.approve",),
    "approval.grn_pending": ("purchases.approve",),
    "approval.item_master_pending": ("item_master.approve",),
    "approval.invoice_pending": ("invoices.approve",),
    "approval.sales_order_pending": ("invoices.approve",),
    "finance.invoice_overdue": ("invoices.view",),
    "finance.bill_overdue": ("purchases.view",),
    "ops.transfer_in_transit": ("transfers.receive", "transfers.view"),
}

SEVERITY_RANK = {"danger": 0, "warning": 1, "info": 2}


def can_see_kind(grants: set[str], kind: str) -> bool:
    if "*" in grants:
        return True
    needed = KIND_PERMS.get(kind, ())
    return any(p in grants for p in needed)


def can_see_any(grants: set[str], *kinds: str) -> bool:
    return any(can_see_kind(grants, k) for k in kinds)

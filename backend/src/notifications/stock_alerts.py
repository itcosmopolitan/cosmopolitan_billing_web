"""Targeted stock alert refresh after a single item×branch movement (Phase 6d)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.item_branch import effective_reorder_level
from src.models import Item, ItemBranchConfig, ItemStock
from src.notifications.evaluator import NotificationCandidate
from src.notifications.store import notify_refresh, resolve_notification, upsert_from_candidate


async def refresh_stock_alerts_for_item(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
) -> None:
    """Upsert or resolve low-stock / out-of-stock for one SKU at one branch."""
    row = (
        await db.execute(
            select(ItemStock.quantity, Item.name, Item.reorder_level, Item.active)
            .join(Item, Item.id == ItemStock.item_id)
            .where(ItemStock.item_id == item_id, ItemStock.branch_id == branch_id)
        )
    ).one_or_none()

    cfg = (
        await db.execute(
            select(ItemBranchConfig.reorder_level).where(
                ItemBranchConfig.item_id == item_id,
                ItemBranchConfig.branch_id == branch_id,
            )
        )
    ).scalar_one_or_none()

    low_key = f"inventory.low_stock:{item_id}:{branch_id}"
    out_key = f"inventory.out_of_stock:{item_id}:{branch_id}"

    if not row or not row.active:
        await resolve_notification(db, low_key)
        await resolve_notification(db, out_key)
        return

    qty = int(row.quantity or 0)
    reorder = effective_reorder_level(int(row.reorder_level or 0), cfg)
    name = row.name or "Item"

    if qty <= 0:
        await resolve_notification(db, low_key)
        await upsert_from_candidate(
            db,
            NotificationCandidate(
                id=out_key,
                kind="inventory.out_of_stock",
                severity="danger",
                title=f"{name} out of stock",
                branch_id=branch_id,
                href=f"/items?search={name}",
            ),
        )
    elif qty <= reorder:
        await resolve_notification(db, out_key)
        await upsert_from_candidate(
            db,
            NotificationCandidate(
                id=low_key,
                kind="inventory.low_stock",
                severity="warning",
                title=f"{name} low stock",
                body=f"Qty {qty} · Reorder {reorder}",
                branch_id=branch_id,
                href=f"/items?search={name}",
            ),
        )
    else:
        await resolve_notification(db, low_key)
        await resolve_notification(db, out_key)


async def refresh_stock_alerts_and_notify(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
) -> None:
    await refresh_stock_alerts_for_item(db, item_id=item_id, branch_id=branch_id)
    await notify_refresh()

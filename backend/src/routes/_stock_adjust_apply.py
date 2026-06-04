"""Apply an approved stock adjustment (shared by adjustments.approve)."""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Item, ItemStock
from src.routes._atomic import (
    add_batch_atomic,
    consume_batches_atomic,
    set_batch_quantity_atomic,
    set_stock_atomic,
)


async def apply_stock_adjustment(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    new_qty: int,
    reason: str,
    notes: Optional[str] = None,
    batch_id: Optional[str] = None,
) -> dict:
    """Set stock to *new_qty* using the same rules as the legacy items.adjust endpoint."""
    if new_qty < 0:
        raise ValueError("new_qty must be >= 0")

    if batch_id:
        b = await set_batch_quantity_atomic(
            db, batch_id=batch_id, new_qty=int(new_qty)
        )
        if not b:
            raise LookupError("Batch not found")
        return {"message": "Batch adjusted", "batch_id": b.id}

    item_row = await db.execute(
        select(Item.batch_tracking, Item.expiry_tracking).where(Item.id == item_id)
    )
    item_flags = item_row.first()
    tracked = bool(item_flags and item_flags.batch_tracking)

    if not tracked:
        await set_stock_atomic(
            db,
            item_id=item_id,
            branch_id=branch_id,
            new_qty=int(new_qty),
        )
        return {"message": "Stock adjusted"}

    cur_row = await db.execute(
        select(ItemStock.quantity).where(
            ItemStock.item_id == item_id,
            ItemStock.branch_id == branch_id,
        )
    )
    cur = int(cur_row.scalar() or 0)
    delta = int(new_qty) - cur
    if delta == 0:
        return {"message": "No change"}

    if delta > 0:
        await add_batch_atomic(
            db,
            item_id=item_id,
            branch_id=branch_id,
            qty=delta,
            source_type="adjustment",
            source_ref=reason,
            notes=notes,
        )
    else:
        strategy = "fefo" if (item_flags and item_flags.expiry_tracking) else "fifo"
        try:
            await consume_batches_atomic(
                db,
                item_id=item_id,
                branch_id=branch_id,
                qty=-delta,
                strategy=strategy,
            )
        except ValueError:
            await db.execute(
                text(
                    "UPDATE item_batches SET quantity = 0 "
                    "WHERE item_id = :i AND branch_id = :b"
                ),
                {"i": item_id, "b": branch_id},
            )
            await set_stock_atomic(
                db,
                item_id=item_id,
                branch_id=branch_id,
                new_qty=int(new_qty),
            )

    return {"message": "Stock adjusted"}

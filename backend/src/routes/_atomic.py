"""
Atomic single-statement helpers for stock and money mutations.

Replaces the read-modify-write pattern that the route handlers were using
(`SELECT row → modify in Python → UPDATE row`) which raced under concurrent
requests — two callers could read the same value, both compute, both write,
the second write silently overwriting the first. Each helper here issues
ONE UPDATE statement so the database does the arithmetic atomically.

These work on SQLite via aiosqlite; the WHERE clauses double as guards
against going negative on stock or paying past the invoice total.
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import ItemStock, SaleInvoice


async def adjust_stock_atomic(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    delta: int,
) -> int:
    """Apply `delta` to the (item_id, branch_id) stock row and return the new
    quantity. Creates the row if it doesn't exist (delta becomes the opening
    quantity, clamped at 0). For negative deltas, refuses if the resulting
    quantity would go below zero (raises ValueError); the WHERE clause does
    the check so the overall operation is still race-safe.
    """
    if delta == 0:
        # No-op, but still return the current quantity for callers.
        row = await db.execute(
            select(ItemStock.quantity).where(
                ItemStock.item_id == item_id,
                ItemStock.branch_id == branch_id,
            )
        )
        return int(row.scalar() or 0)

    if delta > 0:
        # Try the atomic UPDATE first; if no row exists yet, insert it.
        result = await db.execute(
            text(
                "UPDATE item_stock SET quantity = quantity + :delta "
                "WHERE item_id = :item_id AND branch_id = :branch_id"
            ),
            {"delta": delta, "item_id": item_id, "branch_id": branch_id},
        )
        if result.rowcount == 0:
            db.add(ItemStock(
                id=str(uuid.uuid4()),
                item_id=item_id,
                branch_id=branch_id,
                quantity=delta,
            ))
            await db.flush()
            return delta
    else:
        # Decrement: WHERE quantity + delta >= 0 prevents oversell.
        result = await db.execute(
            text(
                "UPDATE item_stock SET quantity = quantity + :delta "
                "WHERE item_id = :item_id AND branch_id = :branch_id "
                "AND quantity + :delta >= 0"
            ),
            {"delta": delta, "item_id": item_id, "branch_id": branch_id},
        )
        if result.rowcount == 0:
            # Either no stock row, or insufficient stock. Surface the latter
            # since it's the actionable case; the caller can decide what to
            # do (e.g. allow the sale anyway and let stock go to zero).
            current = await db.execute(
                select(ItemStock.quantity).where(
                    ItemStock.item_id == item_id,
                    ItemStock.branch_id == branch_id,
                )
            )
            cur = int(current.scalar() or 0)
            raise ValueError(
                f"Insufficient stock for item={item_id} branch={branch_id}: "
                f"have {cur}, need {-delta}"
            )

    # Read back the new quantity (one extra round-trip, acceptable for the
    # POS flow; we don't bother for the bulk write path).
    row = await db.execute(
        select(ItemStock.quantity).where(
            ItemStock.item_id == item_id,
            ItemStock.branch_id == branch_id,
        )
    )
    return int(row.scalar() or 0)


async def set_stock_atomic(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    new_qty: int,
) -> int:
    """Set the absolute quantity (used by `items.adjust_stock`). Last-write-
    wins is acceptable here because adjustments are deliberate operator
    actions, not concurrent automated flows."""
    if new_qty < 0:
        raise ValueError("new_qty must be >= 0")
    result = await db.execute(
        text(
            "UPDATE item_stock SET quantity = :q "
            "WHERE item_id = :item_id AND branch_id = :branch_id"
        ),
        {"q": new_qty, "item_id": item_id, "branch_id": branch_id},
    )
    if result.rowcount == 0:
        db.add(ItemStock(
            id=str(uuid.uuid4()),
            item_id=item_id,
            branch_id=branch_id,
            quantity=new_qty,
        ))
        await db.flush()
    return new_qty


async def add_payment_atomic(
    db: AsyncSession,
    *,
    invoice_id: str,
    amount: float,
) -> Optional[tuple[float, float]]:
    """Add `amount` to `sale_invoices.paid_amount`, clamped to `total`.
    Returns (new_paid_amount, balance) or None if the invoice doesn't exist.

    The clamp + comparison happens in one statement; concurrent partial
    payments can no longer race past the total.
    """
    if amount <= 0:
        return None

    # MIN(total, paid_amount + :amt) prevents overpayment race.
    await db.execute(
        text(
            "UPDATE sale_invoices "
            "SET paid_amount = MIN(total, paid_amount + :amt), "
            "    status = CASE WHEN MIN(total, paid_amount + :amt) >= total "
            "                  THEN 'paid' ELSE 'partial' END "
            "WHERE id = :id"
        ),
        {"amt": amount, "id": invoice_id},
    )
    row = await db.execute(
        select(SaleInvoice.paid_amount, SaleInvoice.total).where(SaleInvoice.id == invoice_id)
    )
    r = row.first()
    if not r:
        return None
    paid = float(r.paid_amount or 0)
    total = float(r.total or 0)
    return paid, round(total - paid, 2)

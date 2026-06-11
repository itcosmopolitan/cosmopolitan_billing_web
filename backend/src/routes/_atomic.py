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
from datetime import datetime
from typing import Optional

from sqlalchemy import asc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Item, ItemBatch, ItemStock, SaleInvoice


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
        # Atomically insert-or-increment the row. This avoids the classic
        # read-modify-write race when the stock row doesn't yet exist.
        await db.execute(
            text(
                "INSERT INTO item_stock (id, item_id, branch_id, quantity) "
                "VALUES (:id, :item_id, :branch_id, :delta) "
                "ON CONFLICT(item_id, branch_id) DO UPDATE "
                "SET quantity = quantity + :delta"
            ),
            {
                "id": str(uuid.uuid4()),
                "item_id": item_id,
                "branch_id": branch_id,
                "delta": delta,
            },
        )
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
    await db.execute(
        text(
            "INSERT INTO item_stock (id, item_id, branch_id, quantity) "
            "VALUES (:id, :item_id, :branch_id, :q) "
            "ON CONFLICT(item_id, branch_id) DO UPDATE "
            "SET quantity = :q"
        ),
        {
            "id": str(uuid.uuid4()),
            "item_id": item_id,
            "branch_id": branch_id,
            "q": new_qty,
        },
    )
    return new_qty


# ─── Batch (FIFO / FEFO) helpers ─────────────────────────────────────────────
# Tracked items keep a row per parcel in `item_batches`. Untracked items skip
# the batch table entirely — `is_tracked()` is the gate every batch helper
# checks first so callers can blindly invoke them without branching at the
# call-site (purchases, sales, transfers all do this).


async def is_tracked(db: AsyncSession, item_id: str) -> tuple[bool, bool]:
    """Return (batch_tracking, expiry_tracking) flags for the item. Missing
    item => (False, False) so callers degrade to the legacy stock flow."""
    row = await db.execute(
        select(Item.batch_tracking, Item.expiry_tracking).where(Item.id == item_id)
    )
    r = row.first()
    if not r:
        return False, False
    return bool(r.batch_tracking), bool(r.expiry_tracking)


def _today() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def _next_batch_number(item_id: str) -> str:
    """Auto-generated batch number when the vendor didn't supply one. Short
    + sortable: BCH-<short-uuid>. Persisted on the row so the UI is stable."""
    return f"BCH-{uuid.uuid4().hex[:8].upper()}"


async def add_batch_atomic(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    qty: int,
    batch_number: Optional[str] = None,
    mfg_date: Optional[str] = None,
    expiry_date: Optional[str] = None,
    cost_price: float = 0,
    vendor_id: Optional[str] = None,
    source_type: str = "manual",
    source_ref: Optional[str] = None,
    received_date: Optional[str] = None,
    notes: Optional[str] = None,
) -> Optional[ItemBatch]:
    """Create a new batch row AND bump item_stock atomically. Returns the
    persisted ItemBatch (or None if qty <= 0). Caller must `await db.commit()`.
    Used by purchases, transfer-receive, opening-stock, and the explicit
    "Add Batch" item action.
    """
    if qty <= 0:
        return None
    # If the caller forgot to flip batch_tracking but is still calling this
    # helper, set it implicitly — easier to opt-in than to error out on a
    # legitimate purchase flow.
    await db.execute(
        text("UPDATE items SET batch_tracking = 1 WHERE id = :id"),
        {"id": item_id},
    )
    batch = ItemBatch(
        id=str(uuid.uuid4()),
        item_id=item_id,
        branch_id=branch_id,
        batch_number=batch_number or _next_batch_number(item_id),
        mfg_date=mfg_date,
        expiry_date=expiry_date,
        quantity=qty,
        initial_qty=qty,
        cost_price=cost_price,
        vendor_id=vendor_id,
        source_type=source_type,
        source_ref=source_ref,
        received_date=received_date or _today(),
        notes=notes,
        active=True,
    )
    db.add(batch)
    await db.flush()
    # Bump aggregate stock so the per-branch counter stays in sync.
    await adjust_stock_atomic(db, item_id=item_id, branch_id=branch_id, delta=qty)
    return batch


def _batch_order(strategy: str):
    """Return ORDER BY columns for batch consumption.

    FEFO: nearest expiry first; NULL expiry sorts last (consume dated stock
    before perpetual stock). Tie-broken by received_date so older receipts
    drain first when two batches share an expiry.

    FIFO: oldest received first; tie-broken by created_at to keep the order
    deterministic when two receipts share a date.
    """
    if strategy == "fefo":
        # SQLite sorts NULLs first by default; flip with `expiry_date IS NULL`
        # so the rows without a date sit at the bottom.
        return [
            text("(expiry_date IS NULL)"),
            asc(ItemBatch.expiry_date),
            asc(ItemBatch.received_date),
            asc(ItemBatch.created_at),
        ]
    return [asc(ItemBatch.received_date), asc(ItemBatch.created_at)]


async def consume_batches_atomic(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    qty: int,
    strategy: str = "fifo",
    preferred_batch_id: Optional[str] = None,
    explicit_allocation: Optional[list[dict]] = None,
) -> list[dict]:
    """Deduct `qty` units across batches at (item_id, branch_id).

    Three modes, evaluated in this order:

    1. `explicit_allocation`: caller-supplied `[{batch_id, qty}, ...]`. We
       consume exactly those batches in that order. Used by the POS / transfer
       UIs when the operator has manually split a line across multiple lots
       via the BatchAllocationModal. `sum(qty)` must equal the outer `qty`.

    2. `preferred_batch_id`: that batch is consumed first (up to its remaining
       qty); any shortfall falls back to FIFO/FEFO across the others. Useful
       as a "hand-pick one lot" shortcut without spelling out the full split.

    3. Pure FIFO/FEFO via `strategy`.

    Returns the consumption ledger as `[{batch_id, batch_number, consumed,
    expiry_date}, ...]` in the order consumed, mirrors the deduction onto
    item_stock, and raises ValueError when stock is short (rolling back any
    partial decrements so the txn stays atomic). Caller commits.
    """
    if qty <= 0:
        return []

    # ── Mode 1: explicit allocation ───────────────────────────────────────
    if explicit_allocation:
        # Per-entry guard. Negative qty is the dangerous case: the pydantic
        # layer in front of the POS rejects it, but transfers replay this
        # function from JSON-decoded `requested_allocation` on approve which
        # bypasses pydantic entirely — so we re-validate here. Without this
        # check, `[{qty: 15}, {qty: -5}]` would sum to 10, pass the sum
        # check, drain batch A by 15 while skipping B, and leave the
        # SUM(batches) == item_stock invariant broken (aggregate would only
        # be decremented by `qty` further down).
        cleaned: list[dict] = []
        for e in explicit_allocation:
            try:
                q = int(e.get("qty") or 0)
            except (TypeError, ValueError):
                raise ValueError(
                    f"Invalid allocation qty {e.get('qty')!r} for item={item_id}"
                )
            if q <= 0:
                raise ValueError(
                    f"Allocation qty must be > 0 (got {q}) for item={item_id}"
                )
            if not e.get("batch_id"):
                raise ValueError(
                    f"Allocation entry missing batch_id for item={item_id}"
                )
            cleaned.append({"batch_id": e["batch_id"], "qty": q})

        total = sum(e["qty"] for e in cleaned)
        if total != qty:
            raise ValueError(
                f"Allocation sum ({total}) does not match line qty ({qty}) "
                f"for item={item_id}"
            )
        # Pull every referenced batch in one round-trip.
        ids = [e["batch_id"] for e in cleaned]
        rows = (await db.execute(
            select(ItemBatch).where(ItemBatch.id.in_(ids)).with_for_update()
        )).scalars().all()
        by_id = {b.id: b for b in rows}

        consumed: list[dict] = []
        taken: list[tuple[ItemBatch, int]] = []
        for entry in cleaned:
            bid = entry["batch_id"]
            take = entry["qty"]
            b = by_id.get(bid)
            if not b or b.item_id != item_id or b.branch_id != branch_id:
                # Roll back and bail — the cart referenced a batch from a
                # different item/branch (stale UI state probably).
                for bb, tt in taken:
                    bb.quantity = bb.quantity + tt
                raise ValueError(
                    f"Batch {bid} not valid for item={item_id} branch={branch_id}"
                )
            if not b.active:
                for bb, tt in taken:
                    bb.quantity = bb.quantity + tt
                raise ValueError(
                    f"Batch {b.batch_number} is inactive and cannot be consumed"
                )
            if b.quantity < take:
                for bb, tt in taken:
                    bb.quantity = bb.quantity + tt
                raise ValueError(
                    f"Insufficient stock on batch {b.batch_number}: "
                    f"need {take}, have {b.quantity}"
                )
            b.quantity = b.quantity - take
            taken.append((b, take))
            consumed.append({
                "batch_id": b.id,
                "batch_number": b.batch_number,
                "consumed": take,
                "expiry_date": b.expiry_date,
            })
        await adjust_stock_atomic(db, item_id=item_id, branch_id=branch_id, delta=-qty)
        return consumed

    # ── Modes 2 + 3: FIFO/FEFO with optional preferred ────────────────────
    strategy = strategy if strategy in ("fifo", "fefo") else "fifo"
    order = _batch_order(strategy)
    res = await db.execute(
        select(ItemBatch)
        .where(
            ItemBatch.item_id == item_id,
            ItemBatch.branch_id == branch_id,
            ItemBatch.active == True,  # noqa: E712 - SQLAlchemy expression
            ItemBatch.quantity > 0,
        )
        .order_by(*order)
        .with_for_update()
    )
    batches = list(res.scalars().all())
    if preferred_batch_id:
        # Pull the preferred batch to the front of the queue if it exists in
        # the active list. If not, just ignore the hint and use FIFO/FEFO —
        # silent fallback is friendlier than 400-erroring at the POS.
        idx = next(
            (i for i, b in enumerate(batches) if b.id == preferred_batch_id),
            None,
        )
        if idx is not None:
            batches.insert(0, batches.pop(idx))

    remaining = qty
    consumed = []
    # Track (batch, taken_so_far) so a rollback restores exactly what we took
    # rather than relying on positional alignment with the original list.
    taken = []
    for b in batches:
        if remaining <= 0:
            break
        take = min(b.quantity, remaining)
        b.quantity = b.quantity - take
        remaining -= take
        taken.append((b, take))
        consumed.append({
            "batch_id": b.id,
            "batch_number": b.batch_number,
            "consumed": take,
            "expiry_date": b.expiry_date,
        })
    if remaining > 0:
        # Short on batched stock. Roll back what we wrote and let the caller
        # decide (sales currently allows oversell to zero).
        for b, t in taken:
            b.quantity = b.quantity + t
        raise ValueError(
            f"Insufficient batch stock for item={item_id} branch={branch_id}: "
            f"need {qty}, have {qty - remaining}"
        )
    # Mirror the deduction onto aggregate stock so untracked-consumer code
    # paths (POS subtotals, reports) keep working.
    await adjust_stock_atomic(db, item_id=item_id, branch_id=branch_id, delta=-qty)
    return consumed


async def set_batch_quantity_atomic(
    db: AsyncSession,
    *,
    batch_id: str,
    new_qty: int,
) -> Optional[ItemBatch]:
    """Absolute set on a single batch (used by per-batch stock adjustment).
    Adjusts item_stock by the delta. Returns the updated batch or None if not
    found. Caller commits."""
    if new_qty < 0:
        raise ValueError("new_qty must be >= 0")
    res = await db.execute(select(ItemBatch).where(ItemBatch.id == batch_id))
    b = res.scalar_one_or_none()
    if not b:
        return None
    delta = int(new_qty) - int(b.quantity or 0)
    b.quantity = int(new_qty)
    if delta != 0:
        # Stock should never go below zero from a per-batch absolute set, but
        # adjust_stock_atomic will refuse a negative delta that would drop the
        # aggregate below zero — clamp in that case.
        try:
            await adjust_stock_atomic(
                db, item_id=b.item_id, branch_id=b.branch_id, delta=delta
            )
        except ValueError:
            await db.execute(
                text(
                    "UPDATE item_stock SET quantity = 0 "
                    "WHERE item_id = :i AND branch_id = :br"
                ),
                {"i": b.item_id, "br": b.branch_id},
            )
    return b


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

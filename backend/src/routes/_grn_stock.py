"""GRN stock receipt + reversal helpers (Phase 3).

Stock-in always lands on a GoodsReceiptNote — bills are financial only.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.batch_dates import validate_batch_dates
from src.models import ItemBatch
from src.routes._atomic import add_batch_atomic, adjust_stock_atomic, is_tracked, set_batch_quantity_atomic


class ReceiptLine:
    """Minimal line shape for stock receipt (PurchaseLine / PO line / GRN line)."""

    __slots__ = (
        "item_id", "name", "qty", "cost",
        "batch_number", "mfg_date", "expiry_date",
    )

    def __init__(
        self,
        *,
        item_id: Optional[str],
        name: str,
        qty: int,
        cost: float = 0,
        batch_number: Optional[str] = None,
        mfg_date: Optional[str] = None,
        expiry_date: Optional[str] = None,
    ):
        self.item_id = item_id
        self.name = name
        self.qty = int(qty)
        self.cost = cost
        self.batch_number = batch_number
        self.mfg_date = mfg_date
        self.expiry_date = expiry_date


async def receive_lines_to_stock(
    db: AsyncSession,
    *,
    grn_id: str,
    branch_id: str,
    vendor_id: str,
    received_date: str,
    lines: list[ReceiptLine],
) -> None:
    """Add stock for each catalog line on a received GRN."""
    for line in lines:
        if not line.item_id or line.qty <= 0:
            continue
        tracked, expiry_tracked = await is_tracked(db, line.item_id)
        if tracked:
            date_errs = validate_batch_dates(
                mfg_date=line.mfg_date,
                expiry_date=line.expiry_date,
                received_date=received_date,
                require_expiry=expiry_tracked,
            )
            if date_errs:
                raise ValueError(f"{line.name}: {'; '.join(date_errs)}")
            await add_batch_atomic(
                db,
                item_id=line.item_id,
                branch_id=branch_id,
                qty=line.qty,
                batch_number=line.batch_number,
                mfg_date=line.mfg_date,
                expiry_date=line.expiry_date,
                cost_price=float(line.cost or 0),
                vendor_id=vendor_id,
                source_type="grn",
                source_ref=grn_id,
                received_date=received_date,
            )
        else:
            await adjust_stock_atomic(
                db,
                item_id=line.item_id,
                branch_id=branch_id,
                delta=line.qty,
                movement_type="grn",
                source_type="grn",
                source_ref=grn_id,
            )


async def reverse_grn_stock(
    db: AsyncSession,
    *,
    grn_id: str,
    branch_id: str,
    line_items: list,
) -> int:
    """Reverse stock added by a received GRN. Returns units removed."""
    removed = 0
    batches = (await db.execute(
        select(ItemBatch).where(ItemBatch.source_ref == grn_id)
    )).scalars().all()
    for b in batches:
        qty = int(b.quantity or 0)
        if qty > 0:
            try:
                await adjust_stock_atomic(
                    db,
                    item_id=b.item_id,
                    branch_id=b.branch_id,
                    delta=-qty,
                    movement_type="grn_reversal",
                    source_type="grn",
                    source_ref=grn_id,
                )
                removed += qty
            except ValueError:
                pass
        await db.delete(b)
    batch_item_ids = {b.item_id for b in batches}
    for li in line_items:
        if not li.item_id:
            continue
        qty = int(getattr(li, "received_qty", None) or getattr(li, "qty", 0) or 0)
        if qty <= 0:
            continue
        if li.item_id in batch_item_ids:
            continue
        try:
            await adjust_stock_atomic(
                db,
                item_id=li.item_id,
                branch_id=branch_id,
                delta=-qty,
                movement_type="grn_reversal",
                source_type="grn",
                source_ref=grn_id,
            )
            removed += qty
        except ValueError:
            pass
    return removed


async def grn_batches_consumed(db: AsyncSession, grn_id: str) -> bool:
    """True if any batch spawned by this GRN has been partially consumed."""
    batches = (await db.execute(
        select(ItemBatch).where(ItemBatch.source_ref == grn_id)
    )).scalars().all()
    return any(int(b.quantity or 0) < int(b.initial_qty or 0) for b in batches)

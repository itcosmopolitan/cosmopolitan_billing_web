"""Stock movement ledger + reservations (Phase 0)."""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import ItemStock, Organisation, StockMovement, StockReservation, StockReservationStatus


async def get_allow_overselling(db: AsyncSession) -> bool:
    row = (await db.execute(select(Organisation.allow_overselling).limit(1))).scalar_one_or_none()
    if row is None:
        return True
    return bool(row)


async def get_physical_qty(db: AsyncSession, *, item_id: str, branch_id: str) -> int:
    q = (await db.execute(
        select(ItemStock.quantity).where(
            ItemStock.item_id == item_id,
            ItemStock.branch_id == branch_id,
        )
    )).scalar_one_or_none()
    return int(q or 0)


async def get_reserved_qty(
    db: AsyncSession, *, item_id: str, branch_id: str, exclude_source_ref: Optional[str] = None,
) -> int:
    conds = [
        StockReservation.item_id == item_id,
        StockReservation.branch_id == branch_id,
        StockReservation.status == StockReservationStatus.active,
    ]
    if exclude_source_ref:
        conds.append(StockReservation.source_ref != exclude_source_ref)
    total = (await db.execute(
        select(func.coalesce(func.sum(StockReservation.qty), 0)).where(and_(*conds))
    )).scalar()
    return int(total or 0)


async def get_available_qty(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    exclude_source_ref: Optional[str] = None,
) -> int:
    physical = await get_physical_qty(db, item_id=item_id, branch_id=branch_id)
    reserved = await get_reserved_qty(
        db, item_id=item_id, branch_id=branch_id, exclude_source_ref=exclude_source_ref,
    )
    return max(0, physical - reserved)


async def record_stock_movement(
    db: AsyncSession,
    *,
    item_id: str,
    branch_id: str,
    delta: int,
    before_qty: int,
    after_qty: int,
    movement_type: str,
    source_type: Optional[str] = None,
    source_ref: Optional[str] = None,
    batch_id: Optional[str] = None,
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> None:
    if delta == 0:
        return
    db.add(StockMovement(
        id=str(uuid.uuid4()),
        item_id=item_id,
        branch_id=branch_id,
        delta=delta,
        before_qty=before_qty,
        after_qty=after_qty,
        movement_type=movement_type,
        source_type=source_type,
        source_ref=source_ref,
        batch_id=batch_id,
        notes=notes,
        created_by=created_by,
    ))


async def reserve_for_sales_order(
    db: AsyncSession,
    *,
    order_id: str,
    branch_id: str,
    lines: list,
) -> None:
    """Create active reservations for each catalog line on a confirmed SO."""
    for line in lines:
        if not line.item_id or not line.qty:
            continue
        available = await get_available_qty(
            db, item_id=line.item_id, branch_id=branch_id, exclude_source_ref=order_id,
        )
        if int(line.qty) > available:
            raise ValueError(
                f"Insufficient stock for {line.name}: need {line.qty}, available {available}"
            )
        db.add(StockReservation(
            id=str(uuid.uuid4()),
            item_id=line.item_id,
            branch_id=branch_id,
            qty=int(line.qty),
            source_type="sales_order",
            source_ref=order_id,
            source_line_id=getattr(line, "id", None),
            status=StockReservationStatus.active,
        ))


async def release_reservations(
    db: AsyncSession,
    *,
    source_type: str,
    source_ref: str,
) -> int:
    rows = (await db.execute(
        select(StockReservation).where(
            StockReservation.source_type == source_type,
            StockReservation.source_ref == source_ref,
            StockReservation.status == StockReservationStatus.active,
        )
    )).scalars().all()
    for r in rows:
        r.status = StockReservationStatus.released
    return len(rows)


async def fulfil_reservations(
    db: AsyncSession,
    *,
    source_type: str,
    source_ref: str,
) -> int:
    rows = (await db.execute(
        select(StockReservation).where(
            StockReservation.source_type == source_type,
            StockReservation.source_ref == source_ref,
            StockReservation.status == StockReservationStatus.active,
        )
    )).scalars().all()
    for r in rows:
        r.status = StockReservationStatus.fulfilled
    return len(rows)


async def refresh_so_reservations(
    db: AsyncSession,
    *,
    order_id: str,
    branch_id: str,
    lines: list,
) -> None:
    """Re-sync active reservations after a partial SO→invoice convert."""
    if await get_allow_overselling(db):
        return
    await release_reservations(db, source_type="sales_order", source_ref=order_id)
    if lines:
        await reserve_for_sales_order(
            db, order_id=order_id, branch_id=branch_id, lines=lines,
        )

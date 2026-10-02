from __future__ import annotations

import json
import uuid
from datetime import date
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.item_branch import effective_cost_price
from src.models import (
    Branch,
    Item,
    ItemBatch,
    ItemBranchConfig,
    ItemStock,
    PoolSaleAllocation,
    PoolSaleAllocationReversal,
    StockPool,
)
from src.qty import as_qty


async def _reverse_pool_allocation(
    db: AsyncSession,
    *,
    allocation: PoolSaleAllocation,
    qty_delta: float,
    operation: str,
    return_id: str | None,
    invoice_number: str,
    created_by: str,
    remove_from_sale_branch: bool,
) -> PoolSaleAllocationReversal:
    from src.routes._atomic import adjust_stock_atomic, consume_batches_atomic

    qty_delta = as_qty(qty_delta)
    if qty_delta == 0:
        raise ValueError("Pool allocation reversal quantity must not be zero")

    sale_movement_id = None
    owner_movement_id = str(uuid.uuid4())
    positive = qty_delta > 0
    qty = abs(qty_delta)
    tracked = allocation.source_batch_id is not None

    if positive and remove_from_sale_branch:
        sale_movement_id = str(uuid.uuid4())
        if tracked:
            if not allocation.dest_batch_id:
                raise HTTPException(409, "Cannot reverse a tracked pool allocation without its destination batch")
            await consume_batches_atomic(
                db,
                item_id=allocation.item_id,
                branch_id=allocation.sale_branch_id,
                qty=qty,
                explicit_allocation=[{"batch_id": allocation.dest_batch_id, "qty": qty}],
                movement_type="pool_transfer_out",
                source_type="pool_sale_reversal",
                source_ref=invoice_number,
                created_by=created_by,
                movement_id=sale_movement_id,
            )
        else:
            await adjust_stock_atomic(
                db,
                item_id=allocation.item_id,
                branch_id=allocation.sale_branch_id,
                delta=-qty,
                movement_type="pool_transfer_out",
                source_type="pool_sale_reversal",
                source_ref=invoice_number,
                created_by=created_by,
                movement_id=sale_movement_id,
            )

    if tracked:
        source_batch = (await db.execute(
            select(ItemBatch)
            .where(ItemBatch.id == allocation.source_batch_id)
            .with_for_update()
        )).scalar_one_or_none()
        if source_batch is None or source_batch.item_id != allocation.item_id or source_batch.branch_id != allocation.owner_branch_id:
            raise HTTPException(
                409,
                "The original source batch is unavailable; no pool stock was restored",
            )
        source_batch.quantity = as_qty(source_batch.quantity or 0)
        if positive:
            source_batch.quantity = as_qty(source_batch.quantity + qty)
            source_batch.active = True
            delta = qty
            movement_type = "pool_transfer_in"
        else:
            if source_batch.quantity < qty:
                raise HTTPException(409, "The original source batch no longer has enough stock to undo this return")
            source_batch.quantity = as_qty(source_batch.quantity - qty)
            delta = -qty
            movement_type = "pool_transfer_out"
        await adjust_stock_atomic(
            db,
            item_id=allocation.item_id,
            branch_id=allocation.owner_branch_id,
            delta=delta,
            movement_type=movement_type,
            source_type="pool_sale_reversal",
            source_ref=invoice_number,
            created_by=created_by,
            movement_id=owner_movement_id,
        )
    else:
        delta = qty if positive else -qty
        await adjust_stock_atomic(
            db,
            item_id=allocation.item_id,
            branch_id=allocation.owner_branch_id,
            delta=delta,
            movement_type="pool_transfer_in" if positive else "pool_transfer_out",
            source_type="pool_sale_reversal",
            source_ref=invoice_number,
            created_by=created_by,
            movement_id=owner_movement_id,
        )

    await db.flush()
    reversal = PoolSaleAllocationReversal(
        id=str(uuid.uuid4()),
        allocation_id=allocation.id,
        invoice_id=allocation.invoice_id,
        return_id=return_id,
        operation=operation,
        qty_delta=qty_delta,
        sale_movement_id=sale_movement_id,
        owner_movement_id=owner_movement_id,
        created_by=created_by,
    )
    db.add(reversal)
    await db.flush()
    return reversal


async def reverse_pool_allocations_for_cancel(
    db: AsyncSession,
    *,
    invoice_id: str,
    invoice_number: str,
    created_by: str,
) -> list[PoolSaleAllocationReversal]:
    allocations = (await db.execute(
        select(PoolSaleAllocation)
        .where(PoolSaleAllocation.invoice_id == invoice_id)
        .order_by(PoolSaleAllocation.item_id, PoolSaleAllocation.owner_branch_id, PoolSaleAllocation.id)
        .with_for_update()
    )).scalars().all()
    reversed_rows = []
    for allocation in allocations:
        already_reversed = float((await db.execute(
            select(func.coalesce(func.sum(PoolSaleAllocationReversal.qty_delta), 0))
            .where(PoolSaleAllocationReversal.allocation_id == allocation.id)
        )).scalar_one() or 0)
        remaining = as_qty(float(allocation.qty or 0) - already_reversed)
        if remaining > 0:
            reversed_rows.append(await _reverse_pool_allocation(
                db,
                allocation=allocation,
                qty_delta=remaining,
                operation="cancel",
                return_id=None,
                invoice_number=invoice_number,
                created_by=created_by,
                remove_from_sale_branch=True,
            ))
    return reversed_rows


async def reverse_pool_allocations_for_return(
    db: AsyncSession,
    *,
    invoice_id: str,
    invoice_line_id: str,
    return_id: str,
    requested_by_batch: dict[str, float],
    untracked_qty: float,
    invoice_number: str,
    created_by: str,
) -> dict[str, float]:
    """Move returned pooled quantities from the sale branch back to their owners."""
    allocations = (await db.execute(
        select(PoolSaleAllocation)
        .where(
            PoolSaleAllocation.invoice_id == invoice_id,
            PoolSaleAllocation.invoice_line_id == invoice_line_id,
        )
        .order_by(PoolSaleAllocation.created_at, PoolSaleAllocation.id)
        .with_for_update()
    )).scalars().all()
    remaining_by_allocation = {}
    for allocation in allocations:
        reversed_qty = float((await db.execute(
            select(func.coalesce(func.sum(PoolSaleAllocationReversal.qty_delta), 0))
            .where(PoolSaleAllocationReversal.allocation_id == allocation.id)
        )).scalar_one() or 0)
        remaining_by_allocation[allocation.id] = max(
            0.0,
            as_qty(float(allocation.qty or 0) - reversed_qty),
        )

    moved_by_batch: dict[str, float] = {}
    for allocation in allocations:
        if not allocation.dest_batch_id or allocation.dest_batch_id not in requested_by_batch:
            continue
        wanted = as_qty(requested_by_batch[allocation.dest_batch_id])
        available = remaining_by_allocation[allocation.id]
        if wanted > available + 1e-9:
            raise HTTPException(409, "Returned quantity exceeds the unreturned pool allocation")
        if wanted > 0:
            await _reverse_pool_allocation(
                db,
                allocation=allocation,
                qty_delta=wanted,
                operation="return",
                return_id=return_id,
                invoice_number=invoice_number,
                created_by=created_by,
                remove_from_sale_branch=True,
            )
            moved_by_batch[allocation.dest_batch_id] = wanted

    untracked_remaining = as_qty(untracked_qty)
    moved_untracked = 0.0
    for allocation in allocations:
        if allocation.source_batch_id is not None or untracked_remaining <= 0:
            continue
        take = min(remaining_by_allocation[allocation.id], untracked_remaining)
        if take > 0:
            await _reverse_pool_allocation(
                db,
                allocation=allocation,
                qty_delta=take,
                operation="return",
                return_id=return_id,
                invoice_number=invoice_number,
                created_by=created_by,
                remove_from_sale_branch=True,
            )
            untracked_remaining = as_qty(untracked_remaining - take)
            moved_untracked = as_qty(moved_untracked + take)
    moved_by_batch[f"__untracked__:{invoice_line_id}"] = moved_untracked
    return moved_by_batch


async def undo_pool_allocations_for_return(
    db: AsyncSession,
    *,
    return_id: str,
    invoice_number: str,
    created_by: str,
    undo: bool,
) -> dict[str, float]:
    rows = (await db.execute(
        select(PoolSaleAllocationReversal, PoolSaleAllocation)
        .join(PoolSaleAllocation, PoolSaleAllocation.id == PoolSaleAllocationReversal.allocation_id)
        .where(
            PoolSaleAllocationReversal.return_id == return_id,
        )
        .order_by(PoolSaleAllocationReversal.created_at, PoolSaleAllocationReversal.id)
        .with_for_update()
    )).all()
    quantities_by_batch: dict[str, float] = {}
    grouped: dict[str, tuple[PoolSaleAllocation, list[PoolSaleAllocationReversal]]] = {}
    for reversal, allocation in rows:
        grouped.setdefault(allocation.id, (allocation, []))[1].append(reversal)
    for allocation, history in grouped.values():
        prior_total = sum(float(entry.qty_delta or 0) for entry in history)
        # `undo` removes a currently-restored return; redo restores a voided
        # return. Signed ledger rows make either operation append-only.
        if undo:
            if prior_total <= 0:
                continue
            qty_delta = -prior_total
        else:
            last = history[-1]
            if last.operation != "return_void" or float(last.qty_delta or 0) >= 0:
                continue
            qty_delta = abs(float(last.qty_delta or 0))
        if undo:
            await _reverse_pool_allocation(
                db,
                allocation=allocation,
                qty_delta=qty_delta,
                operation="return_void",
                return_id=return_id,
                invoice_number=invoice_number,
                created_by=created_by,
                remove_from_sale_branch=False,
            )
        else:
            await _reverse_pool_allocation(
                db,
                allocation=allocation,
                qty_delta=qty_delta,
                operation="return_unvoid",
                return_id=return_id,
                invoice_number=invoice_number,
                created_by=created_by,
                remove_from_sale_branch=False,
            )
        batch_key = allocation.dest_batch_id or f"__untracked__:{allocation.invoice_line_id}"
        quantities_by_batch[batch_key] = as_qty(
            quantities_by_batch.get(batch_key, 0) + abs(qty_delta)
        )
    return quantities_by_batch


def _usable_batch(batch: ItemBatch, *, excludes_expired: bool, today: str) -> bool:
    if not batch.active or as_qty(batch.quantity or 0) <= 0:
        return False
    return not (
        excludes_expired
        and batch.expiry_date
        and batch.expiry_date < today
    )


async def consume_clubbed_sale_line(
    db: AsyncSession,
    *,
    item: Item,
    line_input: Any,
    line: Any,
    pool: StockPool,
    member_branches: list[Branch],
    sale_branch_id: str,
    invoice_id: str,
    invoice_number: str,
    created_by: str,
    allow_oversell: bool,
) -> list[dict]:
    """Allocate a clubbed sale, transfer external stock to the sale branch, then sell it."""
    from src.routes._atomic import (
        add_batch_atomic,
        adjust_stock_atomic,
        clamp_stock_to_zero_with_ledger,
        consume_batches_atomic,
    )

    item_id = item.id
    members = sorted(member_branches, key=lambda branch: branch.id)
    member_ids = [branch.id for branch in members]
    if sale_branch_id not in member_ids:
        raise HTTPException(409, detail={"code": "branch_not_in_active_pool"})

    # Lock rows in a stable order before calculating any allocation.
    stock_rows = (await db.execute(
        select(ItemStock)
        .where(ItemStock.item_id == item_id, ItemStock.branch_id.in_(member_ids))
        .order_by(ItemStock.branch_id)
        .with_for_update()
    )).scalars().all()
    stock_by_branch = {row.branch_id: as_qty(row.quantity or 0) for row in stock_rows}

    tracked = bool(item.batch_tracking)
    expiry_tracked = bool(item.expiry_tracking)
    today = date.today().isoformat()
    batches: list[ItemBatch] = []
    batches_by_id: dict[str, ItemBatch] = {}
    batches_by_branch: dict[str, list[ItemBatch]] = {}
    if tracked:
        batches = list((await db.execute(
            select(ItemBatch)
            .where(ItemBatch.item_id == item_id, ItemBatch.branch_id.in_(member_ids))
            .order_by(ItemBatch.branch_id, ItemBatch.id)
            .with_for_update()
        )).scalars().all())
        batches_by_id = {batch.id: batch for batch in batches}
        for batch in batches:
            if _usable_batch(batch, excludes_expired=expiry_tracked, today=today):
                batches_by_branch.setdefault(batch.branch_id, []).append(batch)
        for branch_batches in batches_by_branch.values():
            if expiry_tracked:
                branch_batches.sort(key=lambda batch: (
                    batch.expiry_date is None,
                    batch.expiry_date or "",
                    batch.received_date or "",
                    batch.created_at,
                ))
            else:
                branch_batches.sort(key=lambda batch: (
                    batch.received_date or "",
                    batch.created_at,
                ))

    remaining = as_qty(line_input.qty)
    source_allocations: list[dict] = []
    destination_batch_allocations: list[dict] = []
    local_allocations: list[dict] = []

    if tracked:
        local_batches = batches_by_branch.get(sale_branch_id, [])
        requested = line_input.batch_allocation or []
        manually_selected: set[str] = set()
        for entry in requested:
            batch_id = entry.batch_id
            qty = as_qty(entry.qty)
            batch = batches_by_id.get(batch_id)
            if batch is None or batch.branch_id != sale_branch_id or not _usable_batch(
                batch, excludes_expired=expiry_tracked, today=today
            ):
                raise HTTPException(400, "Manual batch selection must use sellable batches at the selling branch")
            if qty > as_qty(batch.quantity or 0):
                raise HTTPException(409, "Selected selling-branch batch no longer has enough stock")
            if qty > remaining:
                raise HTTPException(400, "Manual batch allocation exceeds the invoice line quantity")
            local_allocations.append({"batch_id": batch.id, "qty": qty})
            manually_selected.add(batch.id)
            remaining = as_qty(remaining - qty)

        local_remaining = as_qty(sum(
            as_qty(batch.quantity or 0) for batch in local_batches
        ) - sum(entry["qty"] for entry in local_allocations))
        local_take = min(remaining, max(0.0, local_remaining))
        for batch in local_batches:
            if local_take <= 0:
                break
            already = sum(
                entry["qty"] for entry in local_allocations
                if entry["batch_id"] == batch.id
            )
            take = min(
                max(0.0, as_qty(batch.quantity or 0) - already),
                local_take,
            )
            if take > 0:
                local_allocations.append({"batch_id": batch.id, "qty": take})
                local_take = as_qty(local_take - take)
                remaining = as_qty(remaining - take)
    else:
        own_qty = max(0.0, stock_by_branch.get(sale_branch_id, 0.0))
        own_take = min(remaining, own_qty)
        if own_take > 0:
            local_allocations.append({"qty": own_take})
            remaining = as_qty(remaining - own_take)

    other_branches = [branch for branch in members if branch.id != sale_branch_id]
    if tracked:
        other_branches.sort(
            key=lambda branch: (
                -sum(as_qty(batch.quantity or 0) for batch in batches_by_branch.get(branch.id, [])),
                branch.id,
            )
        )
    else:
        other_branches.sort(
            key=lambda branch: (-max(0.0, stock_by_branch.get(branch.id, 0.0)), branch.id)
        )

    # Determine the complete, locked draw before mutating any source branch.
    planned_draws: list[dict] = []
    for branch in other_branches:
        if remaining <= 0:
            break
        if tracked:
            for batch in batches_by_branch.get(branch.id, []):
                if remaining <= 0:
                    break
                take = min(as_qty(batch.quantity or 0), remaining)
                if take > 0:
                    planned_draws.append({"branch": branch, "batch": batch, "qty": take})
                    remaining = as_qty(remaining - take)
        else:
            available = max(0.0, stock_by_branch.get(branch.id, 0.0))
            take = min(available, remaining)
            if take > 0:
                planned_draws.append({"branch": branch, "batch": None, "qty": take})
                remaining = as_qty(remaining - take)

    unfilled = remaining
    if unfilled > 0 and not allow_oversell:
        raise HTTPException(
            409,
            detail={
                "code": "insufficient_pool_stock",
                "item_id": item_id,
                "requested": as_qty(line_input.qty),
                "available": as_qty(line_input.qty - unfilled),
            },
        )

    owner_configs = (await db.execute(
        select(ItemBranchConfig).where(
            ItemBranchConfig.item_id == item_id,
            ItemBranchConfig.branch_id.in_([draw["branch"].id for draw in planned_draws]),
        )
    )).scalars().all() if planned_draws and not tracked else []
    config_by_branch = {row.branch_id: row for row in owner_configs}
    owner_names = {branch.id: branch.name for branch in members}

    for draw in planned_draws:
        owner = draw["branch"]
        batch = draw["batch"]
        qty = draw["qty"]
        out_movement_id = str(uuid.uuid4())
        in_movement_id = str(uuid.uuid4())
        unit_cost = (
            float(batch.cost_price or 0)
            if batch is not None
            else float(effective_cost_price(
                item.cost_price,
                config_by_branch.get(owner.id).cost_price
                if config_by_branch.get(owner.id) else None,
            ))
        )

        if batch is not None:
            consumed = await consume_batches_atomic(
                db,
                item_id=item_id,
                branch_id=owner.id,
                qty=qty,
                explicit_allocation=[{"batch_id": batch.id, "qty": qty}],
                movement_type="pool_transfer_out",
                source_type="pool_sale",
                source_ref=invoice_number,
                created_by=created_by,
                movement_id=out_movement_id,
            )
            source = consumed[0]
            destination = await add_batch_atomic(
                db,
                item_id=item_id,
                branch_id=sale_branch_id,
                qty=qty,
                batch_number=batch.batch_number,
                mfg_date=batch.mfg_date,
                expiry_date=batch.expiry_date,
                cost_price=unit_cost,
                vendor_id=batch.vendor_id,
                source_type="transfer",
                source_ref=invoice_number,
                received_date=today,
                notes=f"Auto-fulfilled from {owner.name} for invoice {invoice_number}",
                movement_type="pool_transfer_in",
                movement_id=in_movement_id,
                movement_source_type="pool_sale",
                created_by=created_by,
            )
            if destination is None:
                raise RuntimeError("Pool transfer did not create a destination batch")
            destination_batch_allocations.append({
                "batch_id": destination.id,
                "qty": qty,
            })
            source_batch_id = batch.id
            source_batch_no = batch.batch_number
            expiry_date = batch.expiry_date
            cost_source = "batch"
            source_batch_manifest = {
                "batch_id": source_batch_id,
                "batch_number": source_batch_no,
                "expiry_date": expiry_date,
                "cost_price": unit_cost,
                "qty": qty,
            }
        else:
            await adjust_stock_atomic(
                db,
                item_id=item_id,
                branch_id=owner.id,
                delta=-qty,
                movement_type="pool_transfer_out",
                source_type="pool_sale",
                source_ref=invoice_number,
                created_by=created_by,
                movement_id=out_movement_id,
            )
            await adjust_stock_atomic(
                db,
                item_id=item_id,
                branch_id=sale_branch_id,
                delta=qty,
                movement_type="pool_transfer_in",
                source_type="pool_sale",
                source_ref=invoice_number,
                created_by=created_by,
                movement_id=in_movement_id,
            )
            source_batch_id = None
            source_batch_no = None
            expiry_date = None
            cost_source = "branch_cost"
            source_batch_manifest = None
            destination_batch_allocations.append({"qty": qty})

        await db.flush()
        db.add(PoolSaleAllocation(
            id=str(uuid.uuid4()),
            invoice_id=invoice_id,
            invoice_line_id=line.id,
            pool_id=pool.id,
            sale_branch_id=sale_branch_id,
            owner_branch_id=owner.id,
            item_id=item_id,
            qty=qty,
            unit_cost=unit_cost,
            cost_source=cost_source,
            source_batch_id=source_batch_id,
            source_batch_no=source_batch_no,
            expiry_date=expiry_date,
            dest_batch_id=destination_batch_allocations[-1].get("batch_id"),
            out_movement_id=out_movement_id,
            in_movement_id=in_movement_id,
            created_by=created_by,
        ))
        source_allocations.append({
            "pool_id": pool.id,
            "item_id": item_id,
            "item_name": line.name,
            "qty": qty,
            "owner_branch_id": owner.id,
            "owner_branch_name": owner_names.get(owner.id, owner.id),
            "sale_branch_id": sale_branch_id,
            "source_batch_id": source_batch_id,
            "source_batch_no": source_batch_no,
            "expiry_date": expiry_date,
            "unit_cost": unit_cost,
            "cost_source": cost_source,
            "out_movement_id": out_movement_id,
            "in_movement_id": in_movement_id,
            "destination_batch_id": destination_batch_allocations[-1].get("batch_id"),
            "source_manifest": source_batch_manifest,
        })

    sale_batches = [*local_allocations, *destination_batch_allocations]
    if tracked:
        sold_qty = as_qty(sum(entry["qty"] for entry in sale_batches))
        if sold_qty > 0:
            consumed = await consume_batches_atomic(
                db,
                item_id=item_id,
                branch_id=sale_branch_id,
                qty=sold_qty,
                explicit_allocation=sale_batches,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
                created_by=created_by,
            )
            line.batch_allocation = json.dumps([
                {
                    "batch_id": entry["batch_id"],
                    "batch_number": entry.get("batch_number"),
                    "consumed": entry["consumed"],
                    "expiry_date": entry.get("expiry_date"),
                }
                for entry in consumed
            ])
        if unfilled > 0:
            await db.execute(
                text("UPDATE item_batches SET quantity = 0 WHERE item_id = :i AND branch_id = :b"),
                {"i": item_id, "b": sale_branch_id},
            )
            await clamp_stock_to_zero_with_ledger(
                db,
                item_id=item_id,
                branch_id=sale_branch_id,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
                created_by=created_by,
                notes=f"Oversell clamp on {invoice_number}",
            )
    else:
        sold_qty = as_qty(sum(entry["qty"] for entry in sale_batches))
        if sold_qty > 0:
            await adjust_stock_atomic(
                db,
                item_id=item_id,
                branch_id=sale_branch_id,
                delta=-sold_qty,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
                created_by=created_by,
            )
        if unfilled > 0:
            await clamp_stock_to_zero_with_ledger(
                db,
                item_id=item_id,
                branch_id=sale_branch_id,
                movement_type="sale",
                source_type="sale_invoice",
                source_ref=invoice_id,
                created_by=created_by,
                notes=f"Oversell clamp on {invoice_number}",
            )

    return source_allocations

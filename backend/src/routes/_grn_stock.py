"""GRN stock receipt + reversal helpers (Phase 3).

Stock-in always lands on a GoodsReceiptNote — bills are financial only.
On receive, each catalog item's branch cost_price is updated to the simple
average of the prior effective branch cost and this receipt's unit cost so
POS margin uses a blended cost rather than only the latest purchase rate.
"""
from __future__ import annotations

import json
import uuid
from collections import defaultdict
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.batch_dates import validate_batch_dates
from src.item_branch import averaged_unit_cost, effective_cost_price
from src.models import AuditLog, Item, ItemBatch, ItemBranchConfig, User
from src.qty import as_qty
from src.routes._atomic import add_batch_atomic, adjust_stock_atomic, is_tracked, set_batch_quantity_atomic
from src.services.audit_service import add_audit_log


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


def _user_role(user: Optional[User]) -> str:
    if user is None:
        return "unknown"
    role = getattr(user, "role", None)
    if role is None:
        return "unknown"
    return str(role.value) if hasattr(role, "value") else str(role)


def format_branch_cost_change_detail(changes: list[dict[str, Any]]) -> str:
    parts = [
        f"{c.get('item_name') or 'Item'} {round(float(c.get('old_cost') or 0), 2)} → {round(float(c.get('new_cost') or 0), 2)}"
        for c in changes
    ]
    preview = "; ".join(parts[:5])
    if len(parts) > 5:
        preview = f"{preview}; +{len(parts) - 5} more"
    return f"Branch cost averaged from purchase receipt: {preview}"


async def _apply_averaged_branch_costs(
    db: AsyncSession,
    *,
    branch_id: str,
    lines: list[ReceiptLine],
) -> list[dict[str, Any]]:
    """Upsert branch cost_price = avg(existing effective cost, receipt unit cost).

    Multiple lines for the same item use a qty-weighted purchase unit cost for
    this receipt, then average once with the prior branch cost.

    Returns a list of change dicts for activity / audit logging.
    """
    aggregates: dict[str, dict[str, float]] = defaultdict(lambda: {"qty": 0.0, "value": 0.0})
    names: dict[str, str] = {}
    for line in lines:
        if not line.item_id:
            continue
        qty = as_qty(line.qty)
        if qty <= 0:
            continue
        aggregates[line.item_id]["qty"] += qty
        aggregates[line.item_id]["value"] += qty * float(line.cost or 0)
        if line.name:
            names[line.item_id] = line.name

    if not aggregates:
        return []

    item_ids = list(aggregates.keys())
    items = {
        row.id: row
        for row in (
            await db.execute(select(Item).where(Item.id.in_(item_ids)))
        ).scalars().all()
    }
    configs = {
        row.item_id: row
        for row in (
            await db.execute(
                select(ItemBranchConfig).where(
                    ItemBranchConfig.item_id.in_(item_ids),
                    ItemBranchConfig.branch_id == branch_id,
                )
            )
        ).scalars().all()
    }

    changes: list[dict[str, Any]] = []
    for item_id, agg in aggregates.items():
        item = items.get(item_id)
        if item is None:
            continue
        purchase_unit = agg["value"] / agg["qty"] if agg["qty"] else 0.0
        cfg = configs.get(item_id)
        existing = effective_cost_price(item.cost_price, cfg.cost_price if cfg else None)
        new_cost = averaged_unit_cost(existing, purchase_unit)
        if abs(float(existing) - float(new_cost)) < 1e-9:
            continue
        if cfg is None:
            cfg = ItemBranchConfig(
                id=str(uuid.uuid4()),
                item_id=item_id,
                branch_id=branch_id,
                is_available=True,
                cost_price=new_cost,
            )
            db.add(cfg)
            configs[item_id] = cfg
        else:
            cfg.cost_price = new_cost
        changes.append({
            "item_id": item_id,
            "item_name": names.get(item_id) or item.name,
            "sku": item.sku,
            "old_cost": round(float(existing), 6),
            "new_cost": round(float(new_cost), 6),
            "purchase_unit": round(float(purchase_unit), 6),
            "branch_id": branch_id,
        })
    return changes


def _log_branch_cost_item_activities(
    db: AsyncSession,
    *,
    user: Optional[User],
    changes: list[dict[str, Any]],
    source_type: str,
    source_id: str,
    source_number: str,
    branch_id: str,
) -> None:
    """Write per-item activity rows for branch cost averages."""
    for change in changes:
        detail = (
            f"Branch cost updated from purchase ({source_number}): "
            f"{change['old_cost']} → {change['new_cost']} "
            f"(avg with purchase unit {change['purchase_unit']})"
        )
        db.add(AuditLog(
            id=str(uuid.uuid4()),
            record_type="item",
            record_id=change["item_id"],
            event_type="item_branch_cost_averaged",
            event_metadata=json.dumps({
                **change,
                "source_type": source_type,
                "source_id": source_id,
                "source_number": source_number,
                "field": "cost_price",
                "changes": [{
                    "field": "cost_price",
                    "old": change["old_cost"],
                    "new": change["new_cost"],
                }],
            }, default=str),
            action="Item Branch Cost Averaged",
            user_id=getattr(user, "id", None),
            user_name=getattr(user, "name", None),
            user_role=_user_role(user),
            module="inventory",
            reference_id=change.get("sku") or change.get("item_name"),
            ref=change.get("sku") or change.get("item_name"),
            detail=detail,
            risk="low",
            branch_id=branch_id,
            ip_address=None,
        ))


async def receive_lines_to_stock(
    db: AsyncSession,
    *,
    grn_id: str,
    branch_id: str,
    vendor_id: str,
    received_date: str,
    lines: list[ReceiptLine],
    user: Optional[User] = None,
    source_number: Optional[str] = None,
    branch_name: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Add stock for each catalog line on a received GRN.

    Also averages branch cost_price and writes item + global audit entries.
    Returns the list of branch-cost changes applied.
    """
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

    cost_changes = await _apply_averaged_branch_costs(db, branch_id=branch_id, lines=lines)
    if cost_changes:
        grn_number = source_number or grn_id
        _log_branch_cost_item_activities(
            db,
            user=user,
            changes=cost_changes,
            source_type="grn",
            source_id=grn_id,
            source_number=grn_number,
            branch_id=branch_id,
        )
        add_audit_log(
            db,
            action="Branch Cost Averaged",
            module="Purchases",
            reference_id=grn_number,
            detail=format_branch_cost_change_detail(cost_changes),
            user=user,
            branch_id=branch_id,
            metadata={
                "grn_id": grn_id,
                "grn_number": grn_number,
                "branch_id": branch_id,
                "branch_name": branch_name,
                "changes": cost_changes,
                "change_count": len(cost_changes),
            },
        )
    return cost_changes


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

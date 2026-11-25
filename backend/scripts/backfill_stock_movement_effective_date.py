#!/usr/bin/env python3
"""Backfill stock movement transaction dates from linked documents.

The script is read-only unless --apply is supplied. It never loads the
application's default DATABASE_URL, so the target must be explicit.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.models import (
    AdjustmentRequest,
    ComplimentaryEntry,
    GoodsReceiptNote,
    ItemBranchConfig,
    PoolSaleAllocationReversal,
    PurchaseBill,
    SaleInvoice,
    SalesReturn,
    StockMovement,
    StockTransfer,
    VendorReturn,
)

IST = ZoneInfo("Asia/Kolkata")


def _document_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _created_ist_date(value: datetime) -> date:
    timestamp = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    return timestamp.astimezone(IST).date()


async def _document_dates(
    db: AsyncSession,
    movements: list[StockMovement],
) -> dict[str, date]:
    result: dict[str, date] = {}
    by_type: dict[str, list[StockMovement]] = {}
    for movement in movements:
        by_type.setdefault((movement.source_type or "").lower(), []).append(movement)

    grn_rows = by_type.get("grn", []) + by_type.get("grn_cancel", [])
    grn_refs = {row.source_ref for row in grn_rows if row.source_ref}
    if grn_refs:
        docs = (await db.execute(
            select(GoodsReceiptNote.id, GoodsReceiptNote.date)
            .where(GoodsReceiptNote.id.in_(grn_refs))
        )).all()
        dates = {doc_id: _document_date(doc_date) for doc_id, doc_date in docs}
        unresolved_refs = {
            row.source_ref
            for row in grn_rows
            if row.source_ref in dates and dates[row.source_ref] is None
        } | {
            row.source_ref
            for row in grn_rows
            if row.source_ref not in dates
        }
        if unresolved_refs:
            bill_docs = (await db.execute(
                select(PurchaseBill.id, PurchaseBill.date)
                .where(PurchaseBill.id.in_(unresolved_refs))
            )).all()
            dates.update({
                doc_id: _document_date(doc_date)
                for doc_id, doc_date in bill_docs
            })
        result.update({
            row.id: dates[row.source_ref]
            for row in grn_rows
            if row.source_ref in dates and dates[row.source_ref]
        })

    invoice_rows = sum(
        (by_type.get(name, []) for name in (
            "sale_invoice", "sale_invoice_void", "pool_sale", "pool_sale_reversal",
        )),
        [],
    )
    invoice_refs = {row.source_ref for row in invoice_rows if row.source_ref}
    invoice_by_ref: dict[str, date] = {}
    if invoice_refs:
        docs = (await db.execute(
            select(SaleInvoice).where(
                or_(SaleInvoice.id.in_(invoice_refs), SaleInvoice.number.in_(invoice_refs))
            )
        )).scalars().all()
        for doc in docs:
            doc_date = _document_date(doc.shipment_date) or _document_date(doc.date)
            if doc_date:
                invoice_by_ref[doc.id] = doc_date
                invoice_by_ref[doc.number] = doc_date
        result.update({
            row.id: invoice_by_ref[row.source_ref]
            for row in invoice_rows
            if row.source_ref in invoice_by_ref
        })

    return_rows = by_type.get("sales_return", []) + by_type.get("return", [])
    return_refs = {row.source_ref for row in return_rows if row.source_ref}
    if return_refs:
        docs = (await db.execute(
            select(SalesReturn.id, SalesReturn.date)
            .where(SalesReturn.id.in_(return_refs))
        )).all()
        dates = {doc_id: _document_date(doc_date) for doc_id, doc_date in docs}
        result.update({
            row.id: dates[row.source_ref]
            for row in return_rows
            if row.source_ref in dates and dates[row.source_ref]
        })

    pool_return_rows = by_type.get("pool_sale_reversal", [])
    pool_movement_ids = {row.id for row in pool_return_rows}
    if pool_movement_ids:
        reversals = (await db.execute(
            select(
                PoolSaleAllocationReversal.sale_movement_id,
                PoolSaleAllocationReversal.owner_movement_id,
                PoolSaleAllocationReversal.return_id,
            ).where(
                or_(
                    PoolSaleAllocationReversal.sale_movement_id.in_(pool_movement_ids),
                    PoolSaleAllocationReversal.owner_movement_id.in_(pool_movement_ids),
                )
            )
        )).all()
        return_ids = {row.return_id for row in reversals if row.return_id}
        if return_ids:
            docs = (await db.execute(
                select(SalesReturn.id, SalesReturn.date)
                .where(SalesReturn.id.in_(return_ids))
            )).all()
            return_dates = {
                doc_id: _document_date(doc_date)
                for doc_id, doc_date in docs
            }
            for reversal in reversals:
                if not reversal.return_id or not return_dates.get(reversal.return_id):
                    continue
                for movement_id in (reversal.sale_movement_id, reversal.owner_movement_id):
                    if movement_id in pool_movement_ids:
                        result[movement_id] = return_dates[reversal.return_id]

    vendor_rows = [
        row for movement_type, rows in by_type.items()
        if movement_type.startswith("vendor_return")
        for row in rows
    ]
    vendor_refs = {row.source_ref for row in vendor_rows if row.source_ref}
    if vendor_refs:
        docs = (await db.execute(
            select(VendorReturn.id, VendorReturn.date)
            .where(VendorReturn.id.in_(vendor_refs))
        )).all()
        dates = {doc_id: _document_date(doc_date) for doc_id, doc_date in docs}
        result.update({
            row.id: dates[row.source_ref]
            for row in vendor_rows
            if row.source_ref in dates and dates[row.source_ref]
        })

    transfer_rows = by_type.get("transfer", []) + by_type.get("transfer_receive", [])
    transfer_refs = {row.source_ref for row in transfer_rows if row.source_ref}
    if transfer_refs:
        docs = (await db.execute(
            select(StockTransfer.id, StockTransfer.recorded_date)
            .where(StockTransfer.id.in_(transfer_refs))
        )).all()
        dates = {doc_id: _document_date(doc_date) for doc_id, doc_date in docs}
        result.update({
            row.id: dates[row.source_ref]
            for row in transfer_rows
            if row.source_ref in dates and dates[row.source_ref]
        })

    complimentary_rows = by_type.get("complimentary", []) + by_type.get("complimentary_entry", [])
    complimentary_refs = {row.source_ref for row in complimentary_rows if row.source_ref}
    if complimentary_refs:
        docs = (await db.execute(
            select(ComplimentaryEntry.id, ComplimentaryEntry.date)
            .where(ComplimentaryEntry.id.in_(complimentary_refs))
        )).all()
        dates = {doc_id: _document_date(doc_date) for doc_id, doc_date in docs}
        result.update({
            row.id: dates[row.source_ref]
            for row in complimentary_rows
            if row.source_ref in dates and dates[row.source_ref]
        })

    adjustment_rows = by_type.get("adjustment", [])
    adjustment_refs = {row.source_ref for row in adjustment_rows if row.source_ref}
    if adjustment_refs:
        docs = (await db.execute(
            select(AdjustmentRequest.id, AdjustmentRequest.adjustment_date)
            .where(AdjustmentRequest.id.in_(adjustment_refs))
        )).all()
        dates = {doc_id: _document_date(doc_date) for doc_id, doc_date in docs}
        result.update({
            row.id: dates[row.source_ref]
            for row in adjustment_rows
            if row.source_ref in dates and dates[row.source_ref]
        })

    opening_rows = by_type.get("opening", [])
    item_ids = {row.item_id for row in opening_rows}
    branch_ids = {row.branch_id for row in opening_rows}
    if item_ids and branch_ids:
        configs = (await db.execute(
            select(
                ItemBranchConfig.item_id,
                ItemBranchConfig.branch_id,
                ItemBranchConfig.opening_stock_date,
            ).where(
                ItemBranchConfig.item_id.in_(item_ids),
                ItemBranchConfig.branch_id.in_(branch_ids),
            )
        )).all()
        dates = {
            (item_id, branch_id): _document_date(opening_date)
            for item_id, branch_id, opening_date in configs
        }
        result.update({
            row.id: dates[(row.item_id, row.branch_id)]
            for row in opening_rows
            if dates.get((row.item_id, row.branch_id))
        })

    return result


async def run(database_url: str, *, batch_size: int, apply_changes: bool) -> Counter:
    url = make_url(database_url)
    if url.drivername == "postgresql":
        url = url.set(drivername="postgresql+asyncpg")
    elif url.drivername == "sqlite":
        url = url.set(drivername="sqlite+aiosqlite")
    if url.drivername not in {"postgresql+asyncpg", "sqlite+aiosqlite"}:
        raise ValueError("Use postgresql+asyncpg:// or sqlite+aiosqlite://")
    print(f"Target: host={url.host or 'local'} database={url.database or '(file)'}")
    engine = create_async_engine(url)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    counts: Counter = Counter()
    try:
        async with factory() as db:
            last_id: str | None = None
            while True:
                async with db.begin():
                    query = select(StockMovement).where(
                        StockMovement.effective_date.is_(None)
                    )
                    if not apply_changes and last_id:
                        query = query.where(StockMovement.id > last_id)
                    movements = (await db.execute(
                        query
                        .order_by(StockMovement.id)
                        .limit(batch_size)
                    )).scalars().all()
                    if not movements:
                        break
                    last_id = movements[-1].id
                    document_dates = await _document_dates(db, movements)
                    for movement in movements:
                        source = "document_date" if movement.id in document_dates else "created_at_ist_fallback"
                        counts[(movement.movement_type, source)] += 1
                        if apply_changes:
                            movement.effective_date = (
                                document_dates[movement.id]
                                if movement.id in document_dates
                                else _created_ist_date(movement.created_at)
                            )
                    if apply_changes:
                        await db.flush()
                print(f"Processed {sum(counts.values())} NULL movement dates")
        for (movement_type, source), count in sorted(counts.items()):
            print(f"{movement_type or '(null)'} | {source}: {count}")
        print("Mode: apply" if apply_changes else "Mode: dry-run (no writes)")
        return counts
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", required=True, help="Explicit SQLAlchemy database URL")
    parser.add_argument("--batch-size", type=int, default=5000)
    parser.add_argument("--dry-run", action="store_true", help="Report counts without writing (default)")
    parser.add_argument("--apply", action="store_true", help="Write dates in committed batches")
    args = parser.parse_args()
    if args.batch_size <= 0:
        parser.error("--batch-size must be greater than zero")
    if args.dry_run and args.apply:
        parser.error("Choose either --dry-run or --apply")
    asyncio.run(run(args.database_url, batch_size=args.batch_size, apply_changes=args.apply))


if __name__ == "__main__":
    main()

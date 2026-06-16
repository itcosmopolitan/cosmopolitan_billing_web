"""Cash Control ledger helpers.

Mirrors the pattern from _payment_ledger.py — callers pass the open db
session and must NOT commit inside this module; the outer route commits
atomically after all side effects.

Source-type values (source_type on CashEntry):
  'sale_invoice'       — POS / invoice paid at create with payment_mode=cash
  'customer_payment'   — payment recorded against an existing invoice
  'sale_return'        — cash refund issued on a sales return
  'purchase_payment'   — vendor bill paid in cash (standalone payment)
  'vendor_advance'     — cash advance paid to vendor
  'manual'             — operator-entered petty cash entry
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import CashEntry


async def _next_entry_number(db: AsyncSession, branch_id: str, date: str) -> str:
    """CE-YYMMDD-N (monotone within a branch+date)."""
    date_tag = date.replace("-", "")[2:]  # YYMMDD
    prefix = f"CE-{date_tag}-"
    result = await db.execute(
        select(CashEntry.entry_number)
        .where(CashEntry.branch_id == branch_id, CashEntry.date == date)
        .where(CashEntry.entry_number.like(f"{prefix}%"))
    )
    existing = result.scalars().all()
    seq = len(existing) + 1
    return f"{prefix}{seq}"


async def record_cash_in(
    db: AsyncSession,
    *,
    branch_id: str,
    amount: float,
    date: str,
    description: str,
    category: str,
    source_type: str,
    source_id: str,
    source_ref: str,
    recorded_by: str,
) -> CashEntry:
    entry_number = await _next_entry_number(db, branch_id, date)
    entry = CashEntry(
        id=str(uuid.uuid4()),
        branch_id=branch_id,
        type="in",
        category=category,
        description=description,
        amount=float(amount),
        ref=source_ref,
        date=date,
        time=datetime.now().strftime("%H:%M"),
        by=recorded_by,
        entry_number=entry_number,
        source_type=source_type,
        source_id=source_id,
        is_system=True,
    )
    db.add(entry)
    return entry


async def record_cash_out(
    db: AsyncSession,
    *,
    branch_id: str,
    amount: float,
    date: str,
    description: str,
    category: str,
    source_type: str,
    source_id: str,
    source_ref: str,
    recorded_by: str,
) -> CashEntry:
    entry_number = await _next_entry_number(db, branch_id, date)
    entry = CashEntry(
        id=str(uuid.uuid4()),
        branch_id=branch_id,
        type="out",
        category=category,
        description=description,
        amount=float(amount),
        ref=source_ref,
        date=date,
        time=datetime.now().strftime("%H:%M"),
        by=recorded_by,
        entry_number=entry_number,
        source_type=source_type,
        source_id=source_id,
        is_system=True,
    )
    db.add(entry)
    return entry


async def void_cash_entry(
    db: AsyncSession,
    *,
    source_type: str,
    source_id: str,
    voided_by: str,
    reason: str = "Source document voided",
) -> Optional[CashEntry]:
    """Find the live system CashEntry for a source document and create a
    mirror reversal entry. Marks the original is_voided=True.
    Returns None if no matching entry exists (idempotent)."""
    original = (
        await db.execute(
            select(CashEntry).where(
                CashEntry.source_type == source_type,
                CashEntry.source_id == source_id,
                CashEntry.is_voided == False,
                CashEntry.is_system == True,
            )
        )
    ).scalar_one_or_none()
    if original is None:
        return None

    now = datetime.now()
    original.is_voided = True
    original.voided_at = now
    original.voided_by = voided_by
    original.void_reason = reason

    reversal_type = "out" if original.type == "in" else "in"
    entry_number = await _next_entry_number(db, original.branch_id, original.date)
    reversal = CashEntry(
        id=str(uuid.uuid4()),
        branch_id=original.branch_id,
        type=reversal_type,
        category=original.category,
        description=f"Void: {original.entry_number or original.id}",
        amount=original.amount,
        ref=original.ref,
        date=original.date,
        time=now.strftime("%H:%M"),
        by=voided_by,
        entry_number=entry_number,
        source_type="void",
        source_id=original.id,
        is_system=True,
    )
    db.add(reversal)
    return reversal

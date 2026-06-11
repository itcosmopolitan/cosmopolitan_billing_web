"""Vendor advance / overpayment credit ledger (Purchase Phase 3)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Vendor, VendorCreditEntry


async def adjust_vendor_credit(
    db: AsyncSession,
    vendor_id: str,
    delta: float,
    *,
    entry_type: str,
    source_type: Optional[str] = None,
    source_ref: Optional[str] = None,
    source_number: Optional[str] = None,
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> tuple[float, float]:
    """Apply `delta` to vendor.credit_balance and append a ledger row.

    Positive delta = advance / overpayment credit in. Negative = debit when
    settling bills from stored credit. Returns (balance_before, balance_after).
    """
    if abs(delta) < 0.0001:
        vendor = (
            await db.execute(select(Vendor).where(Vendor.id == vendor_id))
        ).scalar_one_or_none()
        bal = float(vendor.credit_balance or 0) if vendor else 0.0
        return (bal, bal)

    vendor = (
        await db.execute(select(Vendor).where(Vendor.id == vendor_id))
    ).scalar_one_or_none()
    if not vendor:
        raise ValueError(f"Vendor {vendor_id} not found")

    prev = float(vendor.credit_balance or 0)
    if delta < 0:
        new = round(max(0.0, prev + delta), 2)
    else:
        new = round(prev + delta, 2)
    vendor.credit_balance = new

    db.add(VendorCreditEntry(
        id=str(uuid.uuid4()),
        vendor_id=vendor_id,
        entry_type=entry_type,
        delta=round(delta, 2),
        balance_before=prev,
        balance_after=new,
        source_type=source_type,
        source_ref=source_ref,
        source_number=source_number,
        notes=notes,
        date=datetime.now().strftime("%Y-%m-%d"),
        created_by=created_by,
    ))
    return (prev, new)

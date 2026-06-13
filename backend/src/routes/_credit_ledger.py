"""Customer store-credit ledger (Sales Phase 1)."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import Customer, CustomerCreditEntry


async def adjust_customer_credit(
    db: AsyncSession,
    customer_id: str,
    delta: float,
    *,
    entry_type: str,
    source_type: Optional[str] = None,
    source_ref: Optional[str] = None,
    source_number: Optional[str] = None,
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> tuple[float, float]:
    """Apply `delta` to customer.credit_balance and append a ledger row.

    Positive delta = credit in (overpayment, return refund). Negative = debit
    (credit-mode sale/payment). Returns (balance_before, balance_after).
    """
    if abs(delta) < 0.0001:
        cust = (
            await db.execute(select(Customer).where(Customer.id == customer_id))
        ).scalar_one_or_none()
        bal = float(cust.credit_balance or 0) if cust else 0.0
        return (bal, bal)

    cust = (
        await db.execute(select(Customer).where(Customer.id == customer_id))
    ).scalar_one_or_none()
    if not cust:
        raise ValueError(f"Customer {customer_id} not found")

    prev = float(cust.credit_balance or 0)
    if delta < 0:
        new = round(max(0.0, prev + delta), 2)
    else:
        new = round(prev + delta, 2)
    cust.credit_balance = new

    db.add(CustomerCreditEntry(
        id=str(uuid.uuid4()),
        customer_id=customer_id,
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

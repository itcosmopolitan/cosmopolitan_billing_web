"""Unified payment ledger (Phase 0)."""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import CustomerPayment, PaymentRecord, VendorPayment


async def record_customer_payment(
    db: AsyncSession,
    pay: CustomerPayment,
) -> None:
    """Mirror a CustomerPayment row into payment_records.

    Re-recording after an edit (void-then-rebuild) refreshes a voided
    ledger row in place so the source document id stays stable.
    """
    existing = (
        await db.execute(
            select(PaymentRecord).where(
                PaymentRecord.source_document_type == "customer_payment",
                PaymentRecord.source_document_id == pay.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.number = pay.number
        existing.party_id = pay.customer_id
        existing.party_name = pay.customer_name
        existing.branch_id = pay.branch_id
        existing.branch_name = pay.branch_name
        existing.date = pay.date
        existing.amount = float(pay.total_amount or 0)
        existing.payment_mode = pay.payment_mode
        existing.payment_ref = pay.payment_ref
        existing.voided = bool(getattr(pay, "voided", False))
        existing.voided_at = getattr(pay, "voided_at", None)
        existing.notes = pay.notes
        existing.created_by = pay.created_by
        return
    db.add(PaymentRecord(
        id=str(uuid.uuid4()),
        number=pay.number,
        direction="receive",
        party_type="customer",
        party_id=pay.customer_id,
        party_name=pay.customer_name,
        branch_id=pay.branch_id,
        branch_name=pay.branch_name,
        date=pay.date,
        amount=float(pay.total_amount or 0),
        payment_mode=pay.payment_mode,
        payment_ref=pay.payment_ref,
        source_document_type="customer_payment",
        source_document_id=pay.id,
        voided=bool(getattr(pay, "voided", False)),
        voided_at=getattr(pay, "voided_at", None),
        notes=pay.notes,
        created_by=pay.created_by,
    ))


async def record_vendor_payment(
    db: AsyncSession,
    pay: VendorPayment,
) -> None:
    """Mirror a VendorPayment row into payment_records.

    Re-recording after an edit refreshes a voided ledger row in place.
    """
    existing = (
        await db.execute(
            select(PaymentRecord).where(
                PaymentRecord.source_document_type == "vendor_payment",
                PaymentRecord.source_document_id == pay.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.number = pay.number
        existing.party_id = pay.vendor_id
        existing.party_name = pay.vendor_name
        existing.branch_id = pay.branch_id
        existing.branch_name = pay.branch_name
        existing.date = pay.date
        existing.amount = float(pay.total_amount or 0)
        existing.payment_mode = pay.payment_mode
        existing.payment_ref = pay.payment_ref
        existing.voided = bool(getattr(pay, "voided", False))
        existing.voided_at = getattr(pay, "voided_at", None)
        existing.notes = pay.notes
        existing.created_by = pay.created_by
        return
    db.add(PaymentRecord(
        id=str(uuid.uuid4()),
        number=pay.number,
        direction="pay",
        party_type="vendor",
        party_id=pay.vendor_id,
        party_name=pay.vendor_name,
        branch_id=pay.branch_id,
        branch_name=pay.branch_name,
        date=pay.date,
        amount=float(pay.total_amount or 0),
        payment_mode=pay.payment_mode,
        payment_ref=pay.payment_ref,
        source_document_type="vendor_payment",
        source_document_id=pay.id,
        voided=bool(getattr(pay, "voided", False)),
        voided_at=getattr(pay, "voided_at", None),
        notes=pay.notes,
        created_by=pay.created_by,
    ))


async def void_payment_record(
    db: AsyncSession,
    *,
    source_document_type: str,
    source_document_id: str,
    voided_at: Optional[str] = None,
) -> None:
    row = (
        await db.execute(
            select(PaymentRecord).where(
                PaymentRecord.source_document_type == source_document_type,
                PaymentRecord.source_document_id == source_document_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return
    row.voided = True
    if voided_at:
        row.voided_at = voided_at

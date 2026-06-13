"""Shared sales/purchase lifecycle helpers — outstanding sync, overdue, void."""
import re
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models import (
    Customer,
    CustomerPayment,
    DocumentReturnStatus,
    InvoiceStatus,
    PurchaseBill,
    SaleInvoice,
    SalesReturn,
    SalesReturnStatus,
    Vendor,
    VendorPayment,
    VendorReturn,
)
from src.routes._credit_ledger import adjust_customer_credit
from src.routes._vendor_credit_ledger import adjust_vendor_credit

DEFAULT_CREDIT_DAYS = 30


def parse_payment_terms_days(terms: Optional[str]) -> int:
    if not terms:
        return DEFAULT_CREDIT_DAYS
    m = re.search(r"(\d+)", str(terms))
    return int(m.group(1)) if m else DEFAULT_CREDIT_DAYS


def compute_due_date(from_date: str, payment_terms: Optional[str] = None) -> str:
    base = datetime.strptime(str(from_date)[:10], "%Y-%m-%d")
    days = parse_payment_terms_days(payment_terms)
    return (base + timedelta(days=days)).strftime("%Y-%m-%d")


def _recompute_invoice_status(inv) -> None:
    if inv.status == InvoiceStatus.cancelled or str(inv.status).endswith("cancelled"):
        return
    total = float(inv.total or 0)
    paid = float(inv.paid_amount or 0)
    # credited_amount (from active credit notes) counts as effective settlement —
    # an invoice with a full return is considered paid even if no cash changed hands.
    credited = float(getattr(inv, "credited_amount", 0) or 0)
    effective = paid + credited
    if effective >= total - 0.01:
        inv.status = InvoiceStatus.paid
    elif effective > 0.01:
        inv.status = InvoiceStatus.partial
    else:
        inv.status = InvoiceStatus.pending


def _recompute_bill_status(bill) -> None:
    if bill.status == InvoiceStatus.cancelled or str(bill.status).endswith("cancelled"):
        return
    total = float(bill.total or 0)
    paid = float(bill.paid_amount or 0)
    if paid >= total:
        bill.status = InvoiceStatus.paid
    elif paid > 0:
        bill.status = InvoiceStatus.partial
    else:
        bill.status = InvoiceStatus.pending


async def recalc_invoice_after_cn(db: AsyncSession, invoice_id: str) -> None:
    """Recompute credited_amount + return_status from active sales returns."""
    inv = (await db.execute(
        select(SaleInvoice).where(SaleInvoice.id == invoice_id)
    )).scalar_one_or_none()
    if inv is None:
        return
    credited = float(
        (await db.execute(
            select(func.coalesce(func.sum(SalesReturn.total), 0)).where(
                and_(
                    SalesReturn.invoice_id == invoice_id,
                    SalesReturn.status != SalesReturnStatus.void,
                )
            )
        )).scalar()
        or 0
    )
    inv.credited_amount = round(credited, 2)
    original_total = float(inv.total or 0)  # total is now stable (never mutated by returns)
    if credited <= 0:
        inv.return_status = DocumentReturnStatus.none.value
    elif original_total > 0 and credited >= original_total - 0.01:
        inv.return_status = DocumentReturnStatus.full.value
    else:
        inv.return_status = DocumentReturnStatus.partial.value
    _recompute_invoice_status(inv)


async def recalc_bill_after_vendor_credit(db: AsyncSession, bill_id: str) -> None:
    """Recompute credited_amount + return_status from active vendor returns."""
    bill = (await db.execute(
        select(PurchaseBill).where(PurchaseBill.id == bill_id)
    )).scalar_one_or_none()
    if bill is None:
        return
    credited = float(
        (await db.execute(
            select(func.coalesce(func.sum(VendorReturn.total), 0)).where(
                and_(
                    VendorReturn.bill_id == bill_id,
                    or_(VendorReturn.voided == False, VendorReturn.voided.is_(None)),  # noqa: E712
                ),
            )
        )).scalar()
        or 0
    )
    bill.credited_amount = round(credited, 2)
    original_total = round(float(bill.total or 0) + credited, 2)
    if credited <= 0:
        bill.return_status = DocumentReturnStatus.none.value
    elif original_total > 0 and credited >= original_total - 0.01:
        bill.return_status = DocumentReturnStatus.full.value
    else:
        bill.return_status = DocumentReturnStatus.partial.value
    _recompute_bill_status(bill)


async def sync_customer_outstanding(db: AsyncSession, customer_id: Optional[str]) -> None:
    if not customer_id:
        return
    cust = (await db.execute(select(Customer).where(Customer.id == customer_id))).scalar_one_or_none()
    if not cust:
        return
    open_statuses = (InvoiceStatus.pending, InvoiceStatus.partial, InvoiceStatus.overdue)
    total = float(
        (await db.execute(
            select(func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0)).where(
                and_(
                    SaleInvoice.customer_id == customer_id,
                    SaleInvoice.status.in_(open_statuses),
                )
            )
        )).scalar()
        or 0
    )
    cust.outstanding = round(max(0.0, total), 2)


async def sync_vendor_outstanding(db: AsyncSession, vendor_id: Optional[str]) -> None:
    if not vendor_id:
        return
    vendor = (await db.execute(select(Vendor).where(Vendor.id == vendor_id))).scalar_one_or_none()
    if not vendor:
        return
    open_statuses = (InvoiceStatus.pending, InvoiceStatus.partial, InvoiceStatus.overdue)
    total = float(
        (await db.execute(
            select(func.coalesce(func.sum(PurchaseBill.total - PurchaseBill.paid_amount), 0)).where(
                and_(
                    PurchaseBill.vendor_id == vendor_id,
                    PurchaseBill.status.in_(open_statuses),
                )
            )
        )).scalar()
        or 0
    )
    vendor.outstanding = round(max(0.0, total), 2)


async def refresh_sale_overdue(db: AsyncSession, branch_id: Optional[str] = None) -> None:
    today = datetime.now().strftime("%Y-%m-%d")
    conds = [
        SaleInvoice.status.in_([InvoiceStatus.pending, InvoiceStatus.partial]),
        SaleInvoice.due_date.isnot(None),
        SaleInvoice.due_date < today,
        SaleInvoice.paid_amount < SaleInvoice.total,
    ]
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
    rows = (await db.execute(select(SaleInvoice).where(and_(*conds)))).scalars().all()
    for inv in rows:
        inv.status = InvoiceStatus.overdue


async def refresh_purchase_overdue(db: AsyncSession, branch_id: Optional[str] = None) -> None:
    today = datetime.now().strftime("%Y-%m-%d")
    conds = [
        PurchaseBill.status.in_([InvoiceStatus.pending, InvoiceStatus.partial]),
        PurchaseBill.due_date.isnot(None),
        PurchaseBill.due_date < today,
        PurchaseBill.paid_amount < PurchaseBill.total,
    ]
    if branch_id:
        conds.append(PurchaseBill.branch_id == branch_id)
    rows = (await db.execute(select(PurchaseBill).where(and_(*conds)))).scalars().all()
    for bill in rows:
        bill.status = InvoiceStatus.overdue


async def reverse_customer_payment(db: AsyncSession, pay: CustomerPayment) -> float:
    """Undo a payment's invoice + credit effects. Returns credit restored."""
    credit_refunded = 0.0
    customer_ids: set[str] = set()
    for alloc in pay.allocations:
        inv = (await db.execute(
            select(SaleInvoice).where(SaleInvoice.id == alloc.invoice_id)
        )).scalar_one_or_none()
        if inv is not None:
            inv.paid_amount = round(
                max(0.0, float(inv.paid_amount or 0) - float(alloc.amount or 0)), 2,
            )
            _recompute_invoice_status(inv)
            if inv.customer_id:
                customer_ids.add(inv.customer_id)
    cid = pay.customer_id
    if pay.payment_mode == "credit" and cid and (pay.total_amount or 0) > 0:
        refund = float(pay.total_amount or 0)
        await adjust_customer_credit(
            db,
            cid,
            refund,
            entry_type="void_restore",
            source_type="customer_payment",
            source_ref=pay.id,
            source_number=pay.number,
        )
        credit_refunded += refund
    if cid and (pay.credit_applied or 0) > 0:
        revoke = float(pay.credit_applied or 0)
        await adjust_customer_credit(
            db,
            cid,
            -revoke,
            entry_type="void_revoke",
            source_type="customer_payment",
            source_ref=pay.id,
            source_number=pay.number,
        )
    for customer_id in customer_ids:
        await sync_customer_outstanding(db, customer_id)
    if cid:
        await sync_customer_outstanding(db, cid)
    return credit_refunded


async def reverse_vendor_payment(db: AsyncSession, pay: VendorPayment) -> None:
    vendor_ids: set[str] = set()
    for alloc in pay.allocations:
        bill = (await db.execute(
            select(PurchaseBill).where(PurchaseBill.id == alloc.bill_id)
        )).scalar_one_or_none()
        if bill is not None:
            bill.paid_amount = round(
                max(0.0, float(bill.paid_amount or 0) - float(alloc.amount or 0)), 2,
            )
            _recompute_bill_status(bill)
            if bill.vendor_id:
                vendor_ids.add(bill.vendor_id)
    if pay.vendor_id:
        vendor_ids.add(pay.vendor_id)
    if (pay.credit_applied or 0) > 0 and pay.vendor_id:
        await adjust_vendor_credit(
            db,
            pay.vendor_id,
            -float(pay.credit_applied or 0),
            entry_type="void_revoke",
            source_type="vendor_payment",
            source_ref=pay.id,
            source_number=pay.number,
        )
    for vendor_id in vendor_ids:
        await sync_vendor_outstanding(db, vendor_id)

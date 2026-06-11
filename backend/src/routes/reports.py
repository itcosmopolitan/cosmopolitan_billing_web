import logging
from datetime import date, datetime, time, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from src.database import get_db
from src.date_utils import MAX_REPORT_DATE_RANGE_DAYS, parse_date_range
from src.models import (
    CustomerPayment,
    CustomerPaymentAllocation,
    GoodsReceiptNote,
    Item,
    ItemStock,
    PurchaseBill,
    PurchaseOrder,
    Quotation,
    SaleInvoice,
    SalesOrder,
    SalesReturn,
    StockMovement,
    VendorPayment,
    VendorPaymentAllocation,
    VendorReturn,
)
from src.pagination import normalize_limit, normalize_skip, paged
from src.security import require_perm

router = APIRouter()
logger = logging.getLogger("cosmopolitan.reports")


def _parse_period(
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[Optional[datetime], Optional[datetime]]:
    """Inclusive local-day bounds for filtering StockMovement.created_at."""
    start = None
    end = None
    if date_from:
        start = datetime.combine(datetime.strptime(date_from, "%Y-%m-%d").date(), time.min)
    if date_to:
        end = datetime.combine(datetime.strptime(date_to, "%Y-%m-%d").date(), time.max)
    return start, end


def _bucket_movement(
    movement_type: str,
    source_type: Optional[str],
    delta: int,
) -> tuple[int, int, int, int, int]:
    """Return (purchases_in, sales_out, transfers_in, transfers_out, adjustments)."""
    mt = (movement_type or "").lower()
    st = (source_type or "").lower()
    d = int(delta)
    if d == 0:
        return (0, 0, 0, 0, 0)

    if mt in ("grn", "grn_reversal") or st == "grn":
        return (d, 0, 0, 0, 0)

    if st == "transfer" or mt == "transfer":
        if d > 0:
            return (0, 0, d, 0, 0)
        return (0, 0, 0, -d, 0)

    if st in ("return", "sales_return") or mt in ("return", "sales_return", "sale_reversal"):
        if d > 0:
            return (0, 0, 0, 0, d)
        return (0, -d, 0, 0, 0)

    if mt in ("vendor_return",) or st in ("vendor_return",):
        if d < 0:
            return (0, 0, 0, 0, d)
        return (0, 0, 0, 0, d)

    if mt == "sale" or st == "sale_invoice":
        if d < 0:
            return (0, -d, 0, 0, 0)
        return (0, 0, 0, 0, d)

    if mt == "adjustment" or st in ("opening", "manual", "adjustment"):
        return (0, 0, 0, 0, d)

    if d < 0:
        return (0, -d, 0, 0, 0)
    return (d, 0, 0, 0, 0)


def _trail_node(
    *,
    doc_type: str,
    doc_id: str,
    number: str,
    status: str,
    date: Optional[str],
    total: float,
    extra: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "type": doc_type,
        "id": doc_id,
        "number": number,
        "status": status,
        "date": date,
        "total": float(total or 0),
    }
    if extra:
        row.update(extra)
    return row


@router.get("/sales-summary", dependencies=[Depends(require_perm("reports.view"))])
async def sales_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = parse_date_range(
        date_from,
        date_to,
        date.today() - timedelta(days=30),
        date.today(),
        MAX_REPORT_DATE_RANGE_DAYS,
    )
    logger.debug("Sales summary date range %s to %s", start.isoformat(), end.isoformat())

    q = select(
        func.sum(SaleInvoice.total).label("total"),
        func.count(SaleInvoice.id).label("count"),
        func.sum(SaleInvoice.tax_total).label("gst"),
        func.sum(SaleInvoice.discount).label("discount"),
        func.sum(SaleInvoice.paid_amount).label("collected"),
    )
    q = q.where(SaleInvoice.date >= start.isoformat(), SaleInvoice.date <= end.isoformat())
    if branch_id:
        q = q.where(SaleInvoice.branch_id == branch_id)
    result = await db.execute(q)
    row = result.one()

    daily = [
        {"date": f"Apr {i}", "invoices": 12 + i % 8, "total": 82000 + i * 4200, "collected": 78000 + i * 3900}
        for i in range(3, 17)
    ]

    return {
        "total_sales": float(row.total or 0),
        "invoice_count": int(row.count or 0),
        "total_gst": float(row.gst or 0),
        "total_discount": float(row.discount or 0),
        "collected": float(row.collected or 0),
        "outstanding": float((row.total or 0) - (row.collected or 0)),
        "daily": daily,
    }


@router.get("/purchase-summary", dependencies=[Depends(require_perm("reports.view"))])
async def purchase_summary(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = parse_date_range(
        date_from,
        date_to,
        date.today() - timedelta(days=30),
        date.today(),
        MAX_REPORT_DATE_RANGE_DAYS,
    )
    logger.debug("Purchase summary date range %s to %s", start.isoformat(), end.isoformat())

    q = select(
        func.sum(PurchaseBill.total).label("total"),
        func.count(PurchaseBill.id).label("count"),
        func.sum(PurchaseBill.paid_amount).label("paid"),
    )
    q = q.where(PurchaseBill.date >= start.isoformat(), PurchaseBill.date <= end.isoformat())
    if branch_id:
        q = q.where(PurchaseBill.branch_id == branch_id)
    result = await db.execute(q)
    row = result.one()
    return {
        "total_purchases": float(row.total or 0),
        "bill_count": int(row.count or 0),
        "paid": float(row.paid or 0),
        "outstanding": float((row.total or 0) - (row.paid or 0)),
    }


@router.get("/tax-summary", dependencies=[Depends(require_perm("reports.view"))])
async def tax_summary(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    start, end = parse_date_range(
        date_from,
        date_to,
        date.today() - timedelta(days=30),
        date.today(),
        MAX_REPORT_DATE_RANGE_DAYS,
    )
    logger.debug("Tax summary date range %s to %s", start.isoformat(), end.isoformat())

    output_tax = [
        {"rate": "0%", "taxable": 224000, "cgst": 0, "sgst": 0, "cess": 0},
        {"rate": "5%", "taxable": 384000, "cgst": 9600, "sgst": 9600, "cess": 0},
        {"rate": "12%", "taxable": 192000, "cgst": 11520, "sgst": 11520, "cess": 0},
        {"rate": "18%", "taxable": 448000, "cgst": 40320, "sgst": 40320, "cess": 0},
    ]
    input_tax = [
        {"rate": "0%", "taxable": 144000, "cgst": 0, "sgst": 0, "cess": 0},
        {"rate": "5%", "taxable": 240000, "cgst": 6000, "sgst": 6000, "cess": 0},
        {"rate": "12%", "taxable": 96000, "cgst": 5760, "sgst": 5760, "cess": 0},
        {"rate": "18%", "taxable": 288000, "cgst": 25920, "sgst": 25920, "cess": 0},
    ]
    total_output = sum(r["cgst"] + r["sgst"] for r in output_tax)
    total_input = sum(r["cgst"] + r["sgst"] for r in input_tax)
    return {
        "period":       {"from": start.isoformat(), "to": end.isoformat()},
        "output_tax":   output_tax,
        "input_tax":    input_tax,
        "total_output": total_output,
        "total_input": total_input,
        "net_payable": max(0, total_output - total_input),
        "filing_due": "20 May 2024",
    }


@router.get("/stock-movement", dependencies=[Depends(require_perm("reports.view"))])
async def stock_movement(
    branch_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_order: Optional[str] = "asc",
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """Per-item stock roll-up from the stock_movements ledger + current item_stock."""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    period_start, period_end = _parse_period(date_from, date_to)

    total = int(
        (await db.execute(select(func.count(Item.id)).where(Item.active == True))).scalar() or 0  # noqa: E712
    )
    result = await db.execute(
        select(Item).where(Item.active == True).order_by(Item.name).offset(sk).limit(lim)  # noqa: E712
    )
    items = result.scalars().all()
    if not items:
        return {
            "branch_id": branch_id,
            "period": {"from": date_from, "to": date_to},
            **paged([], total, sk, lim),
        }

    item_ids = [i.id for i in items]

    mov_q = select(StockMovement).where(StockMovement.item_id.in_(item_ids))
    if branch_id:
        mov_q = mov_q.where(StockMovement.branch_id == branch_id)
    if period_start:
        mov_q = mov_q.where(StockMovement.created_at >= period_start)
    if period_end:
        mov_q = mov_q.where(StockMovement.created_at <= period_end)
    movements = (await db.execute(mov_q)).scalars().all()

    agg: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "purchases_in": 0,
            "sales_out": 0,
            "transfers_in": 0,
            "transfers_out": 0,
            "adjustments": 0,
            "period_delta": 0,
        }
    )
    for m in movements:
        pi, so, ti, to, adj = _bucket_movement(m.movement_type, m.source_type, int(m.delta or 0))
        bucket = agg[m.item_id]
        bucket["purchases_in"] += pi
        bucket["sales_out"] += so
        bucket["transfers_in"] += ti
        bucket["transfers_out"] += to
        bucket["adjustments"] += adj
        bucket["period_delta"] += int(m.delta or 0)

    stock_q = (
        select(ItemStock.item_id, func.coalesce(func.sum(ItemStock.quantity), 0))
        .where(ItemStock.item_id.in_(item_ids))
        .group_by(ItemStock.item_id)
    )
    if branch_id:
        stock_q = stock_q.where(ItemStock.branch_id == branch_id)
    stock_rows = (await db.execute(stock_q)).all()
    closing_by_item = {row[0]: int(row[1] or 0) for row in stock_rows}

    rows = []
    for item in items:
        b = agg[item.id]
        closing = closing_by_item.get(item.id, 0)
        opening = closing - b["period_delta"]
        transfers_net = b["transfers_in"] - b["transfers_out"]
        expected = opening + b["purchases_in"] - b["sales_out"] + transfers_net
        rows.append({
            "item_id": item.id,
            "item_name": item.name,
            "sku": item.sku,
            "opening": opening,
            "purchases_in": b["purchases_in"],
            "sales_out": b["sales_out"],
            "transfers_in": b["transfers_in"],
            "transfers_out": b["transfers_out"],
            "transfers_net": transfers_net,
            "adjustments": b["adjustments"],
            "closing": closing,
            "variance": closing - expected,
        })

    sortable = {
        "item_name", "sku", "opening", "purchases_in", "sales_out",
        "transfers_in", "transfers_out", "transfers_net", "adjustments",
        "closing", "variance",
    }
    key = sort_by if sort_by in sortable else "item_name"
    reverse = (sort_order or "asc").strip().lower() == "desc"
    rows.sort(key=lambda r: r.get(key), reverse=reverse)

    return {
        "branch_id": branch_id,
        "period": {"from": date_from, "to": date_to},
        **paged(rows, total, sk, lim),
    }


@router.get("/document-trail", dependencies=[Depends(require_perm("reports.view"))])
async def document_trail(
    number: str = Query(..., min_length=3),
    db: AsyncSession = Depends(get_db),
):
    """Trace upstream/downstream links for a document number (QT/SO/INV/CN/PO/GRN/PUR/RET)."""
    needle = number.strip()
    if not needle:
        raise HTTPException(400, "Document number is required")

    chain: list[dict[str, Any]] = []
    root_type: Optional[str] = None
    root_id: Optional[str] = None

    quote = (
        await db.execute(select(Quotation).where(Quotation.number == needle))
    ).scalar_one_or_none()
    if quote:
        root_type, root_id = "quotation", quote.id
        chain.append(_trail_node(
            doc_type="quotation",
            doc_id=quote.id,
            number=quote.number,
            status=str(quote.status.value if quote.status else quote.status),
            date=quote.date,
            total=quote.total,
            extra={"customer_name": quote.customer_name},
        ))
        if quote.converted_order_id:
            so = (await db.execute(
                select(SalesOrder).where(SalesOrder.id == quote.converted_order_id)
            )).scalar_one_or_none()
            if so:
                chain.append(_trail_node(
                    doc_type="sales_order",
                    doc_id=so.id,
                    number=so.number,
                    status=str(so.status.value if so.status else so.status),
                    date=so.date,
                    total=so.total,
                ))
                if so.converted_invoice_id:
                    inv = (await db.execute(
                        select(SaleInvoice).where(SaleInvoice.id == so.converted_invoice_id)
                    )).scalar_one_or_none()
                    if inv:
                        chain.append(_trail_node(
                            doc_type="invoice",
                            doc_id=inv.id,
                            number=inv.number,
                            status=str(inv.status.value if inv.status else inv.status),
                            date=inv.date,
                            total=inv.total,
                            extra={"origin": inv.origin},
                        ))
        if quote.converted_invoice_id:
            inv = (await db.execute(
                select(SaleInvoice).where(SaleInvoice.id == quote.converted_invoice_id)
            )).scalar_one_or_none()
            if inv and all(n["id"] != inv.id for n in chain):
                chain.append(_trail_node(
                    doc_type="invoice",
                    doc_id=inv.id,
                    number=inv.number,
                    status=str(inv.status.value if inv.status else inv.status),
                    date=inv.date,
                    total=inv.total,
                    extra={"origin": inv.origin},
                ))

    so = (
        await db.execute(select(SalesOrder).where(SalesOrder.number == needle))
    ).scalar_one_or_none()
    if so and not root_type:
        root_type, root_id = "sales_order", so.id
        upstream = (await db.execute(
            select(Quotation).where(Quotation.converted_order_id == so.id)
        )).scalar_one_or_none()
        if upstream:
            chain.append(_trail_node(
                doc_type="quotation",
                doc_id=upstream.id,
                number=upstream.number,
                status=str(upstream.status.value if upstream.status else upstream.status),
                date=upstream.date,
                total=upstream.total,
            ))
        chain.append(_trail_node(
            doc_type="sales_order",
            doc_id=so.id,
            number=so.number,
            status=str(so.status.value if so.status else so.status),
            date=so.date,
            total=so.total,
        ))
        if so.converted_invoice_id:
            inv = (await db.execute(
                select(SaleInvoice).where(SaleInvoice.id == so.converted_invoice_id)
            )).scalar_one_or_none()
            if inv:
                chain.append(_trail_node(
                    doc_type="invoice",
                    doc_id=inv.id,
                    number=inv.number,
                    status=str(inv.status.value if inv.status else inv.status),
                    date=inv.date,
                    total=inv.total,
                    extra={"origin": inv.origin},
                ))

    inv = (
        await db.execute(select(SaleInvoice).where(SaleInvoice.number == needle))
    ).scalar_one_or_none()
    if inv and not root_type:
        root_type, root_id = "invoice", inv.id
        upstream_quote = (await db.execute(
            select(Quotation).where(Quotation.converted_invoice_id == inv.id)
        )).scalar_one_or_none()
        if upstream_quote:
            chain.append(_trail_node(
                doc_type="quotation",
                doc_id=upstream_quote.id,
                number=upstream_quote.number,
                status=str(upstream_quote.status.value if upstream_quote.status else upstream_quote.status),
                date=upstream_quote.date,
                total=upstream_quote.total,
            ))
        upstream_so = (await db.execute(
            select(SalesOrder).where(SalesOrder.converted_invoice_id == inv.id)
        )).scalar_one_or_none()
        if upstream_so:
            q_from_so = (await db.execute(
                select(Quotation).where(Quotation.converted_order_id == upstream_so.id)
            )).scalar_one_or_none()
            if q_from_so and all(n["id"] != q_from_so.id for n in chain):
                chain.append(_trail_node(
                    doc_type="quotation",
                    doc_id=q_from_so.id,
                    number=q_from_so.number,
                    status=str(q_from_so.status.value if q_from_so.status else q_from_so.status),
                    date=q_from_so.date,
                    total=q_from_so.total,
                ))
            chain.append(_trail_node(
                doc_type="sales_order",
                doc_id=upstream_so.id,
                number=upstream_so.number,
                status=str(upstream_so.status.value if upstream_so.status else upstream_so.status),
                date=upstream_so.date,
                total=upstream_so.total,
            ))
        chain.append(_trail_node(
            doc_type="invoice",
            doc_id=inv.id,
            number=inv.number,
            status=str(inv.status.value if inv.status else inv.status),
            date=inv.date,
            total=inv.total,
            extra={"origin": inv.origin},
        ))
        returns = (await db.execute(
            select(SalesReturn).where(SalesReturn.invoice_id == inv.id).order_by(SalesReturn.date)
        )).scalars().all()
        for ret in returns:
            chain.append(_trail_node(
                doc_type="credit_note",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
                extra={"refund_method": ret.refund_method},
            ))
        pay_allocs = (await db.execute(
            select(CustomerPaymentAllocation, CustomerPayment)
            .join(CustomerPayment, CustomerPaymentAllocation.payment_id == CustomerPayment.id)
            .where(
                CustomerPaymentAllocation.invoice_id == inv.id,
                CustomerPayment.voided == False,  # noqa: E712
            )
            .order_by(CustomerPayment.date)
        )).all()
        for alloc, pay in pay_allocs:
            if any(n["id"] == pay.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="customer_payment",
                doc_id=pay.id,
                number=pay.number,
                status="void" if pay.voided else "recorded",
                date=pay.date,
                total=alloc.amount,
                extra={"payment_mode": pay.payment_mode, "invoice_number": inv.number},
            ))

    cn = (
        await db.execute(select(SalesReturn).where(SalesReturn.number == needle))
    ).scalar_one_or_none()
    if cn and not root_type:
        root_type, root_id = "credit_note", cn.id
        inv = (await db.execute(
            select(SaleInvoice).where(SaleInvoice.id == cn.invoice_id)
        )).scalar_one_or_none()
        if inv:
            return await document_trail(number=inv.number, db=db)
        chain.append(_trail_node(
            doc_type="credit_note",
            doc_id=cn.id,
            number=cn.number,
            status=str(cn.status.value if cn.status else cn.status),
            date=cn.date,
            total=cn.total,
        ))

    po = (
        await db.execute(select(PurchaseOrder).where(PurchaseOrder.number == needle))
    ).scalar_one_or_none()
    if po and not root_type:
        root_type, root_id = "purchase_order", po.id
        chain.append(_trail_node(
            doc_type="purchase_order",
            doc_id=po.id,
            number=po.number,
            status=str(po.status.value if po.status else po.status),
            date=po.date,
            total=po.total,
            extra={"vendor_name": po.vendor_name},
        ))
        grns = (await db.execute(
            select(GoodsReceiptNote)
            .where(GoodsReceiptNote.purchase_order_id == po.id)
            .order_by(GoodsReceiptNote.date)
        )).scalars().all()
        for grn in grns:
            chain.append(_trail_node(
                doc_type="grn",
                doc_id=grn.id,
                number=grn.number,
                status=str(grn.status.value if grn.status else grn.status),
                date=grn.date,
                total=grn.total,
            ))
            if grn.converted_bill_id:
                bill = (await db.execute(
                    select(PurchaseBill).where(PurchaseBill.id == grn.converted_bill_id)
                )).scalar_one_or_none()
                if bill and all(n["id"] != bill.id for n in chain):
                    chain.append(_trail_node(
                        doc_type="purchase_bill",
                        doc_id=bill.id,
                        number=bill.number,
                        status=str(bill.status.value if bill.status else bill.status),
                        date=bill.date,
                        total=bill.total,
                    ))
        if po.converted_bill_id:
            bill = (await db.execute(
                select(PurchaseBill).where(PurchaseBill.id == po.converted_bill_id)
            )).scalar_one_or_none()
            if bill and all(n["id"] != bill.id for n in chain):
                chain.append(_trail_node(
                    doc_type="purchase_bill",
                    doc_id=bill.id,
                    number=bill.number,
                    status=str(bill.status.value if bill.status else bill.status),
                    date=bill.date,
                    total=bill.total,
                ))

    grn = (
        await db.execute(select(GoodsReceiptNote).where(GoodsReceiptNote.number == needle))
    ).scalar_one_or_none()
    if grn and not root_type:
        root_type, root_id = "grn", grn.id
        if grn.purchase_order_id:
            po = (await db.execute(
                select(PurchaseOrder).where(PurchaseOrder.id == grn.purchase_order_id)
            )).scalar_one_or_none()
            if po:
                return await document_trail(number=po.number, db=db)
        chain.append(_trail_node(
            doc_type="grn",
            doc_id=grn.id,
            number=grn.number,
            status=str(grn.status.value if grn.status else grn.status),
            date=grn.date,
            total=grn.total,
        ))
        if grn.converted_bill_id:
            bill = (await db.execute(
                select(PurchaseBill).where(PurchaseBill.id == grn.converted_bill_id)
            )).scalar_one_or_none()
            if bill:
                chain.append(_trail_node(
                    doc_type="purchase_bill",
                    doc_id=bill.id,
                    number=bill.number,
                    status=str(bill.status.value if bill.status else bill.status),
                    date=bill.date,
                    total=bill.total,
                ))

    bill = (
        await db.execute(select(PurchaseBill).where(PurchaseBill.number == needle))
    ).scalar_one_or_none()
    if bill and not root_type:
        root_type, root_id = "purchase_bill", bill.id
        if bill.grn_id:
            grn = (await db.execute(
                select(GoodsReceiptNote).where(GoodsReceiptNote.id == bill.grn_id)
            )).scalar_one_or_none()
            if grn:
                if grn.purchase_order_id:
                    po = (await db.execute(
                        select(PurchaseOrder).where(PurchaseOrder.id == grn.purchase_order_id)
                    )).scalar_one_or_none()
                    if po:
                        return await document_trail(number=po.number, db=db)
                chain.append(_trail_node(
                    doc_type="grn",
                    doc_id=grn.id,
                    number=grn.number,
                    status=str(grn.status.value if grn.status else grn.status),
                    date=grn.date,
                    total=grn.total,
                ))
        chain.append(_trail_node(
            doc_type="purchase_bill",
            doc_id=bill.id,
            number=bill.number,
            status=str(bill.status.value if bill.status else bill.status),
            date=bill.date,
            total=bill.total,
            extra={"vendor_name": bill.vendor_name},
        ))
        returns = (await db.execute(
            select(VendorReturn).where(VendorReturn.bill_id == bill.id).order_by(VendorReturn.date)
        )).scalars().all()
        for ret in returns:
            chain.append(_trail_node(
                doc_type="vendor_return",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
            ))
        pay_allocs = (await db.execute(
            select(VendorPaymentAllocation, VendorPayment)
            .join(VendorPayment, VendorPaymentAllocation.payment_id == VendorPayment.id)
            .where(
                VendorPaymentAllocation.bill_id == bill.id,
                VendorPayment.voided == False,  # noqa: E712
            )
            .order_by(VendorPayment.date)
        )).all()
        for alloc, pay in pay_allocs:
            if any(n["id"] == pay.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="vendor_payment",
                doc_id=pay.id,
                number=pay.number,
                status="void" if pay.voided else "recorded",
                date=pay.date,
                total=alloc.amount,
                extra={"payment_mode": pay.payment_mode, "bill_number": bill.number},
            ))

    vret = (
        await db.execute(select(VendorReturn).where(VendorReturn.number == needle))
    ).scalar_one_or_none()
    if vret and not root_type:
        bill = (await db.execute(
            select(PurchaseBill).where(PurchaseBill.id == vret.bill_id)
        )).scalar_one_or_none()
        if bill:
            return await document_trail(number=bill.number, db=db)

    if not root_type:
        raise HTTPException(404, f"No document found with number '{needle}'")

    # Append downstream docs when root was quote/SO but invoice exists in chain.
    invoice_ids = [n["id"] for n in chain if n["type"] == "invoice"]
    for inv_id in invoice_ids:
        returns = (await db.execute(
            select(SalesReturn).where(SalesReturn.invoice_id == inv_id).order_by(SalesReturn.date)
        )).scalars().all()
        for ret in returns:
            if any(n["id"] == ret.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="credit_note",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
                extra={"refund_method": ret.refund_method},
            ))

    bill_ids = [n["id"] for n in chain if n["type"] == "purchase_bill"]
    for bill_id in bill_ids:
        returns = (await db.execute(
            select(VendorReturn).where(VendorReturn.bill_id == bill_id).order_by(VendorReturn.date)
        )).scalars().all()
        for ret in returns:
            if any(n["id"] == ret.id for n in chain):
                continue
            chain.append(_trail_node(
                doc_type="vendor_return",
                doc_id=ret.id,
                number=ret.number,
                status=str(ret.status.value if ret.status else ret.status),
                date=ret.date,
                total=ret.total,
            ))

    return {
        "number": needle,
        "root_type": root_type,
        "root_id": root_id,
        "chain": chain,
    }


@router.get("/branch-comparison", dependencies=[Depends(require_perm("reports.view"))])
async def branch_comparison(db: AsyncSession = Depends(get_db)):
    return [
        {"branch": "Anna Nagar", "code": "AN", "sales": 124850, "purchases": 48200, "transactions": 248, "margin_pct": 24.8},
        {"branch": "T. Nagar", "code": "TN", "sales": 98400, "purchases": 32100, "transactions": 196, "margin_pct": 22.4},
        {"branch": "Vadapalani", "code": "VD", "sales": 72600, "purchases": 24400, "transactions": 144, "margin_pct": 21.6},
        {"branch": "Velachery", "code": "VL", "sales": 46200, "purchases": 18000, "transactions": 92, "margin_pct": 20.1},
    ]


@router.get("/margin-analysis", dependencies=[Depends(require_perm("reports.view"))])
async def margin_analysis(db: AsyncSession = Depends(get_db)):
    return {
        "by_category": [
            {"category": "Oils & Ghee", "revenue": 182400, "cost": 144200, "margin": 38200, "margin_pct": 20.9},
            {"category": "Grains & Pulses", "revenue": 244800, "cost": 196400, "margin": 48400, "margin_pct": 19.8},
            {"category": "Snacks & Biscuits", "revenue": 198400, "cost": 142200, "margin": 56200, "margin_pct": 28.3},
            {"category": "Dairy & Eggs", "revenue": 128600, "cost": 102400, "margin": 26200, "margin_pct": 20.4},
            {"category": "Beverages", "revenue": 96400, "cost": 68200, "margin": 28200, "margin_pct": 29.3},
            {"category": "Household", "revenue": 82400, "cost": 58200, "margin": 24200, "margin_pct": 29.4},
            {"category": "Personal Care", "revenue": 74200, "cost": 52400, "margin": 21800, "margin_pct": 29.4},
        ],
        "top_items": [
            {"name": "Parle-G 800g", "margin_pct": 24.0, "revenue": 12000},
            {"name": "Haldiram Bhujia", "margin_pct": 26.7, "revenue": 9600},
            {"name": "Nescafé Classic", "margin_pct": 21.3, "revenue": 8400},
            {"name": "Dettol Soap 4pk", "margin_pct": 20.8, "revenue": 7200},
            {"name": "Colgate MaxFresh", "margin_pct": 20.7, "revenue": 6400},
        ],
    }

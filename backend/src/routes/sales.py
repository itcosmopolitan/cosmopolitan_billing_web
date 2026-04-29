from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_
from sqlalchemy.orm import selectinload
from src.database import get_db
from src.models import SaleInvoice, SaleLineItem, ItemStock, Quotation, QuotationLineItem, Customer, InvoiceStatus
from src.pagination import paged, normalize_limit, normalize_skip
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
import uuid

router = APIRouter()

# ─── Schemas ─────────────────────────────────────────────────────────────────
class LineItemIn(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    price: float
    tax_rate: float = 0
    line_discount: float = 0
    line_discount_amount: float = 0

class SaleCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    cashier: str = "Staff"
    date: Optional[str] = None          # defaults to today
    items: List[LineItemIn]
    discount: float = 0
    payment_mode: str = "cash"
    notes: Optional[str] = None

class PaymentIn(BaseModel):
    amount: float
    mode: str = "bank_transfer"
    ref: str = ""

class QuotationCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    branch_name: str = ""
    created_by: str = "Staff"
    date: Optional[str] = None
    valid_until: Optional[str] = None
    items: List[LineItemIn]
    discount: float = 0
    notes: Optional[str] = None

# ─── SAMPLE RETURNS DATA ──────────────────────────────────────────────────────
# Sample returns data (in production, would be stored in database)
SAMPLE_RETURNS = [
    {
        "id": "cn-001",
        "number": "CN-2024-001",
        "customer_id": "cu-002",
        "customer_name": "Rajesh Stores",
        "ref_invoice": "INV-2024-1847",
        "date": "2024-04-16",
        "amount": 1500,
        "reason": "Defective product - damaged packaging",
        "status": "processed",
        "notes": "Basmati Rice 5kg bag torn, customer requested return"
    },
    {
        "id": "cn-002",
        "number": "CN-2024-002",
        "customer_id": "cu-004",
        "customer_name": "Anand Traders",
        "ref_invoice": "INV-2024-1844",
        "date": "2024-04-15",
        "amount": 2800,
        "reason": "Incorrect quantity delivered",
        "status": "processed",
        "notes": "Received 40 units instead of 50"
    },
    {
        "id": "cn-003",
        "number": "CN-2024-003",
        "customer_id": "cu-001",
        "customer_name": "Priya Sharma",
        "ref_invoice": "INV-2024-1845",
        "date": "2024-04-14",
        "amount": 680,
        "reason": "Expired items returned",
        "status": "processed",
        "notes": "Amul Milk cartons expired before use date"
    }
]


def _sale_invoice_filters(
    branch_id: Optional[str],
    status: Optional[str],
    customer_id: Optional[str],
    search: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
):
    conds = []
    if branch_id:
        conds.append(SaleInvoice.branch_id == branch_id)
    if status:
        try:
            conds.append(SaleInvoice.status == InvoiceStatus(status))
        except ValueError:
            conds.append(SaleInvoice.status == status)
    if customer_id:
        conds.append(SaleInvoice.customer_id == customer_id)
    if date_from:
        conds.append(SaleInvoice.date >= date_from)
    if date_to:
        conds.append(SaleInvoice.date <= date_to)
    if search:
        conds.append(
            or_(
                SaleInvoice.number.ilike(f"%{search}%"),
                SaleInvoice.customer_name.ilike(f"%{search}%"),
            )
        )
    return conds


async def _sales_list_summary(db: AsyncSession, conds):
    base = and_(*conds) if conds else True
    amount_total = float(
        (await db.execute(select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(base))).scalar() or 0
    )
    collected_paid = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(
                    and_(base, SaleInvoice.status == InvoiceStatus.paid)
                )
            )
        ).scalar()
        or 0
    )
    credit_pending = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total - SaleInvoice.paid_amount), 0)).where(
                    and_(base, SaleInvoice.status == InvoiceStatus.pending)
                )
            )
        ).scalar()
        or 0
    )
    overdue_total = float(
        (
            await db.execute(
                select(func.coalesce(func.sum(SaleInvoice.total), 0)).where(
                    and_(base, SaleInvoice.status == InvoiceStatus.overdue)
                )
            )
        ).scalar()
        or 0
    )
    return {
        "amountTotal": amount_total,
        "collectedPaid": collected_paid,
        "creditPending": credit_pending,
        "overdueTotal": overdue_total,
    }


# ─── LIST ─────────────────────────────────────────────────────────────────────
@router.get("/")
async def list_invoices(
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = _sale_invoice_filters(branch_id, status, customer_id, search, date_from, date_to)
    q = (
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .order_by(SaleInvoice.created_at.desc())
    )
    if conds:
        q = q.where(and_(*conds))
    count_r = await db.execute(select(func.count(SaleInvoice.id)).where(and_(*conds)) if conds else select(func.count(SaleInvoice.id)))
    total = int(count_r.scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    invoices = result.unique().scalars().all()
    out = [_inv_dict(inv, inv.line_items) for inv in invoices]
    summary = await _sales_list_summary(db, conds)
    return paged(out, total, sk, lim, summary=summary)

# ─── LIST RETURNS ────────────────────────────────────────────────────────────
@router.get("/returns")
async def list_returns(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
):
    """List all credit notes / returns"""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    data = SAMPLE_RETURNS[sk : sk + lim]
    return paged(data, len(SAMPLE_RETURNS), sk, lim)

# ─── QUOTATIONS ───────────────────────────────────────────────────────────────
@router.get("/quotations/")
async def list_quotations(
    branch_id: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List all quotations"""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    q_count = select(func.count(Quotation.id))
    q = select(Quotation).options(selectinload(Quotation.line_items)).order_by(Quotation.created_at.desc())
    if branch_id:
        q = q.where(Quotation.branch_id == branch_id)
        q_count = q_count.where(Quotation.branch_id == branch_id)
    total = int((await db.execute(q_count)).scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    quotations = result.unique().scalars().all()
    items_out = [_quote_dict(qt, qt.line_items) for qt in quotations]
    return paged(items_out, total, sk, lim)

@router.get("/quotations/{quote_id}")
async def get_quotation(quote_id: str, db: AsyncSession = Depends(get_db)):
    """Get a specific quotation"""
    result = await db.execute(select(Quotation).options(selectinload(Quotation.line_items)).where(Quotation.id == quote_id))
    quote = result.unique().scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    return _quote_dict(quote, quote.line_items)

@router.post("/quotations/", status_code=201)
async def create_quotation(data: QuotationCreate, db: AsyncSession = Depends(get_db)):
    """Create a new quotation"""
    # Validate items
    if not data.items or len(data.items) == 0:
        raise HTTPException(400, "Quotation must have at least one item")
    
    for i in data.items:
        if not i.name or i.qty <= 0:
            raise HTTPException(400, "Each item must have name and positive quantity")
    
    # Generate quotation number
    result = await db.execute(select(func.count(Quotation.id)))
    quote_count = result.scalar() or 0
    quote_num = f"QT-{datetime.now().year}-{str(quote_count + 1).zfill(4)}"
    
    # Calculate totals
    subtotal = sum(i.qty * i.price for i in data.items)
    tax_total = sum(i.qty * i.price * (i.tax_rate / 100) for i in data.items)
    total = subtotal + tax_total - data.discount
    
    # Create quotation
    quote = Quotation(
        id=str(uuid.uuid4()),
        number=quote_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name,
        created_by=data.created_by,
        date=data.date or datetime.now().strftime("%Y-%m-%d"),
        valid_until=data.valid_until,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=data.discount,
        total=round(total, 2),
        notes=data.notes,
    )
    
    # Add line items
    for item in data.items:
        line_total = item.qty * item.price + (item.qty * item.price * item.tax_rate / 100) - item.line_discount
        li = QuotationLineItem(
            id=str(uuid.uuid4()),
            quotation_id=quote.id,
            item_id=item.item_id,
            name=item.name,
            qty=item.qty,
            price=item.price,
            tax_rate=item.tax_rate,
            discount=item.line_discount,
            line_total=round(line_total, 2),
        )
        db.add(li)
    
    db.add(quote)
    await db.commit()
    await db.refresh(quote)
    return {"id": quote.id, "number": quote.number, "total": round(total, 2), "status": "draft"}

@router.patch("/quotations/{quote_id}/status")
async def update_quotation_status(quote_id: str, status: str, db: AsyncSession = Depends(get_db)):
    """Update quotation status"""
    result = await db.execute(select(Quotation).where(Quotation.id == quote_id))
    quote = result.scalar_one_or_none()
    if not quote:
        raise HTTPException(404, "Quotation not found")
    quote.status = status
    await db.commit()
    return {"status": quote.status}

# ─── LIST CREDIT PURCHASES ───────────────────────────────────────────────────
@router.get("/credit/purchases")
async def list_credit_purchases(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List all invoices purchased on credit (unpaid)"""
    sk = normalize_skip(skip)
    lim = normalize_limit(limit)
    conds = [SaleInvoice.payment_mode == "credit"]
    q = (
        select(SaleInvoice)
        .options(selectinload(SaleInvoice.line_items))
        .where(SaleInvoice.payment_mode == "credit")
        .order_by(SaleInvoice.created_at.desc())
    )
    total = int((await db.execute(select(func.count(SaleInvoice.id)).where(and_(*conds)))).scalar() or 0)
    result = await db.execute(q.offset(sk).limit(lim))
    invoices = result.unique().scalars().all()
    out = [_inv_dict(inv, inv.line_items) for inv in invoices]
    return paged(out, total, sk, lim)

# ─── GET ONE ──────────────────────────────────────────────────────────────────
@router.get("/{invoice_id}")
async def get_invoice(invoice_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    li_res = await db.execute(select(SaleLineItem).where(SaleLineItem.invoice_id == invoice_id))
    return _inv_dict(inv, li_res.scalars().all())

# ─── CREATE ───────────────────────────────────────────────────────────────────
@router.post("/", status_code=201)
async def create_invoice(data: SaleCreate, db: AsyncSession = Depends(get_db)):
    today = datetime.now().strftime("%Y-%m-%d")
    # Line net (pre-tax) after line_discount (percentage off list line gross)
    line_rows = []
    for i in data.items:
        gross = round(i.qty * i.price, 2)
        line_disc_amt = max(0.0, min(gross, round(i.line_discount_amount or 0, 2)))
        if line_disc_amt > 0:
            line_net = round(gross - line_disc_amt, 2)
        else:
            line_net = round(gross * (1 - i.line_discount / 100), 2)
        line_tax = round(line_net * (i.tax_rate / 100), 2)
        line_rows.append((i, line_net, line_tax))
    subtotal  = sum(r[1] for r in line_rows)
    tax_total = sum(r[2] for r in line_rows)
    total     = round(subtotal + tax_total - data.discount, 2)
    paid      = total if data.payment_mode not in ("credit",) else 0.0
    status    = "paid" if paid >= total else "pending"

    # Sequential-ish number
    count_res = await db.execute(func.count(SaleInvoice.id))
    count = count_res.scalar() or 0
    inv_num = f"INV-{datetime.now().year}-{2000 + count}"

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=data.customer_id,
        customer_name=data.customer_name,
        branch_id=data.branch_id,
        branch_name=data.branch_name or data.branch_id,
        cashier=data.cashier,
        date=data.date or today,
        subtotal=round(subtotal, 2),
        tax_total=round(tax_total, 2),
        discount=round(data.discount, 2),
        total=round(total, 2),
        paid_amount=round(paid, 2),
        payment_mode=data.payment_mode,
        status=status,
        notes=data.notes,
    )
    db.add(inv)

    for item, line_net, _line_tax in line_rows:
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, price=item.price,
            tax_rate=item.tax_rate,
            line_total=line_net,
        )
        db.add(li)
        # Auto-deduct stock
        if item.item_id:
            sq = select(ItemStock).where(and_(
                ItemStock.item_id == item.item_id,
                ItemStock.branch_id == data.branch_id,
            ))
            sr = await db.execute(sq)
            stock = sr.scalar_one_or_none()
            if stock:
                stock.quantity = max(0, stock.quantity - item.qty)

    await db.commit()
    await db.refresh(inv)
    return {"id": inv.id, "number": inv_num, "total": round(total, 2), "status": status}

# ─── PAYMENT ──────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/payment")
async def record_payment(invoice_id: str, data: PaymentIn, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    print(inv.paid_amount)
    inv.paid_amount = min(inv.total, round(inv.paid_amount + data.amount, 2))
    inv.status = "paid" if inv.paid_amount >= inv.total else "partial"
    await db.commit()
    return {
        "status": inv.status,
        "paid_amount": inv.paid_amount,
        "balance": round(inv.total - inv.paid_amount, 2),
    }

# ─── CANCEL ───────────────────────────────────────────────────────────────────
@router.post("/{invoice_id}/cancel")
async def cancel_invoice(invoice_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        raise HTTPException(404, "Invoice not found")
    if inv.status == "paid" and inv.paid_amount > 0:
        raise HTTPException(400, "Cannot cancel a paid invoice. Issue a credit note instead.")
    inv.status = "cancelled"
    await db.commit()
    return {"status": "cancelled"}

# ─── HELPER ───────────────────────────────────────────────────────────────────
def _quote_dict(quote, items=None):
    d = {
        "id": quote.id, "number": quote.number,
        "customerId": quote.customer_id,
        "customerName": quote.customer_name or "Walk-in",
        "branchId": quote.branch_id,
        "branchName": quote.branch_name,
        "createdBy": quote.created_by,
        "date": quote.date,
        "validUntil": quote.valid_until,
        "subtotal": quote.subtotal,
        "taxTotal": quote.tax_total,
        "discount": quote.discount,
        "total": quote.total,
        "status": str(quote.status.value) if hasattr(quote.status, "value") else str(quote.status),
        "notes": quote.notes,
    }
    if items is not None:
        d["items"] = [{
            "id": i.id,
            "name": i.name, "qty": i.qty,
            "price": i.price, "taxRate": i.tax_rate,
            "discount": i.discount, "lineTotal": i.line_total,
        } for i in items]
    return d

def _inv_dict(inv, items=None):
    d = {
        "id": inv.id, "number": inv.number,
        "customerId": inv.customer_id,
        "customerName": inv.customer_name or "Walk-in",
        "branchId": inv.branch_id,
        "branchName": inv.branch_name,
        "cashier": inv.cashier,
        "date": inv.date,
        "subtotal": inv.subtotal,
        "taxTotal": inv.tax_total,
        "discount": inv.discount,
        "total": inv.total,
        "paidAmount": inv.paid_amount,
        "paymentMode": inv.payment_mode,
        "status": str(inv.status.value) if hasattr(inv.status, "value") else str(inv.status),
        "notes": inv.notes,
    }
    if items is not None:
        d["items"] = [{
            "name": i.name, "qty": i.qty,
            "price": i.price, "taxRate": i.tax_rate,
            "lineTotal": i.line_total,
        } for i in items]
    return d

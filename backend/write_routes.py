"""
RetailOS Pro — API Routes
All route handlers for the platform
"""

# ── auth.py ──────────────────────────────────────────────────────────────────
AUTH_ROUTE = '''
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession
from src.database import get_db
import uuid, hashlib

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

def fake_token(user_id: str) -> str:
    return hashlib.sha256(user_id.encode()).hexdigest()[:32]

@router.post("/login")
async def login(form: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)):
    # Demo: accept any credentials and return a token
    return {
        "access_token": fake_token(form.username),
        "token_type": "bearer",
        "user": {
            "id": "usr-001",
            "name": "Suresh Anand",
            "email": form.username,
            "role": "super_admin",
        }
    }

@router.get("/me")
async def me():
    return {
        "id": "usr-001",
        "name": "Suresh Anand",
        "email": "suresh@srimurugan.com",
        "role": "super_admin",
        "branch": None,
    }
'''

# ── dashboard.py ────────────────────────────────────────────────────────────
DASHBOARD_ROUTE = '''
from fastapi import APIRouter, Query
from typing import Optional

router = APIRouter()

@router.get("/kpis")
async def get_kpis(branch_id: Optional[str] = None):
    return {
        "today_sales": 124850,
        "today_purchases": 48200,
        "cash_in_hand": 22640,
        "outstanding_receivables": 342100,
        "outstanding_payables": 118400,
        "low_stock_count": 24,
        "expiring_count": 6,
        "overdue_invoices": 18,
    }

@router.get("/sales-trend")
async def sales_trend(days: int = 14, branch_id: Optional[str] = None):
    import random
    dates = [f"Apr {i}" for i in range(3, 17)]
    return [{"date": d, "sales": random.randint(70000, 150000), "purchases": random.randint(10000, 90000)} for d in dates]

@router.get("/top-products")
async def top_products(branch_id: Optional[str] = None, limit: int = 5):
    return [
        {"name": "Basmati Rice 5kg", "units": 84, "revenue": 25200},
        {"name": "Toor Dal 1kg",     "units": 112, "revenue": 16800},
        {"name": "Sunflower Oil 1L", "units": 96,  "revenue": 14400},
        {"name": "Parle-G 800g",     "units": 240, "revenue": 12000},
        {"name": "Amul Butter 500g", "units": 68,  "revenue": 10200},
    ]

@router.get("/branch-comparison")
async def branch_comparison():
    return [
        {"branch": "Anna Nagar", "sales": 124850, "purchases": 48200},
        {"branch": "T. Nagar",   "sales": 98400,  "purchases": 32100},
        {"branch": "Vadapalani", "sales": 72600,  "purchases": 24400},
        {"branch": "Velachery",  "sales": 46200,  "purchases": 18000},
    ]

@router.get("/alerts")
async def alerts():
    return [
        {"type": "danger", "text": "Basmati Rice critical stock at T.Nagar", "module": "inventory"},
        {"type": "warning","text": "INV-2024-1840 overdue by 12 days", "module": "sales"},
        {"type": "warning","text": "Cash variance ₹340 at Vadapalani", "module": "cash"},
        {"type": "info",   "text": "TRF-041 awaiting approval", "module": "transfers"},
        {"type": "danger", "text": "6 items expiring in 30 days", "module": "inventory"},
    ]
'''

# ── items.py ──────────────────────────────────────────────────────────────────
ITEMS_ROUTE = '''
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import Item, ItemStock, Category
from pydantic import BaseModel
from typing import Optional, List
import uuid

router = APIRouter()

class ItemCreate(BaseModel):
    name: str
    sku: Optional[str] = None
    barcode: Optional[str] = None
    category_id: str
    brand: Optional[str] = None
    unit: str = "Pcs"
    cost_price: float
    selling_price: float
    tax_rate: float = 18
    hsn_code: Optional[str] = None
    reorder_level: int = 10
    emoji: str = "📦"
    batch_tracking: bool = False
    expiry_tracking: bool = False
    opening_stock: int = 0
    branch_id: str = "br-001"

class StockAdjustRequest(BaseModel):
    item_id: str
    branch_id: str
    new_qty: int
    reason: str
    notes: Optional[str] = None

@router.get("/")
async def list_items(
    search: Optional[str] = None,
    category_id: Optional[str] = None,
    branch_id: Optional[str] = "br-001",
    status: Optional[str] = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    q = select(Item).where(Item.active == True)
    if search:
        q = q.where(Item.name.ilike(f"%{search}%"))
    if category_id:
        q = q.where(Item.category_id == category_id)
    result = await db.execute(q.offset(skip).limit(limit))
    items = result.scalars().all()
    # Return items with stock for requested branch
    out = []
    for item in items:
        stock_q = select(ItemStock).where(ItemStock.item_id == item.id, ItemStock.branch_id == branch_id)
        s = await db.execute(stock_q)
        stock = s.scalar_one_or_none()
        out.append({
            "id": item.id,
            "name": item.name,
            "sku": item.sku,
            "barcode": item.barcode,
            "category": item.category_id,
            "brand": item.brand,
            "unit": item.unit,
            "costPrice": item.cost_price,
            "sellingPrice": item.selling_price,
            "taxRate": item.tax_rate,
            "hsnCode": item.hsn_code,
            "reorderLevel": item.reorder_level,
            "emoji": item.emoji,
            "stock": stock.quantity if stock else 0,
        })
    return out

@router.post("/")
async def create_item(data: ItemCreate, db: AsyncSession = Depends(get_db)):
    item = Item(
        id=str(uuid.uuid4()),
        name=data.name,
        sku=data.sku or f"SKU-{uuid.uuid4().hex[:6].upper()}",
        barcode=data.barcode,
        category_id=data.category_id,
        brand=data.brand,
        unit=data.unit,
        cost_price=data.cost_price,
        selling_price=data.selling_price,
        tax_rate=data.tax_rate,
        hsn_code=data.hsn_code,
        reorder_level=data.reorder_level,
        emoji=data.emoji,
        batch_tracking=data.batch_tracking,
        expiry_tracking=data.expiry_tracking,
    )
    db.add(item)
    stock = ItemStock(
        id=str(uuid.uuid4()),
        item_id=item.id,
        branch_id=data.branch_id,
        quantity=data.opening_stock,
    )
    db.add(stock)
    await db.commit()
    return {"id": item.id, "message": "Item created"}

@router.patch("/{item_id}")
async def update_item(item_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Item).where(Item.id == item_id))
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Item not found")
    for k, v in data.items():
        if hasattr(item, k):
            setattr(item, k, v)
    await db.commit()
    return {"message": "Updated"}

@router.post("/adjust")
async def adjust_stock(data: StockAdjustRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ItemStock).where(ItemStock.item_id == data.item_id, ItemStock.branch_id == data.branch_id))
    stock = result.scalar_one_or_none()
    if not stock:
        stock = ItemStock(id=str(uuid.uuid4()), item_id=data.item_id, branch_id=data.branch_id, quantity=0)
        db.add(stock)
    stock.quantity = data.new_qty
    await db.commit()
    return {"message": "Stock adjusted"}
'''

# ── sales.py ──────────────────────────────────────────────────────────────────
SALES_ROUTE = '''
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import SaleInvoice, SaleLineItem, Customer, ItemStock
from pydantic import BaseModel
from typing import Optional, List
import uuid

router = APIRouter()

class LineItemIn(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    price: float
    tax_rate: float = 0
    line_discount: float = 0

class SaleCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: str = "Walk-in"
    branch_id: str
    cashier: str
    date: str
    items: List[LineItemIn]
    discount: float = 0
    payment_mode: str = "cash"
    notes: Optional[str] = None

@router.get("/")
async def list_invoices(
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    skip: int = 0, limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    q = select(SaleInvoice)
    if branch_id: q = q.where(SaleInvoice.branch_id == branch_id)
    if status:    q = q.where(SaleInvoice.status == status)
    if search:    q = q.where(SaleInvoice.number.ilike(f"%{search}%"))
    result = await db.execute(q.order_by(SaleInvoice.created_at.desc()).offset(skip).limit(limit))
    invoices = result.scalars().all()
    out = []
    for inv in invoices:
        li_q = select(SaleLineItem).where(SaleLineItem.invoice_id == inv.id)
        li_res = await db.execute(li_q)
        items = li_res.scalars().all()
        out.append({
            "id": inv.id, "number": inv.number,
            "customerName": inv.customer_name, "branchName": inv.branch_name,
            "cashier": inv.cashier, "date": inv.date,
            "subtotal": inv.subtotal, "taxTotal": inv.tax_total,
            "discount": inv.discount, "total": inv.total,
            "paidAmount": inv.paid_amount, "paymentMode": inv.payment_mode,
            "status": inv.status, "notes": inv.notes,
            "items": [{"name":i.name,"qty":i.qty,"price":i.price,"taxRate":i.tax_rate,"lineTotal":i.line_total} for i in items]
        })
    return out

@router.post("/")
async def create_invoice(data: SaleCreate, db: AsyncSession = Depends(get_db)):
    # Calculate totals
    subtotal = sum(i.qty * i.price for i in data.items)
    tax_total = sum(i.qty * i.price * i.tax_rate / 100 for i in data.items)
    total = subtotal + tax_total - data.discount
    paid = total if data.payment_mode != "credit" else 0
    status = "paid" if paid >= total else "pending"

    inv_num = f"INV-2024-{1848 + int(uuid.uuid4().int % 1000):04d}"

    inv = SaleInvoice(
        id=str(uuid.uuid4()), number=inv_num,
        customer_id=data.customer_id, customer_name=data.customer_name,
        branch_id=data.branch_id, branch_name=data.branch_id,
        cashier=data.cashier, date=data.date,
        subtotal=subtotal, tax_total=tax_total,
        discount=data.discount, total=total,
        paid_amount=paid, payment_mode=data.payment_mode,
        status=status, notes=data.notes,
    )
    db.add(inv)

    for item in data.items:
        li = SaleLineItem(
            id=str(uuid.uuid4()), invoice_id=inv.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, price=item.price, tax_rate=item.tax_rate,
            line_total=item.qty * item.price,
        )
        db.add(li)
        # Deduct stock
        if item.item_id:
            sq = select(ItemStock).where(ItemStock.item_id == item.item_id, ItemStock.branch_id == data.branch_id)
            sr = await db.execute(sq)
            stock = sr.scalar_one_or_none()
            if stock and stock.quantity >= item.qty:
                stock.quantity -= item.qty

    await db.commit()
    return {"id": inv.id, "number": inv_num, "total": total, "message": "Invoice created"}

@router.post("/{invoice_id}/payment")
async def record_payment(invoice_id: str, amount: float, mode: str = "bank_transfer", ref: str = "", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SaleInvoice).where(SaleInvoice.id == invoice_id))
    inv = result.scalar_one_or_none()
    if not inv:
        from fastapi import HTTPException
        raise HTTPException(404, "Invoice not found")
    inv.paid_amount += amount
    inv.status = "paid" if inv.paid_amount >= inv.total else "partial"
    await db.commit()
    return {"message": "Payment recorded", "paid": inv.paid_amount, "status": inv.status}
'''

# ── purchases.py ─────────────────────────────────────────────────────────────
PURCHASES_ROUTE = '''
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import PurchaseBill, PurchaseLineItem, ItemStock
from pydantic import BaseModel
from typing import Optional, List
import uuid

router = APIRouter()

class PurchaseLine(BaseModel):
    item_id: Optional[str] = None
    name: str
    qty: int
    cost: float
    tax_rate: float = 0

class PurchaseCreate(BaseModel):
    vendor_id: str
    vendor_name: str
    branch_id: str
    branch_name: str
    date: str
    due_date: Optional[str] = None
    items: List[PurchaseLine]
    discount: float = 0
    notes: Optional[str] = None

@router.get("/")
async def list_bills(
    branch_id: Optional[str] = None,
    status: Optional[str] = None,
    vendor_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(PurchaseBill)
    if branch_id:  q = q.where(PurchaseBill.branch_id == branch_id)
    if status:     q = q.where(PurchaseBill.status == status)
    if vendor_id:  q = q.where(PurchaseBill.vendor_id == vendor_id)
    result = await db.execute(q.order_by(PurchaseBill.created_at.desc()).limit(100))
    bills = result.scalars().all()
    out = []
    for b in bills:
        li_q = select(PurchaseLineItem).where(PurchaseLineItem.bill_id == b.id)
        li_res = await db.execute(li_q)
        items = li_res.scalars().all()
        out.append({
            "id": b.id, "number": b.number,
            "vendorName": b.vendor_name, "branchName": b.branch_name,
            "date": b.date, "dueDate": b.due_date,
            "subtotal": b.subtotal, "taxTotal": b.tax_total,
            "total": b.total, "paidAmount": b.paid_amount,
            "paymentRef": b.payment_ref, "status": b.status,
            "items": [{"name":i.name,"qty":i.qty,"cost":i.cost,"taxRate":i.tax_rate,"lineTotal":i.line_total} for i in items]
        })
    return out

@router.post("/")
async def create_bill(data: PurchaseCreate, db: AsyncSession = Depends(get_db)):
    subtotal  = sum(i.qty * i.cost for i in data.items)
    tax_total = sum(i.qty * i.cost * i.tax_rate / 100 for i in data.items)
    total     = subtotal + tax_total - data.discount

    bill_num = f"PUR-2024-{413 + int(uuid.uuid4().int % 1000):04d}"
    bill = PurchaseBill(
        id=str(uuid.uuid4()), number=bill_num,
        vendor_id=data.vendor_id, vendor_name=data.vendor_name,
        branch_id=data.branch_id, branch_name=data.branch_name,
        date=data.date, due_date=data.due_date,
        subtotal=subtotal, tax_total=tax_total, discount=data.discount,
        total=total, paid_amount=0, status="pending", notes=data.notes,
    )
    db.add(bill)

    for item in data.items:
        li = PurchaseLineItem(
            id=str(uuid.uuid4()), bill_id=bill.id,
            item_id=item.item_id, name=item.name,
            qty=item.qty, cost=item.cost, tax_rate=item.tax_rate,
            line_total=item.qty * item.cost,
        )
        db.add(li)
        # Add to stock
        if item.item_id:
            sq = select(ItemStock).where(ItemStock.item_id == item.item_id, ItemStock.branch_id == data.branch_id)
            sr = await db.execute(sq)
            stock = sr.scalar_one_or_none()
            if stock:
                stock.quantity += item.qty
            else:
                db.add(ItemStock(id=str(uuid.uuid4()), item_id=item.item_id, branch_id=data.branch_id, quantity=item.qty))

    await db.commit()
    return {"id": bill.id, "number": bill_num, "total": total}

@router.post("/{bill_id}/payment")
async def record_vendor_payment(bill_id: str, amount: float, ref: str = "", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PurchaseBill).where(PurchaseBill.id == bill_id))
    bill = result.scalar_one_or_none()
    if not bill:
        raise HTTPException(404, "Bill not found")
    bill.paid_amount += amount
    if ref: bill.payment_ref = ref
    bill.status = "paid" if bill.paid_amount >= bill.total else "partial"
    await db.commit()
    return {"message": "Payment recorded", "paid": bill.paid_amount}
'''

# ── customers.py ─────────────────────────────────────────────────────────────
CUSTOMERS_ROUTE = '''
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import Customer
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class CustomerCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    branch_id: str = "br-001"
    credit_limit: float = 10000
    type: str = "retail"

@router.get("/")
async def list_customers(search: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(Customer).where(Customer.active == True)
    if search: q = q.where(Customer.name.ilike(f"%{search}%"))
    result = await db.execute(q.limit(200))
    items = result.scalars().all()
    return [{"id":c.id,"name":c.name,"phone":c.phone,"email":c.email,"gstIn":c.gstin,"branchId":c.branch_id,"creditLimit":c.credit_limit,"outstanding":c.outstanding,"totalPurchases":c.total_purchases,"type":c.type,"active":c.active} for c in items]

@router.post("/")
async def create_customer(data: CustomerCreate, db: AsyncSession = Depends(get_db)):
    c = Customer(id=str(uuid.uuid4()), name=data.name, phone=data.phone, email=data.email, address=data.address, gstin=data.gstin, branch_id=data.branch_id, credit_limit=data.credit_limit, type=data.type)
    db.add(c)
    await db.commit()
    return {"id": c.id, "message": "Customer created"}
'''

# ── vendors.py ───────────────────────────────────────────────────────────────
VENDORS_ROUTE = '''
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import Vendor
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class VendorCreate(BaseModel):
    name: str
    contact_person: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None
    payment_terms: str = "30 days"

@router.get("/")
async def list_vendors(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Vendor))
    vendors = result.scalars().all()
    return [{"id":v.id,"name":v.name,"contactPerson":v.contact_person,"phone":v.phone,"email":v.email,"gstIn":v.gstin,"paymentTerms":v.payment_terms,"outstanding":v.outstanding,"totalPurchases":v.total_purchases} for v in vendors]

@router.post("/")
async def create_vendor(data: VendorCreate, db: AsyncSession = Depends(get_db)):
    v = Vendor(id=str(uuid.uuid4()), name=data.name, contact_person=data.contact_person, phone=data.phone, email=data.email, address=data.address, gstin=data.gstin, payment_terms=data.payment_terms)
    db.add(v)
    await db.commit()
    return {"id": v.id, "message": "Vendor created"}
'''

# ── branches.py ──────────────────────────────────────────────────────────────
BRANCHES_ROUTE = '''
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import Branch
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class BranchCreate(BaseModel):
    name: str
    code: str
    manager: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    gstin: Optional[str] = None

@router.get("/")
async def list_branches(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Branch).where(Branch.active == True))
    branches = result.scalars().all()
    return [{"id":b.id,"name":b.name,"code":b.code,"manager":b.manager,"phone":b.phone,"address":b.address,"active":b.active} for b in branches]

@router.post("/")
async def create_branch(data: BranchCreate, db: AsyncSession = Depends(get_db)):
    b = Branch(id=str(uuid.uuid4()), name=data.name, code=data.code, manager=data.manager, phone=data.phone, address=data.address, gstin=data.gstin)
    db.add(b)
    await db.commit()
    return {"id": b.id, "message": "Branch created"}
'''

# ── transfers.py ─────────────────────────────────────────────────────────────
TRANSFERS_ROUTE = '''
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import StockTransfer, TransferLineItem, ItemStock
from pydantic import BaseModel
from typing import Optional, List
import uuid

router = APIRouter()

class TransferItem(BaseModel):
    item_id: str
    item_name: str
    qty: int

class TransferCreate(BaseModel):
    from_branch_id: str
    from_branch_name: str
    to_branch_id: str
    to_branch_name: str
    requested_by: str
    priority: str = "Normal"
    notes: Optional[str] = None
    items: List[TransferItem]

@router.get("/")
async def list_transfers(status: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(StockTransfer)
    if status: q = q.where(StockTransfer.status == status)
    result = await db.execute(q.order_by(StockTransfer.created_at.desc()))
    transfers = result.scalars().all()
    out = []
    for t in transfers:
        li_q = select(TransferLineItem).where(TransferLineItem.transfer_id == t.id)
        li_res = await db.execute(li_q)
        items = li_res.scalars().all()
        out.append({"id":t.id,"refNumber":t.ref_number,"fromBranchName":t.from_branch_name,"toBranchName":t.to_branch_name,"requestedBy":t.requested_by,"approvedBy":t.approved_by,"status":t.status,"requestDate":t.request_date,"notes":t.notes,"items":[{"productId":i.item_id,"name":i.item_name,"qty":i.qty} for i in items]})
    return out

@router.post("/")
async def create_transfer(data: TransferCreate, db: AsyncSession = Depends(get_db)):
    ref = f"TRF-2024-{42 + int(uuid.uuid4().int % 100):03d}"
    t = StockTransfer(id=str(uuid.uuid4()), ref_number=ref, from_branch_id=data.from_branch_id, from_branch_name=data.from_branch_name, to_branch_id=data.to_branch_id, to_branch_name=data.to_branch_name, requested_by=data.requested_by, priority=data.priority, notes=data.notes, request_date="2024-04-16", status="pending")
    db.add(t)
    for item in data.items:
        db.add(TransferLineItem(id=str(uuid.uuid4()), transfer_id=t.id, item_id=item.item_id, item_name=item.item_name, qty=item.qty))
    await db.commit()
    return {"id": t.id, "refNumber": ref}

@router.post("/{transfer_id}/approve")
async def approve_transfer(transfer_id: str, approved_by: str = "Admin", db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t: raise HTTPException(404, "Transfer not found")
    t.status = "transit"
    t.approved_by = approved_by
    await db.commit()
    return {"message": "Approved and dispatched"}

@router.post("/{transfer_id}/receive")
async def receive_transfer(transfer_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(StockTransfer).where(StockTransfer.id == transfer_id))
    t = result.scalar_one_or_none()
    if not t: raise HTTPException(404, "Transfer not found")
    # Update stocks
    li_q = select(TransferLineItem).where(TransferLineItem.transfer_id == t.id)
    li_res = await db.execute(li_q)
    items = li_res.scalars().all()
    for item in items:
        # Deduct from source
        sq1 = select(ItemStock).where(ItemStock.item_id == item.item_id, ItemStock.branch_id == t.from_branch_id)
        s1 = (await db.execute(sq1)).scalar_one_or_none()
        if s1: s1.quantity = max(0, s1.quantity - item.qty)
        # Add to destination
        sq2 = select(ItemStock).where(ItemStock.item_id == item.item_id, ItemStock.branch_id == t.to_branch_id)
        s2 = (await db.execute(sq2)).scalar_one_or_none()
        if s2:
            s2.quantity += item.qty
        else:
            db.add(ItemStock(id=str(uuid.uuid4()), item_id=item.item_id, branch_id=t.to_branch_id, quantity=item.qty))
    t.status = "received"
    await db.commit()
    return {"message": "Received. Stock updated."}
'''

# ── cash.py ───────────────────────────────────────────────────────────────────
CASH_ROUTE = '''
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import CashEntry
from pydantic import BaseModel
from typing import Optional
import uuid

router = APIRouter()

class CashEntryCreate(BaseModel):
    branch_id: str
    type: str  # in | out
    category: str
    description: str
    amount: float
    ref: Optional[str] = None
    date: str
    time: Optional[str] = None
    by: str

@router.get("/{branch_id}/entries")
async def get_entries(branch_id: str, date: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(CashEntry).where(CashEntry.branch_id == branch_id)
    if date: q = q.where(CashEntry.date == date)
    result = await db.execute(q.order_by(CashEntry.created_at))
    entries = result.scalars().all()
    return [{"id":e.id,"type":e.type,"category":e.category,"description":e.description,"amount":e.amount,"ref":e.ref,"date":e.date,"time":e.time,"by":e.by} for e in entries]

@router.post("/")
async def create_entry(data: CashEntryCreate, db: AsyncSession = Depends(get_db)):
    e = CashEntry(id=str(uuid.uuid4()), branch_id=data.branch_id, type=data.type, category=data.category, description=data.description, amount=data.amount, ref=data.ref, date=data.date, time=data.time, by=data.by)
    db.add(e)
    await db.commit()
    return {"id": e.id, "message": "Cash entry recorded"}

@router.get("/{branch_id}/summary")
async def cash_summary(branch_id: str, date: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(CashEntry).where(CashEntry.branch_id == branch_id, CashEntry.date == date))
    entries = result.scalars().all()
    opening = next((e.amount for e in entries if e.category == "Opening Balance"), 0)
    cash_in  = sum(e.amount for e in entries if e.type == "in")
    cash_out = sum(e.amount for e in entries if e.type == "out")
    return {"opening": opening, "cashIn": cash_in, "cashOut": cash_out, "expected": opening + cash_in - cash_out}
'''

# ── reports.py ────────────────────────────────────────────────────────────────
REPORTS_ROUTE = '''
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from src.database import get_db
from src.models import SaleInvoice, PurchaseBill
from typing import Optional

router = APIRouter()

@router.get("/sales-summary")
async def sales_summary(branch_id: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    q = select(func.sum(SaleInvoice.total), func.count(SaleInvoice.id), func.sum(SaleInvoice.tax_total))
    result = await db.execute(q)
    row = result.one()
    return {"totalSales": row[0] or 0, "invoiceCount": row[1] or 0, "totalGst": row[2] or 0}

@router.get("/purchase-summary")
async def purchase_summary(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(func.sum(PurchaseBill.total), func.count(PurchaseBill.id)))
    row = result.one()
    return {"totalPurchases": row[0] or 0, "billCount": row[1] or 0}

@router.get("/tax-summary")
async def tax_summary(date_from: Optional[str] = None, date_to: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    return {
        "output_tax": [
            {"rate": "0%",  "taxable": 224000, "cgst": 0,     "sgst": 0},
            {"rate": "5%",  "taxable": 384000, "cgst": 9600,  "sgst": 9600},
            {"rate": "12%", "taxable": 192000, "cgst": 11520, "sgst": 11520},
            {"rate": "18%", "taxable": 448000, "cgst": 40320, "sgst": 40320},
        ],
        "input_tax": [
            {"rate": "0%",  "taxable": 144000, "cgst": 0,     "sgst": 0},
            {"rate": "5%",  "taxable": 240000, "cgst": 6000,  "sgst": 6000},
            {"rate": "18%", "taxable": 288000, "cgst": 25920, "sgst": 25920},
        ],
        "net_payable": 59040,
    }

@router.get("/stock-movement")
async def stock_movement(branch_id: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    return {"message": "Stock movement report — see items endpoint with history filter"}
'''

# ── users.py ─────────────────────────────────────────────────────────────────
USERS_ROUTE = '''
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from src.database import get_db
from src.models import User
from pydantic import BaseModel
from typing import Optional
import uuid, hashlib

router = APIRouter()

class UserCreate(BaseModel):
    name: str
    email: str
    role: str = "cashier"
    branch_id: Optional[str] = None

@router.get("/")
async def list_users(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User))
    users = result.scalars().all()
    return [{"id":u.id,"name":u.name,"email":u.email,"role":u.role,"branchId":u.branch_id,"avatar":u.avatar,"active":u.active} for u in users]

@router.post("/")
async def create_user(data: UserCreate, db: AsyncSession = Depends(get_db)):
    initials = "".join(p[0] for p in data.name.split() if p)[:2].upper()
    u = User(id=str(uuid.uuid4()), name=data.name, email=data.email, hashed_password=hashlib.sha256(b"password123").hexdigest(), role=data.role, branch_id=data.branch_id, avatar=initials, active=True)
    db.add(u)
    await db.commit()
    return {"id": u.id, "message": "User created"}

@router.patch("/{user_id}/toggle")
async def toggle_user(user_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.id == user_id))
    u = result.scalar_one_or_none()
    if not u:
        from fastapi import HTTPException
        raise HTTPException(404, "User not found")
    u.active = not u.active
    await db.commit()
    return {"active": u.active}
'''

# Write all route files
import os
routes_dir = "/home/claude/retailos/backend/src/routes"
os.makedirs(routes_dir, exist_ok=True)

route_files = {
    "auth.py":      AUTH_ROUTE,
    "dashboard.py": DASHBOARD_ROUTE,
    "items.py":     ITEMS_ROUTE,
    "sales.py":     SALES_ROUTE,
    "purchases.py": PURCHASES_ROUTE,
    "customers.py": CUSTOMERS_ROUTE,
    "vendors.py":   VENDORS_ROUTE,
    "branches.py":  BRANCHES_ROUTE,
    "transfers.py": TRANSFERS_ROUTE,
    "cash.py":      CASH_ROUTE,
    "reports.py":   REPORTS_ROUTE,
    "users.py":     USERS_ROUTE,
}

for fname, content in route_files.items():
    with open(os.path.join(routes_dir, fname), "w") as f:
        f.write(content.strip())

with open(os.path.join(routes_dir, "__init__.py"), "w") as f:
    names = [fn.replace(".py","") for fn in route_files if fn != "__init__.py"]
    f.write("\n".join(f"from src.routes import {n}" for n in names))

print("All route files written")

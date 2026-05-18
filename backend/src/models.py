"""
Cosmopolitan Pro — Database Models
All ORM models for the retail platform
"""
import enum
from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import relationship

from src.database import Base


# ─── Enums ────────────────────────────────────────────────────────────────────
class UserRole(str, enum.Enum):
    super_admin       = "super_admin"
    branch_manager    = "branch_manager"
    cashier           = "cashier"
    inventory_manager = "inventory_manager"
    finance           = "finance"
    purchase_admin    = "purchase_admin"

class InvoiceStatus(str, enum.Enum):
    draft   = "draft"
    paid    = "paid"
    pending = "pending"
    partial = "partial"
    overdue = "overdue"
    cancelled = "cancelled"

class TransferStatus(str, enum.Enum):
    pending  = "pending"
    approved = "approved"
    transit  = "transit"
    received = "received"
    rejected = "rejected"

class QuotationStatus(str, enum.Enum):
    draft    = "draft"
    sent     = "sent"
    accepted = "accepted"
    rejected = "rejected"
    converted = "converted"
    expired  = "expired"


# ─── Organisation ─────────────────────────────────────────────────────────────
class Organisation(Base):
    __tablename__ = "organisations"
    id            = Column(String, primary_key=True)
    name          = Column(String, nullable=False)
    gstin         = Column(String)
    pan           = Column(String)
    address       = Column(Text)
    phone         = Column(String)
    email         = Column(String)
    website       = Column(String)
    state_code    = Column(String, default="33")
    financial_year= Column(String, default="Apr-Mar")
    logo_url      = Column(String)
    created_at    = Column(DateTime, default=datetime.utcnow)


# ─── Branch ───────────────────────────────────────────────────────────────────
class Branch(Base):
    __tablename__ = "branches"
    id         = Column(String, primary_key=True)
    name       = Column(String, nullable=False)
    code       = Column(String, nullable=False, unique=True)
    manager    = Column(String)
    phone      = Column(String)
    address    = Column(Text)
    gstin      = Column(String)
    active     = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    stock      = relationship("ItemStock", back_populates="branch")
    cash_entries = relationship("CashEntry", back_populates="branch")


# ─── Role ─────────────────────────────────────────────────────────────────────
# See docs/USERS_AND_ROLES.md §5.1. `permissions` is a JSON list of strings
# from src.permissions.PERMISSIONS catalog (D1) — wildcards `*` and
# `module.*` are allowed and expanded at check time.
class Role(Base):
    __tablename__ = "roles"
    id          = Column(String, primary_key=True)
    key         = Column(String, unique=True, nullable=False)
    label       = Column(String, nullable=False)
    description = Column(Text, default="")
    color       = Column(String, default="blue")
    permissions = Column(JSON, default=list)
    is_system   = Column(Boolean, default=False)
    active      = Column(Boolean, default=True)
    created_at  = Column(DateTime, default=datetime.utcnow)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ─── User ─────────────────────────────────────────────────────────────────────
class User(Base):
    __tablename__ = "users"
    id           = Column(String, primary_key=True)
    name         = Column(String, nullable=False)
    email        = Column(String, nullable=False, unique=True)
    hashed_password = Column(String, nullable=False)
    # Legacy denormalised role enum — kept as a read-cache for one release cycle
    # (frontend and seed.py still write/read it). New code should resolve via
    # `role_id` → `roles` table. Drop in Phase 3 (first Alembic migration).
    role         = Column(SAEnum(UserRole), default=UserRole.cashier)
    role_id      = Column(String, ForeignKey("roles.id"), nullable=True)
    branch_id    = Column(String, ForeignKey("branches.id"), nullable=True)
    avatar       = Column(String)
    active       = Column(Boolean, default=True)
    last_login   = Column(DateTime)
    created_at   = Column(DateTime, default=datetime.utcnow)


# ─── Category ─────────────────────────────────────────────────────────────────
class Category(Base):
    __tablename__ = "categories"
    id    = Column(String, primary_key=True)
    name  = Column(String, nullable=False)
    icon  = Column(String, default="📦")
    items = relationship("Item", back_populates="category")


# ─── Item (Product) ───────────────────────────────────────────────────────────
class Item(Base):
    __tablename__ = "items"
    id              = Column(String, primary_key=True)
    name            = Column(String, nullable=False)
    sku             = Column(String, unique=True)
    barcode         = Column(String)
    category_id     = Column(String, ForeignKey("categories.id"))
    brand           = Column(String)
    unit            = Column(String, default="Pcs")
    cost_price      = Column(Float, default=0)
    selling_price   = Column(Float, default=0)
    tax_rate        = Column(Float, default=18)
    hsn_code        = Column(String)
    reorder_level   = Column(Integer, default=10)
    emoji           = Column(String, default="📦")
    batch_tracking  = Column(Boolean, default=False)
    expiry_tracking = Column(Boolean, default=False)
    active          = Column(Boolean, default=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    category  = relationship("Category", back_populates="items")
    stock     = relationship("ItemStock", back_populates="item")
    sale_lines = relationship("SaleLineItem", back_populates="item")
    purchase_lines = relationship("PurchaseLineItem", back_populates="item")
    quotation_lines = relationship("QuotationLineItem", back_populates="item")


# ─── Item Stock (per branch) ──────────────────────────────────────────────────
class ItemStock(Base):
    __tablename__ = "item_stock"
    id         = Column(String, primary_key=True)
    item_id    = Column(String, ForeignKey("items.id"), nullable=False)
    branch_id  = Column(String, ForeignKey("branches.id"), nullable=False)
    quantity   = Column(Integer, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    item   = relationship("Item", back_populates="stock")
    branch = relationship("Branch", back_populates="stock")


# ─── Customer ─────────────────────────────────────────────────────────────────
class Customer(Base):
    __tablename__ = "customers"
    id              = Column(String, primary_key=True)
    name            = Column(String, nullable=False)
    phone           = Column(String)
    email           = Column(String)
    address         = Column(Text)
    gstin           = Column(String)
    branch_id       = Column(String, ForeignKey("branches.id"))
    credit_limit    = Column(Float, default=0)
    outstanding     = Column(Float, default=0)
    total_purchases = Column(Float, default=0)
    type            = Column(String, default="retail")  # retail | wholesale
    active          = Column(Boolean, default=True)
    notes           = Column(Text)
    created_at      = Column(DateTime, default=datetime.utcnow)

    invoices = relationship("SaleInvoice", back_populates="customer")
    quotations = relationship("Quotation", back_populates="customer")


# ─── Vendor ───────────────────────────────────────────────────────────────────
class Vendor(Base):
    __tablename__ = "vendors"
    id               = Column(String, primary_key=True)
    name             = Column(String, nullable=False)
    contact_person   = Column(String)
    phone            = Column(String)
    email            = Column(String)
    address          = Column(Text)
    gstin            = Column(String)
    payment_terms    = Column(String, default="30 days")
    outstanding      = Column(Float, default=0)
    total_purchases  = Column(Float, default=0)
    active           = Column(Boolean, default=True)
    created_at       = Column(DateTime, default=datetime.utcnow)

    bills = relationship("PurchaseBill", back_populates="vendor")
    returns = relationship("VendorReturn", back_populates="vendor")


# ─── Sale Invoice ─────────────────────────────────────────────────────────────
class SaleInvoice(Base):
    __tablename__ = "sale_invoices"
    id            = Column(String, primary_key=True)
    number        = Column(String, unique=True, nullable=False)
    customer_id   = Column(String, ForeignKey("customers.id"), nullable=True)
    customer_name = Column(String, default="Walk-in")
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name   = Column(String)
    cashier       = Column(String)
    date          = Column(String, nullable=False)
    subtotal      = Column(Float, default=0)
    tax_total     = Column(Float, default=0)
    discount      = Column(Float, default=0)
    total         = Column(Float, default=0)
    paid_amount   = Column(Float, default=0)
    payment_mode  = Column(String, default="cash")
    status        = Column(SAEnum(InvoiceStatus), default=InvoiceStatus.paid)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    customer  = relationship("Customer", back_populates="invoices")
    line_items = relationship("SaleLineItem", back_populates="invoice", cascade="all, delete-orphan")


class SaleLineItem(Base):
    __tablename__ = "sale_line_items"
    id         = Column(String, primary_key=True)
    invoice_id = Column(String, ForeignKey("sale_invoices.id"), nullable=False)
    item_id    = Column(String, ForeignKey("items.id"), nullable=True)
    name       = Column(String, nullable=False)
    qty        = Column(Integer, default=1)
    price      = Column(Float, default=0)
    tax_rate   = Column(Float, default=0)
    discount   = Column(Float, default=0)
    line_total = Column(Float, default=0)

    invoice = relationship("SaleInvoice", back_populates="line_items")
    item    = relationship("Item", back_populates="sale_lines")


# ─── Quotation ────────────────────────────────────────────────────────────────
class Quotation(Base):
    __tablename__ = "quotations"
    id            = Column(String, primary_key=True)
    number        = Column(String, unique=True, nullable=False)
    customer_id   = Column(String, ForeignKey("customers.id"), nullable=True)
    customer_name = Column(String, default="Walk-in")
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name   = Column(String)
    created_by    = Column(String)
    date          = Column(String, nullable=False)
    valid_until   = Column(String)
    subtotal      = Column(Float, default=0)
    tax_total     = Column(Float, default=0)
    discount      = Column(Float, default=0)
    total         = Column(Float, default=0)
    status        = Column(SAEnum(QuotationStatus), default=QuotationStatus.draft)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    customer   = relationship("Customer", back_populates="quotations")
    line_items = relationship("QuotationLineItem", back_populates="quotation", cascade="all, delete-orphan")


class QuotationLineItem(Base):
    __tablename__ = "quotation_line_items"
    id            = Column(String, primary_key=True)
    quotation_id  = Column(String, ForeignKey("quotations.id"), nullable=False)
    item_id       = Column(String, ForeignKey("items.id"), nullable=True)
    name          = Column(String, nullable=False)
    qty           = Column(Integer, default=1)
    price         = Column(Float, default=0)
    tax_rate      = Column(Float, default=0)
    discount      = Column(Float, default=0)
    line_total    = Column(Float, default=0)

    quotation = relationship("Quotation", back_populates="line_items")
    item      = relationship("Item", back_populates="quotation_lines")


# ─── Purchase Bill ────────────────────────────────────────────────────────────
class PurchaseBill(Base):
    __tablename__ = "purchase_bills"
    id            = Column(String, primary_key=True)
    number        = Column(String, unique=True, nullable=False)
    vendor_id     = Column(String, ForeignKey("vendors.id"), nullable=False)
    vendor_name   = Column(String)
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name   = Column(String)
    date          = Column(String, nullable=False)
    due_date      = Column(String)
    subtotal      = Column(Float, default=0)
    tax_total     = Column(Float, default=0)
    discount      = Column(Float, default=0)
    total         = Column(Float, default=0)
    paid_amount   = Column(Float, default=0)
    payment_ref   = Column(String)
    status        = Column(SAEnum(InvoiceStatus), default=InvoiceStatus.pending)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    vendor     = relationship("Vendor", back_populates="bills")
    line_items = relationship("PurchaseLineItem", back_populates="bill", cascade="all, delete-orphan")


class PurchaseLineItem(Base):
    __tablename__ = "purchase_line_items"
    id         = Column(String, primary_key=True)
    bill_id    = Column(String, ForeignKey("purchase_bills.id"), nullable=False)
    item_id    = Column(String, ForeignKey("items.id"), nullable=True)
    name       = Column(String, nullable=False)
    qty        = Column(Integer, default=1)
    cost       = Column(Float, default=0)
    tax_rate   = Column(Float, default=0)
    line_total = Column(Float, default=0)

    bill = relationship("PurchaseBill", back_populates="line_items")
    item = relationship("Item", back_populates="purchase_lines")


# ─── Vendor Returns ────────────────────────────────────────────────────────────
class VendorReturn(Base):
    __tablename__ = "vendor_returns"
    id            = Column(String, primary_key=True)
    number        = Column(String, unique=True, nullable=False)
    bill_id       = Column(String, ForeignKey("purchase_bills.id"), nullable=False)
    bill_number   = Column(String)
    vendor_id     = Column(String, ForeignKey("vendors.id"), nullable=False)
    vendor_name   = Column(String)
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name   = Column(String)
    date          = Column(String, nullable=False)
    reason        = Column(String)  # Defective, Overstocked, Wrong Item, Quality Issue, etc.
    subtotal      = Column(Float, default=0)
    tax_total     = Column(Float, default=0)
    total         = Column(Float, default=0)
    credited_amount = Column(Float, default=0)
    status        = Column(SAEnum(InvoiceStatus), default=InvoiceStatus.pending)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    vendor    = relationship("Vendor", back_populates="returns")
    bill      = relationship("PurchaseBill")
    line_items = relationship("ReturnLineItem", back_populates="return_note", cascade="all, delete-orphan")


class ReturnLineItem(Base):
    __tablename__ = "return_line_items"
    id            = Column(String, primary_key=True)
    return_id     = Column(String, ForeignKey("vendor_returns.id"), nullable=False)
    item_id       = Column(String, ForeignKey("items.id"), nullable=True)
    name          = Column(String, nullable=False)
    original_qty  = Column(Integer)  # Qty from original purchase
    return_qty    = Column(Integer, default=1)
    cost          = Column(Float, default=0)
    tax_rate      = Column(Float, default=0)
    line_total    = Column(Float, default=0)

    return_note = relationship("VendorReturn", back_populates="line_items")
    item = relationship("Item")


# ─── Stock Transfer ───────────────────────────────────────────────────────────
class StockTransfer(Base):
    __tablename__ = "stock_transfers"
    id               = Column(String, primary_key=True)
    ref_number       = Column(String, unique=True, nullable=False)
    from_branch_id   = Column(String, ForeignKey("branches.id"), nullable=False)
    from_branch_name = Column(String)
    to_branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    to_branch_name   = Column(String)
    requested_by     = Column(String)
    approved_by      = Column(String)
    status           = Column(SAEnum(TransferStatus), default=TransferStatus.pending)
    priority         = Column(String, default="Normal")
    notes            = Column(Text)
    request_date     = Column(String)
    created_at       = Column(DateTime, default=datetime.utcnow)

    items = relationship("TransferLineItem", back_populates="transfer", cascade="all, delete-orphan")


class TransferLineItem(Base):
    __tablename__ = "transfer_line_items"
    id          = Column(String, primary_key=True)
    transfer_id = Column(String, ForeignKey("stock_transfers.id"), nullable=False)
    item_id     = Column(String, ForeignKey("items.id"), nullable=False)
    item_name   = Column(String)
    qty         = Column(Integer, default=0)

    transfer = relationship("StockTransfer", back_populates="items")


# ─── Cash Entry ───────────────────────────────────────────────────────────────
class CashEntry(Base):
    __tablename__ = "cash_entries"
    id          = Column(String, primary_key=True)
    branch_id   = Column(String, ForeignKey("branches.id"), nullable=False)
    type        = Column(String, nullable=False)  # in | out
    category    = Column(String)
    description = Column(String, nullable=False)
    amount      = Column(Float, nullable=False)
    ref         = Column(String)
    date        = Column(String, nullable=False)
    time        = Column(String)
    by          = Column(String)
    created_at  = Column(DateTime, default=datetime.utcnow)

    branch = relationship("Branch", back_populates="cash_entries")


# ─── Stock Adjustment ─────────────────────────────────────────────────────────
class StockAdjustment(Base):
    __tablename__ = "stock_adjustments"
    id            = Column(String, primary_key=True)
    item_id       = Column(String, ForeignKey("items.id"), nullable=False)
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    before_qty    = Column(Integer)
    after_qty     = Column(Integer)
    reason        = Column(String)
    notes         = Column(Text)
    adjusted_by   = Column(String)
    created_at    = Column(DateTime, default=datetime.utcnow)


# ─── Audit Log ────────────────────────────────────────────────────────────────
class AuditLog(Base):
    __tablename__ = "audit_logs"
    id         = Column(String, primary_key=True)
    action     = Column(String, nullable=False)
    user_id    = Column(String)
    user_name  = Column(String)
    module     = Column(String)
    ref        = Column(String)
    detail     = Column(Text)
    risk       = Column(String, default="low")  # low | medium | high
    ip_address = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

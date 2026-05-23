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
    # Legacy single-branch FK. Pre-multi-branch this was THE branch the user
    # belonged to; it's now mirrored from `user_branches[0]` purely so older
    # code that reads `user.branch_id` keeps working until those reads are
    # migrated. There is NO user-facing "primary branch" concept — the
    # authoritative list is `user_branches` (see UserBranch below) and any
    # ordering inside it is incidental. When `all_branches=True` this column
    # is null and user_branches is empty (the user has access to every
    # branch — the super-admin pattern). See docs/USERS_AND_ROLES.md §5.2.
    branch_id    = Column(String, ForeignKey("branches.id"), nullable=True)
    avatar       = Column(String)
    active       = Column(Boolean, default=True)
    last_login   = Column(DateTime)
    created_at   = Column(DateTime, default=datetime.utcnow)
    # True when an admin has just created/reset this user with a temp password
    # and they haven't changed it yet. Frontend forces a redirect to
    # /change-password and blocks all other navigation while True. Flag clears
    # on a successful POST /auth/change-password. See docs/USERS_AND_ROLES.md
    # §10 Phase 4 ("Force password change on first login") for the design.
    must_change_password = Column(Boolean, default=False, nullable=False)
    # When True, user has access to ALL branches (super-admin pattern). The
    # `user_branches` table is empty for this user and `branch_id` is null.
    # When False, `user_branches` lists the specific branches and `branch_id`
    # mirrors the primary one.
    all_branches = Column(Boolean, default=False, nullable=False)


# ─── UserBranch (join table for multi-branch user assignment) ─────────────────
class UserBranch(Base):
    """Many-to-many between users and branches. A user can be assigned to
    multiple branches; their primary branch (first one assigned) is mirrored
    on `users.branch_id` for backwards compat with code that pre-dates the
    multi-branch feature.

    NB: this is purely a UI/data-filter mechanism — there is no per-branch
    permission enforcement on the backend yet. A user with branch_ids=[A,B]
    could still pass `?branch_id=C` to a list endpoint and the server won't
    reject it. Enforcement is tracked under docs/USERS_AND_ROLES.md §10
    Phase 4 (per-branch permission scoping).
    """
    __tablename__ = "user_branches"
    user_id   = Column(String, ForeignKey("users.id",     ondelete="CASCADE"), primary_key=True)
    branch_id = Column(String, ForeignKey("branches.id",  ondelete="CASCADE"), primary_key=True)


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


# ─── Item Batch (FIFO / FEFO lot tracking) ───────────────────────────────────
# A *batch* (a.k.a. lot) is a stock parcel of a single Item at a single Branch
# that shares a vendor/cost/expiry profile. Used to drive FIFO (consume oldest
# received first) and FEFO (consume nearest expiry first) issue strategies.
#
# Invariant: SUM(item_batches.quantity WHERE item_id=I AND branch_id=B) should
# track item_stock.quantity for tracked items. We don't enforce it with a DB
# trigger — instead, src.routes._atomic helpers update both together inside the
# same transaction. Untracked items (`Item.batch_tracking == False`) skip the
# batch table entirely; their stock lives only on item_stock.
class ItemBatch(Base):
    __tablename__ = "item_batches"
    id            = Column(String, primary_key=True)
    item_id       = Column(String, ForeignKey("items.id"), nullable=False)
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False)
    batch_number  = Column(String, nullable=False)         # vendor lot # or auto
    mfg_date      = Column(String)                          # YYYY-MM-DD
    expiry_date   = Column(String)                          # YYYY-MM-DD
    quantity      = Column(Integer, default=0)              # remaining
    initial_qty   = Column(Integer, default=0)              # received qty
    cost_price    = Column(Float, default=0)
    vendor_id     = Column(String, nullable=True)
    # `source_type` records how this batch came into existence so the audit
    # trail in the UI can label rows (Opening, Purchase, Transfer, Adjustment,
    # Manual). `source_ref` is the originating doc id (bill, transfer, etc.).
    source_type   = Column(String, default="manual")
    source_ref    = Column(String, nullable=True)
    received_date = Column(String)                          # YYYY-MM-DD
    notes         = Column(Text)
    active        = Column(Boolean, default=True)
    created_at    = Column(DateTime, default=datetime.utcnow)
    updated_at    = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    item   = relationship("Item")
    branch = relationship("Branch")


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
    # Operator-picked source batch hint set at create time. Honored on
    # approval if the batch still has stock; otherwise FIFO/FEFO kicks in.
    preferred_batch_id = Column(String, nullable=True)
    # Operator-set explicit per-line split (TEXT-encoded JSON list of
    # {batch_id, qty}). When present at approve time, those batches are
    # consumed in that exact order instead of FIFO/FEFO. The Create Transfer
    # UI writes this; the cleaner per-batch view in detail uses
    # `batch_allocation` below.
    requested_allocation = Column(Text, nullable=True)
    # Persisted batch consumption manifest, populated on approve. JSON-encoded
    # list of {batch_id, batch_number, consumed, expiry_date, ...}. Used by
    # receive() to recreate batches at the destination and by the UI to show
    # the operator which lots were drawn from source. Stored as TEXT so we
    # don't depend on JSON column support in older SQLite builds.
    batch_allocation = Column(Text, nullable=True)

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


# ─── Document Numbering ─────────────────────────────────────────────────────────
class DocumentNumbering(Base):
    """Per document-type numbering template (Settings → Document Numbering)."""
    __tablename__ = "document_numbering"
    doc_type  = Column(String, primary_key=True)
    label     = Column(String, nullable=False)
    prefix    = Column(String, nullable=False, default="")
    format    = Column(String, nullable=False, default="{PREFIX}-{YYYY}-####")
    scope     = Column(String, nullable=False, default="per_branch")  # per_branch | centralised
    next_seq  = Column(Integer, default=1)  # seed for new counters
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DocumentNumberCounter(Base):
    """Running sequence per doc_type (+ branch when scope is per_branch)."""
    __tablename__ = "document_number_counters"
    id         = Column(String, primary_key=True)  # "{doc_type}:" or "{doc_type}:{branch_id}"
    doc_type   = Column(String, nullable=False)
    branch_id  = Column(String, nullable=True)
    next_seq   = Column(Integer, default=1)


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

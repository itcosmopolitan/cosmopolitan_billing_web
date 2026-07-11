"""
Cosmopolitan Pro — Database Models
All ORM models for the retail platform
"""
import enum
from datetime import datetime


from sqlalchemy import JSON, Boolean, Column, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import relationship

from src.database import Base


# ─── Enums ────────────────────────────────────────────────────────────────────
class UserRole(str, enum.Enum):
    super_admin       = "super_admin"
    branch_manager    = "branch_manager"
    branch_supervisor = "branch_supervisor"
    cashier           = "cashier"
    inventory_manager = "inventory_manager"
    finance           = "finance"
    purchase_admin    = "purchase_admin"


class ItemApprovalStatus(str, enum.Enum):
    draft = "draft"
    pending = "pending"
    pending_approval = "pending_approval"
    approved = "approved"
    rejected = "rejected"
    inactive = "inactive"

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

class AdjustmentStatus(str, enum.Enum):
    pending  = "pending"
    approved = "approved"
    rejected = "rejected"

class QuotationStatus(str, enum.Enum):
    draft    = "draft"
    sent     = "sent"
    accepted = "accepted"
    rejected = "rejected"
    converted = "converted"
    expired  = "expired"


class SalesOrderStatus(str, enum.Enum):
    """Sales Order lifecycle. Mirrors QuotationStatus shape so the convert
    flows feel consistent. `converted` is terminal — once an SO has spawned
    an invoice, its line items / totals are locked and the SO can't be
    edited or re-converted."""
    draft     = "draft"
    confirmed = "confirmed"
    partially_invoiced = "partially_invoiced"
    converted = "converted"
    cancelled = "cancelled"


class PurchaseOrderStatus(str, enum.Enum):
    """Purchase Order lifecycle. Mirrors SalesOrderStatus exactly — the
    semantics are symmetric (intent → confirmed → spawned-into-bill →
    cancelled). Kept as a separate enum (rather than re-using
    SalesOrderStatus) so the two domains can evolve independently if
    purchase workflows grow new states (e.g. `approved_pending_receipt`).
    """
    draft              = "draft"
    pending_approval   = "pending_approval"
    confirmed          = "confirmed"
    partially_received = "partially_received"
    converted          = "converted"
    cancelled          = "cancelled"


class GRNStatus(str, enum.Enum):
    """Goods Receipt Note lifecycle. Stock moves only at `received`."""
    draft     = "draft"
    received  = "received"
    cancelled = "cancelled"


class SalesReturnStatus(str, enum.Enum):
    """SalesReturn lifecycle. Created in `processed` immediately (returns
    are atomic — stock + credit / refund happens at create time). `void`
    exists for future "undo a return" support but isn't writable yet."""
    processed = "processed"
    void      = "void"


class DocumentReturnStatus(str, enum.Enum):
    """How much of a source invoice/bill has been credited via returns."""
    none    = "none"
    partial = "partial"
    full    = "full"


class StockReservationStatus(str, enum.Enum):
    active    = "active"
    released  = "released"
    fulfilled = "fulfilled"


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
    # inclusive = shelf prices include GST (default); exclusive = tax added at checkout
    tax_pricing_mode = Column(String, default="inclusive")
    # Phase 0: when True (default), POS/SO convert may sell below available stock.
    allow_overselling = Column(Boolean, default=True, nullable=False)
    # Phase 4: JSON {"pos": {"prefix": "POS", "start": 1000}, "invoice": {...}}
    numbering_config  = Column(Text)
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
    # Cash Control settings
    cash_opening_mode       = Column(String, default="carry_forward")  # carry_forward | fixed
    cash_fixed_float        = Column(Float, default=0)
    cash_variance_threshold = Column(Float, default=500)

    stock        = relationship("ItemStock", back_populates="branch")
    item_configs = relationship("ItemBranchConfig", back_populates="branch")
    cash_entries = relationship("CashEntry", back_populates="branch")


# ─── Tax Rate ─────────────────────────────────────────────────────────────────
class TaxRate(Base):
    __tablename__ = "tax_rates"
    id         = Column(String, primary_key=True)
    rate       = Column(Float, nullable=False)
    label      = Column(String, nullable=False)
    examples   = Column(Text, default="")
    active     = Column(Boolean, default=True)
    is_system  = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


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
    role_id      = Column(String, ForeignKey("roles.id"), nullable=True, index=True)
    # Legacy single-branch FK. Pre-multi-branch this was THE branch the user
    # belonged to; it's now mirrored from `user_branches[0]` purely so older
    # code that reads `user.branch_id` keeps working until those reads are
    # migrated. There is NO user-facing "primary branch" concept — the
    # authoritative list is `user_branches` (see UserBranch below) and any
    # ordering inside it is incidental. When `all_branches=True` this column
    # is null and user_branches is empty (the user has access to every
    # branch — the super-admin pattern). See docs/USERS_AND_ROLES.md §5.2.
    branch_id    = Column(String, ForeignKey("branches.id"), nullable=True, index=True)
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
    __table_args__ = (
        Index("ix_user_branches_user_id", "user_id"),
        Index("ix_user_branches_branch_id", "branch_id"),
    )
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
    category_id     = Column(String, ForeignKey("categories.id"), nullable=True)
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
    status = Column(
        SAEnum(ItemApprovalStatus),
        default=ItemApprovalStatus.approved,
        nullable=False,
    )
    approval_status = Column(
        SAEnum(ItemApprovalStatus),
        default=ItemApprovalStatus.approved,
        nullable=False,
    )
    created_by      = Column(String)
    approved_by     = Column(String)
    rejected_by     = Column(String)
    approved_at     = Column(DateTime)
    rejected_at     = Column(DateTime)
    rejection_reason = Column(Text)
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    category  = relationship("Category", back_populates="items")
    stock     = relationship("ItemStock", back_populates="item")
    branch_configs = relationship("ItemBranchConfig", back_populates="item")
    sale_lines = relationship("SaleLineItem", back_populates="item")
    purchase_lines = relationship("PurchaseLineItem", back_populates="item")
    quotation_lines = relationship("QuotationLineItem", back_populates="item")


# ─── Item Branch Config (listing + branch price) ─────────────────────────────
class ItemBranchConfig(Base):
    """Per-branch listing and pricing. ``selling_price`` NULL → item default."""
    __tablename__ = "item_branch_config"
    __table_args__ = (
        UniqueConstraint("item_id", "branch_id", name="uq_item_branch_config"),
    )

    id             = Column(String, primary_key=True)
    item_id        = Column(String, ForeignKey("items.id"), nullable=False)
    branch_id      = Column(String, ForeignKey("branches.id"), nullable=False)
    is_available   = Column(Boolean, default=True)
    cost_price     = Column(Float, nullable=True)
    selling_price  = Column(Float, nullable=True)
    reorder_level  = Column(Integer, nullable=True)
    created_at     = Column(DateTime, default=datetime.utcnow)
    updated_at     = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    item   = relationship("Item", back_populates="branch_configs")
    branch = relationship("Branch", back_populates="item_configs")


# ─── Item Stock (per branch) ──────────────────────────────────────────────────
class ItemStock(Base):
    __tablename__ = "item_stock"
    __table_args__ = (
        UniqueConstraint("item_id", "branch_id", name="uq_item_stock_item_branch"),
    )
    id         = Column(String, primary_key=True)
    item_id    = Column(String, ForeignKey("items.id"), nullable=False, index=True)
    branch_id  = Column(String, ForeignKey("branches.id"), nullable=False, index=True)
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
    __table_args__ = (
        Index("ix_item_batches_item_branch_active", "item_id", "branch_id", "active"),
    )
    id            = Column(String, primary_key=True)
    item_id       = Column(String, ForeignKey("items.id"), nullable=False, index=True)
    branch_id     = Column(String, ForeignKey("branches.id"), nullable=False, index=True)
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
    # Money we owe the customer (always ≥0). Mutations go through
    # routes/_credit_ledger.adjust_customer_credit so every change also
    # writes a CustomerCreditEntry row.
    credit_balance  = Column(Float, default=0, nullable=False)
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
    # Advance / overpayment credit (money we prepaid the vendor). Mutations
    # go through routes/_vendor_credit_ledger.adjust_vendor_credit.
    credit_balance   = Column(Float, default=0, nullable=False)
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
    # 2026-05-23 (Sales Phase 1): payment_mode is intentionally nullable
    # with no Python-side default. None means "no payment recorded yet"
    # (invoice sits in status='pending'). The allow-list of non-null
    # values is enforced by Pydantic — see PaymentMode Literal in
    # routes/sales.py. Setting `default="cash"` here used to clobber
    # explicit `None` values during INSERT, masking the unpaid state.
    payment_mode  = Column(String, nullable=True)
    status        = Column(SAEnum(InvoiceStatus), default=InvoiceStatus.paid)
    due_date      = Column(String)   # credit-term due; drives overdue flag
    # Phase 0: cumulative return value + derived flag (see recalc_invoice_after_cn).
    credited_amount = Column(Float, default=0, nullable=False)
    return_status   = Column(String, default="none")
    # Phase 4: pos | invoice | sales_order | quotation — drives receipt numbering.
    origin        = Column(String, default="invoice")
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    customer  = relationship("Customer", back_populates="invoices")
    line_items = relationship("SaleLineItem", back_populates="invoice", cascade="all, delete-orphan")


class SaleLineItem(Base):
    __tablename__ = "sale_line_items"
    __table_args__ = (
        Index("ix_sale_line_items_invoice_id", "invoice_id"),
        Index("ix_sale_line_items_item_id", "item_id"),
    )
    id         = Column(String, primary_key=True)
    invoice_id = Column(String, ForeignKey("sale_invoices.id"), nullable=False)
    item_id    = Column(String, ForeignKey("items.id"), nullable=True)
    name       = Column(String, nullable=False)
    qty        = Column(Integer, default=1)
    price      = Column(Float, default=0)
    tax_rate   = Column(Float, default=0)
    discount   = Column(Float, default=0)
    line_total = Column(Float, default=0)
    # 2026-05-31: which batch lots this sale line consumed, so a return can
    # restore stock to the SAME lots (preserving original expiry). JSON list
    # of {batch_id, batch_number, consumed, expiry_date}. NULL for untracked
    # items or sales made before this column existed. Mirrors
    # TransferLineItem.batch_allocation.
    batch_allocation = Column(Text)

    invoice = relationship("SaleInvoice", back_populates="line_items")
    item    = relationship("Item", back_populates="sale_lines")


class DailySalesSummary(Base):
    __tablename__ = "mv_daily_sales_summary"
    branch_id = Column(String, primary_key=True)
    sale_date = Column(Date, primary_key=True)
    cashier = Column(String, primary_key=True)
    bill_count = Column(Integer)
    revenue = Column(Float)
    collected = Column(Float)
    discount = Column(Float)
    average_bill_value = Column(Float)


class ProductSalesSummary(Base):
    __tablename__ = "mv_product_sales_summary"
    branch_id = Column(String, primary_key=True)
    sale_date = Column(Date, primary_key=True)
    cashier = Column(String, primary_key=True)
    item_id = Column(String, primary_key=True)
    product_name = Column(String)
    category_id = Column(String)
    brand = Column(String)
    quantity_sold = Column(Integer)
    revenue = Column(Float)
    profit = Column(Float)


class InventorySnapshot(Base):
    __tablename__ = "mv_inventory_snapshot"
    branch_id = Column(String, primary_key=True)
    item_id = Column(String, primary_key=True)
    category_id = Column(String)
    brand = Column(String)
    quantity = Column(Integer)
    reorder_level = Column(Integer)
    inventory_value = Column(Float)
    updated_at = Column(DateTime)


class PaymentSummary(Base):
    __tablename__ = "mv_payment_summary"
    branch_id = Column(String, primary_key=True)
    paid_date = Column(Date, primary_key=True)
    cashier = Column(String, primary_key=True)
    payment_method = Column(String, primary_key=True)
    bill_count = Column(Integer)
    collected = Column(Float)
    pending_amount = Column(Float)


class StaffPerformanceSummary(Base):
    __tablename__ = "mv_staff_performance_summary"
    branch_id = Column(String, primary_key=True)
    sale_date = Column(Date, primary_key=True)
    staff_name = Column(String, primary_key=True)
    bill_count = Column(Integer)
    sales = Column(Float)
    average_bill_value = Column(Float)


class RefundSummary(Base):
    __tablename__ = "mv_refund_summary"
    branch_id = Column(String, primary_key=True)
    refund_date = Column(Date, primary_key=True)
    cashier = Column(String, primary_key=True)
    refund_count = Column(Integer)
    refund_amount = Column(Float)


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
    # Set when status flips to `converted`. Back-pointer to the spawned
    # SalesOrder, mirroring SalesOrder.converted_invoice_id. Used by the
    # delete guard to tell whether a live SO still depends on this quote
    # (status alone is insufficient — it never resets when the SO is
    # deleted). Nullable until conversion. Added 2026-05-30.
    converted_order_id = Column(String, ForeignKey("sales_orders.id"), nullable=True)
    # Set on direct quote→invoice convert (skip SO). Nullable until then.
    converted_invoice_id = Column(String, ForeignKey("sale_invoices.id"), nullable=True)
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


# ─── Sales Order ──────────────────────────────────────────────────────────────
# Intent-to-invoice: lets a customer (or salesperson) reserve a basket of
# items + agreed prices that will become an invoice later. No stock side-
# effect on creation — the stock deduction happens at convert time, same
# code path as POS sales (consume_batches_atomic for tracked, adjust_stock_
# atomic for untracked). When converted, status → converted and the SO is
# locked (no further edits, no re-convert). `converted_invoice_id` is a
# back-pointer to the spawned invoice so the UI can link to it.
class SalesOrder(Base):
    __tablename__ = "sales_orders"
    id                   = Column(String, primary_key=True)
    number               = Column(String, unique=True, nullable=False)
    customer_id          = Column(String, ForeignKey("customers.id"), nullable=True)
    customer_name        = Column(String, default="Walk-in")
    branch_id            = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name          = Column(String)
    created_by           = Column(String)
    date                 = Column(String, nullable=False)
    expected_date        = Column(String)          # when the customer expects fulfilment
    subtotal             = Column(Float, default=0)
    tax_total            = Column(Float, default=0)
    discount             = Column(Float, default=0)
    total                = Column(Float, default=0)
    status               = Column(SAEnum(SalesOrderStatus), default=SalesOrderStatus.draft)
    # Set when status flips to `converted`. Used by the UI to render a
    # "View invoice" link on the SO row. Nullable until conversion.
    converted_invoice_id = Column(String, ForeignKey("sale_invoices.id"), nullable=True)
    notes                = Column(Text)
    created_at           = Column(DateTime, default=datetime.utcnow)

    customer   = relationship("Customer")
    line_items = relationship("SalesOrderLineItem", back_populates="order", cascade="all, delete-orphan")


class SalesOrderLineItem(Base):
    __tablename__ = "sales_order_line_items"
    id         = Column(String, primary_key=True)
    order_id   = Column(String, ForeignKey("sales_orders.id"), nullable=False)
    item_id    = Column(String, ForeignKey("items.id"), nullable=True)
    name       = Column(String, nullable=False)
    qty        = Column(Integer, default=1)
    price      = Column(Float, default=0)
    tax_rate   = Column(Float, default=0)
    discount   = Column(Float, default=0)
    line_total = Column(Float, default=0)

    order = relationship("SalesOrder", back_populates="line_items")
    item  = relationship("Item")


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
    # 2026-05-24: parity with SaleInvoice.payment_mode. Captured when the
    # operator records a vendor payment so the Bills tab can show the
    # method. Nullable (None = no payment yet → status='pending'). Allow-
    # list enforced server-side via the PaymentMode Literal in
    # routes/purchases.py (same 4 values as the POS side: cash / card /
    # upi / bank_transfer).
    payment_mode  = Column(String, nullable=True)
    status        = Column(SAEnum(InvoiceStatus), default=InvoiceStatus.pending)
    credited_amount = Column(Float, default=0, nullable=False)
    return_status   = Column(String, default="none")
    grn_id        = Column(String, ForeignKey("goods_receipt_notes.id"), nullable=True)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    vendor     = relationship("Vendor", back_populates="bills")
    line_items = relationship("PurchaseLineItem", back_populates="bill", cascade="all, delete-orphan")


class PurchaseLineItem(Base):
    __tablename__ = "purchase_line_items"
    __table_args__ = (
        Index("ix_purchase_line_items_bill_id", "bill_id"),
        Index("ix_purchase_line_items_item_id", "item_id"),
    )
    id         = Column(String, primary_key=True)
    bill_id    = Column(String, ForeignKey("purchase_bills.id"), nullable=False)
    item_id    = Column(String, ForeignKey("items.id"), nullable=True)
    name       = Column(String, nullable=False)
    qty        = Column(Integer, default=1)
    cost       = Column(Float, default=0)
    tax_rate   = Column(Float, default=0)
    # 2026-05-24: per-line discount (percent). Parity with
    # SaleLineItem.discount + SalesOrderLineItem.discount.
    discount   = Column(Float, default=0)
    line_total = Column(Float, default=0)

    bill = relationship("PurchaseBill", back_populates="line_items")
    item = relationship("Item", back_populates="purchase_lines")


# ─── Purchase Order ──────────────────────────────────────────────────────────
# Mirror of SalesOrder. Captures the operator's intent to buy from a
# vendor before a bill is cut. Stock is NOT touched at create / edit —
# only at convert time, when the PO spawns a PurchaseBill and the bill's
# create flow handles the receipt-side stock adjustments + batch creation
# (same path POSPage uses for sales). See routes/purchases.convert_order_to_bill.
class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    id                = Column(String, primary_key=True)
    number            = Column(String, unique=True, nullable=False)  # PO-YYYY-NNNN
    vendor_id         = Column(String, ForeignKey("vendors.id"), nullable=False)
    vendor_name       = Column(String)
    branch_id         = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name       = Column(String)
    created_by        = Column(String)
    date              = Column(String, nullable=False)
    expected_date     = Column(String)              # when the goods are expected
    subtotal          = Column(Float, default=0)
    tax_total         = Column(Float, default=0)
    discount          = Column(Float, default=0)
    total             = Column(Float, default=0)
    status            = Column(SAEnum(PurchaseOrderStatus), default=PurchaseOrderStatus.draft)
    # Set when status flips to `converted`. The UI uses this to render a
    # "View bill" link on the PO row. Nullable until conversion.
    converted_bill_id = Column(String, ForeignKey("purchase_bills.id"), nullable=True)
    notes             = Column(Text)
    created_at        = Column(DateTime, default=datetime.utcnow)

    vendor     = relationship("Vendor")
    line_items = relationship("PurchaseOrderLineItem", back_populates="order", cascade="all, delete-orphan")


class PurchaseOrderLineItem(Base):
    __tablename__ = "purchase_order_line_items"
    id         = Column(String, primary_key=True)
    order_id   = Column(String, ForeignKey("purchase_orders.id"), nullable=False)
    item_id    = Column(String, ForeignKey("items.id"), nullable=True)
    name       = Column(String, nullable=False)
    qty        = Column(Integer, default=1)
    # PO captures `cost` (what we'll pay the vendor), matching PurchaseLineItem.
    # Sales side stores `price`; the field name asymmetry is intentional and
    # matches the domain language.
    cost       = Column(Float, default=0)
    tax_rate   = Column(Float, default=0)
    discount   = Column(Float, default=0)           # percent (matches SO convention)
    line_total = Column(Float, default=0)

    order = relationship("PurchaseOrder", back_populates="line_items")
    item  = relationship("Item")


# ─── Goods Receipt Note (GRN) ────────────────────────────────────────────────
# Primary stock-in document for purchases. Bills reference a GRN for lineage;
# legacy bills without grn_id are treated as having an implicit GRN (batches
# keyed on bill.id). See routes/_grn_stock.py + routes/purchases.py.
class GoodsReceiptNote(Base):
    __tablename__ = "goods_receipt_notes"
    id                = Column(String, primary_key=True)
    number            = Column(String, unique=True, nullable=False)  # GRN-YYYY-NNNN
    vendor_id         = Column(String, ForeignKey("vendors.id"), nullable=False)
    vendor_name       = Column(String)
    branch_id         = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name       = Column(String)
    purchase_order_id = Column(String, ForeignKey("purchase_orders.id"), nullable=True)
    po_number         = Column(String)
    date              = Column(String, nullable=False)
    subtotal          = Column(Float, default=0)
    tax_total         = Column(Float, default=0)
    discount          = Column(Float, default=0)
    total             = Column(Float, default=0)
    status            = Column(SAEnum(GRNStatus), default=GRNStatus.received)
    converted_bill_id = Column(String, ForeignKey("purchase_bills.id"), nullable=True)
    notes             = Column(Text)
    created_by        = Column(String)
    created_at        = Column(DateTime, default=datetime.utcnow)

    vendor     = relationship("Vendor")
    line_items = relationship("GRNLineItem", back_populates="grn", cascade="all, delete-orphan")


class GRNLineItem(Base):
    __tablename__ = "grn_line_items"
    id           = Column(String, primary_key=True)
    grn_id       = Column(String, ForeignKey("goods_receipt_notes.id"), nullable=False)
    po_line_id   = Column(String, ForeignKey("purchase_order_line_items.id"), nullable=True)
    item_id      = Column(String, ForeignKey("items.id"), nullable=True)
    name         = Column(String, nullable=False)
    ordered_qty  = Column(Integer)
    received_qty = Column(Integer, default=1)
    cost         = Column(Float, default=0)
    tax_rate     = Column(Float, default=0)
    discount     = Column(Float, default=0)
    line_total   = Column(Float, default=0)
    batch_number = Column(String)
    mfg_date     = Column(String)
    expiry_date  = Column(String)

    grn  = relationship("GoodsReceiptNote", back_populates="line_items")
    item = relationship("Item")


# ─── Vendor Payment ──────────────────────────────────────────────────────────
# Mirror of CustomerPayment for the purchase side. See CustomerPayment for
# the design rationale (multi-bill payments, retrofit path, etc.).
# Overpayment on multi-bill payments accumulates in credit_applied and bumps
# vendor.credit_balance (Purchase Phase 3 — mirrors CustomerPayment).
class VendorPayment(Base):
    __tablename__ = "vendor_payments"
    id              = Column(String, primary_key=True)
    number          = Column(String, unique=True, nullable=False)  # VPAY-YYYY-NNNN
    vendor_id       = Column(String, ForeignKey("vendors.id"), nullable=False)
    vendor_name     = Column(String)
    branch_id       = Column(String, ForeignKey("branches.id"), nullable=True)
    branch_name     = Column(String)
    date            = Column(String, nullable=False)
    total_amount    = Column(Float, default=0)
    payment_mode    = Column(String, nullable=False)
    payment_ref     = Column(String)
    notes           = Column(Text)
    voided          = Column(Boolean, default=False, nullable=False)
    voided_at       = Column(String)
    credit_applied  = Column(Float, default=0)
    created_by      = Column(String)
    created_at      = Column(DateTime, default=datetime.utcnow)

    vendor      = relationship("Vendor")
    allocations = relationship("VendorPaymentAllocation", back_populates="payment", cascade="all, delete-orphan")


class VendorCreditEntry(Base):
    __tablename__ = "vendor_credit_entries"
    id             = Column(String, primary_key=True)
    vendor_id      = Column(String, ForeignKey("vendors.id"), nullable=False)
    entry_type     = Column(String, nullable=False)
    delta          = Column(Float, nullable=False)
    balance_before = Column(Float, default=0)
    balance_after  = Column(Float, default=0)
    source_type    = Column(String)
    source_ref     = Column(String)
    source_number  = Column(String)
    notes          = Column(Text)
    date           = Column(String, nullable=False)
    created_by     = Column(String)
    created_at     = Column(DateTime, default=datetime.utcnow)

    vendor = relationship("Vendor")


class VendorPaymentAllocation(Base):
    __tablename__ = "vendor_payment_allocations"
    id          = Column(String, primary_key=True)
    payment_id  = Column(String, ForeignKey("vendor_payments.id"), nullable=False)
    bill_id     = Column(String, ForeignKey("purchase_bills.id"), nullable=False)
    bill_number = Column(String)
    amount      = Column(Float, default=0)
    created_at  = Column(DateTime, default=datetime.utcnow)

    payment = relationship("VendorPayment", back_populates="allocations")
    bill    = relationship("PurchaseBill")


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
    voided        = Column(Boolean, default=False, nullable=False)
    voided_at     = Column(String)
    notes         = Column(Text)
    created_at    = Column(DateTime, default=datetime.utcnow)

    vendor    = relationship("Vendor", back_populates="returns")
    bill      = relationship("PurchaseBill")
    line_items = relationship("ReturnLineItem", back_populates="return_note", cascade="all, delete-orphan")


class ReturnLineItem(Base):
    __tablename__ = "return_line_items"
    __table_args__ = (
        Index("ix_return_line_items_return_id", "return_id"),
        Index("ix_return_line_items_item_id", "item_id"),
    )
    id            = Column(String, primary_key=True)
    return_id     = Column(String, ForeignKey("vendor_returns.id"), nullable=False)
    # 2026-05-25: link back to the originating bill line so the backend
    # can enforce "cumulative return_qty ≤ bill_line.qty" across multiple
    # returns on the same bill. Parity with SalesReturnLineItem.invoice_line_id.
    # Nullable for legacy returns created before this column existed.
    bill_line_id  = Column(String, ForeignKey("purchase_line_items.id"), nullable=True)
    item_id       = Column(String, ForeignKey("items.id"), nullable=True)
    name          = Column(String, nullable=False)
    original_qty  = Column(Integer)  # Qty from original purchase
    return_qty    = Column(Integer, default=1)
    cost          = Column(Float, default=0)
    tax_rate      = Column(Float, default=0)
    line_total    = Column(Float, default=0)
    # 2026-05-31: JSON ledger of the stock consumption this return line
    # performed, so deletion can reverse the exact lots. For batch-tracked
    # items: [{"batch_id", "consumed"}, ...] (from consume_batches_atomic).
    # For untracked items: [{"batch_id": null, "consumed": qty}] (aggregate
    # decrement). NULL = legacy return created before vendor returns moved
    # stock — deletion must NOT re-add stock for those.
    batch_allocation = Column(Text)

    return_note = relationship("VendorReturn", back_populates="line_items")
    item = relationship("Item")


# ─── Sales Return / Credit Note ───────────────────────────────────────────────
# Customer-side return. ALWAYS linked to a SaleInvoice (invoice_id is
# nullable=False) — open-ended "I'm returning something with no proof of
# purchase" is out of scope. Multiple returns against the same invoice are
# allowed; the create endpoint validates each line against
# (original_qty - Σ already returned across other SalesReturns for the
# same invoice + same item_id).
#
# Refund handling:
#   • refund_method='cash'       → operator gave cash from drawer; no
#     customer.credit_balance change (cash entry tracked separately, out
#     of scope for now).
#   • refund_method='credit'     → customer.credit_balance += credited_amount.
#     Walk-in invoices reject 'credit' (no customer to credit) — the API
#     forces 'cash' for walk-ins.
#   • refund_method='adjustment' → no money moves; reduces the invoice's
#     outstanding balance instead. Useful for "return on a partially-paid
#     invoice where the return amount exceeds what they've paid so far"
#     (the excess stays as a balance reduction rather than a cash refund).
#
# Stock side-effect: restocks happen at the invoice's branch (where the
# sale was made), not necessarily the operator's current branch. For
# tracked items, restocks create a single per-(item,branch) "Returns"
# batch via add_batch_atomic with source_type='return'.
class SalesReturn(Base):
    __tablename__ = "sales_returns"
    id              = Column(String, primary_key=True)
    number          = Column(String, unique=True, nullable=False)  # CN-YYYY-NNNN
    invoice_id      = Column(String, ForeignKey("sale_invoices.id"), nullable=False)
    invoice_number  = Column(String)              # denormalised for list views
    customer_id     = Column(String, ForeignKey("customers.id"), nullable=True)  # mirrors invoice
    customer_name   = Column(String, default="Walk-in")
    branch_id       = Column(String, ForeignKey("branches.id"), nullable=False)  # mirrors invoice
    branch_name     = Column(String)
    date            = Column(String, nullable=False)
    reason          = Column(String)              # free text — Damaged / Wrong Item / etc.
    refund_method   = Column(String, default="cash")  # cash | credit | adjustment
    subtotal        = Column(Float, default=0)
    tax_total       = Column(Float, default=0)
    total           = Column(Float, default=0)
    # How much actually got refunded to the customer (cash or credit).
    # For partially-paid invoices, this is capped at the paid_amount —
    # excess return value reduces the invoice's outstanding balance.
    credited_amount = Column(Float, default=0)
    status          = Column(SAEnum(SalesReturnStatus), default=SalesReturnStatus.processed)
    notes           = Column(Text)
    created_by      = Column(String)
    created_at      = Column(DateTime, default=datetime.utcnow)

    invoice    = relationship("SaleInvoice")
    customer   = relationship("Customer")
    line_items = relationship("SalesReturnLineItem", back_populates="sales_return", cascade="all, delete-orphan")


class SalesReturnLineItem(Base):
    __tablename__ = "sales_return_line_items"
    id            = Column(String, primary_key=True)
    return_id     = Column(String, ForeignKey("sales_returns.id"), nullable=False)
    # Links back to the original invoice line (item_id can be null for
    # legacy invoices where the line was free-typed without a catalog id).
    invoice_line_id = Column(String, ForeignKey("sale_line_items.id"), nullable=True)
    item_id       = Column(String, ForeignKey("items.id"), nullable=True)
    name          = Column(String, nullable=False)
    original_qty  = Column(Integer)                # qty on the original invoice line
    return_qty    = Column(Integer, default=1)
    price         = Column(Float, default=0)       # price at time of original sale
    tax_rate      = Column(Float, default=0)
    line_total    = Column(Float, default=0)       # incl. tax
    # 2026-05-31: which source lots this return restored stock to + how much,
    # so the per-batch cumulative cap (≤ qty taken on the invoice) holds
    # across multiple returns and deletion can reverse the exact lots. JSON
    # list of {batch_id, restored}.
    batch_allocation = Column(Text)

    sales_return = relationship("SalesReturn", back_populates="line_items")
    item         = relationship("Item")


# ─── Customer Payment ────────────────────────────────────────────────────────
# A standalone Payment row recorded when a customer pays one OR MORE invoices
# in a single transaction (cash handover, single UPI, single bank transfer,
# etc.). Mirrors how real-world AR is reconciled — the customer doesn't
# typically write a separate cheque per invoice.
#
# Two write paths both create a CustomerPayment row:
#   1. POST /sales/payments/ — new flow (pick customer → pick invoices →
#      record one payment across them).
#   2. POST /sales/{invoice_id}/payment — legacy single-invoice flow (the
#      "Pay" button on the Invoices tab still hits this). Creates a Payment
#      with exactly one allocation. Retained so the existing per-row Pay
#      ergonomics stay and the Payments tab is COMPLETE (every payment ever
#      recorded, regardless of entry point, shows up).
#
# Overpayment: if the operator allocates more than an invoice's balance,
# the excess routes to customer.credit_balance + we capture how much was
# credited in `credit_applied`. Same semantics as the existing single-
# invoice overpay handling. For walk-in invoices (customer_id=null on the
# invoice), the existing 400 "reduce amount or assign a customer" rule
# still applies — walk-in payments via either path can't overpay.
#
# `customer_id` is nullable here ONLY for legacy single-invoice payments
# against walk-in invoices via path #2. The new multi-invoice flow
# requires a customer up front (the picker is strict).
class CustomerPayment(Base):
    __tablename__ = "customer_payments"
    id              = Column(String, primary_key=True)
    number          = Column(String, unique=True, nullable=False)  # PAY-YYYY-NNNN
    customer_id     = Column(String, ForeignKey("customers.id"), nullable=True)
    customer_name   = Column(String, default="Walk-in")
    branch_id       = Column(String, ForeignKey("branches.id"), nullable=True)
    branch_name     = Column(String)
    date            = Column(String, nullable=False)
    # Sum of allocations.amount + credit_applied. The operator's typed
    # total. Validated server-side against the allocation sum.
    total_amount    = Column(Float, default=0)
    payment_mode    = Column(String, nullable=False)  # PaymentMode literal
    payment_ref     = Column(String)                  # UTR / cheque # / transaction id
    notes           = Column(Text)
    # Excess routed to customer.credit_balance for non-walk-in customers.
    # 0 for exact-amount payments. Always ≥ 0.
    credit_applied  = Column(Float, default=0)
    voided          = Column(Boolean, default=False, nullable=False)
    voided_at       = Column(String)
    created_by      = Column(String)
    created_at      = Column(DateTime, default=datetime.utcnow)

    customer    = relationship("Customer")
    allocations = relationship("CustomerPaymentAllocation", back_populates="payment", cascade="all, delete-orphan")


class CustomerPaymentAllocation(Base):
    __tablename__ = "customer_payment_allocations"
    id             = Column(String, primary_key=True)
    payment_id     = Column(String, ForeignKey("customer_payments.id"), nullable=False)
    invoice_id     = Column(String, ForeignKey("sale_invoices.id"), nullable=False)
    invoice_number = Column(String)  # denormalised for list views (avoids JOINs)
    # Amount actually APPLIED to this invoice (capped at the invoice's
    # balance at time of payment). Excess that operator typed > balance
    # rolls up into the parent payment's credit_applied, not here.
    amount         = Column(Float, default=0)
    created_at     = Column(DateTime, default=datetime.utcnow)

    payment = relationship("CustomerPayment", back_populates="allocations")
    invoice = relationship("SaleInvoice")


# ─── Customer Credit Ledger (Sales Phase 1) ───────────────────────────────────
class CustomerCreditEntry(Base):
    __tablename__ = "customer_credit_entries"
    id             = Column(String, primary_key=True)
    customer_id    = Column(String, ForeignKey("customers.id"), nullable=False)
    entry_type     = Column(String, nullable=False)
    delta          = Column(Float, nullable=False)
    balance_before = Column(Float, default=0)
    balance_after  = Column(Float, default=0)
    source_type    = Column(String)
    source_ref     = Column(String)
    source_number  = Column(String)
    notes          = Column(Text)
    date           = Column(String, nullable=False)
    created_by     = Column(String)
    created_at     = Column(DateTime, default=datetime.utcnow)

    customer = relationship("Customer")


# ─── Stock Movement Ledger (Phase 0) ─────────────────────────────────────────
# Append-only audit of every physical stock change. Populated by _atomic helpers.
class StockMovement(Base):
    __tablename__ = "stock_movements"
    id             = Column(String, primary_key=True)
    item_id        = Column(String, ForeignKey("items.id"), nullable=False)
    branch_id      = Column(String, ForeignKey("branches.id"), nullable=False)
    delta          = Column(Integer, nullable=False)
    before_qty     = Column(Integer, default=0)
    after_qty      = Column(Integer, default=0)
    movement_type  = Column(String, nullable=False)
    source_type    = Column(String)
    source_ref     = Column(String)
    batch_id       = Column(String, ForeignKey("item_batches.id"), nullable=True)
    notes          = Column(Text)
    created_by     = Column(String)
    created_at     = Column(DateTime, default=datetime.utcnow)


# ─── Stock Reservations (Phase 0 — when allow_overselling=False) ─────────────
class StockReservation(Base):
    __tablename__ = "stock_reservations"
    id              = Column(String, primary_key=True)
    item_id         = Column(String, ForeignKey("items.id"), nullable=False)
    branch_id       = Column(String, ForeignKey("branches.id"), nullable=False)
    qty             = Column(Integer, default=0)
    source_type     = Column(String, nullable=False)   # sales_order
    source_ref      = Column(String, nullable=False)
    source_line_id  = Column(String)
    status          = Column(SAEnum(StockReservationStatus), default=StockReservationStatus.active)
    created_at      = Column(DateTime, default=datetime.utcnow)


# ─── Payment Record (Phase 0 — unified money-movement ledger) ────────────────
# Append-only audit of every customer receipt and vendor disbursement.
# Source of truth for payment docs remains customer_payments / vendor_payments;
# this table is the cross-domain index for reporting and future cash reconciliation.
class PaymentRecord(Base):
    __tablename__ = "payment_records"
    id                   = Column(String, primary_key=True)
    number               = Column(String, nullable=False)
    direction            = Column(String, nullable=False)   # receive | pay
    party_type           = Column(String)                   # customer | vendor
    party_id             = Column(String)
    party_name           = Column(String)
    branch_id            = Column(String, ForeignKey("branches.id"), nullable=True)
    branch_name          = Column(String)
    date                 = Column(String, nullable=False)
    amount               = Column(Float, default=0)
    payment_mode         = Column(String)
    payment_ref          = Column(String)
    source_document_type = Column(String, nullable=False)   # customer_payment | vendor_payment
    source_document_id   = Column(String, nullable=False)
    voided               = Column(Boolean, default=False, nullable=False)
    voided_at            = Column(String)
    notes                = Column(Text)
    created_by           = Column(String)
    created_at           = Column(DateTime, default=datetime.utcnow)


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
    id           = Column(String, primary_key=True)
    branch_id    = Column(String, ForeignKey("branches.id"), nullable=False)
    type         = Column(String, nullable=False)   # in | out
    category     = Column(String)
    description  = Column(String, nullable=False)
    amount       = Column(Float, nullable=False)
    ref          = Column(String)
    date         = Column(String, nullable=False)   # YYYY-MM-DD
    time         = Column(String)                   # HH:MM
    by           = Column(String)
    created_at   = Column(DateTime, default=datetime.utcnow)
    # Cash Control Phase 2
    entry_number = Column(String)                   # CE-YYMMDD-seq
    source_type  = Column(String, default="manual") # manual | sale_invoice | customer_payment
                                                    # | sale_return | purchase_payment | vendor_advance
    source_id    = Column(String)                   # id of the originating document (nullable for manual)
    is_system    = Column(Boolean, default=False)   # True = auto-generated; cannot be deleted
    is_voided    = Column(Boolean, default=False)
    voided_at    = Column(DateTime)
    voided_by    = Column(String)
    void_reason  = Column(Text)

    branch = relationship("Branch", back_populates="cash_entries")


# ─── Cash Day Close ────────────────────────────────────────────────────────────
class CashDayClose(Base):
    __tablename__ = "cash_day_closes"
    __table_args__ = (
        UniqueConstraint("branch_id", "date", name="uq_cash_day_close_branch_date"),
    )
    id               = Column(String, primary_key=True)
    branch_id        = Column(String, ForeignKey("branches.id"), nullable=False)
    date             = Column(String, nullable=False)           # YYYY-MM-DD
    opening_balance  = Column(Float, nullable=False, default=0)
    total_cash_in    = Column(Float, nullable=False, default=0)
    total_cash_out   = Column(Float, nullable=False, default=0)
    expected_balance = Column(Float, nullable=False, default=0) # opening + in - out
    physical_count   = Column(Float, nullable=False)
    variance         = Column(Float, nullable=False, default=0) # physical - expected
    variance_reason  = Column(Text)
    notes            = Column(Text)
    closed_by        = Column(String, nullable=False)
    closed_by_id     = Column(String, ForeignKey("users.id"), nullable=True)
    closed_at        = Column(DateTime, nullable=False, default=datetime.utcnow)
    unlocked_by      = Column(String)
    unlocked_at      = Column(DateTime)
    unlock_reason    = Column(Text)
    is_locked        = Column(Boolean, default=True)
    created_at       = Column(DateTime, default=datetime.utcnow)

    branch = relationship("Branch")


# ─── Cash Category ────────────────────────────────────────────────────────────
class CashCategory(Base):
    __tablename__ = "cash_categories"
    id         = Column(String, primary_key=True)
    org_id     = Column(String, ForeignKey("organisations.id"), nullable=False)
    name       = Column(String, nullable=False)
    direction  = Column(String, nullable=False)  # in | out | both
    is_system  = Column(Boolean, default=False)
    active     = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class AdjustmentRequest(Base):
    """Pending/approved/rejected stock adjustment — stock changes only on approve."""
    __tablename__ = "adjustment_requests"
    __table_args__ = (
        UniqueConstraint("branch_id", "ref_number", name="uq_adj_branch_ref"),
    )
    id               = Column(String, primary_key=True)
    ref_number       = Column(String, nullable=False)
    branch_id        = Column(String, ForeignKey("branches.id"), nullable=False)
    branch_name      = Column(String)
    item_id          = Column(String, ForeignKey("items.id"), nullable=False)
    item_name        = Column(String)
    before_qty       = Column(Integer, default=0)
    new_qty          = Column(Integer, nullable=False)
    reason           = Column(String)
    notes            = Column(Text)
    batch_id         = Column(String, nullable=True)
    status           = Column(SAEnum(AdjustmentStatus), default=AdjustmentStatus.pending)
    requested_by     = Column(String)
    approved_by      = Column(String)
    rejected_by      = Column(String)
    rejection_notes  = Column(Text)
    created_at       = Column(DateTime, default=datetime.utcnow)
    resolved_at      = Column(DateTime, nullable=True)

    item = relationship("Item")
    branch = relationship("Branch")


# ─── Stock Adjustment (audit log, written on approve) ─────────────────────────
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
    request_id    = Column(String, nullable=True)
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


# ─── Invoice Template ─────────────────────────────────────────────────────────
class InvoiceTemplateSettings(Base):
    """Singleton invoice print layout (Settings → Invoice Template)."""
    __tablename__ = "invoice_template_settings"
    id                 = Column(String, primary_key=True)
    header_style       = Column(String, default="full")
    show_attr          = Column(Boolean, default=True)
    show_size          = Column(Boolean, default=True)
    show_disc          = Column(Boolean, default=True)
    show_hsn           = Column(Boolean, default=False)
    tax_mode           = Column(String, default="total")
    show_customer      = Column(Boolean, default=True)
    show_payment       = Column(Boolean, default=True)
    show_printed_date  = Column(Boolean, default=True)
    show_store         = Column(Boolean, default=True)
    show_cashier       = Column(Boolean, default=True)
    footer_msg         = Column(Text, default="")
    footer_note        = Column(Text, default="")
    # Legacy columns from first API schema — kept for additive migration.
    show_item_description = Column(Boolean, default=True)
    tax_display        = Column(String, default="")
    footer_text        = Column(Text, default="")
    terms_text         = Column(Text, default="")
    updated_at         = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ─── Audit Log ────────────────────────────────────────────────────────────────
class AuditLog(Base):
    __tablename__ = "audit_logs"
    id         = Column(String, primary_key=True)
    # Optional polymorphic target for record-level timeline queries.
    record_type = Column(String)
    record_id   = Column(String)
    reference_id = Column(String, nullable=True, default=None)
    # Canonical activity event key (e.g. status_changed, payment_recorded).
    event_type  = Column(String)
    # JSON-encoded supplemental payload for cross-links and before/after diffs.
    event_metadata = Column(Text)
    action     = Column(String, nullable=False)
    user_id    = Column(String)
    user_name  = Column(String)
    user_role  = Column(String, nullable=False, default="unknown")
    module     = Column(String)
    reference_id = Column(String)
    ref        = Column(String)
    detail     = Column(Text)
    risk       = Column(String, default="LOW")  # LOW | MEDIUM | HIGH
    ip_address = Column(String)
    device_info = Column(String)
    branch_id  = Column(String)
    metadata_  = Column("metadata", JSON)
    created_at = Column(DateTime, default=datetime.utcnow)


# ─── Activity Comments / Views ───────────────────────────────────────────────
class ActivityComment(Base):
    __tablename__ = "activity_comments"
    __table_args__ = (
        Index("ix_activity_comments_record_created", "record_type", "record_id", "created_at"),
    )
    id          = Column(String, primary_key=True)
    record_type = Column(String, nullable=False)
    record_id   = Column(String, nullable=False)
    author_id   = Column(String, ForeignKey("users.id"), nullable=False)
    body        = Column(Text, nullable=False)
    is_pinned   = Column(Boolean, default=False, nullable=False)
    edited_at   = Column(DateTime)
    deleted_at  = Column(DateTime)
    created_at  = Column(DateTime, default=datetime.utcnow)


class ActivityView(Base):
    __tablename__ = "activity_views"
    __table_args__ = (
        UniqueConstraint("user_id", "record_type", "record_id", name="uq_activity_views_user_record"),
        Index("ix_activity_views_user_record", "user_id", "record_type", "record_id"),
    )
    id            = Column(String, primary_key=True)
    user_id       = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    record_type   = Column(String, nullable=False)
    record_id     = Column(String, nullable=False)
    last_viewed_at = Column(DateTime, default=datetime.utcnow, nullable=False)

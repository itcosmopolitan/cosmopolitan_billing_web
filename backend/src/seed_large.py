"""
Large dashboard/load-test seed.

Run from backend/:
    python src/seed_large.py

Config:
    SEED_MONTHS=6
    SEED_SALES_PER_MONTH=20000
    SEED_PURCHASES_PER_MONTH=2000
    SEED_AUDIT_LOGS_PER_MONTH=30000
    SEED_RANDOM_SEED=42

The script first runs src.seed.seed() so the normal demo master data stays the
base source of truth, then appends production-like transactional volume in
batches. It is deterministic for the same SEED_RANDOM_SEED.
"""
import asyncio
import os
import random
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from src import config

config.load()

from sqlalchemy import select

from src.database import get_async_session
from src.models import (
    AuditLog,
    Branch,
    CashEntry,
    Customer,
    InvoiceStatus,
    Item,
    ItemBatch,
    ItemStock,
    PurchaseBill,
    PurchaseLineItem,
    SaleInvoice,
    SaleLineItem,
    StockTransfer,
    TransferLineItem,
    User,
    Vendor,
)
from src.seed import seed as seed_base


def env_int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


@dataclass
class LargeSeedConfig:
    months: int = env_int("SEED_MONTHS", 6, 1)
    sales_per_month: int = env_int("SEED_SALES_PER_MONTH", 20000, 0)
    purchases_per_month: int = env_int("SEED_PURCHASES_PER_MONTH", 2000, 0)
    audit_logs_per_month: int = env_int("SEED_AUDIT_LOGS_PER_MONTH", 30000, 0)
    random_seed: int = env_int("SEED_RANDOM_SEED", 42, 0)
    batch_size: int = env_int("SEED_BATCH_SIZE", 8000, 1000)
    extra_customers: int = env_int("SEED_EXTRA_CUSTOMERS", 400, 0)


@dataclass
class Counts:
    invoices: int = 0
    invoice_lines: int = 0
    purchases: int = 0
    purchase_lines: int = 0
    cash_entries: int = 0
    audit_logs: int = 0
    batches: int = 0
    transfers: int = 0
    transfer_lines: int = 0


FIRST_NAMES = [
    "Aadhil", "Aisha", "Ananya", "Arjun", "Deepa", "Farhan", "Hassan",
    "Ibrahim", "Kavitha", "Lakshmi", "Meena", "Mohan", "Nisha", "Prakash",
    "Priya", "Ravi", "Reema", "Sanjay", "Suresh", "Zara",
]
LAST_NAMES = [
    "Ahmed", "Anand", "Das", "Hameed", "Krishnan", "Kumar", "Menon",
    "Mohamed", "Nair", "Pillai", "Rahman", "Rasheed", "Reddy", "Sharma",
    "Singh", "Subramanian", "Thomas", "Vijayan",
]
STORE_SUFFIXES = ["Stores", "Mart", "Trading", "Retail", "Provision", "Supermarket"]
EXPENSE_CATEGORIES = ["Transport", "Utilities", "Stationery", "Maintenance", "Tea & Snacks", "Delivery"]
AUDIT_ACTIONS = [
    ("Invoice Created", "Sales", "low"),
    ("Payment Recorded", "Finance", "low"),
    ("Discount Applied", "Sales", "low"),
    ("Stock Adjustment", "Inventory", "medium"),
    ("Transfer Requested", "Inventory", "medium"),
    ("Role Permission Viewed", "Admin", "low"),
    ("Invoice Cancelled", "Sales", "high"),
    ("User Login", "Auth", "low"),
]


def weighted_choice(items, weights):
    return random.choices(items, weights=weights, k=1)[0]


def weighted_day(start: date, day_count: int) -> date:
    days = [start + timedelta(days=i) for i in range(day_count)]
    weights = [1.22 if d.weekday() in (4, 5, 6) else 1.0 for d in days]
    return weighted_choice(days, weights)


def business_timestamp(day: date) -> datetime:
    bucket = random.random()
    if bucket < 0.44:
        hour = random.randint(10, 13)
    elif bucket < 0.80:
        hour = random.randint(17, 20)
    else:
        hour = random.choice([8, 9, 14, 15, 16, 21])
    return datetime.combine(day, dtime(hour, random.randint(0, 59), random.randint(0, 59)))


def money(value: float) -> float:
    return round(float(value), 2)


async def commit_rows(db, rows: list, label: str, force: bool = False) -> int:
    if not rows:
        return 0
    if not force and len(rows) < CURRENT_CONFIG.batch_size:
        return 0
    db.add_all(rows)
    count = len(rows)
    await db.commit()
    rows.clear()
    print(f"    committed {count:>6} {label} objects")
    return count


async def load_base_rows(db):
    branches = (await db.execute(select(Branch).where(Branch.active == True))).scalars().all()
    users = (await db.execute(select(User).where(User.active == True))).scalars().all()
    items = (await db.execute(select(Item).where(Item.active == True))).scalars().all()
    customers = (await db.execute(select(Customer).where(Customer.active == True))).scalars().all()
    vendors = (await db.execute(select(Vendor).where(Vendor.active == True))).scalars().all()
    return branches, users, items, customers, vendors


async def add_extra_customers(db, branches, cfg: LargeSeedConfig) -> list[Customer]:
    if cfg.extra_customers <= 0:
        return []
    rows = []
    branch_weights = branch_weights_for(branches)
    for i in range(1, cfg.extra_customers + 1):
        branch = weighted_choice(branches, branch_weights)
        wholesale = random.random() < 0.22
        if wholesale:
            name = f"{random.choice(LAST_NAMES)} {random.choice(STORE_SUFFIXES)}"
            customer_type = "wholesale"
            credit_limit = random.choice([50000, 75000, 100000, 150000, 200000])
        else:
            name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
            customer_type = "retail"
            credit_limit = random.choice([0, 5000, 10000, 20000])
        rows.append(Customer(
            id=f"cu-lg-{i:05d}",
            name=f"{name} {i}",
            phone=f"9{random.randint(100000000, 999999999)}",
            email=f"customer{i}@example.com",
            branch_id=branch.id,
            credit_limit=credit_limit,
            outstanding=0,
            total_purchases=0,
            type=customer_type,
            active=True,
        ))
    db.add_all(rows)
    await db.commit()
    print(f"    added {len(rows)} extra customers")
    return rows


def branch_weights_for(branches):
    preferred = {
        "br-001": 0.34,
        "br-002": 0.24,
        "br-003": 0.20,
        "br-004": 0.15,
        "br-005": 0.07,
    }
    return [preferred.get(branch.id, 0.08) for branch in branches]


def cashier_weights_for(users):
    preferred = {
        "Arjun M.": 0.34,
        "Kavitha R.": 0.22,
        "Deepa S.": 0.15,
        "Mohan K.": 0.13,
        "Suresh Anand": 0.08,
        "Prakash V.": 0.04,
    }
    return [preferred.get(user.name, 0.05) for user in users]


def item_weights_for(items):
    preferred = {
        "pr-001": 14,
        "pr-002": 13,
        "pr-004": 18,
        "pr-007": 15,
        "pr-009": 16,
        "pr-013": 14,
        "pr-003": 9,
        "pr-005": 8,
        "pr-006": 9,
        "pr-011": 6,
        "pr-015": 5,
        "pr-008": 2,
        "pr-010": 4,
        "pr-012": 4,
        "pr-014": 1,
        "pr-016": 0,
    }
    return [preferred.get(item.id, 3) for item in items]


def choose_customer(customers):
    if random.random() < 0.58:
        return None
    wholesale = [c for c in customers if c.type == "wholesale"]
    retail = [c for c in customers if c.type != "wholesale"]
    pool = wholesale if random.random() < 0.38 and wholesale else retail or customers
    return random.choice(pool)


def invoice_status_and_payment(total: float):
    mode = weighted_choice(
        ["upi", "cash", "card", "credit", "partial"],
        [0.36, 0.28, 0.22, 0.09, 0.05],
    )
    if random.random() < 0.012:
        return "cash", InvoiceStatus.cancelled, 0.0
    if mode == "credit":
        status = InvoiceStatus.overdue if random.random() < 0.18 else InvoiceStatus.pending
        return mode, status, 0.0
    if mode == "partial":
        return mode, InvoiceStatus.partial, money(total * random.uniform(0.28, 0.82))
    return mode, InvoiceStatus.paid, total


async def generate_sales(db, branches, users, items, customers, cfg: LargeSeedConfig, counts: Counts):
    total_sales = cfg.months * cfg.sales_per_month
    if total_sales <= 0:
        return
    print(f"  generating {total_sales:,} sale invoices")
    start_day = date.today() - timedelta(days=(cfg.months * 30) - 1)
    day_count = (date.today() - start_day).days + 1
    branch_weights = branch_weights_for(branches)
    cashier_weights = cashier_weights_for(users)
    item_weights = item_weights_for(items)
    branch_name = {b.id: b.name for b in branches}

    rows = []
    for n in range(1, total_sales + 1):
        branch = weighted_choice(branches, branch_weights)
        cashier = weighted_choice(users, cashier_weights)
        customer = choose_customer(customers)
        created_at = business_timestamp(weighted_day(start_day, day_count))
        line_count = weighted_choice([1, 2, 3, 4, 5, 6], [10, 20, 28, 22, 13, 7])
        wholesale = customer is not None and customer.type == "wholesale"
        chosen_items = []
        while len(chosen_items) < min(line_count, len(items)):
            item = weighted_choice(items, item_weights)
            if item not in chosen_items and item_weights[items.index(item)] > 0:
                chosen_items.append(item)

        line_total = 0.0
        tax_total = 0.0
        line_rows = []
        for idx, item in enumerate(chosen_items, start=1):
            qty = random.randint(8, 60) if wholesale and random.random() < 0.45 else random.randint(1, 6)
            if random.random() < 0.06:
                qty += random.randint(4, 18)
            price = money((item.selling_price or 0) * random.uniform(0.985, 1.025))
            gross = money(qty * price)
            line_discount = money(gross * random.uniform(0.02, 0.08)) if random.random() < 0.08 else 0.0
            taxable = money(gross - line_discount)
            tax = money(taxable * (float(item.tax_rate or 0) / 100))
            line_total += taxable
            tax_total += tax
            line_rows.append(SaleLineItem(
                id=f"si-lg-{n:07d}-{idx:02d}",
                invoice_id=f"inv-lg-{n:07d}",
                item_id=item.id,
                name=item.name,
                qty=qty,
                price=price,
                tax_rate=float(item.tax_rate or 0),
                discount=line_discount,
                line_total=taxable,
            ))

        discount = money((line_total + tax_total) * random.uniform(0.02, 0.10)) if random.random() < 0.12 else 0.0
        total = money(line_total + tax_total - discount)
        payment_mode, status, paid = invoice_status_and_payment(total)
        invoice = SaleInvoice(
            id=f"inv-lg-{n:07d}",
            number=f"INV-LG-{created_at.year}-{n:07d}",
            customer_id=customer.id if customer else None,
            customer_name=customer.name if customer else "Walk-in",
            branch_id=branch.id,
            branch_name=branch_name.get(branch.id, branch.id),
            cashier=cashier.name,
            date=created_at.date().isoformat(),
            subtotal=money(line_total),
            tax_total=money(tax_total),
            discount=discount,
            total=total,
            paid_amount=money(paid),
            payment_mode=payment_mode,
            status=status,
            notes="Large seed invoice",
            created_at=created_at,
        )
        rows.append(invoice)
        rows.extend(line_rows)
        counts.invoices += 1
        counts.invoice_lines += len(line_rows)

        if payment_mode == "cash" and status == InvoiceStatus.paid and n % 8 == 0:
            rows.append(CashEntry(
                id=f"ce-lg-sale-{n:07d}",
                branch_id=branch.id,
                type="in",
                category="Cash Sale",
                description=f"Cash received for {invoice.number}",
                amount=paid,
                ref=invoice.number,
                date=invoice.date,
                time=created_at.strftime("%H:%M"),
                by=cashier.name,
                created_at=created_at,
            ))
            counts.cash_entries += 1

        if n % 25 == 0:
            rows.append(AuditLog(
                id=f"log-lg-sale-{n:07d}",
                action="Invoice Created",
                user_id=cashier.id,
                user_name=cashier.name,
                module="Sales",
                ref=invoice.number,
                detail=f"Created invoice {invoice.number} for {invoice.customer_name} - {money(total)}",
                risk="low",
                created_at=created_at,
            ))
            counts.audit_logs += 1

        if len(rows) >= cfg.batch_size:
            await commit_rows(db, rows, "sales")
        if n % max(1, total_sales // 10) == 0:
            print(f"    sales progress {n:,}/{total_sales:,}")
    await commit_rows(db, rows, "sales", force=True)


async def generate_purchases(db, branches, vendors, items, cfg: LargeSeedConfig, counts: Counts):
    total_purchases = cfg.months * cfg.purchases_per_month
    if total_purchases <= 0:
        return
    print(f"  generating {total_purchases:,} purchase bills")
    start_day = date.today() - timedelta(days=(cfg.months * 30) - 1)
    day_count = (date.today() - start_day).days + 1
    branch_weights = branch_weights_for(branches)
    branch_name = {b.id: b.name for b in branches}

    rows = []
    for n in range(1, total_purchases + 1):
        branch = weighted_choice(branches, branch_weights)
        vendor = random.choice(vendors)
        bill_day = weighted_day(start_day, day_count)
        created_at = datetime.combine(bill_day, dtime(random.randint(8, 17), random.randint(0, 59), 0))
        line_count = random.randint(2, 6)
        chosen = random.sample(items, min(line_count, len(items)))
        subtotal = 0.0
        tax_total = 0.0
        line_rows = []
        for idx, item in enumerate(chosen, start=1):
            qty = random.randint(20, 250)
            cost = money((item.cost_price or 0) * random.uniform(0.96, 1.04))
            line_total = money(qty * cost)
            tax = money(line_total * (float(item.tax_rate or 0) / 100))
            subtotal += line_total
            tax_total += tax
            line_rows.append(PurchaseLineItem(
                id=f"pli-lg-{n:07d}-{idx:02d}",
                bill_id=f"pb-lg-{n:07d}",
                item_id=item.id,
                name=item.name,
                qty=qty,
                cost=cost,
                tax_rate=float(item.tax_rate or 0),
                line_total=line_total,
            ))
        total = money(subtotal + tax_total)
        status = weighted_choice(
            [InvoiceStatus.paid, InvoiceStatus.partial, InvoiceStatus.pending, InvoiceStatus.overdue],
            [0.68, 0.13, 0.14, 0.05],
        )
        if status == InvoiceStatus.paid:
            paid = total
        elif status == InvoiceStatus.partial:
            paid = money(total * random.uniform(0.25, 0.75))
        else:
            paid = 0.0
        rows.append(PurchaseBill(
            id=f"pb-lg-{n:07d}",
            number=f"PUR-LG-{created_at.year}-{n:07d}",
            vendor_id=vendor.id,
            vendor_name=vendor.name,
            branch_id=branch.id,
            branch_name=branch_name.get(branch.id, branch.id),
            date=bill_day.isoformat(),
            due_date=(bill_day + timedelta(days=random.choice([7, 15, 30, 45]))).isoformat(),
            subtotal=money(subtotal),
            tax_total=money(tax_total),
            discount=0,
            total=total,
            paid_amount=paid,
            payment_ref=f"PAY-LG-{n:07d}" if paid else "",
            status=status,
            notes="Large seed purchase",
            created_at=created_at,
        ))
        rows.extend(line_rows)
        counts.purchases += 1
        counts.purchase_lines += len(line_rows)

        if len(rows) >= cfg.batch_size:
            await commit_rows(db, rows, "purchases")
        if n % max(1, total_purchases // 10) == 0:
            print(f"    purchases progress {n:,}/{total_purchases:,}")
    await commit_rows(db, rows, "purchases", force=True)


async def generate_batches(db, branches, items, cfg: LargeSeedConfig, counts: Counts):
    print("  generating extra inventory batches")
    rows = []
    tracked = [item for item in items if item.batch_tracking]
    today = date.today()
    batch_no = 1
    for item in tracked:
        for branch in branches:
            for label, offset, qty_weight in [
                ("EXP", -random.randint(5, 60), 0.10),
                ("NEAR", random.randint(3, 28), 0.22),
                ("MID", random.randint(45, 120), 0.34),
                ("FRESH", random.randint(150, 300), 0.34),
            ]:
                qty = max(1, int((item.reorder_level or 10) * random.uniform(1.5, 5.5) * qty_weight))
                rows.append(ItemBatch(
                    id=f"bt-lg-{batch_no:07d}",
                    item_id=item.id,
                    branch_id=branch.id,
                    batch_number=f"{item.sku}-{label}-{batch_no:07d}",
                    mfg_date=(today - timedelta(days=random.randint(15, 120))).isoformat() if item.expiry_tracking else None,
                    expiry_date=(today + timedelta(days=offset)).isoformat() if item.expiry_tracking else None,
                    quantity=qty,
                    initial_qty=qty + random.randint(0, qty),
                    cost_price=float(item.cost_price or 0),
                    vendor_id=None,
                    source_type="large_seed",
                    source_ref=item.id,
                    received_date=(today - timedelta(days=random.randint(1, 90))).isoformat(),
                    notes=f"Large seed {label.lower()} batch",
                    active=True,
                    created_at=datetime.utcnow() - timedelta(days=random.randint(1, 120)),
                ))
                batch_no += 1
                counts.batches += 1
                if len(rows) >= cfg.batch_size:
                    await commit_rows(db, rows, "batches")
    await commit_rows(db, rows, "batches", force=True)


async def generate_transfers(db, branches, users, items, cfg: LargeSeedConfig, counts: Counts):
    transfer_count = max(50, cfg.months * 120)
    print(f"  generating {transfer_count:,} stock transfers")
    start_day = date.today() - timedelta(days=(cfg.months * 30) - 1)
    rows = []
    for n in range(1, transfer_count + 1):
        from_branch, to_branch = random.sample(branches, 2)
        user = random.choice(users)
        request_date = start_day + timedelta(days=random.randint(0, cfg.months * 30 - 1))
        status = weighted_choice(["pending", "approved", "transit", "received", "rejected"], [0.18, 0.22, 0.18, 0.38, 0.04])
        rows.append(StockTransfer(
            id=f"tr-lg-{n:06d}",
            ref_number=f"TRF-LG-{n:06d}",
            from_branch_id=from_branch.id,
            from_branch_name=from_branch.name,
            to_branch_id=to_branch.id,
            to_branch_name=to_branch.name,
            requested_by=user.name,
            approved_by=random.choice(users).name if status != "pending" else None,
            status=status,
            priority=weighted_choice(["Low", "Normal", "Urgent"], [0.10, 0.75, 0.15]),
            notes="Large seed stock movement",
            request_date=request_date.isoformat(),
            created_at=datetime.combine(request_date, dtime(random.randint(8, 18), random.randint(0, 59), 0)),
        ))
        for idx, item in enumerate(random.sample(items, random.randint(1, 4)), start=1):
            rows.append(TransferLineItem(
                id=f"tli-lg-{n:06d}-{idx:02d}",
                transfer_id=f"tr-lg-{n:06d}",
                item_id=item.id,
                item_name=item.name,
                qty=random.randint(3, 80),
            ))
            counts.transfer_lines += 1
        counts.transfers += 1
        if len(rows) >= cfg.batch_size:
            await commit_rows(db, rows, "transfers")
    await commit_rows(db, rows, "transfers", force=True)


async def generate_cash_entries(db, branches, users, cfg: LargeSeedConfig, counts: Counts):
    print("  generating operating cash entries")
    start_day = date.today() - timedelta(days=(cfg.months * 30) - 1)
    rows = []
    entry_no = 1
    for day_idx in range(cfg.months * 30):
        entry_day = start_day + timedelta(days=day_idx)
        for branch in branches:
            user = random.choice(users)
            rows.append(CashEntry(
                id=f"ce-lg-op-{entry_no:07d}",
                branch_id=branch.id,
                type="in",
                category="Opening Balance",
                description="Daily opening balance",
                amount=money(random.uniform(3000, 18000)),
                ref="",
                date=entry_day.isoformat(),
                time="09:00",
                by=user.name,
                created_at=datetime.combine(entry_day, dtime(9, 0, 0)),
            ))
            counts.cash_entries += 1
            entry_no += 1
            for _ in range(random.randint(1, 3)):
                out_time = dtime(random.randint(10, 19), random.randint(0, 59), 0)
                rows.append(CashEntry(
                    id=f"ce-lg-op-{entry_no:07d}",
                    branch_id=branch.id,
                    type="out",
                    category=random.choice(EXPENSE_CATEGORIES),
                    description="Large seed operating expense",
                    amount=money(random.uniform(80, 4500)),
                    ref="",
                    date=entry_day.isoformat(),
                    time=out_time.strftime("%H:%M"),
                    by=user.name,
                    created_at=datetime.combine(entry_day, out_time),
                ))
                counts.cash_entries += 1
                entry_no += 1
        if len(rows) >= cfg.batch_size:
            await commit_rows(db, rows, "cash")
    await commit_rows(db, rows, "cash", force=True)


async def generate_audit_logs(db, users, cfg: LargeSeedConfig, counts: Counts):
    target = cfg.months * cfg.audit_logs_per_month
    current_from_sales = counts.audit_logs
    remaining = max(0, target - current_from_sales)
    if remaining <= 0:
        return
    print(f"  generating {remaining:,} additional audit logs")
    start_day = date.today() - timedelta(days=(cfg.months * 30) - 1)
    rows = []
    for n in range(1, remaining + 1):
        action, module, risk = random.choice(AUDIT_ACTIONS)
        user = random.choice(users)
        created_at = business_timestamp(start_day + timedelta(days=random.randint(0, cfg.months * 30 - 1)))
        rows.append(AuditLog(
            id=f"log-lg-{n:08d}",
            action=action,
            user_id=user.id,
            user_name=user.name,
            module=module,
            ref=f"LG-{random.randint(1, cfg.months * max(1, cfg.sales_per_month)):07d}",
            detail=f"{action} by {user.name}",
            risk=risk,
            ip_address=f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}",
            created_at=created_at,
        ))
        counts.audit_logs += 1
        if len(rows) >= cfg.batch_size:
            await commit_rows(db, rows, "audit logs")
        if n % max(1, remaining // 10) == 0:
            print(f"    audit progress {n:,}/{remaining:,}")
    await commit_rows(db, rows, "audit logs", force=True)


async def force_dashboard_inventory_shape(db):
    """Make dashboard inventory states obvious without simulating stock effects."""
    print("  shaping current stock for low/out/dead stock scenarios")
    rows = (await db.execute(select(ItemStock))).scalars().all()
    for row in rows:
        if row.item_id == "pr-016":
            row.quantity = max(int(row.quantity or 0), random.randint(24, 72))
        elif row.item_id == "pr-014":
            row.quantity = 0
        elif row.item_id in {"pr-008", "pr-010"}:
            row.quantity = min(int(row.quantity or 0), random.randint(1, 8))
        elif row.item_id in {"pr-001", "pr-002", "pr-004", "pr-009", "pr-013"}:
            row.quantity = max(int(row.quantity or 0), random.randint(80, 420))
    await db.commit()


async def seed_large():
    global CURRENT_CONFIG
    CURRENT_CONFIG = LargeSeedConfig()
    random.seed(CURRENT_CONFIG.random_seed)
    started = time.perf_counter()

    print("🌱 Running base seed first")
    await seed_base()

    counts = Counts()
    AsyncSessionLocal = get_async_session()
    async with AsyncSessionLocal() as db:
        branches, users, items, customers, vendors = await load_base_rows(db)
        customers = customers + await add_extra_customers(db, branches, CURRENT_CONFIG)
        await generate_batches(db, branches, items, CURRENT_CONFIG, counts)
        await generate_sales(db, branches, users, items, customers, CURRENT_CONFIG, counts)
        await generate_purchases(db, branches, vendors, items, CURRENT_CONFIG, counts)
        await generate_transfers(db, branches, users, items, CURRENT_CONFIG, counts)
        await generate_cash_entries(db, branches, users, CURRENT_CONFIG, counts)
        await generate_audit_logs(db, users, CURRENT_CONFIG, counts)
        await force_dashboard_inventory_shape(db)

    duration = time.perf_counter() - started
    print("✅ Large database seed completed")
    print(f"    Total invoices       : {counts.invoices:,}")
    print(f"    Total invoice lines  : {counts.invoice_lines:,}")
    print(f"    Total purchases      : {counts.purchases:,}")
    print(f"    Total purchase lines : {counts.purchase_lines:,}")
    print(f"    Total cash entries   : {counts.cash_entries:,}")
    print(f"    Total audit logs     : {counts.audit_logs:,}")
    print(f"    Total batches        : {counts.batches:,}")
    print(f"    Total transfers      : {counts.transfers:,}")
    print(f"    Total transfer lines : {counts.transfer_lines:,}")
    print(f"    Seed duration        : {duration:.1f}s")


CURRENT_CONFIG = LargeSeedConfig()


if __name__ == "__main__":
    asyncio.run(seed_large())

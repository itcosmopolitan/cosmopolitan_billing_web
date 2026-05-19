"""
Cosmopolitan Pro — Database Seed Script
Run: python src/seed.py

Populates SQLite with the Sri Murugan Traders demo dataset. The chain is
modelled as a Maldives-based retail operation (Male, Addu, Hulhumalé,
Felidhoo + a Hulhumalé warehouse). Earlier revisions had a Chennai/Tamil
Nadu naming throughout; Tier 3 of the audit consolidates everything to
Maldives. India-style GSTIN values and a Tamil Nadu HQ remain on the
Organisation row by design — the parent is registered in TN with overseas
storefronts.
"""
import asyncio
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Load config first before importing database
from src import config

config.load()

from src.database import Base, get_async_session, get_engine
from src.models import (
    AuditLog,
    Branch,
    CashEntry,
    Category,
    Customer,
    Item,
    ItemBatch,
    ItemStock,
    Organisation,
    PurchaseBill,
    PurchaseLineItem,
    Role,
    SaleInvoice,
    SaleLineItem,
    StockTransfer,
    TransferLineItem,
    User,
    UserBranch,
    Vendor,
)
from src.security import hash_password
from src.system_roles import SYSTEM_ROLES


def hp(pw: str) -> str:
    """Bcrypt password hash. Real auth (Phase 1.5) verifies against this via
    src.security.verify_password."""
    return hash_password(pw)

async def seed():
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    AsyncSessionLocal = get_async_session()
    async with AsyncSessionLocal() as db:

        # ── Organisation ──────────────────────────────────────────────────────
        db.add(Organisation(
            id="org-001",
            name="Sri Murugan Traders Pvt Ltd",
            gstin="33AAZCS1429R1Z1",
            pan="AAZCS1429R",
            address="12, Anna Nagar West, Chennai — 600 040",
            phone="044-2626 1234",
            email="accounts@srimurugan.com",
            website="www.srimurugan.com",
            state_code="33",
            financial_year="Apr-Mar",
        ))

        # ── Branches ──────────────────────────────────────────────────────────
        branches = [
            Branch(id="br-001", name="Male",        code="ML", manager="Kavitha R.",  phone="+960-330 1234", address="12, Orchid Magu, Male - 20001", gstin="33AAZCS1429R1Z1", active=True),
            Branch(id="br-002", name="Addu",        code="AD", manager="Mohan K.",    phone="+960-688 5678", address="45, Equatorial Road, Addu City - 20001", gstin="33AAZCS1429R1Z2", active=True),
            Branch(id="br-003", name="Hulhumalé",   code="HM", manager="Ravi S.",     phone="+960-664 3456", address="8, Central Plaza, Hulhumalé - 20001", gstin="33AAZCS1429R1Z3", active=True),
            Branch(id="br-004", name="Felidhoo",    code="FD", manager="Anitha M.",   phone="+960-684 7890", address="22, Island Road, Felidhoo - 20001", gstin="33AAZCS1429R1Z4", active=True),
            Branch(id="br-005", name="Warehouse",   code="WH", manager="Central",     phone="+960-330 0001", address="Plot 14, Industrial Zone, Hulhumalé - 20001", gstin="", active=True),
        ]
        for b in branches:
            db.add(b)

        # ── Roles ─────────────────────────────────────────────────────────────
        for rid, key, label, color, desc, perms in SYSTEM_ROLES:
            db.add(Role(
                id=rid, key=key, label=label, color=color,
                description=desc, permissions=perms,
                is_system=True, active=True,
            ))

        # ── Users ─────────────────────────────────────────────────────────────
        # role_id links to the system role rows added above; the legacy `role`
        # enum column is kept in sync until Phase 3 drops it.
        users = [
            # Demo users intentionally have must_change_password=False so the
            # seeded credentials work straight away for testing / demos / CI.
            # Real users created via POST /users/ default to True (forced
            # change on first login).
            # Every demo user now has an EXPLICIT branch list — the legacy
            # "all_branches=True implies access to all branches" UI was
            # removed 2026-05-18 sixth session. Suresh (super-admin) and
            # Prakash (finance) get all 5 current branches enumerated. If a
            # 6th branch is created later, they must be explicitly granted
            # access (intentional — explicit > implicit).
            User(id="usr-001", name="Suresh Anand", email="suresh@srimurugan.com",  hashed_password=hp("admin123"),    role="super_admin",       role_id="role-super-admin",       branch_id="br-001", avatar="SA", active=True,  must_change_password=False, all_branches=False),
            User(id="usr-002", name="Kavitha R.",   email="kavitha@srimurugan.com", hashed_password=hp("kavitha123"),  role="branch_manager",    role_id="role-branch-manager",    branch_id="br-001", avatar="KR", active=True,  must_change_password=False, all_branches=False),
            User(id="usr-003", name="Arjun M.",     email="arjun@srimurugan.com",   hashed_password=hp("arjun123"),    role="cashier",           role_id="role-cashier",           branch_id="br-001", avatar="AM", active=True,  must_change_password=False, all_branches=False),
            User(id="usr-004", name="Deepa S.",     email="deepa@srimurugan.com",   hashed_password=hp("deepa123"),    role="inventory_manager", role_id="role-inventory-manager", branch_id="br-002", avatar="DS", active=True,  must_change_password=False, all_branches=False),
            User(id="usr-005", name="Prakash V.",   email="prakash@srimurugan.com", hashed_password=hp("prakash123"),  role="finance",           role_id="role-finance",           branch_id="br-001", avatar="PV", active=False, must_change_password=False, all_branches=False),
            User(id="usr-006", name="Mohan K.",     email="mohan@srimurugan.com",   hashed_password=hp("mohan123"),    role="branch_manager",    role_id="role-branch-manager",    branch_id="br-002", avatar="MK", active=True,  must_change_password=False, all_branches=False),
        ]
        for u in users:
            db.add(u)

        # ── User ↔ Branch assignments (multi-branch, 2026-05-18) ──────────────
        # Suresh + Prakash get every branch enumerated (replaces the previous
        # all_branches=True shortcut). Single-branch staff (Kavitha, Arjun,
        # Mohan) get one row each. Deepa (inventory_manager) keeps her two
        # rows to demo the multi-branch UI out of the box: br-002 retail +
        # br-005 warehouse.
        ALL_BRANCH_IDS = ["br-001", "br-002", "br-003", "br-004", "br-005"]
        user_branches = (
            [UserBranch(user_id="usr-001", branch_id=b) for b in ALL_BRANCH_IDS]
            + [UserBranch(user_id="usr-002", branch_id="br-001")]
            + [UserBranch(user_id="usr-003", branch_id="br-001")]
            + [UserBranch(user_id="usr-004", branch_id="br-002")]
            + [UserBranch(user_id="usr-004", branch_id="br-005")]
            + [UserBranch(user_id="usr-005", branch_id=b) for b in ALL_BRANCH_IDS]
            + [UserBranch(user_id="usr-006", branch_id="br-002")]
        )
        for ub in user_branches:
            db.add(ub)

        # ── Categories ────────────────────────────────────────────────────────
        cats = [
            Category(id="cat-001", name="Grains & Pulses",   icon="🌾"),
            Category(id="cat-002", name="Oils & Ghee",       icon="🫙"),
            Category(id="cat-003", name="Dairy & Eggs",      icon="🥛"),
            Category(id="cat-004", name="Snacks & Biscuits", icon="🍪"),
            Category(id="cat-005", name="Beverages",         icon="☕"),
            Category(id="cat-006", name="Household",         icon="🧴"),
            Category(id="cat-007", name="Personal Care",     icon="🪥"),
            Category(id="cat-008", name="Frozen & Chilled",  icon="❄️"),
        ]
        for c in cats:
            db.add(c)

        # ── Items + Stock ─────────────────────────────────────────────────────
        # Tracking flags drive FIFO / FEFO behavior:
        #   batch=True, expiry=True  → FEFO (perishables: dairy, butter, milk,
        #     bread-style snacks). Sales/transfers consume nearest expiry
        #     first; near-expiry tab surfaces these.
        #   batch=True, expiry=False → FIFO (lot-tracked dry goods where we
        #     care about vendor lot but no shelf-life: e.g. cereal, atta).
        #   batch=False              → legacy aggregate stock only.
        items_data = [
            # (id, name, sku, barcode, cat, brand, unit, cost, price, tax, hsn, reorder, emoji, batch, expiry, stock_map)
            ("pr-001","Basmati Rice 5kg",        "GR-001","8901234560001","cat-001","India Gate","Pack",     240, 299,  0, "1006",50,"🌾", True,  False, {"br-001":145,"br-002":62,"br-003":38,"br-004":24,"br-005":320}),
            ("pr-002","Toor Dal 1kg",             "GR-002","8901234560002","cat-001","Tata Sampann","Pack",  120, 148,  5, "0713",60,"🫘", True,  False, {"br-001":220,"br-002":145,"br-003":88,"br-004":66,"br-005":480}),
            ("pr-003","Sunflower Oil 1L",         "OIL-001","8901234560003","cat-002","Fortune","Bottle",    118, 148,  5, "1512",40,"🫙", True,  True,  {"br-001":88,"br-002":56,"br-003":34,"br-004":12,"br-005":240}),
            ("pr-004","Parle-G 800g",             "SN-001","8901234560004","cat-004","Parle","Pack",          38,  50, 18, "1905",80,"🍪", True,  True,  {"br-001":340,"br-002":280,"br-003":190,"br-004":120,"br-005":600}),
            ("pr-005","Amul Butter 500g",         "DY-001","8901234560005","cat-003","Amul","Pack",          118, 150, 12, "0405",30,"🧈", True,  True,  {"br-001":62,"br-002":44,"br-003":28,"br-004":18,"br-005":120}),
            ("pr-006","Aashirvaad Atta 5kg",      "GR-003","8901234560006","cat-001","ITC","Pack",           195, 240,  0, "1101",40,"🌾", True,  False, {"br-001":92,"br-002":68,"br-003":44,"br-004":30,"br-005":280}),
            ("pr-007","Maggi Noodles 12pk",       "SN-002","8901234560007","cat-004","Nestlé","Pack",        150, 192, 18, "1902",50,"🍜", True,  True,  {"br-001":160,"br-002":110,"br-003":72,"br-004":44,"br-005":360}),
            ("pr-008","Surf Excel 1kg",           "HH-001","8901234560008","cat-006","HUL","Pack",           128, 160, 18, "3402",25,"🧼", False, False, {"br-001":8,"br-002":14,"br-003":5,"br-004":22,"br-005":180}),
            ("pr-009","Haldiram Bhujia 200g",     "SN-003","8901234560009","cat-004","Haldiram","Pack",       44,  60, 18, "2106",60,"🥜", True,  True,  {"br-001":280,"br-002":210,"br-003":140,"br-004":95,"br-005":500}),
            ("pr-010","Coconut Oil 500ml",        "OIL-002","8901234560010","cat-002","Parachute","Bottle",  142, 180,  5, "1513",30,"🥥", True,  True,  {"br-001":12,"br-002":28,"br-003":40,"br-004":18,"br-005":200}),
            ("pr-011","Horlicks 500g",            "BV-001","8901234560011","cat-005","GlaxoSmithKline","Jar",218, 280, 18, "2202",20,"🥛", True,  True,  {"br-001":45,"br-002":30,"br-003":18,"br-004":24,"br-005":120}),
            ("pr-012","Dettol Soap 4pk",          "PC-001","8901234560012","cat-007","Reckitt","Pack",        95, 120, 18, "3401",30,"🧴", False, False, {"br-001":95,"br-002":74,"br-003":48,"br-004":36,"br-005":240}),
            ("pr-013","Amul Milk 1L Packet",      "DY-002","8901234560013","cat-003","Amul","Litre",          56,  68,  0, "0401",100,"🥛",True,  True,  {"br-001":180,"br-002":140,"br-003":90,"br-004":70,"br-005":400}),
            ("pr-014","Colgate MaxFresh 150g",    "PC-002","8901234560014","cat-007","Colgate","Tube",        72,  92, 18, "3306",40,"🦷", False, False, {"br-001":64,"br-002":48,"br-003":32,"br-004":44,"br-005":200}),
            ("pr-015","Nescafé Classic 50g",      "BV-002","8901234560015","cat-005","Nestlé","Jar",         148, 188, 18, "2101",20,"☕", True,  True,  {"br-001":38,"br-002":26,"br-003":16,"br-004":20,"br-005":140}),
            ("pr-016","Chana Dal 1kg",            "GR-004","8901234560016","cat-001","Local","Pack",          88, 110,  5, "0713",40,"🫘", True,  False, {"br-001":4,"br-002":8,"br-003":2,"br-004":6,"br-005":350}),
        ]

        # Per-item batch splits. Each entry is (fraction, mfg_offset_days,
        # expiry_offset_days, vendor_id). Tracked items split their seeded
        # stock across these batches so the demo dataset has rich FIFO/FEFO
        # behavior on day one (some near-expiry, some fresh, multiple lots).
        from datetime import date, timedelta as _td

        BATCH_TEMPLATE = [
            # (label, fraction, received_offset_days, mfg_offset_days, expiry_offset_days)
            ("A", 0.35,  -85, -90,  15),   # oldest stock — close to expiry
            ("B", 0.40,  -45, -50,  60),   # mid lot
            ("C", 0.25,  -10, -12, 180),   # freshest lot
        ]
        today_date = date.today()

        def _date(offset_days: int) -> str:
            return (today_date + _td(days=offset_days)).strftime("%Y-%m-%d")

        for row in items_data:
            (pid, name, sku, barcode, cat_id, brand, unit, cost, price, tax,
             hsn, reorder, emoji, batch_tracking, expiry_tracking, stock_map) = row
            item = Item(
                id=pid, name=name, sku=sku, barcode=barcode, category_id=cat_id, brand=brand,
                unit=unit, cost_price=cost, selling_price=price, tax_rate=tax,
                hsn_code=hsn, reorder_level=reorder, emoji=emoji,
                batch_tracking=batch_tracking, expiry_tracking=expiry_tracking,
                active=True,
            )
            db.add(item)
            for br_id, qty in stock_map.items():
                db.add(ItemStock(id=str(uuid.uuid4()), item_id=pid, branch_id=br_id, quantity=qty))
                if not batch_tracking or qty <= 0:
                    continue
                # Split the per-branch quantity across the 3 templated batches,
                # rounding so we still sum to exactly qty.
                allocated = 0
                splits = []
                for idx, (lbl, frac, recv, mfg, exp) in enumerate(BATCH_TEMPLATE):
                    if idx == len(BATCH_TEMPLATE) - 1:
                        chunk = qty - allocated  # last one takes the remainder
                    else:
                        chunk = int(round(qty * frac))
                    if chunk <= 0:
                        continue
                    allocated += chunk
                    splits.append((lbl, chunk, recv, mfg, exp))
                for lbl, chunk, recv, mfg, exp in splits:
                    db.add(ItemBatch(
                        id=str(uuid.uuid4()),
                        item_id=pid,
                        branch_id=br_id,
                        batch_number=f"{sku}-{lbl}-{(today_date.year)}",
                        mfg_date=_date(mfg) if expiry_tracking else None,
                        expiry_date=_date(exp) if expiry_tracking else None,
                        quantity=chunk,
                        initial_qty=chunk,
                        cost_price=cost,
                        vendor_id=None,
                        source_type="opening",
                        source_ref=pid,
                        received_date=_date(recv),
                        notes=f"Seeded opening lot {lbl}",
                        active=True,
                    ))

        # ── Customers ─────────────────────────────────────────────────────────
        customers = [
            Customer(id="cu-001", name="Priya Sharma",   phone="9876543210", email="priya@email.com",    gstin="",                  branch_id="br-001", credit_limit=20000,  outstanding=0,     total_purchases=482000,  type="retail",    active=True),
            Customer(id="cu-002", name="Rajesh Stores",  phone="9445566712", email="rajesh@stores.com",  gstin="33ABCDE1234F1Z5",   branch_id="br-002", credit_limit=100000, outstanding=38400, total_purchases=1864000, type="wholesale", active=True),
            Customer(id="cu-003", name="Meena Krishnan", phone="8776623411", email="meena@email.com",    gstin="",                  branch_id="br-004", credit_limit=10000,  outstanding=6200,  total_purchases=112400,  type="retail",    active=True),
            Customer(id="cu-004", name="Anand Traders",  phone="9810044512", email="anand@traders.in",   gstin="33XYZAB5678G1Z3",   branch_id="br-001", credit_limit=200000, outstanding=84200, total_purchases=4280000, type="wholesale", active=True),
            Customer(id="cu-005", name="Subramanian V.", phone="9500011234", email="",                   gstin="",                  branch_id="br-003", credit_limit=5000,   outstanding=0,     total_purchases=48200,   type="retail",    active=True),
            Customer(id="cu-006", name="Krishnan Stores",phone="9444455123", email="krishnan@email.com", gstin="33PQRST9876H1Z1",   branch_id="br-002", credit_limit=50000,  outstanding=6200,  total_purchases=680000,  type="wholesale", active=False),
        ]
        for c in customers:
            db.add(c)

        # ── Vendors ───────────────────────────────────────────────────────────
        vendors = [
            Vendor(id="vn-001", name="Sri Krishna Traders",    contact_person="Krishnamurthy", phone="9444401234", gstin="33ABCDE0001A1Z1", payment_terms="30 days",  outstanding=0,     total_purchases=2840000),
            Vendor(id="vn-002", name="Madurai Provisions Co.", contact_person="Rajan",         phone="9842201234", gstin="33FGHIJ0002B1Z1", payment_terms="15 days",  outstanding=14200, total_purchases=1240000),
            Vendor(id="vn-003", name="Chennai Oils Ltd",       contact_person="Sundar",        phone="9500012345", gstin="33KLMNO0003C1Z1", payment_terms="Advance",  outstanding=18600, total_purchases=860000),
            Vendor(id="vn-004", name="Tamil Nadu Agri Corp",   contact_person="Senthil",       phone="9445512345", gstin="33PQRST0004D1Z1", payment_terms="45 days",  outstanding=0,     total_purchases=3620000),
            Vendor(id="vn-005", name="Parle Distributor TN",   contact_person="Babu",          phone="9345512345", gstin="33UVWXY0005E1Z1", payment_terms="30 days",  outstanding=12400, total_purchases=640000),
            Vendor(id="vn-006", name="Amul Milk Depot",        contact_person="Rajaram",       phone="9876500001", gstin="33ABCDE1111F1Z1", payment_terms="Weekly",   outstanding=0,     total_purchases=1120000),
        ]
        for v in vendors:
            db.add(v)

        # ── Sale Invoices ─────────────────────────────────────────────────────
        inv_data = [
            {
                "id":"inv-001","number":"INV-2024-1847","customer_id":"cu-002","customer_name":"Rajesh Stores",
                "branch_id":"br-001","branch_name":"Male","cashier":"Arjun M.","date":"2024-04-16",
                "subtotal":10420,"tax_total":222,"discount":0,"total":10642,"paid_amount":10642,
                "payment_mode":"upi","status":"paid","notes":"",
                "items":[
                    {"id":"si-001a","item_id":"pr-001","name":"Basmati Rice 5kg","qty":20,"price":299,"tax_rate":0,"line_total":5980},
                    {"id":"si-001b","item_id":"pr-002","name":"Toor Dal 1kg","qty":30,"price":148,"tax_rate":5,"line_total":4440},
                ],
            },
            {
                "id":"inv-002","number":"INV-2024-1846","customer_id":None,"customer_name":"Walk-in",
                "branch_id":"br-001","branch_name":"Male","cashier":"Arjun M.","date":"2024-04-16",
                "subtotal":430,"tax_total":77.4,"discount":0,"total":507,"paid_amount":507,
                "payment_mode":"cash","status":"paid","notes":"",
                "items":[
                    {"id":"si-002a","item_id":"pr-004","name":"Parle-G 800g","qty":5,"price":50,"tax_rate":18,"line_total":250},
                    {"id":"si-002b","item_id":"pr-009","name":"Haldiram Bhujia 200g","qty":3,"price":60,"tax_rate":18,"line_total":180},
                ],
            },
            {
                "id":"inv-003","number":"INV-2024-1845","customer_id":"cu-001","customer_name":"Priya Sharma",
                "branch_id":"br-001","branch_name":"Male","cashier":"Arjun M.","date":"2024-04-16",
                "subtotal":1280,"tax_total":72,"discount":0,"total":1352,"paid_amount":1352,
                "payment_mode":"card","status":"paid","notes":"",
                "items":[
                    {"id":"si-003a","item_id":"pr-005","name":"Amul Butter 500g","qty":4,"price":150,"tax_rate":12,"line_total":600},
                    {"id":"si-003b","item_id":"pr-013","name":"Amul Milk 1L","qty":10,"price":68,"tax_rate":0,"line_total":680},
                ],
            },
            {
                "id":"inv-004","number":"INV-2024-1844","customer_id":"cu-004","customer_name":"Anand Traders",
                "branch_id":"br-001","branch_name":"Male","cashier":"Kavitha R.","date":"2024-04-16",
                "subtotal":17920,"tax_total":296,"discount":200,"total":18016,"paid_amount":0,
                "payment_mode":"credit","status":"pending","notes":"Net 30 days",
                "items":[
                    {"id":"si-004a","item_id":"pr-006","name":"Aashirvaad Atta 5kg","qty":50,"price":240,"tax_rate":0,"line_total":12000},
                    {"id":"si-004b","item_id":"pr-003","name":"Sunflower Oil 1L","qty":40,"price":148,"tax_rate":5,"line_total":5920},
                ],
            },
            {
                "id":"inv-005","number":"INV-2024-1843","customer_id":None,"customer_name":"Walk-in",
                "branch_id":"br-002","branch_name":"Addu","cashier":"Deepa S.","date":"2024-04-16",
                "subtotal":768,"tax_total":138.24,"discount":0,"total":906,"paid_amount":906,
                "payment_mode":"cash","status":"paid","notes":"",
                "items":[
                    {"id":"si-005a","item_id":"pr-007","name":"Maggi Noodles 12pk","qty":4,"price":192,"tax_rate":18,"line_total":768},
                ],
            },
            {
                "id":"inv-006","number":"INV-2024-1842","customer_id":"cu-004","customer_name":"Anand Traders",
                "branch_id":"br-001","branch_name":"Male","cashier":"Arjun M.","date":"2024-04-15",
                "subtotal":44700,"tax_total":740,"discount":400,"total":45040,"paid_amount":20000,
                "payment_mode":"partial","status":"partial","notes":"Balance ₹25,040 due May 1",
                "items":[
                    {"id":"si-006a","item_id":"pr-001","name":"Basmati Rice 5kg","qty":100,"price":299,"tax_rate":0,"line_total":29900},
                    {"id":"si-006b","item_id":"pr-002","name":"Toor Dal 1kg","qty":100,"price":148,"tax_rate":5,"line_total":14800},
                ],
            },
            {
                "id":"inv-007","number":"INV-2024-1840","customer_id":"cu-006","customer_name":"Krishnan Stores",
                "branch_id":"br-002","branch_name":"Addu","cashier":"Deepa S.","date":"2024-04-04",
                "subtotal":3800,"tax_total":684,"discount":0,"total":4484,"paid_amount":0,
                "payment_mode":"credit","status":"overdue","notes":"Overdue 12 days",
                "items":[
                    {"id":"si-007a","item_id":"pr-004","name":"Parle-G 800g","qty":40,"price":50,"tax_rate":18,"line_total":2000},
                    {"id":"si-007b","item_id":"pr-009","name":"Haldiram Bhujia 200g","qty":30,"price":60,"tax_rate":18,"line_total":1800},
                ],
            },
        ]
        for inv in inv_data:
            db.add(SaleInvoice(
                id=inv["id"], number=inv["number"],
                customer_id=inv["customer_id"], customer_name=inv["customer_name"],
                branch_id=inv["branch_id"], branch_name=inv["branch_name"],
                cashier=inv["cashier"], date=inv["date"],
                subtotal=inv["subtotal"], tax_total=inv["tax_total"],
                discount=inv["discount"], total=inv["total"],
                paid_amount=inv["paid_amount"], payment_mode=inv["payment_mode"],
                status=inv["status"], notes=inv["notes"],
            ))
            for item in inv["items"]:
                db.add(SaleLineItem(
                    id=item["id"], invoice_id=inv["id"],
                    item_id=item["item_id"], name=item["name"],
                    qty=item["qty"], price=item["price"],
                    tax_rate=item["tax_rate"], line_total=item["line_total"],
                ))

        # ── Purchase Bills ────────────────────────────────────────────────────
        bill_data = [
            {
                "id":"pb-001","number":"PUR-2024-0412","vendor_id":"vn-001","vendor_name":"Sri Krishna Traders",
                "branch_id":"br-001","branch_name":"Male","date":"2024-04-16","due_date":"2024-05-16",
                "subtotal":38400,"tax_total":720,"discount":0,"total":39120,"paid_amount":39120,
                "payment_ref":"NEFT-20240416-001","status":"paid",
                "items":[
                    {"id":"pb-001a","item_id":"pr-001","name":"Basmati Rice 5kg","qty":100,"cost":240,"tax_rate":0,"line_total":24000},
                    {"id":"pb-001b","item_id":"pr-002","name":"Toor Dal 1kg","qty":120,"cost":120,"tax_rate":5,"line_total":14400},
                ],
            },
            {
                "id":"pb-002","number":"PUR-2024-0411","vendor_id":"vn-002","vendor_name":"Madurai Provisions Co.",
                "branch_id":"br-002","branch_name":"Addu","date":"2024-04-15","due_date":"2024-04-30",
                "subtotal":22640,"tax_total":352,"discount":0,"total":22992,"paid_amount":11496,
                "payment_ref":"CHQ-1001","status":"partial",
                "items":[
                    {"id":"pb-002a","item_id":"pr-006","name":"Aashirvaad Atta 5kg","qty":80,"cost":195,"tax_rate":0,"line_total":15600},
                    {"id":"pb-002b","item_id":"pr-016","name":"Chana Dal 1kg","qty":80,"cost":88,"tax_rate":5,"line_total":7040},
                ],
            },
            {
                "id":"pb-003","number":"PUR-2024-0410","vendor_id":"vn-003","vendor_name":"Chennai Oils Ltd",
                "branch_id":"br-001","branch_name":"Male","date":"2024-04-14","due_date":"2024-04-24",
                "subtotal":20320,"tax_total":1016,"discount":0,"total":21336,"paid_amount":0,
                "payment_ref":"","status":"pending",
                "items":[
                    {"id":"pb-003a","item_id":"pr-003","name":"Sunflower Oil 1L","qty":100,"cost":118,"tax_rate":5,"line_total":11800},
                    {"id":"pb-003b","item_id":"pr-010","name":"Coconut Oil 500ml","qty":60,"cost":142,"tax_rate":5,"line_total":8520},
                ],
            },
            {
                "id":"pb-004","number":"PUR-2024-0409","vendor_id":"vn-004","vendor_name":"Tamil Nadu Agri Corp",
                "branch_id":"br-003","branch_name":"Hulhumalé","date":"2024-04-13","due_date":"2024-05-28",
                "subtotal":22200,"tax_total":0,"discount":200,"total":22000,"paid_amount":22000,
                "payment_ref":"NEFT-20240413-002","status":"paid",
                "items":[
                    {"id":"pb-004a","item_id":"pr-001","name":"Basmati Rice 5kg","qty":60,"cost":240,"tax_rate":0,"line_total":14400},
                    {"id":"pb-004b","item_id":"pr-006","name":"Aashirvaad Atta 5kg","qty":40,"cost":195,"tax_rate":0,"line_total":7800},
                ],
            },
            {
                "id":"pb-005","number":"PUR-2024-0408","vendor_id":"vn-005","vendor_name":"Parle Distributor TN",
                "branch_id":"br-001","branch_name":"Male","date":"2024-04-12","due_date":"2024-04-12",
                "subtotal":12880,"tax_total":2318,"discount":0,"total":15198,"paid_amount":0,
                "payment_ref":"","status":"overdue",
                "items":[
                    {"id":"pb-005a","item_id":"pr-004","name":"Parle-G 800g","qty":200,"cost":38,"tax_rate":18,"line_total":7600},
                    {"id":"pb-005b","item_id":"pr-009","name":"Haldiram Bhujia 200g","qty":120,"cost":44,"tax_rate":18,"line_total":5280},
                ],
            },
            {
                "id":"pb-006","number":"PUR-2024-0407","vendor_id":"vn-006","vendor_name":"Amul Milk Depot",
                "branch_id":"br-002","branch_name":"Addu","date":"2024-04-11","due_date":"2024-04-18",
                "subtotal":7960,"tax_total":283.2,"discount":0,"total":8243.2,"paid_amount":8243.2,
                "payment_ref":"NEFT-20240411-001","status":"paid",
                "items":[
                    {"id":"pb-006a","item_id":"pr-013","name":"Amul Milk 1L","qty":100,"cost":56,"tax_rate":0,"line_total":5600},
                    {"id":"pb-006b","item_id":"pr-005","name":"Amul Butter 500g","qty":20,"cost":118,"tax_rate":12,"line_total":2360},
                ],
            },
        ]
        for bill in bill_data:
            db.add(PurchaseBill(
                id=bill["id"], number=bill["number"],
                vendor_id=bill["vendor_id"], vendor_name=bill["vendor_name"],
                branch_id=bill["branch_id"], branch_name=bill["branch_name"],
                date=bill["date"], due_date=bill["due_date"],
                subtotal=bill["subtotal"], tax_total=bill["tax_total"],
                discount=bill["discount"], total=bill["total"],
                paid_amount=bill["paid_amount"], payment_ref=bill["payment_ref"],
                status=bill["status"],
            ))
            for item in bill["items"]:
                db.add(PurchaseLineItem(
                    id=item["id"], bill_id=bill["id"],
                    item_id=item["item_id"], name=item["name"],
                    qty=item["qty"], cost=item["cost"],
                    tax_rate=item["tax_rate"], line_total=item["line_total"],
                ))

        # ── Stock Transfers ───────────────────────────────────────────────────
        transfers = [
            {
                "id":"tr-001","ref_number":"TRF-2024-041",
                "from_branch_id":"br-001","from_branch_name":"Male",
                "to_branch_id":"br-002","to_branch_name":"Addu",
                "requested_by":"Mohan K.","approved_by":None,
                "status":"pending","priority":"Urgent","request_date":"2024-04-16",
                "notes":"Urgent — low stock at Addu",
                "items":[
                    {"item_id":"pr-001","item_name":"Basmati Rice 5kg","qty":20},
                    {"item_id":"pr-002","item_name":"Toor Dal 1kg","qty":15},
                    {"item_id":"pr-006","item_name":"Aashirvaad Atta 5kg","qty":10},
                ],
            },
            {
                "id":"tr-002","ref_number":"TRF-2024-040",
                "from_branch_id":"br-005","from_branch_name":"Warehouse",
                "to_branch_id":"br-004","to_branch_name":"Felidhoo",
                "requested_by":"Anitha M.","approved_by":"Suresh Anand",
                "status":"received","priority":"Normal","request_date":"2024-04-15","notes":"",
                "items":[
                    {"item_id":"pr-004","item_name":"Parle-G 800g","qty":80},
                    {"item_id":"pr-009","item_name":"Haldiram Bhujia 200g","qty":60},
                ],
            },
            {
                "id":"tr-003","ref_number":"TRF-2024-039",
                "from_branch_id":"br-002","from_branch_name":"Addu",
                "to_branch_id":"br-003","to_branch_name":"Hulhumalé",
                "requested_by":"Ravi S.","approved_by":"Kavitha R.",
                "status":"transit","priority":"Normal","request_date":"2024-04-14","notes":"",
                "items":[
                    {"item_id":"pr-003","item_name":"Sunflower Oil 1L","qty":20},
                    {"item_id":"pr-010","item_name":"Coconut Oil 500ml","qty":15},
                ],
            },
        ]
        for t in transfers:
            db.add(StockTransfer(
                id=t["id"], ref_number=t["ref_number"],
                from_branch_id=t["from_branch_id"], from_branch_name=t["from_branch_name"],
                to_branch_id=t["to_branch_id"], to_branch_name=t["to_branch_name"],
                requested_by=t["requested_by"], approved_by=t["approved_by"],
                status=t["status"], priority=t["priority"],
                request_date=t["request_date"], notes=t["notes"],
            ))
            for item in t["items"]:
                db.add(TransferLineItem(
                    id=str(uuid.uuid4()), transfer_id=t["id"],
                    item_id=item["item_id"], item_name=item["item_name"], qty=item["qty"],
                ))

        # ── Cash Entries ──────────────────────────────────────────────────────
        cash_entries = [
            CashEntry(id="ce-001", branch_id="br-001", type="in",  category="Opening Balance",  description="Opening cash balance",               amount=5000,  ref="",              date="2024-04-16", time="09:00", by="Kavitha R."),
            CashEntry(id="ce-002", branch_id="br-001", type="in",  category="Cash Sale",         description="POS-2024-1840 cash received",         amount=1240,  ref="POS-2024-1840", date="2024-04-16", time="10:42", by="Arjun M."),
            CashEntry(id="ce-003", branch_id="br-001", type="out", category="Electricity",       description="TNEB electricity bill payment",        amount=2400,  ref="TNEB-APR24",    date="2024-04-16", time="11:30", by="Kavitha R."),
            CashEntry(id="ce-004", branch_id="br-001", type="in",  category="Cash Sale",         description="POS-2024-1841 cash received",         amount=3480,  ref="POS-2024-1841", date="2024-04-16", time="12:15", by="Arjun M."),
            CashEntry(id="ce-005", branch_id="br-001", type="out", category="Vendor Payment",    description="Cash payment to rice supplier",       amount=1800,  ref="",              date="2024-04-16", time="14:00", by="Kavitha R."),
            CashEntry(id="ce-006", branch_id="br-001", type="out", category="Transport",         description="Auto delivery charge",                amount=360,   ref="",              date="2024-04-16", time="15:30", by="Arjun M."),
            CashEntry(id="ce-007", branch_id="br-001", type="in",  category="Cash Sale",         description="Multiple POS transactions batch",     amount=8640,  ref="",              date="2024-04-16", time="16:00", by="Arjun M."),
            CashEntry(id="ce-008", branch_id="br-001", type="out", category="Stationery",        description="Receipt paper rolls 10 packs",       amount=200,   ref="",              date="2024-04-16", time="16:45", by="Arjun M."),
        ]
        for ce in cash_entries:
            db.add(ce)

        # ── Audit Logs ────────────────────────────────────────────────────────
        logs = [
            AuditLog(id=str(uuid.uuid4()), action="Invoice Created",    user_id="usr-003", user_name="Arjun M.",    module="Sales",    ref="INV-2024-1847", detail="Created invoice for Rajesh Stores — ₹10,642", risk="low"),
            AuditLog(id=str(uuid.uuid4()), action="Discount Applied",   user_id="usr-002", user_name="Kavitha R.",  module="Sales",    ref="INV-2024-1844", detail="Invoice discount ₹200 applied (1.1%)",         risk="low"),
            AuditLog(id=str(uuid.uuid4()), action="Transfer Approved",  user_id="usr-001", user_name="Suresh Anand",module="Inventory",ref="TRF-2024-041",  detail="Approved stock transfer Male→Addu (3 items)",    risk="medium"),
            AuditLog(id=str(uuid.uuid4()), action="Payment Recorded",   user_id="usr-003", user_name="Arjun M.",   module="Finance",  ref="INV-2024-1842", detail="Partial payment ₹20,000 for Anand Traders",     risk="low"),
            AuditLog(id=str(uuid.uuid4()), action="Cash Entry",         user_id="usr-002", user_name="Kavitha R.",  module="Cash",    ref="CE-003",        detail="Cash out ₹2,400 — Electricity TNEB-APR24",      risk="low"),
            AuditLog(id=str(uuid.uuid4()), action="Invoice Cancelled",  user_id="usr-002", user_name="Kavitha R.",  module="Sales",   ref="INV-2024-1839", detail="Invoice cancelled — Customer return",            risk="high"),
            AuditLog(id=str(uuid.uuid4()), action="Stock Adjustment",   user_id="usr-004", user_name="Deepa S.",    module="Inventory",ref="ADJ-041",       detail="Basmati Rice reduced 78→62 — Physical count",   risk="medium"),
            AuditLog(id=str(uuid.uuid4()), action="User Login",         user_id="usr-001", user_name="Suresh Anand",module="Auth",    ref="SYS",           detail="Admin login from 103.x.x.x (Chrome/Windows)",   risk="low"),
        ]
        for log in logs:
            db.add(log)

        await db.commit()
        print("✅  Database seeded successfully!")
        print("    Branches: 5  |  Items: 16  |  Stock entries: 80")
        print("    Batches  : ~3 lots per branch per tracked item (FIFO/FEFO ready)")
        print(f"    Customers: 6 |  Vendors: 6 |  Users: 6  |  Roles: {len(SYSTEM_ROLES)}")
        print("    Invoices: 7  |  Bills: 6   |  Transfers: 3")
        print("    Cash entries: 8  |  Audit logs: 8")

if __name__ == "__main__":
    asyncio.run(seed())

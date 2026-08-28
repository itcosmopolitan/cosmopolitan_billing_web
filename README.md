# Cosmopolitan Pro

**Multi-branch retail billing, POS, inventory, and management platform**

---

## ✨ Features

### 🧾 Point of Sale
- Touch-friendly product grid with category filter and barcode search
- Live cart with quantity controls, GST calculation, discounts
- 4 payment modes: Cash, Card, UPI, Credit
- Hold & resume multiple bills simultaneously
- Keyboard shortcuts: `F2` search · `F4` hold · `F8` complete sale
- **Thermal receipt printing + WhatsApp share**

### 📦 Inventory
- Multi-branch stock view across all stores + warehouse
- Low stock alerts, reorder level tracking
- Stock adjustment with full audit trail (count / damage / theft)
- Item master: SKU, barcode, HSN, GST rate, cost/selling price, margin %

### ↔ Stock Transfers
- 4-step workflow: Request → Approve → Dispatch → Receive
- Auto stock deduction at source, credit at destination
- Transfer audit trail

### 🛒 Sales & Purchases
- Invoice + purchase bill register with filters
- Quotations, credit notes, purchase orders, GRN
- Record payments (partial/full), track outstanding balances

### 💰 Cash Control
- Daily petty cash register per branch
- Day-close reconciliation with variance detection

### 📊 Reports
- Sales Register · Purchase Register · GST Tax Summary
- Stock Movement · Branch Comparison · Margin Analysis

### ⚙ Settings & Admin
- Users & Roles (6 role types), branch management
- Org profile, tax config, document numbering
- Full audit trail with risk levels

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ with npm
- Python 3.10+

### One-command launch

```bash
# macOS / Linux
chmod +x run.sh && ./run.sh

# Windows
run.bat
```

Open **http://localhost:3000**
API Docs: **http://localhost:8080/api/docs**

---

---

## 🛠 Tech Stack

| | |
|---|---|
| Frontend | React 18 + Vite + Tailwind CSS + Zustand |
| Charts | Recharts |
| Backend | Python FastAPI + SQLAlchemy (async) |
| Database | SQLite (swap to PostgreSQL for production) |

---

## 📁 Structure

```
cosmopolitan_billing_web/
├── frontend/src/
│   ├── pages/          # 12 full-featured pages
│   ├── components/     # UI library + Receipt + Layout
│   ├── store/          # Zustand (app state + POS cart)
│   ├── api/            # Axios API client
│   ├── auth/           # useCan, RequireAuth/RequirePerm guards
│   └── utils/          # Helpers + seed data
├── backend/src/
│   ├── main.py         # FastAPI app
│   ├── security.py     # JWT + require_perm dependency
│   ├── permissions.py  # Permission catalog
│   ├── system_roles.py # 6 seeded system roles
│   ├── models.py       # 16+ ORM models
│   ├── seed.py         # Demo data seeder
│   └── routes/         # 14 API route files (incl. roles, permissions)
├── docs/               # USERS_AND_ROLES, APPROVAL_FLOW, NOTIFICATIONS, …
├── run.sh              # macOS/Linux launcher
├── run.bat             # Windows launcher
├── stop.bat            # Windows stop
└── restart.bat         # Windows restart
```

---

## Re-seed demo data

```bash
cd backend && python src/seed.py
```

## Production build

```bash
cd frontend && npm run build   # → frontend/dist/
```

MIT License

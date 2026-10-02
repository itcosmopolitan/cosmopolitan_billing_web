# Clubbed Inventory (Stock Pool) for POS — Implementation Specification v2

Revised against the actual codebase (FastAPI + async SQLAlchemy + PostgreSQL, React/Zustand POS) and the business decisions below.

> **Revision v3:** Payment status is no longer a restriction for direct POS clubbed-stock sales. Credit, partial and unpaid POS invoices may draw from other pool branches. Every cross-branch allocation must be recorded and cancellation/return must restore stock to the exact original source branch and batch.

---

## 1. Objective

Let a POS cashier at Branch A sell against the **combined stock of all branches in a stock pool**, while everything else stays branch-specific:

- Selling price, tax, invoice, invoice numbering, sales reports → **selling branch (A)**
- Physical stock ownership and stock reports → **owning branch**
- Branch inventory remains the source of truth. Clubbed stock is **calculated, never stored**.

```text
Branch A = 20, Branch B = 30  →  Pool stock = 50 (calculated)
Cashier at A sells 25         →  A: 0, B: 25, invoice belongs to A at A's price
```

> **Rule:** Quantities may be pooled. Prices, invoices and sales revenue are never pooled.

---

## 2. Decisions (confirmed) and assumptions (please confirm)

### Confirmed business decisions

| # | Decision |
|---|---|
| D1 | **Cross-branch selling is supported** (Option B). |
| D2 | **Transfer price = item cost at the owning (source) branch.** Tracked items: cost of the consumed batch. Untracked items: owning branch's effective cost (`ItemBranchConfig.cost_price`, falling back to `Item.cost_price`). |
| D3 | **Auto-fulfilment.** Stock is deducted from the owning branch at billing time. No approval, no in-transit state. Proof lives in the invoice's **Audit log and Activity log**. |
| D4 | **Clubbed stock is not restricted by payment status.** Fully paid, credit, partial and unpaid invoices may use clubbed stock, provided every cross-branch allocation is recorded and is reversible to its original source branch/batch. All allocation and sale changes remain atomic. |
| D5 | **Batch and expiry-tracked items must be supported.** |
| D6 | **Allocation priority:** selling branch first, then other pool branches with the most stock. |

### Assumptions made from the codebase review (confirm or correct)

| # | Assumption |
|---|---|
| A1 | "Cost at the branch from where the item is sold" means the **branch the stock is taken from (B)**, not the selling branch. |
| A2 | **Serial tracking does not exist in the codebase** (no model, flag, API or invoice manifest). Serial items are therefore out of scope; pool draws support batch, expiry and untracked items only. If serial tracking is planned, it needs its own spec first. |
| A3 | Pool draws are allowed for **direct POS checkout (`origin='pos'`) regardless of payment status**, including fully paid, credit, partial and unpaid invoices. Each pool allocation must be recorded against the invoice so cancellation/return can restore stock to the exact original source branch/batch. Approval workflows and sales-order/quotation conversion remain branch-local unless separately enabled later. |
| A4 | **Returns and cancellations restock at the selling branch (A).** The units were transferred to A as part of the sale (see §7), so existing return and cancel code keeps working unchanged. Moving stock back to B is a normal transfer if the business wants it. |
| A5 | **Expired batches are never drawn from other branches.** (Current FEFO sells expired lots at the selling branch; that existing behaviour is not changed here.) |
| A6 | Cashiers see the **pool total** only, not other branches' individual quantities. |
| A7 | Branches have separate GSTINs; the codebase has no GST/accounting treatment for inter-branch movement. This spec records full data for it but implements none. **Confirm the tax treatment with your accountant.** |

---

## 3. Codebase facts this design relies on

| Area | Fact (from code review) | Consequence |
|---|---|---|
| Stock | `item_stock(item_id, branch_id, quantity)` is the operational balance; `item_batches` hold tracked stock; `stock_movements` is an audit ledger (not a rebuild source) | Pool total = SUM over members at read time |
| Helpers | `_atomic.py`: `adjust_stock_atomic`, `consume_batches_atomic`, `add_batch_atomic`; `_stock_ledger.py`: `record_stock_movement` | Reuse these; do **not** reuse transfer **routes** (two-phase, separate commits, approvals) |
| Batches | Branch-scoped; transfer receive recreates the batch at the destination, copying number, dates, vendor, cost | Same pattern for pool receipts |
| Sale flow | `sales.py › create_invoice` → `_consume_sale_line_stock` (branch-local, FEFO if expiry tracked else FIFO) → single `db.commit()` | Pool allocation slots in before the commit, same transaction |
| Logging | Audit/activity rows are written **after** commit in a separate commit (`_write_post_commit_audit`) | Pool-draw proof must be written **inside** the sale transaction |
| Overselling | `Organisation.allow_overselling` defaults to true; aggregate clamps to zero | Must never overdraw a *non-selling* branch |
| Idempotency | None on `/sales/` | Required before cross-branch draws (a retry would move B's stock twice) |
| Pricing | `create_invoice` trusts submitted line prices; no server re-resolution | Out of scope, but a test must prove pooling never alters price |
| Schema | Runtime `create_all()` + additive helpers in `database.py`; Alembic exists separately | New tables auto-create; new columns need an additive helper **and** an Alembic file |
| Tenancy | No tenant key; `Organisation` is a singleton | Pools need no tenant column |
| Reports | `/reports/stock-movement` is **document-derived** (sales lines + purchase lines + transfer docs), not from `stock_movements` | Must be extended or B will not reconcile |
| Profit | Margin/COGS reports use global `Item.cost_price` | Unchanged here; allocation rows store true cost for future use |

---

## 4. Data model

### 4.1 `stock_pools`

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| name | varchar | unique |
| active | bool | inactive pools are ignored everywhere |
| allow_cross_branch_sales | bool | default **false**; this is the rollout switch (no feature-flag service exists) |
| created_by, created_at, updated_at | | |

### 4.2 `stock_pool_branches`

| Column | Type | Notes |
|---|---|---|
| id | PK | |
| pool_id | FK → stock_pools | |
| branch_id | FK → branches | **UNIQUE** (a branch belongs to at most one pool) |
| created_by, created_at | | |

Membership removal is a hard delete; the change is recorded in the audit log (§12).

### 4.3 `pool_sale_allocations` (append-only proof of every cross-branch draw)

One row per **source branch and source batch** portion of an invoice line.

| Column | Notes |
|---|---|
| id | PK |
| invoice_id, invoice_line_id | the sale it served |
| pool_id | |
| sale_branch_id | A |
| owner_branch_id | B |
| item_id, qty | `qty` uses the same numeric type as `SaleLineItem.qty` (fractional quantities exist) |
| unit_cost, cost_source | `batch` or `branch_cost` (D2) |
| source_batch_id, source_batch_no, expiry_date | nullable for untracked items |
| dest_batch_id | batch created at A (nullable) |
| out_movement_id, in_movement_id | links to `stock_movements` rows |
| created_by, created_at | |

Indexes: `(invoice_id)`, `(owner_branch_id, created_at)`, `(sale_branch_id, created_at)`. Rows are never updated or deleted.

### 4.4 `sale_invoices` additions

| Column | Notes |
|---|---|
| client_request_id | varchar(64), nullable; unique with `branch_id` where not null (idempotency, §9) |
| pool_drawn | bool default false; cheap flag for UI badges and filters |

### 4.5 `stock_movements`

No schema change. New movement types: `pool_transfer_out` (at B) and `pool_transfer_in` (at A), with `source_type='pool_sale'` and `source_ref=<invoice number>`.

---

## 5. Pool rules and validation

- A branch belongs to **at most one** pool (DB unique constraint).
- Only **active** branches can be members; an inactive branch's stock does not count and is never drawn.
- A pool needs **at least 2 members** to be activated.
- Pool membership of the selling branch must be checked **server-side on every sale**, never trusted from the client.
- Admin UI shows a warning if members have **different GSTINs** (see A7).
- Stock in a branch counts toward the pool regardless of that branch's own listing status for the item, unless the item is globally inactive.
- An item is sellable at A only if it is listed and priced at A. Pool stock does not make an unlisted item sellable there.
- Pool CRUD and membership changes are audit-logged and require `stock_pools.manage`.

---

## 6. Stock calculation

Pooled quantity for `(item, selling_branch A)`:

```text
members      = active branches in A's active pool
untracked    = SUM(item_stock.quantity)                       over members
tracked      = SUM(item_batches.remaining) WHERE active
               AND remaining > 0 AND (expiry_date IS NULL OR expiry_date >= today)
               over members
pool_stock   = untracked or tracked, per the item's batch_tracking flag
```

Never stored. Computed in one grouped query per POS page of items (`GROUP BY item_id` over the page's item IDs), using the existing indexes: `item_stock (item_id, branch_id)` unique and `item_batches (item_id, branch_id, active)`.

---

## 7. Cross-branch sale design: "transfer-in, then sell"

A cross-branch sale is processed as **an instant internal transfer from B to A, then a normal sale at A**.

```text
B: pool_transfer_out  -5   (cost = B's batch/branch cost)
A: pool_transfer_in   +5   (batch recreated at A with same number, dates, cost)
A: sale               -25  (existing code path, invoice at A, A's price)
```

Why this shape:

- The invoice, its batch manifest, returns, cancellations and A's reports keep working **unchanged**, because all sale-side stock lives at A.
- B's ledger shows a clean, explainable transfer-out; B's reconciliation balances.
- Cost travels with the units, so nothing is lost for later COGS work.

Pool receipts do **not** recompute A's weighted-average cost: the units are sold immediately and never sit in A's stock.

### 7.1 Allocation algorithm (per invoice line, when `stock_mode='clubbed'`)

1. Compute A's own sellable quantity (non-expired for tracked items) and take `min(needed, A_available)` from A through the existing path.
2. `shortfall = needed − taken_from_A`. If zero, no pool rows are written.
3. Candidates = other active members of A's pool, excluding branches with nothing sellable. Sort by sellable quantity **descending**, ties by `branch_id` ascending (deterministic).
4. Draw greedily. Tracked items: FEFO batches at that branch (expiry ascending, NULLs last, then received date), **expired batches excluded** (A5). Never draw more than a branch's sellable quantity. Non-selling branches are never clamped or overdrawn, regardless of `allow_overselling`.
5. For each drawn portion, inside the sale transaction:
   1. `consume_batches_atomic` / `adjust_stock_atomic` at B with `movement_type='pool_transfer_out'`.
   2. `add_batch_atomic` at A (the existing transfer exemption for duplicate batch numbers applies) plus `adjust_stock_atomic` with `movement_type='pool_transfer_in'`.
   3. Insert the `pool_sale_allocations` row.
6. If a shortfall still remains after all members:
   - `allow_overselling = false` → reject the whole invoice (HTTP 409 `insufficient_pool_stock`), full rollback.
   - `allow_overselling = true` → the remainder follows today's behaviour at A. B is never involved.
7. Run the normal sale consumption at A for the **full line quantity**, passing an **explicit `batch_allocation`** for tracked items: A's own FEFO batches plus the batches just created from B. This stops FEFO at A from picking some other lot (for example an expired one) and leaving the transferred stock behind.

### 7.2 Eligibility

Pool draws occur only if **all** are true:

- request has `stock_mode='clubbed'`
- `origin='pos'` direct checkout, invoice fully paid at creation (A3)
- A is in an **active** pool with `allow_cross_branch_sales = true`
- user has `pos.use_pool_stock`

Otherwise the sale is processed exactly as today. A branch-mode request **never** touches another branch.

### 7.3 Cost

| Item type | `unit_cost` | `cost_source` |
|---|---|---|
| Tracked | consumed source batch `cost_price` | `batch` |
| Untracked | owning branch effective cost (`ItemBranchConfig.cost_price` → `Item.cost_price`) | `branch_cost` |

Stored on every allocation row and on the recreated A batch. Existing profit reports keep using global cost; they are not worse off and not changed by this feature.

---

## 8. Concurrency and atomicity

- Everything in §7 runs in the **same session transaction** as invoice creation, ending in the existing single `db.commit()`. Any exception rolls back the invoice, A's changes, B's deductions and the allocation rows together.
- **Lock order** (prevents deadlocks across terminals):
  1. Process invoice lines sorted by `item_id`.
  2. For each item, `SELECT … FOR UPDATE` the `item_stock` rows of all pool members ordered by `branch_id`.
  3. Lock batch rows ordered by `(branch_id, batch_id)`.
- **Recompute availability after locking** and decide allocation from the locked values. The earlier read is advisory only. Do not rely on a pre-lock availability check.
- Concurrent terminals selling the same last units: the second request fails with 409 and nothing is changed.
- `FOR UPDATE` is not enforced by SQLite; **concurrency tests must run on PostgreSQL**.

---

## 9. Idempotency

- POS generates a UUID `client_request_id` per checkout attempt and **reuses it on retry**.
- `/sales/` looks up `(branch_id, client_request_id)` first; if found, returns the existing invoice without any stock movement.
- A unique-index violation from two simultaneous identical requests is caught, rolled back, and the existing invoice is returned.
- Required for pool draws; recommended for all POS sales.

---

## 10. API changes

### 10.1 POS item list (extend `items.py › list_items`)

```http
GET /items/?branch_id=1&pos_mode=true&stock_mode=clubbed
```

Per item (existing fields unchanged):

```json
{
  "id": 101,
  "selling_price": 1000,
  "available_stock": 20,
  "pool_id": 10,
  "pool_stock": 50,
  "pool_sellable": true
}
```

- `selling_price` always comes from the current branch's effective price. There is **no pooled price field**.
- `pool_id`, `pool_stock` are `null` in branch mode.
- `stock_mode=clubbed` when the branch is not in an active pool, or the user lacks `pos.use_pool_stock` → `409 branch_not_in_active_pool` / `403`.

### 10.2 Create invoice (extend `sales.py › create_invoice` / `SaleCreate`)

New optional fields: `stock_mode` (`"branch"` default | `"clubbed"`), `client_request_id`.

Response adds `pool_allocations: []` when any draw occurred.

### 10.3 New endpoints (new router `stock_pools.py`)

| Method | Path | Permission |
|---|---|---|
| GET | `/stock-pools` | `stock_pools.view` |
| POST / PATCH / DELETE | `/stock-pools[/{id}]` | `stock_pools.manage` |
| POST | `/stock-pools/{id}/branches` | `stock_pools.manage` |
| DELETE | `/stock-pools/{id}/branches/{branch_id}` | `stock_pools.manage` |
| GET | `/stock-pools/for-branch/{branch_id}` | `pos.use` (returns pool summary or null) |
| GET | `/sales/{invoice_id}/pool-allocations` | invoice view permission |
| GET | `/reports/pool-issues` | `reports.view` |

All branch inputs go through the existing branch-scope checks (`_resolve_branch_scope`, `security.py`).

---

## 11. Permissions

Add to `permissions.py` and the frontend `useCan`:

| Permission | Purpose |
|---|---|
| `stock_pools.view` | See pools and members |
| `stock_pools.manage` | Create/edit pools, membership, `allow_cross_branch_sales` |
| `pos.use_pool_stock` | Switch POS to clubbed mode and sell from the pool |

A cashier needs access only to branch A. Pool configuration, not user-branch access, authorizes reading B's stock through the pool.

---

## 12. Audit log and Activity log (the proof)

For **every invoice with a pool draw**, write these **before the sale commit, in the same transaction** (do not use the post-commit helper for these):

**Invoice Activity log** (`record_type='sales_invoice'`, via `_log_sales_invoice_history`) — one event, human-readable `detail`:

```text
Stock drawn from other branches (pool "Chennai Combined"):
5 × Premium Shirt taken from Branch B (batch LOT-22, exp 2027-03-31, cost ₹600.00/unit)
and transferred to Branch A to fulfil this sale. Transfer-out recorded at Branch B,
transfer-in at Branch A. Invoice, price and tax remain with Branch A.
```

Structured `event_metadata` JSON: pool id/name, per-allocation owner branch, batch, qty, `unit_cost`, `cost_source`, movement ids, acting user.

**Audit log** (`AuditLog`) — two entries, event type `pool_stock_draw`:

1. `branch = A`, linked to the invoice (selling branch view).
2. `branch = B`, same invoice reference (owning branch can see why its stock fell).

**Implementation notes**

- Verify that `build_audit_entry` and `_log_sales_invoice_history` do not commit internally; if they do, add non-committing variants and use those.
- Any failure writing these rows aborts the sale, so a draw can never exist without proof.
- `pool_sale_allocations` is the permanent structured evidence; the log entries are the readable narrative.
- Pool admin changes (create, edit, add/remove branch, toggle cross-branch) get ordinary audit entries.
- **UI:** `ActivityDrawer.jsx` currently renders only `detail`. Keep `detail` self-sufficient, and optionally render `event_metadata` as an allocation table. The invoice view shows a "Stock sourced from other branches" panel (from `/sales/{id}/pool-allocations`) and a `pool_drawn` badge in the sales list.

---

## 13. Returns, cancellations, edits

**Important business rule:** if a sale used clubbed stock, a cancellation or return must restore each quantity to the **same source branch and source batch** from which it was originally taken. Do not simply return all units to the selling branch.

Example:

```text
Initial:
  Branch A = 2
  Branch B = 10

Credit invoice at A = 5 units

Allocation:
  A supplies 2
  B supplies 3

After invoice:
  A = 0
  B = 7

Invoice cancelled:
  A receives back 2
  B receives back 3

Final:
  A = 2
  B = 10
```

For tracked stock, the allocation must also retain the source batch:

```text
A / Batch A001 → 2
B / Batch B001 → 2
B / Batch B002 → 1
```

On cancellation/return, restore the quantities to those same branch/batch locations where possible, preserving cost and expiry information.

| Scenario | Behaviour |
|---|---|
| Sales return | Reverse the original allocation where the returned quantity can be traced to a pool allocation. Restore the corresponding quantity to the original source branch/batch. |
| Invoice cancellation | Reverse every pool allocation: units originally taken from A return to A; units taken from B return to B; units from C return to C, etc. |
| Return void/undo | Reverse only the previous return operation and restore the quantities to the locations from which the return had reduced stock. |
| Pool allocation rows | Never modify or delete the original allocation rows. Record separate reversal/restock movements and link them to the original allocation/invoice. |

The cancellation/return implementation must be atomic. If any source branch/batch cannot be restored, the complete reversal must fail and roll back rather than partially restoring stock.

```text
SOURCE BRANCH/BATCH
       ↓
pool_transfer_out
       ↓
DESTINATION / SELLING BRANCH
       ↓
sale
       ↓
cancellation / return
       ↓
reverse allocation
       ↓
ORIGINAL SOURCE BRANCH/BATCH
```

---

## 14. Reports and other consumers of stock

| Consumer | Change |
|---|---|
| `/reports/current-stock`, low/out-of-stock, expiry, branch stock summary | **None.** They show physical branch stock. |
| `/reports/stock-movement` (document-derived union) | **Extend:** add `pool_sale_allocations` as a fourth source: a "Pool issue" out-row for B and a "Pool receipt" in-row for A. Without this, B will not reconcile. |
| `/reports/stock-transfers` | Unchanged; pool movements are intentionally not transfer documents. |
| **New:** `/reports/pool-issues` | For B (and admins): units issued to other branches' sales: date, invoice, selling branch, item, batch, qty, unit cost, total. |
| Sales / revenue / tax reports | **None.** Revenue stays at A. |
| Profit / margin / valuation | No change (global cost). Allocation `unit_cost` is stored for a future branch-cost COGS improvement. |
| Stock alerts | Automatic: `adjust_stock_atomic` refreshes B's low/out-of-stock alerts. |
| Dashboard materialized views | No query change. Subject to the existing refresh lag. |
| Sales-order/invoice approval/quotation conversion | Remain branch-local (A3). |

---

## 15. Frontend

- **Store** (`store/index.js`): per-branch `stockMode` (`branch` | `clubbed`). Selector shown only if `/stock-pools/for-branch` returns an active pool with cross-branch enabled **and** the user has `pos.use_pool_stock`.
- **`POSPage.jsx`**: pass `stock_mode` to `itemsAPI.list` and `salesAPI.create`; generate and reuse `client_request_id` per checkout attempt.
- **Product card:** branch mode shows `Branch stock: 20`; clubbed mode shows `Pool stock: 50 • Here: 20`. Price is always the branch price. No pooled price anywhere.
- **Cart / checkout:** when a line exceeds branch stock in clubbed mode, show a clear notice: *"5 units will be drawn from other branches in this pool and transferred at cost."* Cashier confirms by completing checkout.
- **`BatchAllocationModal.jsx`:** manual picking is limited to **branch A's own batches**. The pool portion is system-allocated.
- **Settings → Branches** (`SettingsPage.jsx`): new "Stock Pools" section: create pool, add/remove branches, active toggle, "Allow cross-branch sales" toggle, GSTIN-mismatch warning.
- **Invoice view / `ActivityDrawer.jsx`:** pool panel and event rendering as in §12.
- **Reports:** "Pool Issues" report page.

---

## 16. Edge cases

| Case | Behaviour |
|---|---|
| A = 0, B = 20 | Pool 20; sale draws all from B |
| Item not listed/priced at A | Not sellable at A, even with pool stock |
| Branch removed from pool mid-flight | Takes effect on the next request; an in-progress sale holds locks and completes consistently |
| Pool or branch deactivated | Stock excluded; branch mode continues to work |
| Expired lots at B | Excluded from pool stock and never drawn |
| Same batch number exists at A and B | Allowed; recreated batch at A follows the transfer exemption, with no merge |
| Fractional quantities | Supported; allocation quantities use the sale-line numeric type |
| Insufficient across pool | Per `allow_overselling`; B never overdrawn |
| Retry after timeout | Idempotent; returns the same invoice |
| Partial/credit/unpaid POS bill requesting pool stock | Allowed when clubbed mode is enabled; every source branch/batch allocation is recorded so cancellation/return can restore stock to the original source |
| Zero-quantity recreated batches at A | Follow existing consumed-batch handling (verify they are deactivated or ignored consistently) |
| Missing `item_stock` row at A | Pool receipt must create it (verify `adjust_stock_atomic` upserts) |

---

## 17. Testing

**Unit**
- Pool stock calculation: 20+30, 0+30, 20+0, many branches, inactive branch, inactive pool, no pool, expired batches excluded.
- Allocation order (current first, then most stock, ties by `branch_id`), FEFO within a branch, explicit batch allocation at A.

**Billing**
- Invoice branch = A; price = A's price (A ₹1,000 vs B ₹1,200); numbering at A.
- Untracked, batch-tracked and expiry-tracked draws; fractional quantity.
- Movements: `pool_transfer_out` at B, `pool_transfer_in` + `sale` at A; `source_ref` = invoice number.
- `unit_cost` correct for batch and branch cost.
- Branch-mode request never touches B; A3 flows never draw.
- Insufficient pool with `allow_overselling` true and false; B never negative.

**Atomicity and concurrency (PostgreSQL)**
- Two terminals selling the last pooled units: exactly one succeeds.
- Forced failure after B's deduction: everything rolls back.
- Opposite-order multi-item carts: no deadlock.
- Idempotent retry, including simultaneous identical requests.

**Audit proof**
- Activity and audit rows exist and are committed with the sale; a forced log failure aborts the sale.
- Both branches' audit entries are present; allocation rows are immutable.

**Returns and cancellation**
- Full and partial return, cancel, and return-void restore pooled quantities to the exact original source branch/batch, with correct cost and expiry; original allocation rows remain immutable and reversal movements are recorded.

**Reports**
- B's stock-movement reconciles (opening + purchases − sales − pool issues ± transfers = closing).
- Sales reports remain branch-correct; Pool Issues report matches allocations.

**Permissions and admin**
- Pool CRUD validation (duplicate branch, inactive branch, <2 members); `pos.use_pool_stock` enforced server-side.

Use `test_approval_lifecycle.py::test_pos_direct_with_pos_use` as the POS billing template; add new tests alongside.

---

## 18. Rollout

1. **Schema and admin:** new tables and columns (additive helper in `database.py` plus an Alembic file), pool CRUD, permissions. `allow_cross_branch_sales` off.
2. **Read-only clubbed view:** `stock_mode` on the item list and the POS selector, no cross-branch selling yet.
3. **Backend allocation:** §7–9, 12 with the full test suite, no UI exposure.
4. **POS UI for cross-branch selling,** notice and idempotency key.
5. **Reports and UI proof:** stock-movement extension, Pool Issues report, invoice panel and drawer rendering.
6. **Pilot:** enable `allow_cross_branch_sales` on one pool; reconcile B's stock daily for two weeks; then expand.

---

## 19. Out of scope / follow-ups

- Serial-number tracking (not in codebase).
- GST/accounting treatment of inter-branch movement (A7).
- Branch-cost-based COGS and valuation in margin reports (data is captured in `pool_sale_allocations`).
- Returning stock to the owning branch automatically.
- Server-side re-validation of submitted line prices in `create_invoice` (recommended hardening, independent of this feature).
- Pool-level dashboards and notifications to the owning branch.
- Pool draws for sales-order/quotation conversion and approval workflows (unless separately enabled). Credit, partial and unpaid direct POS bills are in scope; their allocations must be reversible to the original source branch/batch.

---

## 20. Design principle

```text
PRICE      → selling branch (A)
INVOICE    → selling branch (A)
REVENUE    → selling branch (A)
STOCK      → owning branch, moved to A by an auditable internal transfer at cost
POOL       → a calculated availability view; never stored, never priced
```

# Users & Roles — Design & Implementation Plan

**Status:** Approved design, awaiting Phase 1 implementation.
**Owner of decisions:** product / repo owner (decisions ratified 2026-05-05).
**Audience:** any future agent or developer picking this up.

This doc is the source of truth for *why* the RBAC system is shaped the way it is.
If you disagree with a decision below, raise it with the owner before changing it —
several decisions were deliberately chosen over alternatives that look attractive.

---

## 1. Goal

Turn the cosmetic role/permission strings that already exist in `frontend/src/utils/seedData.js → ROLES` into a real, **server-enforced**, editable, persisted RBAC system. Server is the source of truth; the client only uses permissions to hide UI.

## 2. Where We Started

| Layer | State at start of work |
|---|---|
| **DB** | `users` table with single `role` enum column (`super_admin`, `branch_manager`, `cashier`, `inventory_manager`, `finance`, `purchase_admin`). `hashed_password` column existed but was never written. No `roles` or `permissions` tables. |
| **Auth** | `routes/auth.py` validated against a hardcoded `DEMO_USERS` dict, returned a fake token like `demo-jwt-suresh`. `/auth/me` always returned the super-admin. No JWT verification middleware anywhere. |
| **Permissions** | Defined as static strings in `frontend/src/utils/seedData.js → ROLES`. Never enforced. Store hard-coded `user.permissions: ['*']`. |
| **UI** | `SettingsPage.jsx → "Users & Roles"` tab could list/invite/edit/disable users. The "Roles & Permissions" card was read-only. |
| **Audit** | `AuditLog` table existed; nothing wrote to it. |

---

## 3. Ratified Decisions (do not silently revisit)

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Custom roles may only pick permissions from the static `PERMISSIONS` catalog** defined in `backend/src/permissions.py`. No free-form permission strings. | Compile-time guarantee that every `require_perm("foo.bar")` corresponds to a real, grantable permission. Prevents silently-un-grantable perms. |
| **D2** | **No per-branch permission scoping in this phase.** A user has at most one `branch_id` (existing column), and `branch_id` continues to act as a *data filter* on routes that already use it. Permission *checks* are global. | Halves the schema and dependency complexity. Re-evaluate in Phase 4 if "cashier at Anna Nagar only" becomes a real requirement. |
| **D3** | **`auth_enforced` flag defaults to `false`.** When false, the `current_user` dependency returns the seeded super-admin and `require_perm(...)` never 403s — preserves today's open-demo behavior. Ops opts in by setting `AUTH_ENFORCED=true`. | Lets us ship schema + UI in Phase 1 without breaking the running demo. Ops flips the switch when ready. |
| **D4** | **Single role per user.** `users.role_id` is a plain FK, not a join table. | Half the codebase complexity. Adding multi-role later is a non-breaking migration (FK → join table). |
| **D5** | **Keep a separate `pos.*` namespace** alongside `invoices.*`. POS-terminal-specific actions (open till, override price, apply discount, refund) are distinct from general invoice CRUD. | Granular control: a cashier can have `pos.*` but not `invoices.delete`. |
| **D6** | **Backfill `role_id` for existing users** during the boot-time migration, mapping the legacy `users.role` enum string → the matching `roles.key`. | Existing demo users keep working without manual DB surgery. |

---

## 4. Permission Catalog (final)

Lives in `backend/src/permissions.py`. Single source of truth. The frontend gets it via `GET /api/v1/permissions/catalog`.

```python
PERMISSIONS = {
    "dashboard": ["view", "export"],
    "items":     ["view", "create", "edit", "delete", "export", "adjust"],
    "invoices":  ["view", "create", "edit", "delete", "cancel", "export"],
    "pos":       ["use", "discount", "override_price", "refund",
                  "hold_bill", "split_payment", "open_till", "close_till"],
    "purchases": ["view", "create", "edit", "delete", "export"],
    "transfers": ["view", "create", "approve", "receive"],
    "customers": ["view", "create", "edit", "delete"],
    "vendors":   ["view", "create", "edit", "delete"],
    "cash":      ["view", "entry", "edit", "close", "export"],
    "reports":   ["view", "export"],
    "users":     ["view", "create", "edit", "delete", "manage_roles"],
    "settings":  ["view", "edit"],
    "audit":     ["view"],
}
```

**Wildcards:** `"*"` = all permissions; `"module.*"` = all actions in that module. Both expanded at check time by `permissions.expand()`.

**Adding a new permission:** add it here, regenerate seed if you want a system role to grant it, and that's it. Custom roles get it as a checkbox in the UI matrix automatically (catalog flows through `/permissions/catalog`).

---

## 5. Schema Changes

### 5.1 New table: `roles`

```python
class Role(Base):
    __tablename__ = "roles"
    id          = Column(String, primary_key=True)
    key         = Column(String, unique=True, nullable=False)  # stable slug, used in code
    label       = Column(String, nullable=False)
    description = Column(Text, default="")
    color       = Column(String, default="blue")               # for UI chips
    permissions = Column(JSON, default=list)                   # ["items.view", "*", ...]
    is_system   = Column(Boolean, default=False)               # blocks delete; perms still editable
    active      = Column(Boolean, default=True)
    created_at  = Column(DateTime, default=datetime.utcnow)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
```

System roles cannot be deleted. `super_admin` is special-cased on every save: `permissions` is forced back to `["*"]`. UI hides the perm matrix for it (just shows a "Full Access" badge).

### 5.2 Modify `users`

- **Add** `role_id = Column(String, ForeignKey("roles.id"))`.
- **Keep** the legacy `role` enum column **for one release cycle** as a denormalised cache so existing UI that reads `u.role` keeps working. Drop it in Phase 3 (first Alembic migration).
- **Start using** `hashed_password` (passlib bcrypt — already in `requirements.txt`).
- **Add (optional, for hardening — can defer to Phase 4):** `password_changed_at`, `failed_login_count`, `locked_until`.

### 5.3 Migration strategy

The repo doesn't use Alembic and `models.py` changes don't auto-migrate (per `CLAUDE.md`). We use a **hybrid**:

- **Additive parts** (the new `roles` table) handled by the existing `Base.metadata.create_all()` on app startup.
- **Column adds on existing tables** (`users.role_id`) handled by an idempotent boot-time migration in `database.py`:
  ```python
  # in get_engine() or a new init_schema()
  async with engine.begin() as conn:
      await conn.run_sync(Base.metadata.create_all)
      await _ensure_columns(conn, "users", [
          ("role_id", "VARCHAR"),
          # ... future additive columns here
      ])
      await _backfill_role_ids(conn)   # D6
  ```
- **Destructive changes** (eventually dropping `users.role`, renaming, FK changes) → introduce Alembic in Phase 3 as the *first* migration. Existing `retailos.db` files would need either an Alembic stamp or a one-shot `npm run seed`.

The Phase-1 boot migration **must be idempotent** — running on an already-migrated DB must be a no-op.

### 5.4 D6 backfill — exact mapping

```python
LEGACY_ROLE_TO_ID = {
    "super_admin":       "role-super-admin",
    "branch_manager":    "role-branch-manager",
    "cashier":           "role-cashier",
    "inventory_manager": "role-inventory-manager",
    "finance":           "role-finance",
    "purchase_admin":    "role-purchase-admin",
}
```

Backfill: `UPDATE users SET role_id = <mapped> WHERE role_id IS NULL AND role = ?`. Runs once at boot; safe to re-run.

---

## 6. System Roles (seeded permission sets)

Seeded by `backend/src/seed.py`. Mirrors today's `frontend/src/utils/seedData.js → ROLES` but uses wildcards where the original list was effectively all-of-module, and adds `pos.*` per D5.

| Role key | Permissions |
|---|---|
| `super_admin` | `["*"]` |
| `branch_manager` | `dashboard.*`, `pos.*`, `invoices.*`, `items.view`, `items.edit`, `items.adjust`, `items.export`, `transfers.create`, `transfers.approve`, `customers.*`, `vendors.view`, `cash.view`, `cash.edit`, `reports.*` |
| `cashier` | `dashboard.view`, `pos.use`, `pos.hold_bill`, `pos.split_payment`, `invoices.create`, `invoices.view`, `invoices.cancel`, `cash.view`, `cash.entry`, `customers.view` |
| `inventory_manager` | `dashboard.view`, `items.*`, `transfers.*`, `purchases.view`, `purchases.create`, `reports.*` |
| `finance` | `dashboard.*`, `invoices.view`, `invoices.export`, `purchases.view`, `purchases.export`, `cash.*`, `reports.*` |
| `purchase_admin` | `dashboard.view`, `purchases.*`, `vendors.*`, `reports.view` |

Note: `cashier` deliberately does **not** get `pos.discount` / `pos.override_price` / `pos.refund` — those are escalation actions a manager grants per-deployment.

---

## 7. Backend Architecture

### 7.1 Auth flow

```
POST /auth/login            verify password (bcrypt) → issue JWT { sub: user_id, iat }
GET  /auth/me               decode JWT → user + role + expanded perms
POST /auth/logout           client-side token discard (no server state)
POST /auth/change-password  in-app password change
POST /auth/refresh          (Phase 4)
```

**Permissions are NOT embedded in the JWT.** They're looked up from `roles.permissions` per request, with a small in-process LRU cache (TTL ~30s). Why: revoking a permission takes effect within 30s without forcing logout. For a single-process SQLite deployment this is fine; revisit if you ever go multi-process.

### 7.2 The single dependency

`backend/src/security.py`:

```python
from fastapi import Depends, HTTPException, Header
from src import config
from src.permissions import expand

async def current_user(authorization: str | None = Header(None),
                       db = Depends(get_db)) -> User:
    settings = config.get()
    if not settings.auth_enforced:
        return await _demo_super_admin(db)        # D3
    user = await _decode_and_load(authorization, db)
    if not user or not user.active:
        raise HTTPException(401, "Not authenticated")
    return user

def require_perm(*needed: str):
    async def _dep(user: User = Depends(current_user),
                   db = Depends(get_db)) -> User:
        granted = expand(await _granted_perms(user, db))
        if "*" not in granted and not (set(needed) & granted):
            raise HTTPException(403, f"Missing permission: {' or '.join(needed)}")
        return user
    return _dep
```

### 7.3 Applying gates to routes

Mechanical change across all 12 routers. Two patterns:

```python
# When you don't need the user object:
@router.post("/", dependencies=[Depends(require_perm("items.create"))])
async def create_item(...): ...

# When you do (audit, ownership checks, etc.):
async def create_invoice(data: InvoiceCreate,
                         user: User = Depends(require_perm("invoices.create")),
                         db = Depends(get_db)):
    ...
```

### 7.4 New routes

```
GET    /api/v1/permissions/catalog      → { "items": ["view","create",...], ... }
GET    /api/v1/roles/                   → list all roles (+ user_count)
GET    /api/v1/roles/{id}               → single role
POST   /api/v1/roles/                   → create custom (perm: users.manage_roles)
PUT    /api/v1/roles/{id}               → update label/desc/color/permissions
DELETE /api/v1/roles/{id}               → delete (blocked if is_system or user_count > 0)
```

Existing `/users` routes get `Depends(require_perm("users.*"))` and `POST /users` starts hashing the password.

### 7.5 Audit hook

Wrap `current_user` in a middleware that, after a successful state-changing call (POST/PUT/PATCH/DELETE), writes an `AuditLog` row with `user_id`, `user_name`, `module` (from URL prefix), `ref` (resource id when known), `risk` (lookup table by route), and `ip_address` (`request.client.host`).

Risk levels:
- `high`: `users.*`, `roles.*`, `item_master.delete`, `invoices.delete`, `pos.refund`, `pos.override_price`
- `medium`: most other writes
- `low`: not logged (reads)

This finally fills the `AuditLog` table the UI already pretends to read on `/audit`.

### 7.6 Config additions (`backend/src/config.py` + `.env.example`)

```ini
AUTH_ENFORCED=false
JWT_SECRET_KEY=change-me-in-production
JWT_ALGORITHM=HS256
JWT_EXPIRATION_HOURS=24
```

`config.load()` ordering must still hold (see `CLAUDE.md` gotchas).

---

## 8. Frontend Architecture

### 8.1 Permission helper — one file, used everywhere

`frontend/src/auth/permissions.js`:

```js
import { useAppStore } from '@/store'

const expand = (granted = [], catalog = {}) => {
  const out = new Set()
  if (granted.includes('*')) {
    Object.entries(catalog).forEach(([m, acts]) =>
      acts.forEach(a => out.add(`${m}.${a}`)))
    return out
  }
  granted.forEach(p => {
    if (p.endsWith('.*')) {
      const mod = p.slice(0, -2)
      ;(catalog[mod] || []).forEach(a => out.add(`${mod}.${a}`))
    } else out.add(p)
  })
  return out
}

export const useCan = () => {
  const { permissions, permCatalog } = useAppStore()
  const set = expand(permissions, permCatalog)
  return (...needed) => needed.some(p => set.has(p))
}
```

Usage:

```jsx
const can = useCan()
{can('items.create') && <button onClick={openAdd}>+ Add Item</button>}
```

### 8.2 Store changes (`frontend/src/store/index.js`)

Add to `useAppStore`:

```js
permissions: [],     // flat list from server, e.g. ["items.view", "items.create"]
permCatalog: {},     // from /permissions/catalog
roles: [],           // for the Roles editor UI
setSession: ({ user, permissions, permCatalog }) =>
  set({ user, permissions, permCatalog }),
clearSession: () =>
  set({ user: null, permissions: [], roles: [] }),
```

`partialize` of the persisted slice should NOT persist `permissions` (security: always re-fetch on app boot). Currently persisted: `activeBranch`, `theme`, `sidebarCollapsed` — leave that alone.

### 8.3 Login flow

```
POST /auth/login          → token
localStorage.setItem('retailos_token', token)
GET  /auth/me             → user (with role)
GET  /permissions/catalog → catalog
useAppStore.getState().setSession({ user, permissions: user.permissions, permCatalog })
navigate('/dashboard')
```

On hard reload of any page: `App.jsx` calls `/auth/me` and `/permissions/catalog` *before* rendering routes if a token is present. While that's pending, render a tiny splash to avoid flicker.

### 8.4 Route guards (closes the open hole `CLAUDE.md` calls out)

`frontend/src/auth/guards.jsx`:

```jsx
export function RequireAuth({ children }) {
  const { user } = useAppStore()
  return user ? children : <Navigate to="/login" replace />
}
export function RequirePerm({ perm, children }) {
  const can = useCan()
  return can(perm) ? children : <Forbidden requiredPerm={perm} />
}
```

Wire in `App.jsx`:

```jsx
<Route path="/items"
  element={<RequirePerm perm="items.view"><ItemsPage /></RequirePerm>} />
```

Wrap the whole `AppShell` in `<RequireAuth>`. The 401 axios interceptor stays as a safety net.

### 8.5 Sidebar trims itself

`Sidebar.jsx` already renders nav items from a static array. Tag each with a permission and `.filter()` against `useCan()` so users don't see (and click into) routes they can't enter.

### 8.6 Roles editor UI

Replace the read-only "Roles & Permissions" card in `SettingsPage.jsx` with:

- **Roles table:** Name · Color · #Users · System? · Actions
- **+ New Role** button → modal with label / description / color
- **Edit** on each row → modal with a **permission matrix**:
  - Rows = modules (from `permCatalog`)
  - Columns = actions
  - Header checkbox per row toggles `module.*`
  - Master checkbox toggles `*`
  - **Save** → `PUT /roles/{id}` → toast → refresh roles list
- **Delete** disabled (with tooltip) if `is_system` or `users_using > 0`
- **Super Admin** row: matrix replaced by a "Full Access" badge; permissions field is non-editable

The existing "Invite User" / "Edit User" modals get one change: the **Role** select pulls from `/roles/` instead of the hardcoded list.

---

## 9. Phased Rollout

Ship in 4 PRs. Each is reviewable, reversible, and leaves the app working.

### Phase 1 — Schema + catalog + roles API + frontend wiring (no enforcement)

- New `Role` model + `users.role_id` column.
- Idempotent boot-time migration in `database.py` (column-add + role backfill, D6).
- `permissions.py` catalog + `GET /permissions/catalog`.
- `routes/roles.py` full CRUD (gates added in Phase 2).
- `seed.py` updated: 6 system roles + linked users + bcrypt hashes.
- Frontend: `auth/permissions.js`, `auth/guards.jsx`, store fields, `useCan()`. **No callers yet.**
- Roles editor UI in Settings (talks to `/roles` and `/permissions/catalog`).
- `AUTH_ENFORCED=false` (default).

✅ **Smoke test:**
- `GET /permissions/catalog` returns the dict.
- `GET /roles/` returns 6 system roles.
- All existing demo users have `role_id` set.
- Existing UI works exactly as before.
- New Roles editor renders, can create/edit/delete custom roles.

### Phase 2 — Real JWT + enforce on the must-have modules

Cover the user's stated must-haves: dashboard view; items add/remove/edit/view; invoices add/remove/edit/view.

- `security.py` with `current_user` and `require_perm`.
- Real JWT issue/verify in `auth.py` (passlib + python-jose, both already in `requirements.txt`).
- Apply `Depends(require_perm(...))` to **only** `dashboard`, `items`, `sales` (= invoices) routes.
- Sidebar trimming + `RequirePerm` route guards on the same three pages.
- `+ Add Item` / `Edit` / `Delete` buttons in `ItemsPage` gated by `useCan()`.
- Same for `SalesPage` / `POSPage` create-invoice flows.
- Set `AUTH_ENFORCED=true` in `.env.example` (devs flip it locally when ready).

✅ **Acceptance:** `cashier` user logs in, can create invoices but **cannot** see "+ Add Item" on Items, **and** gets a 403 if they POST `/items/` directly via curl.

### Phase 3 — Roll out to remaining modules

- Apply `require_perm` to `purchases`, `transfers`, `customers`, `vendors`, `cash`, `reports`, `users`, `branches`.
- Audit-log writes for state-changing routes.
- Introduce **Alembic** as the first non-additive migration: drop `users.role` enum column.

### Phase 4 — Polish

- `/auth/refresh`, lockout on N failed logins, password reset flow, force-change-on-first-login.
- Per-branch permission scoping (revisit D2 if needed).
- Maker-checker workflow (e.g. "approve invoice > ₹50K").
- Session-replay protection (token versioning).

---

## 10. File-by-File Checklist (Phase 1)

```
backend/src/
├─ permissions.py                    NEW   catalog + expand()
├─ security.py                       NEW   current_user, require_perm
│                                          (require_perm imported in Phase 2)
├─ models.py                         MOD   add Role; add users.role_id
├─ database.py                       MOD   _ensure_columns(), _backfill_role_ids()
├─ config.py                         MOD   auth_enforced, jwt_*
├─ seed.py                           MOD   system roles, bcrypt user passwords, link role_id
└─ routes/
   ├─ __init__.py                    MOD   register roles + permissions routers
   ├─ auth.py                        MOD   real bcrypt + JWT (Phase 2)
   ├─ users.py                       MOD   hash password on create
   ├─ roles.py                       NEW   full CRUD, blocks deleting system/in-use
   └─ permissions.py                 NEW   GET /catalog

frontend/src/
├─ auth/
│  ├─ permissions.js                 NEW   useCan(), expand
│  └─ guards.jsx                     NEW   RequireAuth, RequirePerm, Forbidden
├─ store/index.js                    MOD   permissions, permCatalog, roles, setSession
├─ api/index.js                      MOD   rolesAPI, permissionsAPI; auth/me on app boot
├─ App.jsx                           MOD   bootstrap permCatalog before routes mount
├─ pages/
│  ├─ auth/LoginPage.jsx             MOD   call /auth/me + /permissions/catalog post-login
│  └─ settings/
│     ├─ SettingsPage.jsx            MOD   Roles section reads from /roles
│     └─ RoleEditor.jsx              NEW   permission matrix component
```

backend/.env.example: add `AUTH_ENFORCED=false`, `JWT_*` keys.

---

## 11. Conventions to Follow

- **ID prefixes:** `role-<slug>` for system roles (e.g. `role-super-admin`); `uuid.uuid4().hex` for custom roles. Matches the prefix-PK convention in `CLAUDE.md`.
- **Permission strings:** lowercase `module.action`; never camelCase or with spaces. Wildcards `*` and `module.*` only.
- **`require_perm` placement:** prefer the `dependencies=[...]` form unless the route body needs the `User` object. Keep gates at the *route* level, not deep inside service functions.
- **Audit:** never call `_audit(...)` directly from a route handler — let the middleware do it. Routes shouldn't know about audit logs.
- **Frontend gating:** never gate using `user.role === 'cashier'`. Always `useCan('items.create')`. Roles change; permissions are stable.
- **Tests:** there is no test harness in the repo (`CLAUDE.md`). Don't claim to have run tests. Add manual smoke-test steps to the PR description instead.

---

## 12. Out of Scope (intentionally)

- Per-branch permission scoping (D2, deferred).
- Multi-role per user (D4, deferred).
- OAuth / SSO.
- Field-level permissions (e.g. "can see cost_price").
- Time-bound permissions ("cashier between 9am–6pm").
- Approval workflows / maker-checker (Phase 4).

---

## 13. Open / Future Questions (re-evaluate before Phase 4)

1. Once enforcement is on, do we want to expose **"impersonate user"** for super-admins (with audit)?
2. Should **password rotation** be enforced (e.g. every 90 days)?
3. **Read-only super-admin?** Useful for support staff who shouldn't be able to mutate.
4. Does `pos.refund` need a **maker-checker** flow on day one, or can a cashier with the perm do it directly?

---

## 14. Quick Reference for Future Agents

- **Where do I add a new permission?** → `backend/src/permissions.py` `PERMISSIONS` dict. Done.
- **How do I gate a new route?** → `dependencies=[Depends(require_perm("module.action"))]`.
- **How do I gate a new button in React?** → `const can = useCan(); {can('module.action') && <Button .../>}`
- **How do I add a new system role?** → Edit the seed list in `backend/src/seed.py`. **Re-seed wipes data**, so prefer adding via the Roles editor UI for live deployments.
- **Where is "the user can do this" decided?** → Server: `require_perm` in the route. Client: `useCan` in the component. Both must agree.
- **Can I trust `user.role` for branching logic?** → No. Use permissions. The legacy `role` enum will be dropped in Phase 3.

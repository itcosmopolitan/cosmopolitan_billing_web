# Issues Log

Living register of bugs and behavioural issues found in the app. New
problems get appended; resolved ones flip status to **Resolved** with the
fix details added inline (don't delete entries — the history is the value).

## How to use this file

- Add a new entry under "Open issues" with the next ID (`ISS-NNN`, zero-padded).
- Severity: **critical** (blocks work / data loss / security) · **high** (feature broken) · **medium** (wrong behaviour, workaround exists) · **low** (cosmetic).
- When fixing, update **Status** to `Resolved`, fill in **Fix**, **Files touched**, and **Resolved**, and move the whole entry under "Resolved issues" preserving its ID.
- Keep details concise but specific — name files, line numbers, root cause, not vague descriptions.
- Reference design docs (e.g. `docs/USERS_AND_ROLES.md`) instead of repeating their content.

## Status snapshot

| ID | Status | Severity | Title |
|---|---|---|---|
| ISS-001 | ✅ Resolved | medium | Sidebar always shows "Super Admin" regardless of logged-in user |
| ISS-002 | 🟠 Open    | high   | LoginPage validates against frontend-only hardcoded list, never calls backend |
| ISS-003 | 🟠 Open    | medium | Store's default `user` is hardcoded super-admin and reverts on refresh |

---

## Resolved issues

### ISS-001 — Sidebar always shows "Super Admin" regardless of logged-in user

- **Status:** ✅ Resolved
- **Severity:** medium (UX — wrong info displayed; permissions weren't actually elevated)
- **Reported:** 2026-05-05
- **Resolved:** 2026-05-05
- **Reporter:** product owner

**Symptom**
After signing in as Arjun M. (cashier), the sidebar's user pill displayed "Super Admin" beneath the name. Same wrong label appeared for every other user too.

**Root cause**
`frontend/src/components/layout/Sidebar.jsx:149` had a literal string `Super Admin` instead of deriving the role label from `user.role`. The store and login flow were updating `user.name` and `user.avatar` correctly — only the role line below the name was lying.

```jsx
<div style={{ fontSize: 13, fontWeight: 500, ... }}>{user.name}</div>
<div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Super Admin</div>  // ← literal!
```

**Fix**
Resolve the role label from the live `roles` list in the Zustand store (covers custom roles created via the Roles editor), falling back to the static `roleLabels` map for the 6 system roles, then to the raw role key.

**Files touched**
- `frontend/src/components/layout/Sidebar.jsx` — added `roles` to the destructured store state, added `userRole` lookup chain, replaced literal with `{userRoleLabel}`.

**Verification**
- Suresh Anand → "Super Admin"
- Arjun M. → "Cashier"
- Kavitha R. → "Branch Manager"
- Custom role assigned to a user → that role's label

---

## Open issues

### ISS-002 — LoginPage validates against frontend-only hardcoded list, never calls backend

- **Status:** 🟠 Open
- **Severity:** high (login is fake; passwords on the form don't even match the seed)
- **Reported:** 2026-05-05 (surfaced while triaging ISS-001)

**Symptom**
`POST /api/v1/auth/login` is never called. The Login page accepts whatever email/password matches its own hardcoded `DEMO_USERS` array. The passwords in that array (`admin123`, `branch123`, `cash123`) don't even match the bcrypt-hashed passwords seed.py writes (`admin123`, `kavitha123`, `arjun123`). After login, `permissions` and `permCatalog` in the store are not populated from the server — they stay at the default `['*']`.

**Root cause**
`frontend/src/pages/auth/LoginPage.jsx:6-10, 23-32` — login validation is purely client-side:
```jsx
const DEMO_USERS = [
  { email: 'suresh@srimurugan.com', password: 'admin123', ... },
  { email: 'arjun@srimurugan.com', password: 'cash123',   ... },  // wrong pw vs seed
  ...
]
const user = DEMO_USERS.find(u => u.email === email && u.password === password)
```

**Planned fix (Phase 2 of Users & Roles rollout)**
Per `docs/USERS_AND_ROLES.md §8.3`:
1. `POST /auth/login` (real bcrypt verify, real JWT issue) — already scheduled.
2. After token returned: `GET /auth/me` + `GET /permissions/catalog` in parallel.
3. `useAppStore.getState().setSession({ user, permissions, permCatalog })`.
4. Then `navigate('/dashboard')`.

**Files that will be touched**
- `frontend/src/pages/auth/LoginPage.jsx` — drop hardcoded list, call `authAPI.login` + `authAPI.me` + `permissionsAPI.catalog`.
- `backend/src/routes/auth.py` — switch demo dict to bcrypt verify against `users.hashed_password`; issue real JWT.

---

### ISS-003 — Store's default `user` is hardcoded super-admin and reverts on refresh

- **Status:** 🟠 Open
- **Severity:** medium (chained on top of ISS-002 — once login is real, this masks the auth state)
- **Reported:** 2026-05-05 (surfaced while triaging ISS-001)

**Symptom**
After signing in as Arjun M. and then refreshing any page, the sidebar (and anywhere else reading `useAppStore.user`) snaps back to "Suresh Anand / Super Admin". The Settings → Users & Roles tab shows the editor as if a super-admin is logged in regardless of session.

**Root cause**
`frontend/src/store/index.js`:
- The Zustand `useAppStore` initializer hardcodes `user: { id: 'usr-001', name: 'Suresh Anand', role: 'super_admin', permissions: ['*'] }` as the default state.
- `partialize` only persists `activeBranch`, `theme`, `sidebarCollapsed`. So `user` is *not* persisted — but on every page reload the default super-admin re-instates.
- Net effect: login state survives in-memory navigation but not a hard reload.

**Planned fix (Phase 2 of Users & Roles rollout)**
1. Default `user: null` and `permissions: []` in the store.
2. `App.jsx` boot: if `localStorage.retailos_token` exists, call `/auth/me` + `/permissions/catalog` *before* rendering routes; on 401, clear token and bounce to `/login`.
3. Wrap `<AppShell>` in `<RequireAuth>` (already defined in `frontend/src/auth/guards.jsx` — wired in Phase 2).

**Files that will be touched**
- `frontend/src/store/index.js` — default state.
- `frontend/src/App.jsx` — boot-time `/auth/me` fetch + splash before routes mount.

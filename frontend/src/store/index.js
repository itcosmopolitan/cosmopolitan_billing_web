import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** Pre-tax line amount after one line-level discount (pct or flat). */
export const applyLineCalc = (item) => {
  const qty = Math.max(0, Number(item.qty) || 0)
  const price = Number(item.price) || 0
  const gross = round2(qty * price)
  const lineDiscountType = item.lineDiscountType === 'flat' ? 'flat' : 'pct'
  const rawValue = Number(
    item.lineDiscountValue ??
    (lineDiscountType === 'pct' ? item.lineDiscountPct : item.lineDiscountFlat)
  ) || 0
  const lineDiscountValue = lineDiscountType === 'pct'
    ? Math.min(100, Math.max(0, rawValue))
    : Math.max(0, rawValue)
  const totalDisc = lineDiscountType === 'pct'
    ? round2(Math.min(gross, gross * (lineDiscountValue / 100)))
    : round2(Math.min(gross, lineDiscountValue))
  const lineTotal = round2(gross - totalDisc)
  return {
    ...item,
    qty,
    price,
    lineDiscountType,
    lineDiscountValue,
    // Keep compatibility with any old reads.
    lineDiscountPct: lineDiscountType === 'pct' ? lineDiscountValue : 0,
    lineDiscountFlat: lineDiscountType === 'flat' ? lineDiscountValue : 0,
    lineTotal,
  }
}

const normalizeCartItem = (raw) => {
  const qty = Math.max(0, Number(raw.qty) || 0)
  const price = Number(raw.price ?? raw.selling_price) || 0
  let lineDiscountType = raw.lineDiscountType === 'flat' ? 'flat' : 'pct'
  let lineDiscountValue = Number(raw.lineDiscountValue) || 0
  const legacyPct = Number(raw.lineDiscountPct) || 0
  const legacyFlat = Number(raw.lineDiscountFlat) || 0
  if (lineDiscountValue <= 0) {
    if (legacyPct > 0) {
      lineDiscountType = 'pct'
      lineDiscountValue = legacyPct
    } else if (legacyFlat > 0) {
      lineDiscountType = 'flat'
      lineDiscountValue = legacyFlat
    } else if (raw.lineDiscount != null && Number(raw.lineDiscount) > 0) {
      // Old held bills stored per-unit line discount; convert to line flat amount.
      lineDiscountType = 'flat'
      lineDiscountValue = round2(Number(raw.lineDiscount) * qty)
    }
  }
  return applyLineCalc({
    ...raw,
    qty,
    price,
    lineDiscountType,
    lineDiscountValue,
    costPrice: Number(raw.costPrice) || 0,
    hsnCode: raw.hsnCode || raw.hsn_code || '',
    availableStock: Number(raw.availableStock ?? raw.available_stock) || 0,
    taxRate: Number(raw.taxRate ?? raw.tax_rate) || 0,
    // Batch-tracking metadata. `*_tracking` flags drive whether CartRow
    // renders the picker at all. `batchAllocation` is the per-line split
    // across source batches; defaults to auto FIFO/FEFO computed by CartRow
    // once it loads the batch list. `batchAllocationCustom` flips to true
    // when the operator hand-edits via the modal — that locks the split
    // until they change qty, which resets it back to auto.
    batchTracking: Boolean(raw.batchTracking ?? raw.batch_tracking),
    expiryTracking: Boolean(raw.expiryTracking ?? raw.expiry_tracking),
    batchAllocation: Array.isArray(raw.batchAllocation) ? raw.batchAllocation : [],
    batchAllocationCustom: Boolean(raw.batchAllocationCustom),
  })
}

// ─── App Store ────────────────────────────────────────────────────────────────
export const useAppStore = create(
  persist(
    (set) => ({
      // User session — populated by App.jsx on boot via /auth/me, or by
      // LoginPage after a successful /auth/login. Default null so RequireAuth
      // bounces unauthenticated visitors to /login. Fixes ISS-003 (was a
      // hardcoded super-admin that re-instated on every page reload).
      user: null,

      // Branch context — populated by App.jsx on boot from
      // `branchesAPI.list()`. Single source of truth: never hardcode branches
      // here or anywhere else (was a 3-way duplication that desynced when the
      // seed switched branch names mid-project — see audit ISS-006/refactor).
      activeBranch: null,
      branches: [],

      // UI preferences
      sidebarCollapsed: false,
      theme: 'light',
      // ── RBAC session state (Users & Roles, Phase 1 + 1.5) ────────────────
      // `permissions` is the list granted to the current user (e.g. ["items.view", "*"]).
      // `permCatalog` is the full module → [actions] map from /permissions/catalog,
      // needed to expand wildcards in useCan().
      // `roles` caches /roles/ for the Roles editor in Settings.
      // None of these are persisted to localStorage — we always re-fetch on app
      // boot so a permission revoke takes effect on the next reload.
      permissions: [],
      permCatalog: {},
      roles: [],

      // Actions
      setActiveBranch: (branch) => set((s) => {
        const list = Array.isArray(s.branches) ? s.branches : []
        const normalized = branch && typeof branch === 'object' ? branch : list.find((b) => b.id === branch) || null
        const allowedIds = s.user?.all_branches || !s.user?.branch_ids?.length
          ? null
          : new Set(s.user.branch_ids)
        const allowed = !normalized
          ? null
          : (!allowedIds || allowedIds.has(normalized.id) ? normalized : null)
        const fallback = allowedIds
          ? list.find((b) => allowedIds.has(b.id)) || null
          : list[0] || null
        const newActive = allowed || fallback
        // Notify other parts of the app that the active branch changed so
        // they can re-fetch data immediately (avoids forcing a full reload).
        if (typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('branch:changed', { detail: newActive }))
          } catch (e) {
            // ignore
          }
        }
        return { activeBranch: newActive }
      }),
      setBranches: (branches) => set((s) => {
        // Keep the persisted activeBranch if it still exists in the new list,
        // otherwise default to the first allowed branch (or null if empty).
        const list = Array.isArray(branches) ? branches : []
        const allowedIds = s.user?.all_branches || !s.user?.branch_ids?.length
          ? null
          : new Set(s.user.branch_ids)
        const stillThere = list.find((b) => b.id === s.activeBranch?.id)
        const fallback = allowedIds
          ? list.find((b) => allowedIds.has(b.id)) || null
          : list[0] || null
        return {
          branches: list,
          activeBranch: (stillThere && (!allowedIds || allowedIds.has(stillThere.id))) ? stillThere : (fallback || null),
        }
      }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setUser: (user) => set({ user }),
      setPermCatalog: (permCatalog) => set({ permCatalog }),
      setRoles: (roles) => set({ roles }),
      setSession: ({ user, permissions, permCatalog }) => set((s) => {
        // When the session changes (login / boot rehydrate), re-evaluate the
        // persisted activeBranch against the new user's allowed branches.
        // A previously-persisted activeBranch from a super-admin session
        // would otherwise stick around for a cashier who can't actually
        // access it. Users with all_branches=true (or no branch_ids list)
        // keep whatever activeBranch they had.
        const allowedIds = user?.all_branches || !user?.branch_ids?.length
          ? null  // null = no constraint
          : new Set(user.branch_ids)
        const activeOk = !allowedIds || (s.activeBranch && allowedIds.has(s.activeBranch.id))
        const fallback = allowedIds
          ? s.branches.find((b) => allowedIds.has(b.id))
          : (s.activeBranch || s.branches[0])
        return {
          user,
          permissions: permissions || [],
          activeBranch: activeOk ? s.activeBranch : (fallback || null),
          ...(permCatalog ? { permCatalog } : {}),
        }
      }),
      clearSession: () => set({ user: null, permissions: [], roles: [], activeBranch: null }),
    }),
    { name: 'retailos-app', partialize: (s) => ({ activeBranch: s.activeBranch, theme: s.theme, sidebarCollapsed: s.sidebarCollapsed }) }
  )
)

    // React-friendly subscription helper: components can call this to receive
    // updates when the active branch changes. Returns an unsubscribe function.
    export function subscribeToBranchChanged(cb) {
      return useAppStore.subscribe(
        (s) => s.activeBranch,
        (newVal, oldVal) => {
          try {
            cb(newVal, oldVal)
          } catch (e) {
            // swallow listener errors
          }
        }
      )
    }

// ─── POS Store ────────────────────────────────────────────────────────────────
export const usePOSStore = create((set, get) => ({
  cart: [],
  customer: null,
  discountPct: 0,
  discountAmt: 0,
  // Sales Phase 1 (2026-05-23): payment is now two fields — a checkbox
  // ("Payment received?") + a method dropdown (Cash / Card / UPI /
  // Bank Transfer). Default unchecked so the operator must consciously
  // confirm receipt before the sale is recorded as paid. When unchecked,
  // POSPage submits with payment_mode=null → backend creates an unpaid
  // (pending) invoice. See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md.
  paymentReceived: false,
  paymentMethod: null,
  splitPayments: [],
  heldBills: [],
  notes: '',

  // Cart actions
  addItem: (product) => {
    const { cart } = get()
    const existing = cart.find((i) => i.id === product.id)
    if (existing) {
      set({
        // Mirror updateQty's reset of `batchAllocationCustom`. Without it, a
        // cashier who manually split the batch allocation and then re-clicked
        // the product card would keep the stale custom flag — CartRow's
        // auto-effect would refuse to re-balance for the bumped qty and the
        // backend would later 400 with "Allocation sum does not match line qty".
        cart: cart.map((i) =>
          i.id === product.id
            ? applyLineCalc({ ...i, qty: i.qty + 1, batchAllocationCustom: false })
            : i
        ),
      })
    } else {
      set({
        cart: [
          ...cart,
          normalizeCartItem({
            ...product,
            qty: 1,
            lineDiscountType: product.lineDiscountType || 'pct',
            lineDiscountValue: Number(product.lineDiscountValue) || 0,
          }),
        ],
      })
    }
  },

  // Replace a tracked line's batch split. `custom` flips the lock — `true`
  // when the operator saved a manual edit in the modal, `false` (or
  // omitted) when CartRow auto-rebuilds the allocation from FIFO/FEFO. The
  // distinction lets CartRow's effect skip re-auto-allocating while the
  // operator's manual split is still valid for the current qty.
  setLineBatchAllocation: (id, allocation, custom = false) => set((s) => ({
    cart: s.cart.map((i) => (
      i.id === id
        ? { ...i, batchAllocation: allocation || [], batchAllocationCustom: !!custom }
        : i
    )),
  })),

  removeItem: (id) => set((s) => ({ cart: s.cart.filter((i) => i.id !== id) })),

  updateQty: (id, qty) => {
    if (qty <= 0) { get().removeItem(id); return }
    set((s) => ({
      // Clearing `batchAllocationCustom` lets CartRow's effect re-run the
      // auto-FIFO/FEFO split for the new qty. Without this, a custom split
      // for qty=13 would silently mismatch when qty becomes 18.
      cart: s.cart.map((i) => (
        i.id === id
          ? applyLineCalc({ ...i, qty, batchAllocationCustom: false })
          : i
      )),
    }))
  },

  setLineDiscount: (id, value, type) => {
    set((s) => ({
      cart: s.cart.map((i) =>
        i.id === id
          ? applyLineCalc({
              ...i,
              lineDiscountType: type || i.lineDiscountType || 'pct',
              lineDiscountValue: value,
            })
          : i
      ),
    }))
  },

  setLineDiscountType: (id, type) => {
    set((s) => ({
      cart: s.cart.map((i) =>
        i.id === id ? applyLineCalc({ ...i, lineDiscountType: type }) : i
      ),
    }))
  },

  // Backward-compatible wrappers
  setLineDiscountPct: (id, pct) => get().setLineDiscount(id, pct, 'pct'),
  setLineDiscountFlat: (id, amt) => get().setLineDiscount(id, amt, 'flat'),

  clearCart: () => set({
    cart: [], customer: null, discountPct: 0, discountAmt: 0, notes: '',
    // PR 1: reset payment fields so the next sale starts fresh + unchecked.
    paymentReceived: false, paymentMethod: null,
  }),

  setCustomer: (customer) => set({ customer }),
  setDiscount: (pct, amt) => set({ discountPct: pct, discountAmt: amt }),
  // PR 1: dual-setter for the new payment UX. setPaymentReceived(true)
  // is harmless without a method (POSPage validates at submit); setting
  // false also clears the method so a held bill resumed with the box
  // unchecked doesn't carry a stale leftover.
  setPaymentReceived: (received) => set((s) => ({
    paymentReceived: !!received,
    paymentMethod: received ? s.paymentMethod : null,
  })),
  setPaymentMethod: (m) => set({ paymentMethod: m }),
  setNotes: (n) => set({ notes: n }),

  holdBill: () => {
    const { cart, customer, discountPct, heldBills, paymentReceived, paymentMethod } = get()
    if (cart.length === 0) return
    const label = `Hold #${heldBills.length + 1}`
    set({
      heldBills: [...heldBills, {
        id: Date.now(),
        billNumber: label,
        cart: cart.map((i) => applyLineCalc(i)),
        customer,
        discountPct,
        // PR 1: persist the new payment fields so resume restores the
        // operator's state. Older held bills (created before this version)
        // won't have these and the migration in resumeBill below handles
        // them.
        paymentReceived,
        paymentMethod,
        heldAt: new Date(),
      }],
      cart: [], customer: null, discountPct: 0,
      paymentReceived: false, paymentMethod: null,
    })
  },

  resumeBill: (heldId) => {
    const { heldBills } = get()
    const bill = heldBills.find((b) => b.id === heldId)
    if (!bill) return
    // Migration for held bills created before Sales Phase 1:
    //   • Legacy `paymentMethod: 'credit'`  → unchecked, no method
    //     (pre-2026-05-25 'credit' meant "no payment". Post-cutover
    //     it's a real method — but legacy held bills predate that.
    //     Held bills are in-memory only so this branch is harmless
    //     after the first page reload.)
    //   • Legacy `paymentMethod: <other>`   → checked + that method
    //   • Missing fields entirely (very old) → unchecked, no method
    let resumedReceived = false
    let resumedMethod = null
    if ('paymentReceived' in bill) {
      // New-shape held bill — restore as-is.
      resumedReceived = !!bill.paymentReceived
      resumedMethod = bill.paymentMethod ?? null
    } else if (bill.paymentMethod && bill.paymentMethod !== 'credit') {
      resumedReceived = true
      resumedMethod = bill.paymentMethod
    }
    set({
      cart: bill.cart.map((i) => normalizeCartItem(i)),
      customer: bill.customer,
      discountPct: bill.discountPct,
      paymentReceived: resumedReceived,
      paymentMethod: resumedMethod,
      heldBills: heldBills.filter((b) => b.id !== heldId),
    })
  },

  // Computed totals — lineTotal is tax-inclusive.
  getSubtotal: () => get().cart.reduce((s, i) => s + i.lineTotal, 0),
  getTaxTotal: () => get().cart.reduce((s, i) => {
    const rate = Number(i.taxRate) || 0
    const amt = Number(i.lineTotal) || 0
    if (amt <= 0 || rate <= 0) return s
    return s + Math.round((amt * rate / (100 + rate)) * 100) / 100
  }, 0),
  getDiscount: () => {
    const sub = get().getSubtotal()
    return get().discountAmt + (sub * get().discountPct / 100)
  },
  getTotal: () => {
    const sub = get().getSubtotal()
    const disc = get().getDiscount()
    return Math.max(0, Math.round((sub - disc) * 100) / 100)
  },
}))

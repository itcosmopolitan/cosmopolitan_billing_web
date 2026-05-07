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
      setActiveBranch: (branch) => set({ activeBranch: branch }),
      setBranches: (branches) => set((s) => {
        // Keep the persisted activeBranch if it still exists in the new list,
        // otherwise default to the first one (or null if the list is empty).
        const list = Array.isArray(branches) ? branches : []
        const stillThere = list.find((b) => b.id === s.activeBranch?.id)
        return {
          branches: list,
          activeBranch: stillThere || list[0] || null,
        }
      }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setUser: (user) => set({ user }),
      setPermCatalog: (permCatalog) => set({ permCatalog }),
      setRoles: (roles) => set({ roles }),
      setSession: ({ user, permissions, permCatalog }) => set({
        user,
        permissions: permissions || [],
        ...(permCatalog ? { permCatalog } : {}),
      }),
      clearSession: () => set({ user: null, permissions: [], roles: [] }),
    }),
    { name: 'retailos-app', partialize: (s) => ({ activeBranch: s.activeBranch, theme: s.theme, sidebarCollapsed: s.sidebarCollapsed }) }
  )
)

// ─── POS Store ────────────────────────────────────────────────────────────────
export const usePOSStore = create((set, get) => ({
  cart: [],
  customer: null,
  discountPct: 0,
  discountAmt: 0,
  paymentMethod: 'cash',
  splitPayments: [],
  heldBills: [],
  billNumber: 'POS-2024-1848',
  notes: '',

  // Cart actions
  addItem: (product) => {
    const { cart } = get()
    const existing = cart.find((i) => i.id === product.id)
    if (existing) {
      set({
        cart: cart.map((i) =>
          i.id === product.id ? applyLineCalc({ ...i, qty: i.qty + 1 }) : i
        ),
      })
    } else {
      set({
        cart: [
          ...cart,
          applyLineCalc({
            ...product,
            qty: 1,
            lineDiscountType: product.lineDiscountType || 'pct',
            lineDiscountValue: Number(product.lineDiscountValue) || 0,
          }),
        ],
      })
    }
  },

  removeItem: (id) => set((s) => ({ cart: s.cart.filter((i) => i.id !== id) })),

  updateQty: (id, qty) => {
    if (qty <= 0) { get().removeItem(id); return }
    set((s) => ({
      cart: s.cart.map((i) => (i.id === id ? applyLineCalc({ ...i, qty }) : i)),
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

  clearCart: () => set({ cart: [], customer: null, discountPct: 0, discountAmt: 0, notes: '' }),

  setCustomer: (customer) => set({ customer }),
  setDiscount: (pct, amt) => set({ discountPct: pct, discountAmt: amt }),
  setPaymentMethod: (m) => set({ paymentMethod: m }),
  setNotes: (n) => set({ notes: n }),

  holdBill: () => {
    const { cart, customer, discountPct, billNumber, heldBills } = get()
    if (cart.length === 0) return
    set({
      heldBills: [...heldBills, { id: Date.now(), billNumber, cart: cart.map((i) => applyLineCalc(i)), customer, discountPct, heldAt: new Date() }],
      cart: [], customer: null, discountPct: 0,
    })
  },

  resumeBill: (heldId) => {
    const { heldBills } = get()
    const bill = heldBills.find((b) => b.id === heldId)
    if (!bill) return
    set({
      cart: bill.cart.map((i) => normalizeCartItem(i)),
      customer: bill.customer,
      discountPct: bill.discountPct,
      heldBills: heldBills.filter((b) => b.id !== heldId),
    })
  },

  // Computed totals
  getSubtotal: () => get().cart.reduce((s, i) => s + i.lineTotal, 0),
  getTaxTotal: () => get().cart.reduce((s, i) => s + (i.lineTotal * (i.taxRate / 100)), 0),
  getDiscount: () => {
    const sub = get().getSubtotal()
    return get().discountAmt + (sub * get().discountPct / 100)
  },
  getTotal: () => {
    const sub = get().getSubtotal()
    const tax = get().getTaxTotal()
    const disc = get().getDiscount()
    return sub + tax - disc
  },
}))

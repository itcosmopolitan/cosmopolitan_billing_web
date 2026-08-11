import axios from 'axios'
import toast from 'react-hot-toast'
import { useAppStore } from '@/store'

// ─── Base client ──────────────────────────────────────────────────────────────
export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
})

// Global in-flight cache for GET requests to avoid duplicate identical
// GET requests (helps during React StrictMode double-mount in dev).
const _originalGet = api.get.bind(api)
const _inFlightGetRequests = new Map()
api.get = (url, config) => {
  // AbortController-backed requests must not dedupe — remounting a tab (React
  // StrictMode or switching settings tabs) aborts the first signal while the
  // deduped promise is still in-flight, so the next caller gets a canceled
  // promise and no new network request is sent.
  if (config?.signal) {
    return _originalGet(url, config)
  }

  // Auto-attach active branch id so dedupe key includes it (important
  // because request interceptors run after this wrapper). This ensures
  // requests for different branches are considered distinct.
  try {
    const state = useAppStore.getState()
    const activeBranch = state?.activeBranch
    const explicitNoBranch = config?.noBranchScope || (typeof url === 'string' && url.startsWith('/audit'))

    if (config?.noBranchScope) {
      delete config.noBranchScope
    }

    if (!explicitNoBranch && activeBranch && activeBranch.id) {
      config = config || {}
      config.params = config.params || {}
      if (config.params.branch_id === undefined) {
        config.params.branch_id = activeBranch.id
      } else if (config.params.branch_id === null) {
        // explicit opt-out: do not inject active branch
        delete config.params.branch_id
      }
    }
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[api.get] url=', url, 'params=', config?.params, 'activeBranch=', activeBranch?.id, 'explicitNoBranch=', explicitNoBranch)
    }
  } catch (e) {
    // ignore
  }

  // Create a stable key from url + sorted params
  const params = (config && config.params) ? config.params : undefined
  let key
  try {
    key = `${url}|${params ? JSON.stringify(params) : ''}`
  } catch (e) {
    key = url
  }
  const existing = _inFlightGetRequests.get(key)
  if (existing) return existing
  const promise = _originalGet(url, config).finally(() => _inFlightGetRequests.delete(key))
  _inFlightGetRequests.set(key, promise)
  return promise
}

// Clear in-flight GET cache when the active branch changes so pages will
// perform fresh requests instead of receiving deduped promises tied to the
// previous branch's params.
if (typeof window !== 'undefined') {
  window.addEventListener('branch:changed', () => {
    try {
      _inFlightGetRequests.clear()
      if (api._recentErrors) api._recentErrors.clear()
    } catch (e) {
      // ignore
    }
  })
}

/** Dedupe session-expiry handling when many requests 401 at once. */
let handlingSessionExpiry = false

export function resetSessionExpiryGuard() {
  handlingSessionExpiry = false
}

function isLoginRequest(url) {
  return url.includes('/auth/login')
}

function isAuthMeRequest(url) {
  return url.includes('/auth/me')
}

// Request interceptor — attach token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('retailos_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Response interceptor — global error handling
api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    // Intentional cancellation (tab switch, unmount) — not an error for the user.
    if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') {
      return Promise.reject(err)
    }

    const rawDetail = err?.response?.data?.detail
    const status = err?.response?.status
    const url = err?.config?.url || ''

    // Some endpoints return structured detail objects (e.g. bulk-delete
    // returns `{blocked: [...], message: "..."}` so the caller can render
    // per-row reasons inline). Pull `.message` out for the global toast;
    // never call `toast.error()` with a non-string (react-hot-toast will
    // render `[object Object]`). The original error stays attached on
    // err.response.data.detail so the caller's catch block can still
    // read the structured payload.
    let msg
    if (typeof rawDetail === 'string') {
      msg = rawDetail
    } else if (rawDetail && typeof rawDetail === 'object') {
      msg = rawDetail.message || JSON.stringify(rawDetail)
    } else {
      msg = err.message || 'Request failed'
    }

    // 2026-05-25: bulk-delete endpoints surface a structured `{blocked,
    // message}` body on guard failures. The caller mounts a confirm modal
    // that lists the blocked rows + reasons inline — a global toast on
    // top of that is just noise. Suppress it for this one shape.
    const isBulkDeleteBlocked =
      status === 400 &&
      url.includes('/bulk-delete') &&
      rawDetail && typeof rawDetail === 'object' &&
      Array.isArray(rawDetail.blocked)

    if (status === 401) {
      if (isLoginRequest(url)) {
        // Wrong credentials — operator is already on the login form.
        toast.error(msg || 'Invalid email or password')
      } else if (!isAuthMeRequest(url) && !isLoginRequest(url)) {
        // Session expired or invalid token — redirect once, no error spam.
        if (!handlingSessionExpiry) {
          handlingSessionExpiry = true
        localStorage.removeItem('retailos_token')
        const here = window.location.pathname
          if (here !== '/login') {
            window.location.replace('/login')
          } else {
            resetSessionExpiryGuard()
          }
        }
      }
      // Boot-time /auth/me failure: RequireAuth sends user to login — stay silent.
    } else if (!isBulkDeleteBlocked) {
      // Suppress duplicate identical toasts within a short window to avoid
      // spamming the user when multiple concurrent requests fail for the
      // same reason (e.g. permission check). Keep a tiny in-memory cache
      // keyed by message + status.
      if (!api._recentErrors) api._recentErrors = new Map()
      const key = `${status}:${msg}`
      const now = Date.now()
      const prev = api._recentErrors.get(key) || 0
      // Skip if we showed this exact message in the last 2000ms
      if (now - prev > 2000) {
        api._recentErrors.set(key, now)
        toast.error(msg)
        // Periodically clean old entries to avoid unbounded growth
        if (api._recentErrors.size > 1000) {
          const cutoff = now - 60_000
          for (const [k, t] of api._recentErrors.entries()) {
            if (t < cutoff) api._recentErrors.delete(k)
          }
        }
      }
    }
    return Promise.reject(err)
  }
)

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authAPI = {
  login:  (email, password) => api.post('/auth/login', { email, password }),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  logout: ()                => api.post('/auth/logout'),
  me:     ()                => api.get('/auth/me'),
  // Self-serve password change. Requires old password (defense against
  // stolen sessions, and the input the forced-first-login flow uses).
  // On success the backend clears must_change_password and returns
  // { message, must_change_password: false }.
  changePassword: (oldPassword, newPassword) =>
    api.post('/auth/change-password', { old_password: oldPassword, new_password: newPassword }),
}

export const setupAPI = {
  status: () => api.get('/setup/status'),
  initialize: (data) => api.post('/setup/initialize', data),
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export const dashAPI = {
  filters:          (params) => api.get('/dashboard/filters', { params }),
  summary:          (params) => api.get('/dashboard/summary', { params }),
  sales:            (params) => api.get('/dashboard/sales', { params }),
  inventory:        (params) => api.get('/dashboard/inventory', { params }),
  billing:          (params) => api.get('/dashboard/billing', { params }),
  operations:       (params) => api.get('/dashboard/operations', { params }),
  export:           (data)   => api.post('/dashboard/export', data),
  topProducts:      (params) => api.get('/dashboard/sales/top-products', { params }),
  recentSales:      (params) => api.get('/dashboard/sales/recent-sales', { params }),
  lowStock:         (params) => api.get('/dashboard/inventory/low-stock', { params }),
  expiryNear:       (params) => api.get('/dashboard/inventory/expiry-near', { params }),
  pendingPayments:  (params) => api.get('/dashboard/billing/pending-payments', { params }),
  activityLogs:     (params) => api.get('/dashboard/operations/activity-logs', { params }),
}

export const activityAPI = {
  timeline: (recordType, recordId, params = {}) => api.get(`/activity/${recordType}/${recordId}`, { params }),
  postComment: (data) => api.post('/activity/comments', data),
  patchComment: (commentId, data) => api.patch(`/activity/comments/${commentId}`, data),
  deleteComment: (commentId) => api.delete(`/activity/comments/${commentId}`),
}

// ─── Items ────────────────────────────────────────────────────────────────────
export const itemsAPI = {
  list:    (params) => api.get('/items/',             { params }),
  get:     (id)     => api.get(`/items/${id}`),
  create:  (data)   => api.post('/items/', data),
  update:  (id, data) => api.put(`/items/${id}`, data),
  patch:   (id, data) => api.patch(`/items/${id}`, data),
  approve: (id)     => api.post(`/items/${id}/approve`),
  reject:  (id, data = {}) => api.post(`/items/${id}/reject`, data),
  adjust:  (data)   => api.post('/items/adjust', data),
  delete:  (id, params) => api.delete(`/items/${id}`, { params }),
  getBranches:    (id) => api.get(`/items/${id}/branches`),
  updateBranches: (id, data) => api.put(`/items/${id}/branches`, data),
  getBranchBatchInfo: (itemId, branchId) => api.get(`/items/${itemId}/branches/${branchId}/batch-info`),
  // Batch / lot tracking (FIFO + FEFO inventory). `listBatches` returns
  // batches ordered nearest-expiry first; `createBatch` adds a new lot and
  // also bumps the per-branch stock counter; `patchBatch` edits metadata
  // (numbers, dates, notes) without changing quantity.
  batches: {
    list:        (itemId, params) => api.get(`/items/${itemId}/batches`, { params }),
    create:      (itemId, data)   => api.post(`/items/${itemId}/batches`, data),
    patch:       (batchId, data)  => api.patch(`/items/batches/${batchId}`, data),
    nearExpiry:  (params)         => api.get('/items/batches/near-expiry', { params }),
  },
  categories: {
    list:   ()     => api.get('/items/categories'),
    create: (data) => api.post('/items/categories', data),
  },
}

// ─── Sales ────────────────────────────────────────────────────────────────────
export const salesAPI = {
  list:    (params) => api.get('/sales/',             { params }),
  get:     (id)     => api.get(`/sales/${id}`),
  create:  (data)   => api.post('/sales/', data, { timeout: 30_000 }),
  update:  (id, data) => api.put(`/sales/${id}`, data),
  payment: (id, data) => api.post(`/sales/${id}/payment`, data),
  cancel:  (id)     => api.post(`/sales/${id}/cancel`),
  submit:  (id)     => api.post(`/sales/${id}/submit`),
  approve: (id, notes) => api.post(`/sales/${id}/approve`, { notes }),
  reject:  (id, notes) => api.post(`/sales/${id}/reject`, { notes }),
  // creditPurchases endpoint removed 2026-05-23 (Sales Phase 1) — see
  // ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md. The same data is
  // available via salesAPI.list({ payment_mode: 'credit' }) if needed.

  // Sales Phase 1 PR 2 (2026-05-23): real Sales Orders + Sales Returns
  // (real, persisted — replaces the SAMPLE_RETURNS hardcoded list).
  orders: {
    list:         (params)        => api.get('/sales/orders/', { params }),
    get:          (id)            => api.get(`/sales/orders/${id}`),
    create:       (data)          => api.post('/sales/orders/', data),
    // PR 2 follow-up (2026-05-23): full replace of editable fields +
    // items. Server rejects with 400 when the SO is in a terminal status
    // (converted / cancelled) — UI hides the Edit affordance for those.
    update:       (id, data)      => api.put(`/sales/orders/${id}`, data),
    updateStatus: (id, status)    => api.patch(`/sales/orders/${id}/status`, null, { params: { status } }),
    // body = { payment_received: bool, payment_mode: string|null, notes: string|null }
    convert:      (id, body)      => api.post(`/sales/orders/${id}/convert`, body),
    submit:       (id)            => api.post(`/sales/orders/${id}/submit`),
    approve:      (id, notes)     => api.post(`/sales/orders/${id}/approve`, { notes }),
    reject:       (id, notes)     => api.post(`/sales/orders/${id}/reject`, { notes }),
  },
  returns: {
    // 2026-05-24: trailing slash on list + create is LOAD-BEARING.
    // The backend registers `/{invoice_id}` BEFORE `/returns/`; without
    // the trailing slash, `/sales/returns` matches `/{invoice_id}` with
    // invoice_id="returns" → 404 "Invoice not found" toast firing on
    // every visit to the Returns tab. The same pattern as `/orders/` +
    // `/quotations/` (both use trailing slash).
    list:   (params) => api.get('/sales/returns/', { params }),
    get:    (id)     => api.get(`/sales/returns/${id}`),
    // body shape — see ConvertToInvoiceIn / SalesReturnCreate in routes/sales.py
    create:   (data) => api.post('/sales/returns/', data),
    void:     (id)   => api.post(`/sales/returns/${id}/void`),
    undoVoid: (id)   => api.post(`/sales/returns/${id}/undo-void`),
  },
  // 2026-05-24: multi-invoice payments — operator picks a customer,
  // selects pending invoices, allocates an amount per invoice. Backend
  // also writes a CustomerPayment row when the legacy single-invoice
  // POST /sales/{id}/payment endpoint runs, so this list reflects every
  // payment regardless of entry point. Trailing slash same rationale.
  payments: {
    list:   (params) => api.get('/sales/payments/', { params }),
    get:    (id)     => api.get(`/sales/payments/${id}`),
    create: (data)   => api.post('/sales/payments/', data),
    void:   (id)     => api.post(`/sales/payments/${id}/void`),
  },
  // 2026-05-25: bulk-delete endpoints. All-or-nothing semantics:
  // backend returns 400 with { detail: { blocked: [...], message } }
  // if any row is blocked. On success: { deleted: [...], count, ... }.
  bulkDelete: {
    invoices:   (ids) => api.post('/sales/bulk-delete', { ids }),
    orders:     (ids) => api.post('/sales/orders/bulk-delete', { ids }),
    quotations: (ids) => api.post('/sales/quotations/bulk-delete', { ids }),
    returns:    (ids) => api.post('/sales/returns/bulk-delete', { ids }),
    payments:   (ids) => api.post('/sales/payments/bulk-delete', { ids }),
  },
  quotations: {
    list:    (params) => api.get('/sales/quotations/', { params }),
    get:     (id)     => api.get(`/sales/quotations/${id}`),
    create:  (data)   => api.post('/sales/quotations/', data),
    // PR 2 follow-up (2026-05-23): full edit. Server rejects 400 when
    // the quote is in a terminal status (accepted / converted / rejected).
    update:  (id, data) => api.put(`/sales/quotations/${id}`, data),
    updateStatus:   (id, status) => api.patch(`/sales/quotations/${id}/status`, null, { params: { status } }),
    // PR 2: convert quotation → sales order (server copies prices verbatim
    // + marks the quote `accepted`). Returns the new SO's id + number.
    convertToOrder: (id)         => api.post(`/sales/quotations/${id}/convert-to-order`),
    convertToInvoice: (id, body) => api.post(`/sales/quotations/${id}/convert-to-invoice`, body),
  },
}

// ─── Purchases ────────────────────────────────────────────────────────────────
export const purchasesAPI = {
  list:    (params) => api.get('/purchases/',         { params }),
  get:     (id)     => api.get(`/purchases/${id}`),
  create:  (data)   => api.post('/purchases/', data),
  update:  (id, data) => api.put(`/purchases/${id}`, data),
  payment: (id, data) => api.post(`/purchases/${id}/payment`, data),
  cancel:  (id)     => api.post(`/purchases/${id}/cancel`),
  submit:  (id)     => api.post(`/purchases/${id}/submit`),
  approve: (id, notes) => api.post(`/purchases/${id}/approve`, { notes }),
  reject:  (id, notes) => api.post(`/purchases/${id}/reject`, { notes }),
  // Purchase Orders — mirror of salesAPI.orders. PO is the intent doc;
  // convert spawns a bill (which is what moves stock + creates batches).
  orders: {
    list:         (params) => api.get('/purchases/orders/',          { params }),
    get:          (id)     => api.get(`/purchases/orders/${id}`),
    create:       (data)   => api.post('/purchases/orders/', data),
    update:       (id, data) => api.put(`/purchases/orders/${id}`, data),
    updateStatus: (id, status) => api.patch(`/purchases/orders/${id}/status`, { status }),
    submit:       (id)     => api.post(`/purchases/orders/${id}/submit`),
    approve:      (id, notes) => api.post(`/purchases/orders/${id}/approve`, { notes }),
    reject:       (id, notes) => api.post(`/purchases/orders/${id}/reject`, { notes }),
    convert:      (id, body) => api.post(`/purchases/orders/${id}/convert`, body),
  },
  grns: {
    list:       (params) => api.get('/purchases/grns/', { params }),
    get:        (id)     => api.get(`/purchases/grns/${id}`),
    create:     (data)   => api.post('/purchases/grns/', data),
    fromPo:     (poId, data) => api.post(`/purchases/grns/from-po/${poId}`, data),
    bill:       (id, body) => api.post(`/purchases/grns/${id}/bill`, body),
    cancel:     (id)     => api.post(`/purchases/grns/${id}/cancel`),
    submit:     (id)     => api.post(`/purchases/grns/${id}/submit`),
    approve:    (id, notes) => api.post(`/purchases/grns/${id}/approve`, { notes }),
    reject:     (id, notes) => api.post(`/purchases/grns/${id}/reject`, { notes }),
  },
  returns: {
    list:    (params) => api.get('/purchases/returns/', { params }),
    get:     (id)     => api.get(`/purchases/returns/${id}`),
    create:   (data) => api.post('/purchases/returns/', data),
    approve:  (id)   => api.post(`/purchases/returns/${id}/approve`),
    void:     (id)   => api.post(`/purchases/returns/${id}/void`),
    undoVoid: (id)   => api.post(`/purchases/returns/${id}/undo-void`),
  },
  // Multi-bill vendor payments — mirror of salesAPI.payments.
  payments: {
    list:   (params) => api.get('/purchases/payments/', { params }),
    get:    (id)     => api.get(`/purchases/payments/${id}`),
    create: (data)   => api.post('/purchases/payments/', data),
    void:   (id)     => api.post(`/purchases/payments/${id}/void`),
  },
  // Bulk delete — same shape as salesAPI.bulkDelete.
  bulkDelete: {
    bills:    (ids) => api.post('/purchases/bulk-delete', { ids }),
    orders:   (ids) => api.post('/purchases/orders/bulk-delete', { ids }),
    returns:  (ids) => api.post('/purchases/returns/bulk-delete', { ids }),
    payments: (ids) => api.post('/purchases/payments/bulk-delete', { ids }),
  },
}

// ─── Customers ────────────────────────────────────────────────────────────────
export const customersAPI = {
  list:   (params) => api.get('/customers/',          { params }),
  get:    (id)     => api.get(`/customers/${id}`),
  creditLedger: (id, params) => api.get(`/customers/${id}/credit-ledger`, { params }),
  create: (data)   => api.post('/customers/', data),
  update: (id, data) => api.put(`/customers/${id}`, data),
}

// ─── Autocomplete (dropdown typeahead) ───────────────────────────────────────
export const AUTOCOMPLETE_CUSTOMER_URL = '/autocomplete/customer'
export const AUTOCOMPLETE_VENDOR_URL = '/autocomplete/vendor'
export const AUTOCOMPLETE_CATEGORY_URL = '/autocomplete/category'
export const AUTOCOMPLETE_UNIT_URL = '/autocomplete/unit'
export const AUTOCOMPLETE_TAX_RATE_URL = '/autocomplete/tax-rate'
export const AUTOCOMPLETE_BRANCH_URL = '/autocomplete/branch'
export const AUTOCOMPLETE_ITEM_URL = '/autocomplete/item'
export const AUTOCOMPLETE_STAFF_URL = '/autocomplete/staff'
export const AUTOCOMPLETE_BRANCH_MANAGERS_URL = '/autocomplete/branch-managers'

export const autocompleteAPI = {
  customers: (params) => api.get(AUTOCOMPLETE_CUSTOMER_URL, { params }),
  vendors: (params) => api.get(AUTOCOMPLETE_VENDOR_URL, { params }),
  categories: (params) => api.get(AUTOCOMPLETE_CATEGORY_URL, { params }),
  units: (params) => api.get(AUTOCOMPLETE_UNIT_URL, { params }),
  taxRates: (params) => api.get(AUTOCOMPLETE_TAX_RATE_URL, { params }),
  branches: (params) => api.get(AUTOCOMPLETE_BRANCH_URL, { params }),
  items: (params) => api.get(AUTOCOMPLETE_ITEM_URL, { params }),
  staff: (params) => api.get(AUTOCOMPLETE_STAFF_URL, { params }),
  branchManagers: (params) => api.get(AUTOCOMPLETE_BRANCH_MANAGERS_URL, { params }),
}

// ─── Vendors ──────────────────────────────────────────────────────────────────
export const vendorsAPI = {
  list:   (params) => api.get('/vendors/',            { params }),
  get:    (id)     => api.get(`/vendors/${id}`),
  creditLedger: (id, params) => api.get(`/vendors/${id}/credit-ledger`, { params }),
  create: (data)   => api.post('/vendors/', data),
  update: (id, data) => api.put(`/vendors/${id}`, data),
}

// ─── Branches ────────────────────────────────────────────────────────────────
export const branchesAPI = {
  list:   (params) => api.get('/branches/', { params }),
  get:    (id)     => api.get(`/branches/${id}`),
  create: (data)   => api.post('/branches/', data),
  update: (id, data) => api.put(`/branches/${id}`, data),
}

// ─── Summaries (section tab counts) ───────────────────────────────────────────
export const summariesAPI = {
  get: (module, params) => api.get('/summaries/', { params: { module, ...params } }),
}

// ─── Transfers ────────────────────────────────────────────────────────────────
export const transfersAPI = {
  list:    (params) => api.get('/transfers/',          { params }),
  get:     (id)     => api.get(`/transfers/${id}`),
  create:  (data)   => api.post('/transfers/', data),
  update:  (id, data) => api.put(`/transfers/${id}`, data),
  approve: (id, data) => api.post(`/transfers/${id}/approve`, data),
  submit:  (id, params) => api.post(`/transfers/${id}/submit`, null, { params }),
  reject:  (id, data) => api.post(`/transfers/${id}/reject`, data),
  receive: (id, data) => api.post(`/transfers/${id}/receive`, data),
  delete:  (id, params) => api.delete(`/transfers/${id}`, { params }),
}

// ─── Stock Adjustments (approval workflow) ───────────────────────────────────
export const adjustmentsAPI = {
  list:    (params) => api.get('/adjustments/', { params }),
  create:  (data)   => api.post('/adjustments/', data),
  approve: (id, data) => api.post(`/adjustments/${id}/approve`, data),
  submit:  (id, params) => api.post(`/adjustments/${id}/submit`, null, { params }),
  reject:  (id, data) => api.post(`/adjustments/${id}/reject`, data),
  delete:  (id, params) => api.delete(`/adjustments/${id}`, { params }),
}

// ─── Cash ─────────────────────────────────────────────────────────────────────
export const cashAPI = {
  entries: (branchId, date) => api.get(`/cash/${branchId}/entries`, { params: { date } }),
  summary: (branchId, date) => api.get(`/cash/${branchId}/summary`, { params: { date } }),
  add:     (branchId, data) => api.post(`/cash/${branchId}/entries`, data),
  delete:  (branchId, entryId) => api.delete(`/cash/${branchId}/entries/${entryId}`),
  void:    (branchId, entryId, data) => api.post(`/cash/${branchId}/entries/${entryId}/void`, data),
  history: (branchId, params) => api.get(`/cash/${branchId}/history`, { params }),
  unlock:  (branchId, closeId, data) => api.post(`/cash/${branchId}/close/${closeId}/unlock`, data),
  categories: {
    list: (params) => api.get('/cash/categories', { params }),
  },
  close:   (branchId, data) => api.post(`/cash/${branchId}/close`, data),
}

// ─── Reports ──────────────────────────────────────────────────────────────────
export const reportsAPI = {
  salesSummary:    (params) => api.get('/reports/sales-summary',    { params }),
  purchaseSummary: (params) => api.get('/reports/purchase-summary', { params }),
  taxSummary:      (params) => api.get('/reports/tax-summary',      { params }),
  stockMovement:   (params) => api.get('/reports/stock-movement',   { params }),
  salesRegister:         (params) => api.get('/reports/sales-register',     { params }),
  dailySales:            (params) => api.get('/reports/daily-sales',        { params }),
  productSales:          (params) => api.get('/reports/product-sales',      { params }),
  categorySales:         (params) => api.get('/reports/category-sales',     { params }),
  branchSales:           (params) => api.get('/reports/branch-sales',       { params }),
  cashierSales:          (params) => api.get('/reports/cashier-sales',      { params }),
  purchaseRegister:      (params) => api.get('/reports/purchase-register',  { params }),
  vendorPurchases:       (params) => api.get('/reports/vendor-purchases',   { params }),
  productPurchases:      (params) => api.get('/reports/product-purchases',  { params }),
  currentStock:          (params) => api.get('/reports/current-stock',      { params }),
  lowStock:              (params) => api.get('/reports/low-stock',         { params }),
  outOfStock:            (params) => api.get('/reports/out-of-stock',       { params }),
  stockTransfers:        (params) => api.get('/reports/stock-transfers',    { params }),
  dailyTax:              (params) => api.get('/reports/daily-tax',         { params }),
  monthlyTax:            (params) => api.get('/reports/monthly-tax',       { params }),
  quarterlyTax:          (params) => api.get('/reports/quarterly-tax',     { params }),
  gstSummary:            (params) => api.get('/reports/gst-summary',       { params }),
  outstandingReceivables:(params) => api.get('/reports/outstanding-receivables',{ params }),
  outstandingPayables:   (params) => api.get('/reports/outstanding-payables',{ params }),
  pettyCash:             (params) => api.get('/reports/petty-cash',        { params }),
  topCustomers:          (params) => api.get('/reports/top-customers',      { params }),
  vendorOutstanding:     (params) => api.get('/reports/vendor-outstanding', { params }),
  branchCompare:         (params) => api.get('/reports/branch-comparison',{ params }),
  marginAnalysis:        (params) => api.get('/reports/margin-analysis',  { params }),
  documentTrail:   (params) => api.get('/reports/document-trail',   { params }),
}

// ─── Users ────────────────────────────────────────────────────────────────────
export const usersAPI = {
  list:   (params)   => api.get('/users/', { params }),
  create: (data)     => api.post('/users/', data),
  update: (id, data) => api.patch(`/users/${id}`, data),
  toggle: (id)       => api.patch(`/users/${id}/toggle`),
}

// ─── Roles ────────────────────────────────────────────────────────────────────
// See docs/USERS_AND_ROLES.md §7.4. CRUD on roles + the read-only permission
// catalog used by the Roles editor and useCan().
export const rolesAPI = {
  list:   (params) => api.get('/roles/', { params }),
  get:    (id)       => api.get(`/roles/${id}`),
  create: (data)     => api.post('/roles/', data),
  update: (id, data) => api.put(`/roles/${id}`, data),
  delete: (id)       => api.delete(`/roles/${id}`),
}

export const permissionsAPI = {
  catalog: () => api.get('/permissions/catalog'),
}

// ─── Settings ─────────────────────────────────────────────────────────────────
export const settingsAPI = {
  getOrganisation: (config) => api.get('/settings/organisation', config),
  updateOrganisation: (data) => api.put('/settings/organisation', data),
  patchOrganisation: (data) => api.patch('/settings/organisation', data),
  getInvoiceTemplate: (config) => api.get('/settings/invoice-template', config),
  updateInvoiceTemplate: (data) => api.put('/settings/invoice-template', data),
  listNumbering: (config) => api.get('/settings/numbering', config),
  updateNumbering: (docType, data) => api.put(`/settings/numbering/${docType}`, data),
  previewNumber: (docType, branchId) => api.get('/settings/numbering/preview', {
    params: { doc_type: docType, branch_id: branchId || undefined },
  }),
  getTaxSettings: (config) => api.get('/taxes/settings', config),
  updateTaxSettings: (data) => api.patch('/taxes/settings', data),
}

// ─── Notifications ────────────────────────────────────────────────────────────
export const notificationsAPI = {
  list:    (params) => api.get('/notifications/', { params }),
  count:   (params) => api.get('/notifications/count', { params }),
  read:    (id)     => api.post(`/notifications/${id}/read`),
  readAll: (params) => api.post('/notifications/read-all', null, { params }),
}

// ─── Tax rates ───────────────────────────────────────────────────────────────
export const taxRatesAPI = {
  list:   (params, config) => api.get('/taxes/', { params, ...config }),
  get:    (id)       => api.get(`/taxes/${id}`),
  create: (data)     => api.post('/taxes/', data),
  update: (id, data) => api.put(`/taxes/${id}`, data),
  delete: (id)       => api.delete(`/taxes/${id}`),
}

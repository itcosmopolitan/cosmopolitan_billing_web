import axios from 'axios'
import toast from 'react-hot-toast'

// ─── Base client ──────────────────────────────────────────────────────────────
export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
})

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
    const msg = err?.response?.data?.detail || err.message || 'Request failed'
    const status = err?.response?.status
    const url = err?.config?.url || ''
    const isAuthEndpoint = url.startsWith('/auth/')
    if (status === 401) {
      // Always surface the message — silent redirect on 401 made wrong-password
      // login look broken (no toast, no UI change).
      toast.error(msg)
      // Don't kick the user to /login if the failing request IS /auth/login
      // (already there) or /auth/me (App.jsx boot — RequireAuth handles it).
      if (!isAuthEndpoint) {
        localStorage.removeItem('retailos_token')
        const here = window.location.pathname
        if (here !== '/login') window.location.href = '/login'
      }
    } else {
      toast.error(msg)
    }
    return Promise.reject(err)
  }
)

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authAPI = {
  login:  (email, password) => api.post('/auth/login', { email, password }),
  logout: ()                => api.post('/auth/logout'),
  me:     ()                => api.get('/auth/me'),
  // Self-serve password change. Requires old password (defense against
  // stolen sessions, and the input the forced-first-login flow uses).
  // On success the backend clears must_change_password and returns
  // { message, must_change_password: false }.
  changePassword: (oldPassword, newPassword) =>
    api.post('/auth/change-password', { old_password: oldPassword, new_password: newPassword }),
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export const dashAPI = {
  kpis:            (branchId) => api.get('/dashboard/kpis',            { params: { branch_id: branchId } }),
  salesTrend:      (days)     => api.get('/dashboard/sales-trend',      { params: { days } }),
  topProducts:     (branchId) => api.get('/dashboard/top-products',     { params: { branch_id: branchId } }),
  branchComparison:()         => api.get('/dashboard/branch-comparison'),
  alerts:          ()         => api.get('/dashboard/alerts'),
}

// ─── Items ────────────────────────────────────────────────────────────────────
export const itemsAPI = {
  list:    (params) => api.get('/items/',             { params }),
  get:     (id)     => api.get(`/items/${id}`),
  create:  (data)   => api.post('/items/', data),
  update:  (id, data) => api.put(`/items/${id}`, data),
  adjust:  (data)   => api.post('/items/adjust', data),
  delete:  (id)     => api.delete(`/items/${id}`),
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
}

// ─── Sales ────────────────────────────────────────────────────────────────────
export const salesAPI = {
  list:    (params) => api.get('/sales/',             { params }),
  get:     (id)     => api.get(`/sales/${id}`),
  create:  (data)   => api.post('/sales/', data),
  payment: (id, data) => api.post(`/sales/${id}/payment`, data),
  cancel:  (id)     => api.post(`/sales/${id}/cancel`),
  returns: (params) => api.get('/sales/returns', { params }),
  creditPurchases: (params) => api.get('/sales/credit/purchases', { params }),
  quotations: {
    list:    (params) => api.get('/sales/quotations/', { params }),
    get:     (id)     => api.get(`/sales/quotations/${id}`),
    create:  (data)   => api.post('/sales/quotations/', data),
    updateStatus: (id, status) => api.patch(`/sales/quotations/${id}/status`, { status }),
  },
}

// ─── Purchases ────────────────────────────────────────────────────────────────
export const purchasesAPI = {
  list:    (params) => api.get('/purchases/',         { params }),
  get:     (id)     => api.get(`/purchases/${id}`),
  create:  (data)   => api.post('/purchases/', data),
  payment: (id, data) => api.post(`/purchases/${id}/payment`, data),
  returns: {
    list:    (params) => api.get('/purchases/returns/', { params }),
    get:     (id)     => api.get(`/purchases/returns/${id}`),
    create:  (data)   => api.post('/purchases/returns/', data),
    approve: (id)     => api.post(`/purchases/returns/${id}/approve`),
  }
}

// ─── Customers ────────────────────────────────────────────────────────────────
export const customersAPI = {
  list:   (params) => api.get('/customers/',          { params }),
  get:    (id)     => api.get(`/customers/${id}`),
  create: (data)   => api.post('/customers/', data),
  update: (id, data) => api.put(`/customers/${id}`, data),
}

// ─── Vendors ──────────────────────────────────────────────────────────────────
export const vendorsAPI = {
  list:   (params) => api.get('/vendors/',            { params }),
  get:    (id)     => api.get(`/vendors/${id}`),
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

// ─── Transfers ────────────────────────────────────────────────────────────────
export const transfersAPI = {
  list:    (params) => api.get('/transfers/',          { params }),
  get:     (id)     => api.get(`/transfers/${id}`),
  create:  (data)   => api.post('/transfers/', data),
  approve: (id)     => api.post(`/transfers/${id}/approve`),
  receive: (id)     => api.post(`/transfers/${id}/receive`),
}

// ─── Cash ─────────────────────────────────────────────────────────────────────
export const cashAPI = {
  entries: (branchId, date) => api.get(`/cash/${branchId}/entries`, { params: { date } }),
  summary: (branchId, date) => api.get(`/cash/${branchId}/summary`, { params: { date } }),
  add:     (branchId, data) => api.post(`/cash/${branchId}/entries`, data),
  close:   (branchId, data) => api.post(`/cash/${branchId}/close`, data),
}

// ─── Reports ──────────────────────────────────────────────────────────────────
export const reportsAPI = {
  salesSummary:    (params) => api.get('/reports/sales-summary',    { params }),
  purchaseSummary: (params) => api.get('/reports/purchase-summary', { params }),
  taxSummary:      (params) => api.get('/reports/tax-summary',      { params }),
  stockMovement:   (params) => api.get('/reports/stock-movement',   { params }),
  branchCompare:   (params) => api.get('/reports/branch-comparison',{ params }),
  marginAnalysis:  (params) => api.get('/reports/margin-analysis',  { params }),
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
  list:   ()         => api.get('/roles/'),
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
  listNumbering: () => api.get('/settings/numbering'),
  updateNumbering: (docType, data) => api.put(`/settings/numbering/${docType}`, data),
}

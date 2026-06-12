import { api } from '@/api'

const cleanParams = (filters = {}) => {
  const params = {}
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params[key] = value
  })
  return params
}

export const getDashboardFilters = () => api.get('/dashboard/filters')
export const getDashboardSummary = (filters) => api.get('/dashboard/summary', { params: cleanParams(filters) })
export const getSalesDashboard = (filters) => api.get('/dashboard/sales', { params: cleanParams(filters) })
export const getInventoryDashboard = (filters) => api.get('/dashboard/inventory', { params: cleanParams(filters) })
export const getBillingDashboard = (filters) => api.get('/dashboard/billing', { params: cleanParams(filters) })
export const getOperationsDashboard = (filters) => api.get('/dashboard/operations', { params: cleanParams(filters) })

export const getSalesTopProducts = (filters) => api.get('/dashboard/sales/top-products', { params: cleanParams(filters) })
export const getRecentSales = (filters) => api.get('/dashboard/sales/recent-sales', { params: cleanParams(filters) })
export const getLowStock = (filters) => api.get('/dashboard/inventory/low-stock', { params: cleanParams(filters) })
export const getExpiryNear = (filters) => api.get('/dashboard/inventory/expiry-near', { params: cleanParams(filters) })
export const getPendingPayments = (filters) => api.get('/dashboard/billing/pending-payments', { params: cleanParams(filters) })
export const getActivityLogs = (filters) => api.get('/dashboard/operations/activity-logs', { params: cleanParams(filters) })

export const exportDashboardApi = (payload) => api.post('/dashboard/export', payload)

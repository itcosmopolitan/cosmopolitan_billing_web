import { useQuery } from '@tanstack/react-query'
import {
  getBillingDashboard,
  getInventoryDashboard,
  getOperationsDashboard,
  getSalesDashboard,
} from '../api/dashboardApi'
import { dashboardKeys } from '../api/queryKeys'

const endpoints = {
  sales: getSalesDashboard,
  inventory: getInventoryDashboard,
  billing: getBillingDashboard,
  operations: getOperationsDashboard,
}

export function useDashboardQuery(tab, filters, { autoRefresh = false, enabled = true } = {}) {
  return useQuery({
    queryKey: dashboardKeys[tab](filters),
    queryFn: () => endpoints[tab](filters),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    keepPreviousData: true,
    refetchInterval: autoRefresh ? 60_000 : false,
    enabled: enabled && Boolean(endpoints[tab]),
  })
}

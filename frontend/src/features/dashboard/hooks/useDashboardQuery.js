import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/store'
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
  const activeBranchId = useAppStore((s) => s.activeBranch?.id)
  const requestFilters = useMemo(
    () => ({
      ...filters,
      ...(filters?.branch_id ? {} : activeBranchId ? { branch_id: activeBranchId } : {}),
    }),
    [filters, activeBranchId],
  )

  return useQuery({
    queryKey: dashboardKeys[tab](requestFilters),
    queryFn: () => endpoints[tab](requestFilters),
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    keepPreviousData: true,
    refetchInterval: autoRefresh ? 60_000 : false,
    enabled: enabled && Boolean(endpoints[tab]),
  })
}

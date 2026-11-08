import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/store'
import {
  getBillingDashboard,
  getInventoryDashboard,
  getOperationsDashboard,
  getSalesDashboard,
} from '../api/dashboardApi'
import { dashboardKeys } from '../api/queryKeys'
import { dashboardRequestForRefresh } from '../utils/dashboardRefresh'

const endpoints = {
  sales: getSalesDashboard,
  inventory: getInventoryDashboard,
  billing: getBillingDashboard,
  operations: getOperationsDashboard,
}

export function useDashboardQuery(
  tab,
  filters,
  { autoRefresh = false, enabled = true, refreshToken = 0, onUpdatedAt } = {},
) {
  const activeBranchId = useAppStore((s) => s.activeBranch?.id)
  const completedRefreshToken = useRef(0)
  const currentRefreshToken = Number(refreshToken || 0)
  const requestFilters = useMemo(
    () => ({
      ...filters,
      ...(filters?.branch_id ? {} : activeBranchId ? { branch_id: activeBranchId } : {}),
    }),
    [filters, activeBranchId],
  )

  const query = useQuery({
    queryKey: [...dashboardKeys[tab](requestFilters), currentRefreshToken],
    queryFn: async () => {
      const request = dashboardRequestForRefresh(
        requestFilters,
        currentRefreshToken,
        completedRefreshToken.current,
      )
      const result = await endpoints[tab](request.filters)
      const { bypassCache } = request
      if (bypassCache) completedRefreshToken.current = currentRefreshToken
      return result
    },
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    keepPreviousData: true,
    refetchInterval: autoRefresh ? 60_000 : false,
    enabled: enabled && Boolean(endpoints[tab]),
  })

  useEffect(() => {
    if (query.data?.generated_at) onUpdatedAt?.(query.data.generated_at)
  }, [onUpdatedAt, query.data?.generated_at])

  return query
}

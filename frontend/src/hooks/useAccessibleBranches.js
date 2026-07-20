import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { branchesAPI } from '@/api'
import { useAppStore } from '@/store'

export const branchQueryKeys = {
  all: (status = 'all') => ['branches', 'all', status],
}

export function invalidateBranchQueries(queryClient) {
  if (!queryClient) return
  queryClient.invalidateQueries({ queryKey: ['branches'] })
}

export function useAccessibleBranches() {
  const queryClient = useQueryClient()
  const user = useAppStore((s) => s.user)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const setActiveBranch = useAppStore((s) => s.setActiveBranch)
  const setBranches = useAppStore((s) => s.setBranches)

  const branchQuery = useQuery({
    queryKey: branchQueryKeys.all('all'),
    queryFn: async () => {
      const data = await branchesAPI.list({ status: 'all' })
      if (Array.isArray(data)) return data
      if (Array.isArray(data?.items)) return data.items
      return []
    },
    enabled: Boolean(user?.id),
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  })

  const allBranches = useMemo(() => {
    const rows = Array.isArray(branchQuery.data) ? branchQuery.data : []
    return rows.filter((b) => b && typeof b === 'object')
  }, [branchQuery.data])

  const accessibleBranches = useMemo(() => {
    if (!user) return []

    const activeOnly = allBranches.filter((branch) => branch?.active !== false)

    if (user.all_branches) {
      return activeOnly
    }

    const assigned = Array.isArray(user.branch_ids) && user.branch_ids.length > 0
      ? user.branch_ids
      : (user.branch_id ? [user.branch_id] : [])

    if (!assigned.length) {
      return []
    }

    const assignedSet = new Set(assigned)
    return activeOnly.filter((branch) => assignedSet.has(branch.id))
  }, [allBranches, user?.all_branches, user?.branch_id, user?.branch_ids])

  useEffect(() => {
    if (!branchQuery.isSuccess) return
    setBranches(allBranches)
  }, [allBranches, branchQuery.isSuccess, setBranches])

  useEffect(() => {
    if (!user) return
    if (!accessibleBranches.length) {
      if (activeBranch?.id) {
        setActiveBranch(null)
      }
      return
    }

    const activeStillAllowed = accessibleBranches.some((branch) => branch.id === activeBranch?.id)
    if (!activeStillAllowed) {
      setActiveBranch(accessibleBranches[0])
    }
  }, [accessibleBranches, activeBranch?.id, setActiveBranch, user?.id])

  return {
    allBranches,
    accessibleBranches,
    isLoading: branchQuery.isLoading,
    isError: branchQuery.isError,
    refetch: () => branchQuery.refetch(),
    invalidate: () => invalidateBranchQueries(queryClient),
  }
}

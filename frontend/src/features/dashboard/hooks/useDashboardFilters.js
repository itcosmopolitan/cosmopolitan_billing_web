import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/store'
import { getDashboardFilters } from '../api/dashboardApi'
import { dashboardKeys } from '../api/queryKeys'

const isoDate = (date) => date.toISOString().slice(0, 10)

const monthStart = () => {
  const now = new Date()
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 1))
}

const today = () => isoDate(new Date())

export function useDashboardFilters() {
  const activeBranch = useAppStore((s) => s.activeBranch)
  const branches = useAppStore((s) => s.branches)
  const [filters, setFilters] = useState({
    from: monthStart(),
    to: today(),
    staff_id: '',
    category_id: '',
  })

  const optionsQuery = useQuery({
    queryKey: dashboardKeys.filters(),
    queryFn: getDashboardFilters,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  const setFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const resetFilters = () => {
    setFilters({
      from: monthStart(),
      to: today(),
      staff_id: '',
      category_id: '',
    })
  }

  const filterOptions = useMemo(() => {
    const apiOptions = optionsQuery.data || {}
    return {
      branches: apiOptions.branches?.length ? apiOptions.branches : branches,
      staff: apiOptions.staff || [],
      categories: apiOptions.categories || [],
    }
  }, [branches, optionsQuery.data])

  return {
    filters,
    setFilter,
    setFilters,
    resetFilters,
    filterOptions,
    optionsLoading: optionsQuery.isLoading,
  }
}

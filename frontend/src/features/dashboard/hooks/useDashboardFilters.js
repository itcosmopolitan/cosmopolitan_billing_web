import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/store'
import { getDashboardFilters } from '../api/dashboardApi'
import { dashboardKeys } from '../api/queryKeys'

const isoDate = (date) => date.toISOString().slice(0, 10)

const today = () => isoDate(new Date())
const monthStart = () => {
  const now = new Date()
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 1))
}

const startOfWeek = (now) => {
  const day = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((day + 6) % 7))
  return monday
}

const endOfWeek = (start) => {
  const sunday = new Date(start)
  sunday.setDate(start.getDate() + 6)
  return sunday
}

const rangeOptions = [
  { value: 'today', label: 'Today' },
  { value: 'last_3_days', label: 'Last 3 days' },
  { value: 'this_week', label: 'This week' },
  { value: 'previous_week', label: 'Previous week' },
  { value: 'this_month', label: 'This month' },
  { value: 'previous_month', label: 'Previous month' },
  { value: 'last_3_months', label: 'Last 3 months' },
]

const getPresetRange = (range) => {
  const now = new Date()
  const todayString = today()

  switch (range) {
    case 'today':
      return { from: todayString, to: todayString }
    case 'last_3_days': {
      const start = new Date(now)
      start.setDate(now.getDate() - 2)
      return { from: isoDate(start), to: todayString }
    }
    case 'this_week': {
      const start = startOfWeek(now)
      return { from: isoDate(start), to: todayString }
    }
    case 'previous_week': {
      const thisMonday = startOfWeek(now)
      const start = new Date(thisMonday)
      start.setDate(thisMonday.getDate() - 7)
      const end = endOfWeek(start)
      return { from: isoDate(start), to: isoDate(end) }
    }
    case 'this_month':
      return { from: monthStart(), to: todayString }
    case 'previous_month': {
      const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0)
      const previousMonthStart = new Date(previousMonthEnd.getFullYear(), previousMonthEnd.getMonth(), 1)
      return { from: isoDate(previousMonthStart), to: isoDate(previousMonthEnd) }
    }
    case 'last_3_months': {
      const start = new Date(now.getFullYear(), now.getMonth() - 2, 1)
      return { from: isoDate(start), to: todayString }
    }
    default:
      return { from: monthStart(), to: todayString }
  }
}

const DEFAULT_RANGE = 'this_month'
const defaultFilters = {
  range: DEFAULT_RANGE,
  ...getPresetRange(DEFAULT_RANGE),
  staff_id: '',
  category_id: '',
}

export function useDashboardFilters() {
  const activeBranch = useAppStore((s) => s.activeBranch)
  const branches = useAppStore((s) => s.branches)
  const [filters, setFilters] = useState(defaultFilters)

  const optionsQuery = useQuery({
    queryKey: dashboardKeys.filters(),
    queryFn: getDashboardFilters,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  const setFilter = (key, value) => {
    if (key === 'range') {
      setFilters((prev) => ({
        ...prev,
        range: value,
        ...getPresetRange(value),
      }))
      return
    }
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const resetFilters = () => {
    setFilters(defaultFilters)
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
    rangeOptions,
  }
}

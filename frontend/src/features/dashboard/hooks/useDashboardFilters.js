import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/store'
import { getDashboardFilters } from '../api/dashboardApi'
import { dashboardKeys } from '../api/queryKeys'

const isoDate = (date) => {
  return date.toISOString().slice(0, 10)
}

const businessTodayDate = () => {
  const parts = new Intl.DateTimeFormat('en-MV', {
    timeZone: 'Indian/Maldives',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = (type) => Number(parts.find((value) => value.type === type)?.value)
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')))
}

const monthStart = () => {
  const now = businessTodayDate()
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
}

const startOfWeek = (now) => {
  const day = now.getUTCDay()
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7))
  return monday
}

const endOfWeek = (start) => {
  const sunday = new Date(start)
  sunday.setUTCDate(start.getUTCDate() + 6)
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
  const now = businessTodayDate()
  const todayString = isoDate(now)

  switch (range) {
    case 'today':
      return { from: todayString, to: todayString }
    case 'last_3_days': {
      const start = new Date(now)
      start.setUTCDate(now.getUTCDate() - 2)
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
      const previousMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      const previousMonthStart = new Date(Date.UTC(
        previousMonthEnd.getUTCFullYear(),
        previousMonthEnd.getUTCMonth(),
        1,
      ))
      return { from: isoDate(previousMonthStart), to: isoDate(previousMonthEnd) }
    }
    case 'last_3_months': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
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
  const activeBranchId = useAppStore((s) => s.activeBranch?.id)
  const branches = useAppStore((s) => s.branches)
  const [filters, setFilters] = useState(defaultFilters)
  const knownStaffOptions = useRef(new Map())

  const staffFilterParams = useMemo(() => ({
    branch_id: filters.branch_id || activeBranchId || '',
    from: filters.from,
    to: filters.to,
    category_id: filters.category_id,
  }), [activeBranchId, filters.branch_id, filters.category_id, filters.from, filters.to])

  const optionsQuery = useQuery({
    queryKey: dashboardKeys.filters(staffFilterParams),
    queryFn: () => getDashboardFilters(staffFilterParams),
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  useEffect(() => {
    for (const option of optionsQuery.data?.staff || []) {
      knownStaffOptions.current.set(option.id, option)
    }
  }, [optionsQuery.data])

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
    const staffOptions = apiOptions.staff || []
    const selectedStaffOption = filters.staff_id
      ? knownStaffOptions.current.get(filters.staff_id)
      : null
    const hasSelectedStaffOption = staffOptions.some((option) => option.id === filters.staff_id)
    return {
      branches: apiOptions.branches?.length ? apiOptions.branches : branches,
      staff: selectedStaffOption && !hasSelectedStaffOption
        ? [...staffOptions, selectedStaffOption]
        : staffOptions,
      categories: apiOptions.categories || [],
    }
  }, [branches, filters.staff_id, optionsQuery.data])

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

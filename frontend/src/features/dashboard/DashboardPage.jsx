import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import DashboardHeader from './components/DashboardHeader'
import DashboardTabs from './components/DashboardTabs'
import SkeletonCard from './components/SkeletonCard'
import { dashboardKeys } from './api/queryKeys'
import { useCan } from '@/auth/permissions'
import { useAutoRefresh } from './hooks/useAutoRefresh'
import { useDashboardFilters } from './hooks/useDashboardFilters'
import { useDebouncedFilters } from './hooks/useDebouncedFilters'
import { exportDashboard } from './utils/exportDashboard'
import { DASHBOARD_TABS } from './utils/tabsConfig'

const SalesDashboard = lazy(() => import('./tabs/SalesDashboard'))
const InventoryDashboard = lazy(() => import('./tabs/InventoryDashboard'))
const BillingDashboard = lazy(() => import('./tabs/BillingDashboard'))
const OperationsDashboard = lazy(() => import('./tabs/OperationsDashboard'))

const tabComponents = {
  sales: SalesDashboard,
  inventory: InventoryDashboard,
  billing: BillingDashboard,
  operations: OperationsDashboard,
}

export default function DashboardPage() {
  const queryClient = useQueryClient()
  const can = useCan()
  const [activeTab, setActiveTab] = useState('sales')
  const { autoRefresh, toggleAutoRefresh } = useAutoRefresh(false)
  const { filters, setFilter, resetFilters, filterOptions, rangeOptions } = useDashboardFilters()
  const debouncedFilters = useDebouncedFilters(filters, 400)
  const fetchingCount = useIsFetching({ queryKey: dashboardKeys.root })

  const visibleTabs = useMemo(
    () => DASHBOARD_TABS.filter((tab) => can(tab.permission)),
    [can],
  )

  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(visibleTabs[0].id)
    }
  }, [activeTab, visibleTabs])

  const ActiveTab = tabComponents[activeTab] || SalesDashboard
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: dashboardKeys.root })
  }

  const handleExport = (format) => {
    exportDashboard({ tab: activeTab, format, filters: debouncedFilters }).catch(() => {})
  }

  if (!visibleTabs.length) {
    return (
      <div className="page-container">
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
            No dashboard tabs are available for your role.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <DashboardHeader
        filters={filters}
        filterOptions={{ ...filterOptions, rangeOptions }}
        onFilterChange={setFilter}
        onReset={resetFilters}
        onRefresh={refresh}
        isFetching={fetchingCount > 0}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={toggleAutoRefresh}
        onExport={handleExport}
      />
      <DashboardTabs tabs={visibleTabs} activeTab={activeTab} onChange={setActiveTab} />
      <Suspense fallback={<DashboardFallback />}>
        <ActiveTab filters={debouncedFilters} autoRefresh={autoRefresh} />
      </Suspense>
    </div>
  )
}

function DashboardFallback() {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="grid-kpi">
        {Array.from({ length: 6 }).map((_, index) => <SkeletonCard key={index} height={136} />)}
      </div>
      <div className="grid-2">
        <SkeletonCard height={320} rows={5} />
        <SkeletonCard height={320} rows={5} />
      </div>
    </div>
  )
}

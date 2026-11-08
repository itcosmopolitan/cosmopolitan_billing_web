import BranchComparisonChart from '../charts/BranchComparisonChart'
import HeatmapChart from '../charts/HeatmapChart'
import ChartCard from '../components/ChartCard'
import CompactCurrency from '../components/CompactCurrency'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import PermissionGate from '../components/PermissionGate'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatCurrency, formatNumber } from '../utils/formatCurrency'
import { NOT_SET } from '@/utils/emptyValue'

const spark = (rows = [], key) => rows.map((row) => ({ value: row[key] || 0 }))

export default function OperationsDashboard({ filters, autoRefresh, refreshToken, onUpdatedAt }) {
  const query = useDashboardQuery('operations', filters, { autoRefresh, refreshToken, onUpdatedAt })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const deltaValues = data.delta_values || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}
  const categoryFiltered = Boolean(filters.category_id)

  const staffChart = (charts.staff_sales || []).map((row) => ({ ...row, branch: row.staff }))

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="grid-kpi">
        <KpiCard
          title={categoryFiltered ? "Today's Invoices Containing This Category" : "Today's Transactions"}
          tooltip="Count of finalized invoices dated business-local today. Ignores the selected date range; Branch, KAM, and Category filters apply."
          value={formatNumber(kpis.daily_transactions)}
          delta={deltas.daily_transactions}
          deltaTooltip={formatDeltaValues(deltaValues.daily_transactions)}
          tone="info"
          sparkline={spark(charts.branch_performance, 'sales')}
          loading={loading}
        />
        <KpiCard title="Peak Sales Hour" value={kpis.peak_sales_hour || NOT_SET} delta={deltas.peak_sales_hour} tone="warning" sparkline={spark(charts.hourly_heatmap, 'value')} loading={loading} />
        <KpiCard title="Best Branch" value={kpis.best_branch || NOT_SET} delta={deltas.best_branch} tone="success" sparkline={spark(charts.branch_performance, 'sales')} loading={loading} />
        <KpiCard title="Best KAM" value={kpis.best_staff || NOT_SET} delta={deltas.best_staff} tone="success" sparkline={spark(charts.staff_sales, 'sales')} loading={loading} permission="dashboard.staff_performance.view" />
      </div>

      <div className="grid-3">
        <PermissionGate permission="dashboard.staff_performance.view">
          <ChartCard title="KAM Sales (MVR, excl. GST)" loading={loading}>
            <BranchComparisonChart data={staffChart} />
          </ChartCard>
        </PermissionGate>
        <ChartCard title="Hourly Heatmap (MVR, excl. GST)" loading={loading}>
          <HeatmapChart data={charts.hourly_heatmap || []} />
        </ChartCard>
        <ChartCard title="Branch Performance (MVR, excl. GST)" loading={loading}>
          <BranchComparisonChart data={charts.branch_performance || []} />
        </ChartCard>
      </div>

      <div className="grid-2">
        <OperationalEfficiencyPanel analytics={analytics} categoryFiltered={categoryFiltered} />
        <DataTable title="Branch Rankings" loading={loading} rows={tables.branch_rankings?.items || []} columns={categoryFiltered ? branchCategoryColumns : branchColumns} />
      </div>

      <div className="grid-2">
        <PermissionGate permission="dashboard.staff_performance.view">
          <DataTable title="KAM Performance" loading={loading} rows={tables.staff_performance?.items || []} columns={categoryFiltered ? staffCategoryColumns : staffColumns} />
        </PermissionGate>
        <div
          title="Recent audit logs follow the selected date range and Branch filter. KAM and Category are not log attributes and do not filter this table."
          style={{ minWidth: 0 }}
        >
          <DataTable title="Recent Logs" loading={loading} rows={tables.recent_logs?.items || []} columns={logColumns} />
        </div>
      </div>
    </div>
  )
}

function formatDeltaValues(values) {
  if (!values) return undefined
  return `Previous: ${Number(values.previous || 0)}; Current: ${Number(values.current || 0)}`
}

function OperationalEfficiencyPanel({ analytics = {}, categoryFiltered = false }) {
  const billsPerStaffDay = Number(analytics.bills_per_staff_per_day ?? analytics.productivity ?? 0)
  const billsPerStaff = Number(analytics.bills_per_staff || 0)
  const revenuePerBill = Number(analytics.revenue_per_bill || 0)

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>Operational Efficiency</h4>
      </div>
      <div className="card-body" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <EfficiencyMetric label="Bills per KAM per day" value={formatNumber(billsPerStaffDay)} emphasis />
          <EfficiencyMetric label={categoryFiltered ? 'Category invoices per KAM' : 'Bills per KAM'} value={formatNumber(billsPerStaff)} />
          <EfficiencyMetric
            label="Revenue per bill excl. GST (MVR)"
            value={<CompactCurrency value={revenuePerBill} />}
            valueTitle={formatCurrency(revenuePerBill)}
          />
        </div>
      </div>
    </div>
  )
}

function EfficiencyMetric({ label, value, emphasis = false, valueTitle }) {
  return (
    <div style={{ minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5 }}>{label}</div>
      <div
        title={valueTitle}
        style={{
          fontSize: emphasis ? 19 : 17,
          lineHeight: 1.15,
          fontWeight: 800,
          color: emphasis ? 'var(--text-primary)' : 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </div>
    </div>
  )
}

const staffColumns = [
  { key: 'staff', header: 'KAM' },
  { key: 'bill_count', header: 'Bills', align: 'right', width: 72, render: (row) => formatNumber(row.bill_count) },
  { key: 'sales', header: 'Sales excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.sales} /> },
]

const staffCategoryColumns = [
  { key: 'staff', header: 'KAM' },
  { key: 'bill_count', header: 'Invoices containing this category', align: 'right', width: 170, render: (row) => formatNumber(row.bill_count) },
  { key: 'sales', header: 'Sales excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.sales} /> },
]

const branchColumns = [
  { key: 'branch', header: 'Branch' },
  { key: 'transactions', header: 'Bills', align: 'right', width: 78, render: (row) => formatNumber(row.transactions) },
  { key: 'sales', header: 'Sales excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.sales} /> },
]

const branchCategoryColumns = [
  { key: 'branch', header: 'Branch' },
  { key: 'transactions', header: 'Invoices containing this category', align: 'right', width: 170, render: (row) => formatNumber(row.transactions) },
  { key: 'sales', header: 'Sales (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.sales} /> },
]

const logColumns = [
  { key: 'created_at', header: 'Time' },
  { key: 'module', header: 'Module' },
  { key: 'detail', header: 'Detail' },
]

import BranchComparisonChart from '../charts/BranchComparisonChart'
import HeatmapChart from '../charts/HeatmapChart'
import ChartCard from '../components/ChartCard'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import PermissionGate from '../components/PermissionGate'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatCompactCurrency, formatNumber, formatPercent } from '../utils/formatCurrency'

const spark = (rows = [], key) => rows.map((row) => ({ value: row[key] || 0 }))

export default function OperationsDashboard({ filters, autoRefresh }) {
  const query = useDashboardQuery('operations', filters, { autoRefresh })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}

  const staffChart = (charts.staff_sales || []).map((row) => ({ ...row, branch: row.staff }))

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="grid-kpi">
        <KpiCard title="Daily Transactions" value={formatNumber(kpis.daily_transactions)} delta={deltas.daily_transactions} tone="info" sparkline={spark(charts.branch_performance, 'sales')} loading={loading} />
        <KpiCard title="Peak Sales Hour" value={kpis.peak_sales_hour || '—'} delta={deltas.peak_sales_hour} tone="warning" sparkline={spark(charts.hourly_heatmap, 'value')} loading={loading} />
        <KpiCard title="Best Branch" value={kpis.best_branch || '—'} delta={deltas.best_branch} tone="success" sparkline={spark(charts.branch_performance, 'sales')} loading={loading} />
        <KpiCard title="Best Staff" value={kpis.best_staff || '—'} delta={deltas.best_staff} tone="success" sparkline={spark(charts.staff_sales, 'sales')} loading={loading} permission="dashboard.staff_performance.view" />
      </div>

      <div className="grid-3">
        <PermissionGate permission="dashboard.staff_performance.view">
          <ChartCard title="Staff Sales" loading={loading}>
            <BranchComparisonChart data={staffChart} />
          </ChartCard>
        </PermissionGate>
        <ChartCard title="Hourly Heatmap" loading={loading}>
          <HeatmapChart data={charts.hourly_heatmap || []} />
        </ChartCard>
        <ChartCard title="Branch Performance" loading={loading}>
          <BranchComparisonChart data={charts.branch_performance || []} />
        </ChartCard>
      </div>

      <div className="grid-2">
        <OperationalEfficiencyPanel analytics={analytics} />
        <DataTable title="Branch Rankings" loading={loading} rows={tables.branch_rankings?.items || []} columns={branchColumns} />
      </div>

      <div className="grid-2">
        <PermissionGate permission="dashboard.staff_performance.view">
          <DataTable title="Staff Performance" loading={loading} rows={tables.staff_performance?.items || []} columns={staffColumns} />
        </PermissionGate>
        <DataTable title="Recent Logs" loading={loading} rows={tables.recent_logs?.items || []} columns={logColumns} />
      </div>
    </div>
  )
}

function OperationalEfficiencyPanel({ analytics = {} }) {
  const productivity = Number(analytics.productivity || 0)
  const billsPerStaff = Number(analytics.bills_per_staff || 0)
  const revenuePerBill = Number(analytics.revenue_per_bill || 0)
  const productivityScore = Math.min(100, Math.max(0, productivity / 100))
  const billScore = Math.min(100, Math.max(0, billsPerStaff / 250))
  const revenueScore = Math.min(100, Math.max(0, revenuePerBill / 100))
  const tone = productivity >= 1000 ? 'var(--green)' : productivity >= 500 ? 'var(--blue)' : 'var(--amber)'
  const toneBg = productivity >= 1000 ? 'var(--green-bg)' : productivity >= 500 ? 'var(--blue-bg)' : 'var(--amber-bg)'
  const status = productivity >= 1000 ? 'High output' : productivity >= 500 ? 'Steady' : 'Needs lift'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>Operational Efficiency</h4>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 999,
            color: tone,
            background: toneBg,
          }}
        >
          {status}
        </span>
      </div>
      <div className="card-body" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '126px minmax(0, 1fr)', gap: 20, alignItems: 'center' }}>
          <div
            style={{
              width: 118,
              height: 118,
              borderRadius: '50%',
              background: `conic-gradient(${tone} ${productivityScore * 3.6}deg, var(--bg-raised) 0deg)`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div
              style={{
                width: 90,
                height: 90,
                borderRadius: '50%',
                background: 'var(--bg-surface)',
                display: 'grid',
                placeItems: 'center',
                textAlign: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 22, lineHeight: 1, fontWeight: 800 }}>
                  {formatCompactPercent(productivity)}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>
                  Output
                </div>
              </div>
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              <EfficiencyMetric label="Productivity" value={formatPercent(productivity)} emphasis />
              <EfficiencyMetric label="Bills per staff" value={formatNumber(billsPerStaff)} />
              <EfficiencyMetric label="Revenue per bill" value={formatCompactCurrency(revenuePerBill)} />
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
              <EfficiencyProgress label="Productivity index" value={productivityScore} tone={tone} />
              <EfficiencyProgress label="Staff load" value={billScore} tone="var(--blue)" />
              <EfficiencyProgress label="Bill value" value={revenueScore} tone="var(--green)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function EfficiencyMetric({ label, value, emphasis = false }) {
  return (
    <div style={{ minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5 }}>{label}</div>
      <div
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

function EfficiencyProgress({ label, value, tone }) {
  const width = Math.min(100, Math.max(0, value))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 7, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>{label}</span>
        <span style={{ color: tone, fontWeight: 800 }}>{Math.round(width)}%</span>
      </div>
      <div className="progress-bar" style={{ height: 8, borderRadius: 999 }}>
        <div className="progress-fill" style={{ width: `${width}%`, background: tone, borderRadius: 999 }} />
      </div>
    </div>
  )
}

function formatCompactPercent(value) {
  const n = Number(value || 0)
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K%`
  return formatPercent(n)
}

const staffColumns = [
  { key: 'staff', header: 'Staff' },
  { key: 'bill_count', header: 'Bills', align: 'right', width: 72, render: (row) => formatNumber(row.bill_count) },
  { key: 'sales', header: 'Sales', align: 'right', render: (row) => formatCompactCurrency(row.sales) },
]

const branchColumns = [
  { key: 'branch', header: 'Branch' },
  { key: 'transactions', header: 'Bills', align: 'right', width: 78, render: (row) => formatNumber(row.transactions) },
  { key: 'sales', header: 'Sales', align: 'right', render: (row) => formatCompactCurrency(row.sales) },
]

const logColumns = [
  { key: 'created_at', header: 'Time' },
  { key: 'module', header: 'Module' },
  { key: 'detail', header: 'Detail' },
]

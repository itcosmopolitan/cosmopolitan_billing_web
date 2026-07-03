import { useMemo } from 'react'
import BranchComparisonChart from '../charts/BranchComparisonChart'
import CategoryPieChart from '../charts/CategoryPieChart'
import RevenueProfitChart from '../charts/RevenueProfitChart'
import SalesTrendChart from '../charts/SalesTrendChart'
import ChartCard from '../components/ChartCard'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent } from '../utils/formatCurrency'

const spark = (rows = [], key) => rows.map((row) => ({ value: row[key] || 0 }))

export default function SalesDashboard({ filters, autoRefresh }) {
  const query = useDashboardQuery('sales', filters, { autoRefresh })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}

  const salesSpark = useMemo(() => spark(charts.sales_trend, 'sales'), [charts.sales_trend])
  const revenueSpark = useMemo(() => spark(charts.revenue_vs_profit, 'revenue'), [charts.revenue_vs_profit])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="grid-kpi">
        <KpiCard title="Daily Sales" value={formatCompactCurrency(kpis.daily_sales)} delta={deltas.daily_sales} tone="success" sparkline={salesSpark} loading={loading} />
        <KpiCard title="Weekly Sales" value={formatCompactCurrency(kpis.weekly_sales)} delta={deltas.weekly_sales} tone="info" sparkline={salesSpark} loading={loading} />
        <KpiCard title="Monthly Sales" value={formatCompactCurrency(kpis.monthly_sales)} delta={deltas.monthly_sales} tone="success" sparkline={salesSpark} loading={loading} />
        <KpiCard title="Revenue" value={formatCompactCurrency(kpis.total_revenue)} delta={deltas.total_revenue} tone="neutral" sparkline={revenueSpark} loading={loading} />
        <KpiCard title="Profit Margin" value={formatPercent(kpis.profit_margin)} delta={deltas.profit_margin} tone="success" sparkline={spark(charts.revenue_vs_profit, 'profit')} loading={loading} permission="dashboard.profit.view" />
        <KpiCard title="Average Bill Value" value={formatCurrency(kpis.average_bill_value)} delta={deltas.average_bill_value} tone="info" sparkline={salesSpark} loading={loading} />
      </div>

      <div className="grid-2">
        <ChartCard title="Sales Trend" loading={loading}>
          <SalesTrendChart data={charts.sales_trend || []} />
        </ChartCard>
        <ChartCard title="Revenue vs Profit" loading={loading}>
          <RevenueProfitChart data={charts.revenue_vs_profit || []} />
        </ChartCard>
      </div>

      <div className="grid-2">
        <ChartCard title="Category Mix" loading={loading}>
          <CategoryPieChart data={charts.category_pie || []} nameKey="category" valueKey="revenue" />
        </ChartCard>
        <ChartCard title="Brand Mix" loading={loading}>
          <CategoryPieChart data={charts.brand_donut || []} nameKey="brand" valueKey="revenue" donut />
        </ChartCard>
      </div>

      <div className="grid-2">
        <TargetAchievementPanel data={analytics.target_vs_achievement} />
        <ChartCard title="Branch-wise Sales" loading={loading}>
          <BranchComparisonChart data={analytics.branch_wise_sales || []} />
        </ChartCard>
      </div>

      <div className="grid-3">
        <DataTable title="Top Products" loading={loading} rows={tables.top_products?.items || []} columns={topProductColumns} />
        <DataTable title="Top Customers" loading={loading} rows={tables.top_customers?.items || []} columns={topCustomerColumns} />
        <DataTable title="Recent Sales" loading={loading} rows={tables.recent_sales?.items || []} columns={recentSalesColumns} />
      </div>
    </div>
  )
}

function TargetAchievementPanel({ data = {} }) {
  const target = Number(data?.target || 0)
  const achieved = Number(data?.achieved || 0)
  const pct = Number(data?.achievement_pct || 0)
  const cappedPct = Math.min(100, Math.max(0, pct))
  const remaining = Math.max(0, target - achieved)
  const overTarget = Math.max(0, achieved - target)
  const tone = pct >= 100 ? 'var(--green)' : pct >= 80 ? 'var(--blue)' : 'var(--amber)'
  const toneBg = pct >= 100 ? 'var(--green-bg)' : pct >= 80 ? 'var(--blue-bg)' : 'var(--amber-bg)'
  const status = pct >= 100 ? 'Target met' : pct >= 80 ? 'On track' : 'Needs focus'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>Target vs Achievement</h4>
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '150px minmax(0, 1fr)',
            gap: 20,
            alignItems: 'center',
          }}
        >
          <div
            style={{
              width: 136,
              height: 136,
              borderRadius: '50%',
              background: `conic-gradient(${tone} ${cappedPct * 3.6}deg, var(--bg-raised) 0deg)`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div
              style={{
                width: 104,
                height: 104,
                borderRadius: '50%',
                background: 'var(--bg-surface)',
                display: 'grid',
                placeItems: 'center',
                textAlign: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 26, lineHeight: 1, fontWeight: 800, color: 'var(--text-primary)' }}>
                  {formatPercent(pct)}
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                  Progress
                </div>
              </div>
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              <TargetMetric label="Target" value={formatCompactCurrency(target)} />
              <TargetMetric label="Achieved" value={formatCompactCurrency(achieved)} emphasis />
              <TargetMetric
                label={overTarget > 0 ? 'Above target' : 'Remaining'}
                value={formatCompactCurrency(overTarget > 0 ? overTarget : remaining)}
              />
            </div>
            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Achievement</span>
                <span style={{ color: tone, fontWeight: 800 }}>{formatPercent(pct)}</span>
              </div>
              <div className="progress-bar" style={{ height: 10, borderRadius: 999 }}>
                <div
                  className="progress-fill"
                  style={{ width: `${cappedPct}%`, background: tone, borderRadius: 999 }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                <span>MVR 0</span>
                <span>{formatCompactCurrency(target)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TargetMetric({ label, value, emphasis = false }) {
  return (
    <div style={{ minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5 }}>{label}</div>
      <div
        style={{
          fontSize: emphasis ? 22 : 18,
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

const topProductColumns = [
  { key: 'name', header: 'Product' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'revenue', header: 'Revenue', align: 'right', render: (row) => formatCompactCurrency(row.revenue) },
]

const topCustomerColumns = [
  { key: 'name', header: 'Customer' },
  { key: 'bill_count', header: 'Bills', align: 'right', width: 70, render: (row) => formatNumber(row.bill_count) },
  { key: 'revenue', header: 'Revenue', align: 'right', render: (row) => formatCompactCurrency(row.revenue) },
]

const recentSalesColumns = [
  { key: 'number', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'total', header: 'Total', align: 'right', render: (row) => formatCompactCurrency(row.total) },
]

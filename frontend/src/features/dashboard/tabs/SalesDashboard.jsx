import { useMemo } from 'react'
import BranchComparisonChart from '../charts/BranchComparisonChart'
import CategoryPieChart from '../charts/CategoryPieChart'
import RevenueProfitChart from '../charts/RevenueProfitChart'
import SalesTrendChart from '../charts/SalesTrendChart'
import ChartCard from '../components/ChartCard'
import CompactCurrency from '../components/CompactCurrency'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatCurrency, formatNumber, formatPercent } from '../utils/formatCurrency'
import { formatQtyNumber } from '@/utils/decimalPrecision'

const spark = (rows = [], key) => rows.map((row) => ({ value: row[key] || 0 }))

export default function SalesDashboard({ filters, autoRefresh, refreshToken, onUpdatedAt }) {
  const query = useDashboardQuery('sales', filters, { autoRefresh, refreshToken, onUpdatedAt })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const deltaValues = data.delta_values || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}
  const categoryFiltered = Boolean(filters.category_id)
  const recentSalesColumnsForView = categoryFiltered
    ? recentCategorySalesColumns
    : recentSalesColumns

  const salesSpark = useMemo(() => spark(charts.sales_trend, 'sales'), [charts.sales_trend])
  const revenueSpark = useMemo(() => spark(charts.revenue_vs_profit, 'revenue'), [charts.revenue_vs_profit])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {kpis.cost_coverage_pct != null && kpis.cost_coverage_pct < 95 ? (
        <div
          role="status"
          title="Coverage is based on current Item.cost_price; items without a positive cost are excluded."
          className="card"
          style={{ padding: '12px 16px', color: 'var(--amber)' }}
        >
          Cost coverage is {formatPercent(kpis.cost_coverage_pct)}. Profit margin may be incomplete because fewer than 95% of net taxable sales have a positive item cost.
        </div>
      ) : null}
      <div className="grid-kpi">
        <KpiCard
          title="Today's Sales (MVR, excl. GST)"
          tooltip="Net sales excluding GST for business-local today vs yesterday. Ignores the date range; Branch, Staff, and Category filters apply."
          value={<CompactCurrency value={kpis.daily_sales} />}
          delta={deltas.daily_sales}
          deltaTooltip={formatDeltaValues(deltaValues.daily_sales)}
          tone="success"
          loading={loading}
        />
        <KpiCard
          title="Last 7 Days (MVR, excl. GST)"
          tooltip="Net sales excluding GST for the rolling 7 days ending today vs the prior 7 days. Ignores the date range; Branch, Staff, and Category filters apply."
          value={<CompactCurrency value={kpis.weekly_sales} />}
          delta={deltas.weekly_sales}
          deltaTooltip={formatDeltaValues(deltaValues.weekly_sales)}
          tone="info"
          loading={loading}
        />
        <KpiCard
          title="Month to Date (MVR, excl. GST)"
          tooltip="Net sales excluding GST from the 1st of this month through today vs the same elapsed days of the previous month. Ignores the date range; Branch, Staff, and Category filters apply."
          value={<CompactCurrency value={kpis.monthly_sales} />}
          delta={deltas.monthly_sales}
          deltaTooltip={formatDeltaValues(deltaValues.monthly_sales)}
          tone="success"
          loading={loading}
        />
        <KpiCard
          title="Revenue (MVR, excl. GST)"
          tooltip="Selected-range finalized invoice sales excluding GST, less non-void returns excluding GST. Invoice date and return date determine the period."
          value={<CompactCurrency value={kpis.total_revenue} />}
          detail={`Gross incl. GST, before returns: MVR ${formatCurrency(kpis.gross_revenue)}`}
          delta={deltas.total_revenue}
          deltaTooltip={formatDeltaValues(deltaValues.total_revenue)}
          tone="neutral"
          sparkline={revenueSpark}
          loading={loading}
        />
        <KpiCard
          title="Profit Margin"
          tooltip="Net profit divided by net taxable revenue. Cost uses current Item.cost_price because sale-time cost is not stored; returns reverse revenue and cost."
          value={formatPercent(kpis.profit_margin)}
          delta={deltas.profit_margin}
          deltaTooltip={formatPercentDeltaValues(deltaValues.profit_margin)}
          deltaUnit=" pp"
          tone="success"
          sparkline={spark(charts.revenue_vs_profit, 'profit')}
          loading={loading}
          permission="dashboard.profit.view"
        />
        <KpiCard
          title="Average Bill Value (MVR, excl. GST)"
          tooltip={`Selected-range net sales excluding GST divided by finalized invoice count. Median finalized invoice value excluding GST: ${kpis.median_bill_value == null ? 'N/A' : formatCurrency(kpis.median_bill_value)}.`}
          value={formatCurrency(kpis.average_bill_value)}
          delta={deltas.average_bill_value}
          deltaTooltip={formatDeltaValues(deltaValues.average_bill_value)}
          tone="info"
          sparkline={salesSpark}
          loading={loading}
        />
      </div>

      <div className="grid-2">
        <ChartCard title="Sales Trend (MVR, excl. GST)" loading={loading}>
          <SalesTrendChart data={charts.sales_trend || []} label="Sales excl. GST (MVR)" />
        </ChartCard>
        <ChartCard title="Revenue vs Profit (MVR, excl. GST)" loading={loading}>
          <RevenueProfitChart data={charts.revenue_vs_profit || []} />
        </ChartCard>
      </div>

      <div className="grid-2">
        <ChartCard title="Category Mix (MVR, excl. GST)" loading={loading}>
          <CategoryPieChart data={charts.category_pie || []} nameKey="category" valueKey="revenue" />
        </ChartCard>
        <ChartCard title="Brand Mix (MVR, excl. GST)" loading={loading}>
          <CategoryPieChart data={charts.brand_donut || []} nameKey="brand" valueKey="revenue" donut />
        </ChartCard>
      </div>

      <div className="grid-2">
        <TargetAchievementPanel data={analytics.target_vs_achievement} />
        <ChartCard title="Branch-wise Sales (MVR, excl. GST)" loading={loading}>
          <BranchComparisonChart data={analytics.branch_wise_sales || []} />
        </ChartCard>
      </div>

      <div className="grid-3">
        <DataTable title="Top Products" loading={loading} rows={tables.top_products?.items || []} columns={topProductColumns} />
        <DataTable title="Top Customers" loading={loading} rows={tables.top_customers?.items || []} columns={categoryFiltered ? topCustomerCategoryColumns : topCustomerColumns} />
        <DataTable title={categoryFiltered ? 'Recent Category Sales (excl. GST)' : 'Recent Sales'} loading={loading} rows={tables.recent_sales?.items || []} columns={recentSalesColumnsForView} />
      </div>
    </div>
  )
}

function formatDeltaValues(values) {
  if (!values) return undefined
  const previous = Number(values.previous || 0).toFixed(2)
  const current = Number(values.current || 0).toFixed(2)
  return `Previous: MVR ${previous}; Current: MVR ${current}`
}

function formatPercentDeltaValues(values) {
  if (!values) return undefined
  return `Previous: ${Number(values.previous || 0).toFixed(1)}%; Current: ${Number(values.current || 0).toFixed(1)}%`
}

function TargetAchievementPanel({ data = {} }) {
  const target = Number(data?.target || 0)
  const achieved = Number(data?.achieved || 0)
  const pct = Number(data?.achievement_pct || 0)
  const hasTarget = target > 0
  const cappedPct = Math.min(100, Math.max(0, pct))
  const remaining = Math.max(0, target - achieved)
  const overTarget = Math.max(0, achieved - target)
  const tone = !hasTarget ? 'var(--text-muted)' : pct >= 100 ? 'var(--green)' : pct >= 80 ? 'var(--blue)' : 'var(--amber)'
  const toneBg = !hasTarget ? 'var(--bg-raised)' : pct >= 100 ? 'var(--green-bg)' : pct >= 80 ? 'var(--blue-bg)' : 'var(--amber-bg)'
  const status = !hasTarget ? 'No target set' : pct >= 100 ? 'Target met' : pct >= 80 ? 'On track' : 'Needs focus'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <div style={{ flex: 1 }}>
          <h4 style={{ margin: 0 }}>Target vs Achievement (MVR, achievement excl. GST)</h4>
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
            {data.target_period || 'Full-month target; not prorated to the selected date range.'}
          </div>
        </div>
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
              <TargetMetric label="Target (MVR)" value={<CompactCurrency value={target} />} />
              <TargetMetric label="Achieved excl. GST (MVR)" value={<CompactCurrency value={achieved} />} emphasis />
              <TargetMetric
                label={overTarget > 0 ? 'Above target (MVR)' : 'Remaining (MVR)'}
                value={<CompactCurrency value={overTarget > 0 ? overTarget : remaining} />}
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
                <span>0</span>
                <CompactCurrency value={target} />
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
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatQtyNumber(row.qty) },
  { key: 'revenue', header: 'Revenue excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.revenue} /> },
]

const topCustomerColumns = [
  { key: 'name', header: 'Customer' },
  { key: 'bill_count', header: 'Bills', align: 'right', width: 70, render: (row) => formatNumber(row.bill_count) },
  { key: 'revenue', header: 'Revenue excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.revenue} /> },
]

const topCustomerCategoryColumns = [
  { key: 'name', header: 'Customer' },
  { key: 'bill_count', header: 'Invoices containing this category', align: 'right', width: 170, render: (row) => formatNumber(row.bill_count) },
  { key: 'revenue', header: 'Revenue excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.revenue} /> },
]

const recentSalesColumns = [
  { key: 'number', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'total', header: 'Invoice total incl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.total} /> },
]

const recentCategorySalesColumns = [
  { key: 'number', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'total', header: 'Category sales excl. GST (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.total} /> },
]

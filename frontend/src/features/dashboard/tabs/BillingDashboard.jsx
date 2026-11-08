import PaymentMethodChart from '../charts/PaymentMethodChart'
import SalesTrendChart from '../charts/SalesTrendChart'
import ChartCard from '../components/ChartCard'
import CompactCurrency from '../components/CompactCurrency'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatNumber, formatPercent } from '../utils/formatCurrency'

const spark = (rows = [], key) => (Array.isArray(rows) ? rows : []).map((row) => ({ value: row[key] || 0 }))

export default function BillingDashboard({ filters, autoRefresh, refreshToken, onUpdatedAt }) {
  const query = useDashboardQuery('billing', filters, { autoRefresh, refreshToken, onUpdatedAt })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const deltaValues = data.delta_values || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}
  const categoryFiltered = Boolean(filters.category_id)

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {categoryFiltered ? (
        <div role="status" className="card" style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>
          Payment and balance figures aren&apos;t available per category. Clear the category filter to see them.
        </div>
      ) : null}
      <div className="billing-kpi-grid">
        <KpiCard title="Cash (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.cash} />} delta={deltas.cash} deltaTooltip={formatDeltaValues(deltaValues.cash)} tone="success" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Card (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.card} />} delta={deltas.card} deltaTooltip={formatDeltaValues(deltaValues.card)} tone="info" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Legacy UPI (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.upi} />} delta={deltas.upi} deltaTooltip={formatDeltaValues(deltaValues.upi)} tone="neutral" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Cheque (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.cheque} />} delta={deltas.cheque} deltaTooltip={formatDeltaValues(deltaValues.cheque)} tone="neutral" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Bank Transfer (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.transfer} />} delta={deltas.transfer} deltaTooltip={formatDeltaValues(deltaValues.transfer)} tone="info" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Credit (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.credit} />} delta={deltas.credit} deltaTooltip={formatDeltaValues(deltaValues.credit)} tone="warning" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        {/* <KpiCard title="Other Payments (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.other} />} delta={deltas.other} deltaTooltip={formatDeltaValues(deltaValues.other)} tone="neutral" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} /> */}
        <KpiCard title="Pending Payments (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.pending_payments} />} delta={deltas.pending_payments} deltaTooltip={formatDeltaValues(deltaValues.pending_payments)} tone="warning" sparkline={spark(charts.daily_billing_count, 'count')} loading={loading} />
        <KpiCard title="Returned Value (MVR)" value={<CompactCurrency value={kpis.refunds} />} delta={deltas.refunds} deltaTooltip={formatDeltaValues(deltaValues.refunds)} tone="danger" sparkline={spark(charts.refund_trends, 'refunds')} loading={loading} />
        <KpiCard title="Tax Collected (MVR)" tooltip="GST on finalized invoices by invoice date minus tax on non-void returns by return date. Uses the Tax Summary report's tax-inclusive line calculation." value={<CompactCurrency value={kpis.tax_collected} />} tone="info" loading={loading} />
        <KpiCard
          title="Actually Refunded / Credited (MVR)"
          value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.credited_refunds} />}
          detail={categoryFiltered ? 'Not attributable by category' : undefined}
          delta={deltas.credited_refunds}
          deltaTooltip={formatDeltaValues(deltaValues.credited_refunds)}
          tone="danger"
          sparkline={categoryFiltered ? [] : spark(charts.refund_trends, 'credited_refunds')}
          loading={loading}
        />
        <KpiCard title="Discounts (MVR)" value={categoryFiltered ? 'N/A' : <CompactCurrency value={kpis.discounts} />} delta={deltas.discounts} deltaTooltip={formatDeltaValues(deltaValues.discounts)} tone="warning" sparkline={spark(charts.daily_billing_count, 'count')} loading={loading} />
        <KpiCard
          title={categoryFiltered ? 'Category Invoices Due' : 'Invoices Due'}
          tooltip="Count of finalized invoices with an outstanding balance in the selected date range. Respects Branch, KAM, and Category filters."
          value={formatNumber(analytics.pending_invoice_count)}
          tone="warning"
          loading={loading}
        />
      </div>

      <div className="grid-3">
        <ChartCard title="Payment Distribution (MVR)" loading={loading}>
          {categoryFiltered ? <UnavailableByCategory /> : <PaymentMethodChart data={charts.payment_distribution || []} />}
        </ChartCard>
        <ChartCard title="Returned Value Trends (MVR)" loading={loading}>
          <SalesTrendChart data={charts.refund_trends || []} valueKey="refunds" label="Returned value (MVR)" />
        </ChartCard>
        <ChartCard title={categoryFiltered ? 'Daily Invoices Containing This Category' : 'Daily Billing Count'} loading={loading}>
          <SalesTrendChart data={charts.daily_billing_count || []} valueKey="count" label="Bills" />
        </ChartCard>
      </div>

      <div className="grid-2">
        <CollectionEfficiencyPanel analytics={analytics} kpis={kpis} categoryFiltered={categoryFiltered} />
        <DataTable title={categoryFiltered ? 'Pending Invoices Containing This Category' : 'Pending Payments'} loading={loading} rows={tables.pending_payments?.items || []} columns={pendingColumns} />
      </div>

      <div className="grid-2">
        <DataTable title={categoryFiltered ? 'Recent Returns Containing This Category' : 'Recent Refunds'} loading={loading} rows={tables.recent_refunds?.items || []} columns={refundColumns} />
        <DataTable title={categoryFiltered ? 'Invoices Containing This Category With Discounts' : 'Discounted Bills'} loading={loading} rows={tables.discounted_bills?.items || []} columns={discountColumns} />
      </div>
    </div>
  )
}

function CollectionEfficiencyPanel({ analytics = {}, kpis = {}, categoryFiltered = false }) {
  const efficiency = analytics.collection_efficiency == null ? null : Number(analytics.collection_efficiency)
  const refundPct = Number(analytics.refund_percentage || 0)
  const pendingCount = Number(analytics.pending_invoice_count || 0)
  const pendingAmount = kpis.pending_payments == null ? null : Number(kpis.pending_payments)
  const collected = kpis.collected == null ? null : Number(kpis.collected)
  const cappedEfficiency = efficiency == null ? 0 : Math.min(100, Math.max(0, efficiency))
  const tone = efficiency == null ? 'var(--text-muted)' : efficiency >= 92 ? 'var(--green)' : efficiency >= 80 ? 'var(--blue)' : 'var(--amber)'
  const toneBg = efficiency == null ? 'var(--bg-raised)' : efficiency >= 92 ? 'var(--green-bg)' : efficiency >= 80 ? 'var(--blue-bg)' : 'var(--amber-bg)'
  const status = efficiency == null ? 'Unavailable' : efficiency >= 92 ? 'Strong' : efficiency >= 80 ? 'Healthy' : 'Follow up'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4
          title="(Invoice paid_amount - refunds actually credited) / net revenue. This equals 1 - outstanding / net revenue when invoice, return, and balance amounts reconcile."
          style={{ margin: 0, flex: 1 }}
        >
          Collection Efficiency
        </h4>
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
        <div style={{ display: 'grid', gridTemplateColumns: '136px minmax(0, 1fr)', gap: 20, alignItems: 'center' }}>
          <div
            style={{
              width: 124,
              height: 124,
              borderRadius: '50%',
              background: `conic-gradient(${tone} ${cappedEfficiency * 3.6}deg, var(--bg-raised) 0deg)`,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div
              style={{
                width: 94,
                height: 94,
                borderRadius: '50%',
                background: 'var(--bg-surface)',
                display: 'grid',
                placeItems: 'center',
                textAlign: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 25, lineHeight: 1, fontWeight: 800 }}>{efficiency == null ? 'N/A' : formatPercent(efficiency)}</div>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>
                  Collected
                </div>
              </div>
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              <CollectionMetric label="Collected (MVR)" value={collected == null ? 'N/A' : <CompactCurrency value={collected} />} emphasis />
              <CollectionMetric label="Pending (MVR)" value={pendingAmount == null ? 'N/A' : <CompactCurrency value={pendingAmount} />} />
              <CollectionMetric label={categoryFiltered ? 'Pending invoices containing this category' : 'Invoices due'} value={formatNumber(pendingCount)} />
            </div>

            <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
              {efficiency == null ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Collection rate: N/A</div>
              ) : <ProgressMetric label="Collection rate" value={efficiency} tone={tone} />}
              <ProgressMetric label="Refund rate" value={refundPct} tone="var(--red)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function UnavailableByCategory() {
  return (
    <div style={{ height: 240, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      Not attributable by category
    </div>
  )
}

function formatDeltaValues(values) {
  if (!values) return undefined
  return `Previous: MVR ${Number(values.previous || 0).toFixed(2)}; Current: MVR ${Number(values.current || 0).toFixed(2)}`
}

function CollectionMetric({ label, value, emphasis = false }) {
  return (
    <div style={{ minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5 }}>{label}</div>
      <div
        style={{
          fontSize: emphasis ? 20 : 17,
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

function ProgressMetric({ label, value, tone }) {
  const width = Math.min(100, Math.max(0, value))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 7, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>{label}</span>
        <span style={{ color: tone, fontWeight: 800 }}>{formatPercent(value)}</span>
      </div>
      <div className="progress-bar" style={{ height: 8, borderRadius: 999 }}>
        <div
          className="progress-fill"
          style={{
            width: `${width}%`,
            background: tone,
            borderRadius: 999,
          }}
        />
      </div>
    </div>
  )
}

const pendingColumns = [
  { key: 'number', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'balance', header: 'Balance (MVR)', align: 'right', render: (row) => row.balance == null ? 'N/A' : <CompactCurrency value={row.balance} /> },
  { key: 'due_date', header: 'Due date' },
  { key: 'overdue', header: 'Overdue', render: (row) => row.overdue ? 'Yes' : 'No' },
]

const refundColumns = [
  { key: 'number', header: 'Credit Note' },
  { key: 'customer', header: 'Customer' },
  { key: 'amount', header: 'Returned (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.amount} /> },
  { key: 'credited_amount', header: 'Refunded / Credited (MVR)', align: 'right', render: (row) => row.credited_amount == null ? 'N/A' : <CompactCurrency value={row.credited_amount} /> },
]

const discountColumns = [
  { key: 'number', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'discount', header: 'Discount (MVR)', align: 'right', render: (row) => row.discount == null ? 'N/A' : <CompactCurrency value={row.discount} /> },
]

import PaymentMethodChart from '../charts/PaymentMethodChart'
import SalesTrendChart from '../charts/SalesTrendChart'
import ChartCard from '../components/ChartCard'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatCompactCurrency, formatNumber, formatPercent } from '../utils/formatCurrency'

const spark = (rows = [], key) => rows.map((row) => ({ value: row[key] || 0 }))

export default function BillingDashboard({ filters, autoRefresh }) {
  const query = useDashboardQuery('billing', filters, { autoRefresh })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="grid-kpi">
        <KpiCard title="Cash" value={formatCompactCurrency(kpis.cash)} delta={deltas.cash} tone="success" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Card" value={formatCompactCurrency(kpis.card)} delta={deltas.card} tone="info" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="UPI" value={formatCompactCurrency(kpis.upi)} delta={deltas.upi} tone="neutral" sparkline={spark(charts.payment_distribution, 'amount')} loading={loading} />
        <KpiCard title="Pending Payments" value={formatCompactCurrency(kpis.pending_payments)} delta={deltas.pending_payments} tone="warning" sparkline={spark(charts.daily_billing_count, 'count')} loading={loading} />
        <KpiCard title="Refunds" value={formatCompactCurrency(kpis.refunds)} delta={deltas.refunds} tone="danger" sparkline={spark(charts.refund_trends, 'refunds')} loading={loading} />
        <KpiCard title="Discounts" value={formatCompactCurrency(kpis.discounts)} delta={deltas.discounts} tone="warning" sparkline={spark(charts.daily_billing_count, 'count')} loading={loading} />
      </div>

      <div className="grid-3">
        <ChartCard title="Payment Distribution" loading={loading}>
          <PaymentMethodChart data={charts.payment_distribution || []} />
        </ChartCard>
        <ChartCard title="Refund Trends" loading={loading}>
          <SalesTrendChart data={charts.refund_trends || []} valueKey="refunds" label="Refunds" />
        </ChartCard>
        <ChartCard title="Daily Billing Count" loading={loading}>
          <SalesTrendChart data={charts.daily_billing_count || []} valueKey="count" label="Bills" />
        </ChartCard>
      </div>

      <div className="grid-2">
        <CollectionEfficiencyPanel analytics={analytics} kpis={kpis} />
        <DataTable title="Pending Payments" loading={loading} rows={tables.pending_payments?.items || []} columns={pendingColumns} />
      </div>

      <div className="grid-2">
        <DataTable title="Recent Refunds" loading={loading} rows={tables.recent_refunds?.items || []} columns={refundColumns} />
        <DataTable title="Discounted Bills" loading={loading} rows={tables.discounted_bills?.items || []} columns={discountColumns} />
      </div>
    </div>
  )
}

function CollectionEfficiencyPanel({ analytics = {}, kpis = {} }) {
  const efficiency = Number(analytics.collection_efficiency || 0)
  const refundPct = Number(analytics.refund_percentage || 0)
  const pendingCount = Number(analytics.pending_invoice_count || 0)
  const pendingAmount = Number(kpis.pending_payments || 0)
  const collected = Number(kpis.cash || 0) + Number(kpis.card || 0) + Number(kpis.upi || 0)
  const cappedEfficiency = Math.min(100, Math.max(0, efficiency))
  const tone = efficiency >= 92 ? 'var(--green)' : efficiency >= 80 ? 'var(--blue)' : 'var(--amber)'
  const toneBg = efficiency >= 92 ? 'var(--green-bg)' : efficiency >= 80 ? 'var(--blue-bg)' : 'var(--amber-bg)'
  const status = efficiency >= 92 ? 'Strong' : efficiency >= 80 ? 'Healthy' : 'Follow up'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>Collection Efficiency</h4>
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
                <div style={{ fontSize: 25, lineHeight: 1, fontWeight: 800 }}>{formatPercent(efficiency)}</div>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>
                  Collected
                </div>
              </div>
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              <CollectionMetric label="Collected" value={formatCompactCurrency(collected)} emphasis />
              <CollectionMetric label="Pending" value={formatCompactCurrency(pendingAmount)} />
              <CollectionMetric label="Invoices due" value={formatNumber(pendingCount)} />
            </div>

            <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
              <ProgressMetric label="Collection rate" value={efficiency} tone={tone} />
              <ProgressMetric label="Refund rate" value={refundPct} tone="var(--red)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
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
  { key: 'balance', header: 'Balance', align: 'right', render: (row) => formatCompactCurrency(row.balance) },
]

const refundColumns = [
  { key: 'number', header: 'Credit Note' },
  { key: 'customer', header: 'Customer' },
  { key: 'amount', header: 'Amount', align: 'right', render: (row) => formatCompactCurrency(row.amount) },
]

const discountColumns = [
  { key: 'number', header: 'Invoice' },
  { key: 'customer', header: 'Customer' },
  { key: 'discount', header: 'Discount', align: 'right', render: (row) => formatCompactCurrency(row.discount) },
]

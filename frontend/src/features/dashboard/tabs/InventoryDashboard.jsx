import { useMemo } from 'react'
import CategoryPieChart from '../charts/CategoryPieChart'
import SalesTrendChart from '../charts/SalesTrendChart'
import ChartCard from '../components/ChartCard'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatCompactCurrency, formatNumber, formatPercent } from '../utils/formatCurrency'

const spark = (rows = [], key) => rows.map((row) => ({ value: row[key] || 0 }))

export default function InventoryDashboard({ filters, autoRefresh }) {
  const query = useDashboardQuery('inventory', filters, { autoRefresh })
  const data = query.data || {}
  const loading = query.isLoading && !query.data
  const kpis = data.kpis || {}
  const deltas = data.deltas || {}
  const charts = data.charts || {}
  const tables = data.tables || {}
  const analytics = data.analytics || {}
  const valueSpark = useMemo(() => spark(charts.inventory_value_trend, 'value'), [charts.inventory_value_trend])

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="grid-kpi">
        <KpiCard title="Inventory Value" value={formatCompactCurrency(kpis.inventory_value)} delta={deltas.inventory_value} tone="neutral" sparkline={valueSpark} loading={loading} />
        <KpiCard title="Products" value={formatNumber(kpis.products)} delta={deltas.products} tone="info" sparkline={valueSpark} loading={loading} />
        <KpiCard title="Out of Stock" value={formatNumber(kpis.out_of_stock)} delta={deltas.out_of_stock} tone="danger" sparkline={valueSpark} loading={loading} />
        <KpiCard title="Low Stock" value={formatNumber(kpis.low_stock)} delta={deltas.low_stock} tone="warning" sparkline={valueSpark} loading={loading} />
      </div>

      <div className="grid-3">
        <ChartCard title="Inventory Value Trend" loading={loading}>
          <SalesTrendChart data={charts.inventory_value_trend || []} valueKey="value" label="Inventory Value" />
        </ChartCard>
        <ChartCard title="Fast vs Slow Moving" loading={loading}>
          <CategoryPieChart
            data={charts.fast_vs_slow_moving || []}
            nameKey="segment"
            valueKey="count"
            valueFormatter={formatSkuCount}
            donut
          />
        </ChartCard>
        <ChartCard title="Stock by Category" loading={loading}>
          <CategoryPieChart data={charts.stock_by_category || []} nameKey="category" valueKey="value" />
        </ChartCard>
      </div>

      <div className="grid-2">
        <FifoFefoPanel data={analytics.fifo_fefo} />
        <BatchMovementPanel data={analytics.batch_movement} />
      </div>

      <div className="grid-2">
        <DataTable title="Current Stock" loading={loading} rows={tables.current_stock?.items || []} columns={stockColumns} />
        <DataTable title="Low Stock" loading={loading} rows={tables.low_stock?.items || []} columns={lowStockColumns} />
      </div>
      <div className="grid-2">
        <DataTable title="Dead Stock" loading={loading} rows={tables.dead_stock?.items || []} columns={deadStockColumns} />
        <DataTable title="Expiry Near" loading={loading} rows={tables.expiry_near?.items || []} columns={expiryColumns} />
      </div>
    </div>
  )
}

const formatSkuCount = (value) => {
  const count = Number(value || 0)
  return `${formatNumber(count)} ${count === 1 ? 'SKU' : 'SKUs'}`
}

function FifoFefoPanel({ data = {} }) {
  const tracked = Number(data?.tracked_products || 0)
  const active = Number(data?.active_batches || 0)
  const nearExpiry = Number(data?.near_expiry_batches || 0)
  const coverage = Number(data?.fefo_coverage || 0)
  const cappedCoverage = Math.min(100, Math.max(0, coverage))
  const riskPct = active ? Math.min(100, (nearExpiry / active) * 100) : 0
  const tone = coverage >= 75 ? 'var(--green)' : coverage >= 45 ? 'var(--amber)' : 'var(--red)'
  const toneBg = coverage >= 75 ? 'var(--green-bg)' : coverage >= 45 ? 'var(--amber-bg)' : 'var(--red-bg)'
  const status = coverage >= 75 ? 'Covered' : coverage >= 45 ? 'Partial' : 'Review'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>FIFO / FEFO Insights</h4>
        <StatusPill tone={tone} background={toneBg}>{status}</StatusPill>
      </div>
      <div className="card-body" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '126px minmax(0, 1fr)', gap: 20, alignItems: 'center' }}>
          <RingGauge value={coverage} cappedValue={cappedCoverage} tone={tone} label="FEFO" />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              <MiniMetric label="Tracked SKUs" value={formatNumber(tracked)} emphasis />
              <MiniMetric label="Active batches" value={formatNumber(active)} />
              <MiniMetric label="Near expiry" value={formatNumber(nearExpiry)} tone="var(--amber)" />
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
              <ProgressLine label="FEFO coverage" value={coverage} tone={tone} />
              <ProgressLine label="Near-expiry exposure" value={riskPct} tone="var(--amber)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function BatchMovementPanel({ data = {} }) {
  const received = Number(data?.received_batches || 0)
  const consumed = Number(data?.consumed_batches || 0)
  const deadStock = Number(data?.dead_stock_skus || 0)
  const totalMovement = received + consumed
  const consumedPct = totalMovement ? (consumed / totalMovement) * 100 : 0
  const receivedPct = totalMovement ? (received / totalMovement) * 100 : 0
  const deadTone = deadStock > 0 ? 'var(--amber)' : 'var(--green)'
  const deadBg = deadStock > 0 ? 'var(--amber-bg)' : 'var(--green-bg)'

  return (
    <div className="card">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>Batch Movement</h4>
        <StatusPill tone={deadTone} background={deadBg}>{deadStock > 0 ? 'Watch list' : 'Clear'}</StatusPill>
      </div>
      <div className="card-body" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 18 }}>
          <MiniMetric label="Received" value={formatNumber(received)} emphasis />
          <MiniMetric label="Consumed" value={formatNumber(consumed)} />
          <MiniMetric label="Dead stock" value={formatNumber(deadStock)} tone={deadTone} />
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <ProgressLine label="Receiving share" value={receivedPct} tone="var(--blue)" />
          <ProgressLine label="Consumption share" value={consumedPct} tone="var(--green)" />
        </div>

        <div
          style={{
            marginTop: 18,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--bg-raised)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 12,
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Movement volume</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 800 }}>{formatNumber(totalMovement)} batches</span>
        </div>
      </div>
    </div>
  )
}

function RingGauge({ value, cappedValue, tone, label }) {
  return (
    <div
      style={{
        width: 118,
        height: 118,
        borderRadius: '50%',
        background: `conic-gradient(${tone} ${cappedValue * 3.6}deg, var(--bg-raised) 0deg)`,
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
          <div style={{ fontSize: 23, lineHeight: 1, fontWeight: 800 }}>{formatPercent(value)}</div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>{label}</div>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ tone, background, children }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '3px 8px',
        borderRadius: 999,
        color: tone,
        background,
      }}
    >
      {children}
    </span>
  )
}

function MiniMetric({ label, value, emphasis = false, tone }) {
  return (
    <div style={{ minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5 }}>{label}</div>
      <div
        style={{
          fontSize: emphasis ? 20 : 17,
          lineHeight: 1.15,
          fontWeight: 800,
          color: tone || (emphasis ? 'var(--text-primary)' : 'var(--text-secondary)'),
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

function ProgressLine({ label, value, tone }) {
  const width = Math.min(100, Math.max(0, value))
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 7, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>{label}</span>
        <span style={{ color: tone, fontWeight: 800 }}>{formatPercent(value)}</span>
      </div>
      <div className="progress-bar" style={{ height: 8, borderRadius: 999 }}>
        <div className="progress-fill" style={{ width: `${width}%`, background: tone, borderRadius: 999 }} />
      </div>
    </div>
  )
}

const stockColumns = [
  { key: 'name', header: 'Product' },
  { key: 'branch', header: 'Branch' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'value', header: 'Value', align: 'right', render: (row) => formatCompactCurrency(row.value) },
]

const lowStockColumns = [
  { key: 'name', header: 'Product' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'reorder_level', header: 'Reorder', align: 'right', width: 82, render: (row) => formatNumber(row.reorder_level) },
]

const deadStockColumns = [
  { key: 'name', header: 'Product' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'value', header: 'Value', align: 'right', render: (row) => formatCompactCurrency(row.value) },
]

const expiryColumns = [
  { key: 'name', header: 'Product' },
  { key: 'batch_number', header: 'Batch' },
  { key: 'expiry_date', header: 'Expiry' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
]

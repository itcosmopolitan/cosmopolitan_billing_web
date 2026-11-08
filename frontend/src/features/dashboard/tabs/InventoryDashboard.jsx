import CategoryPieChart from '../charts/CategoryPieChart'
import ChartCard from '../components/ChartCard'
import CompactCurrency from '../components/CompactCurrency'
import DataTable from '../components/DataTable'
import KpiCard from '../components/KpiCard'
import { useDashboardQuery } from '../hooks/useDashboardQuery'
import { formatNumber, formatPercent } from '../utils/formatCurrency'

export default function InventoryDashboard({ filters, autoRefresh, refreshToken, onUpdatedAt }) {
  const query = useDashboardQuery('inventory', filters, { autoRefresh, refreshToken, onUpdatedAt })
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
        <KpiCard title="Inventory Value (MVR)" tooltip="Current quantity × current Item.cost_price. Ignores date range and KAM; Branch and Category apply." value={<CompactCurrency value={kpis.inventory_value} />} delta={deltas.inventory_value} tone="neutral" loading={loading} />
        <KpiCard title="Products" tooltip="Current active stock rows. Ignores date range and KAM; Branch and Category apply." value={formatNumber(kpis.products)} delta={deltas.products} tone="info" loading={loading} />
        <KpiCard title="Out of Stock" tooltip="Current active stock rows with quantity <= 0. Ignores date range and KAM; Branch and Category apply." value={formatNumber(kpis.out_of_stock)} delta={deltas.out_of_stock} tone="danger" loading={loading} />
        <KpiCard title="Low Stock" tooltip="Current active stock rows with 0 < quantity <= reorder level. Ignores date range and KAM; Branch and Category apply." value={formatNumber(kpis.low_stock)} delta={deltas.low_stock} tone="warning" loading={loading} />
      </div>

      <div className="grid-2">
        <ChartCard title="Fast vs Slow Moving" loading={loading}>
          <div
            title="Fast = active SKUs with positive stock and at least one finalized sale in the selected range. Slow = active SKUs with positive stock and no finalized sale. Both counts use only active SKUs with stock rows; Branch, KAM, Category, and date range apply. Out-of-stock SKUs are excluded."
            style={{ marginBottom: 8, fontSize: 11, color: 'var(--text-muted)' }}
          >
            Counts cover active SKUs with positive stock only; hover for the rule.
          </div>
          <CategoryPieChart
            data={charts.fast_vs_slow_moving || []}
            nameKey="segment"
            valueKey="count"
            valueFormatter={formatSkuCount}
            donut
          />
        </ChartCard>
        <ChartCard title="Stock by Category (MVR)" loading={loading}>
          <div title="Current stock value is quantity × current Item.cost_price. Ignores date range and KAM; Branch and Category apply. Others reconciles the remaining value.">
            <CategoryPieChart data={charts.stock_by_category || []} nameKey="category" valueKey="value" />
          </div>
        </ChartCard>
      </div>

      <div className="grid-2">
        <FifoFefoPanel data={analytics.fifo_fefo} />
        <BatchMovementPanel data={analytics.batch_movement} />
      </div>

      <div className="grid-2">
        <div title="Current stock ignores date range and KAM; Branch and Category apply."><DataTable title="Current Stock" loading={loading} rows={tables.current_stock?.items || []} columns={stockColumns} /></div>
        <div title="Current stock ignores date range and KAM; Branch and Category apply."><DataTable title="Low Stock (0 < qty <= reorder level)" loading={loading} rows={tables.low_stock?.items || []} columns={lowStockColumns} /></div>
      </div>
      <div className="grid-2">
        <div title="Current stock ignores date range and KAM; Branch and Category apply."><DataTable title="Out of Stock (qty <= 0)" loading={loading} rows={tables.out_of_stock?.items || []} columns={outOfStockColumns} /></div>
        <div title="Stock quantity is current; the selected date range and KAM define whether an item had finalized sales. Branch and Category apply."><DataTable title="Dead Stock" loading={loading} rows={tables.dead_stock?.items || []} columns={deadStockColumns} /></div>
      </div>
      <div className="grid-2">
        <div title="Expiry status uses business-local today and ignores date range and KAM; Branch and Category apply."><DataTable title="Expired (expiry before business-local today)" loading={loading} rows={tables.expired?.items || []} columns={expiryColumns} /></div>
        <div title="Expiry status uses business-local today and ignores date range and KAM; Branch and Category apply."><DataTable title="Expiring in 30 Days (including today)" loading={loading} rows={tables.expiring_30_days?.items || []} columns={expiryColumns} /></div>
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
    <div className="card" title="Current active batches and expiry coverage. Ignores date range and KAM; Branch and Category apply.">
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
  const consumed = Number(data?.stock_out_movements || 0)
  const deadStock = Number(data?.dead_stock_skus || 0)
  const totalMovement = Number(data?.movement_records || 0)
  const deadTone = deadStock > 0 ? 'var(--amber)' : 'var(--green)'
  const deadBg = deadStock > 0 ? 'var(--amber-bg)' : 'var(--green-bg)'

  return (
    <div className="card" title="Batch received dates and stock movement dates follow the selected range. Branch and Category apply; KAM does not apply to inventory movements.">
      <div className="card-header" style={{ padding: '12px 16px' }}>
        <h4 style={{ margin: 0, flex: 1 }}>Batch & Stock Movement</h4>
        <StatusPill tone={deadTone} background={deadBg}>{deadStock > 0 ? 'Watch list' : 'Clear'}</StatusPill>
      </div>
      <div className="card-body" style={{ padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 18 }}>
          <MiniMetric label={data?.received_label || 'Batches received'} value={formatNumber(received)} emphasis title={data?.received_tooltip} />
          <MiniMetric label={data?.consumed_label || 'Stock-out movement records'} value={formatNumber(consumed)} title={data?.consumed_tooltip} />
          <MiniMetric label="Dead stock" value={formatNumber(deadStock)} tone={deadTone} />
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
          <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>Stock movement records</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 800 }}>{formatNumber(totalMovement)}</span>
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

function MiniMetric({ label, value, emphasis = false, tone, title }) {
  return (
    <div style={{ minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div title={title} style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 5 }}>{label}</div>
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
  { key: 'value', header: 'Value (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.value} /> },
]

const lowStockColumns = [
  { key: 'name', header: 'Product' },
  { key: 'branch', header: 'Branch' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'reorder_level', header: 'Reorder', align: 'right', width: 82, render: (row) => formatNumber(row.reorder_level) },
]

const outOfStockColumns = [
  { key: 'name', header: 'Product' },
  { key: 'branch', header: 'Branch' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'reorder_level', header: 'Reorder', align: 'right', width: 82, render: (row) => formatNumber(row.reorder_level) },
]

const deadStockColumns = [
  { key: 'name', header: 'Product' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
  { key: 'value', header: 'Value (MVR)', align: 'right', render: (row) => <CompactCurrency value={row.value} /> },
]

const expiryColumns = [
  { key: 'name', header: 'Product' },
  { key: 'batch_number', header: 'Batch' },
  { key: 'expiry_date', header: 'Expiry' },
  { key: 'qty', header: 'Qty', align: 'right', width: 72, render: (row) => formatNumber(row.qty) },
]

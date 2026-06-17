import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { dashAPI } from '@/api'
import { useAppStore } from '@/store'
import { KPICard, Card, BarList } from '@/components/ui'
import { fmt } from '@/utils/helpers'

const QUICK_ACTIONS = [
  { icon: '🧾', label: 'New Sale', path: '/pos' },
  { icon: '📄', label: 'Quotation', path: '/sales' },
  { icon: '📥', label: 'Receive Stock', path: '/purchases' },
  { icon: '💸', label: 'Add Expense', path: '/cash' },
  { icon: '💳', label: 'Record Payment', path: '/sales' },
  { icon: '🔄', label: 'Transfer Stock', path: '/transfers' },
]

const BRANCH_COLORS = ['#6366f1', '#a78bfa', '#2dd4bf', '#f5a623', '#22c97a', '#f5485c']
const ALERT_BORDER = { red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--blue)' }
const ALERT_ICON = { danger: '🔴', warning: '🟡', info: '🔵' }
// API returns `{type: "danger"|"warning"|"info"}`; map to colour + icon.
const alertBorder = (t) => ALERT_BORDER[t === 'danger' ? 'red' : t === 'warning' ? 'amber' : 'blue']

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-default)', borderRadius: 8, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color, display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: 'DM Mono', fontWeight: 500 }}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const [trendPeriod, setTrendPeriod] = useState('14d')
  const [kpis, setKpis] = useState({})
  const [salesTrend, setSalesTrend] = useState([])
  const [topProducts, setTopProducts] = useState([])
  const [branchData, setBranchData] = useState([])
  const [alerts, setAlerts] = useState([])

  useEffect(() => {
    let cancelled = false
    const trendDays = trendPeriod === '7d' ? 7 : trendPeriod === '30d' ? 30 : 14
    const branchId = activeBranch?.id
    ;(async () => {
      try {
        const [k, t, p, b, a] = await Promise.all([
          dashAPI.kpis(branchId).catch(() => ({})),
          dashAPI.salesTrend(trendDays).catch(() => []),
          dashAPI.topProducts(branchId).catch(() => []),
          dashAPI.branchComparison().catch(() => []),
          dashAPI.alerts().catch(() => []),
        ])
        if (cancelled) return
        setKpis(k || {})
        setSalesTrend(Array.isArray(t) ? t : [])
        setTopProducts(Array.isArray(p) ? p : [])
        setBranchData(Array.isArray(b) ? b : [])
        setAlerts(Array.isArray(a) ? a : [])
      } catch (e) {
        // Toast already handled by global axios interceptor.
        console.error(e)
      }
    })()
    return () => { cancelled = true }
  }, [trendPeriod, activeBranch?.id])

  const trendTotal = salesTrend.reduce((s, d) => s + (d.sales || 0), 0)
  const trendAvg   = salesTrend.length ? trendTotal / salesTrend.length : 0
  const trendPeak  = salesTrend.reduce((m, d) => Math.max(m, d.sales || 0), 0)
  const fmtCompact = (n) => {
    const abs = Math.abs(Number(n) || 0)
    if (abs >= 1000000000) return `Rf ${(abs / 1000000000).toFixed(2)}B`
    if (abs >= 1000000) return `Rf ${(abs / 1000000).toFixed(2)}M`
    if (abs >= 1000) return `Rf ${(abs / 1000).toFixed(2)}K`
    return fmt(Math.round(abs))
  }

  return (
    <div className="page-container">

      {/* KPI Grid */}
      <div className="grid-kpi" style={{ marginBottom: 22 }}>
        <KPICard label="Today's Sales" value={fmt(kpis.today_sales || 0)} icon="💰" color="var(--accent)" onClick={() => navigate('/sales')} />
        <KPICard label="Today's Purchases" value={fmt(kpis.today_purchases || 0)} icon="📦" color="var(--purple)" onClick={() => navigate('/purchases')} />
        <KPICard label="Cash in Hand" value={fmt(kpis.cash_in_hand || 0)} sub={activeBranch?.name || 'All branches'} icon="🏦" color="var(--green)" onClick={() => navigate('/cash')} />
        <KPICard label="Outstanding Receivables" value={fmt(kpis.outstanding_receivables || 0)} delta={`${kpis.overdue_invoices ?? 0} invoices overdue`} deltaUp={false} icon="📋" color="var(--red)" onClick={() => navigate('/sales')} />
        <KPICard label="Outstanding Payables" value={fmt(kpis.outstanding_payables || 0)} icon="💳" color="var(--amber)" onClick={() => navigate('/purchases')} />
        <KPICard label="Low Stock Items" value={String(kpis.low_stock_count ?? 0)} delta="Across all branches" deltaUp={false} icon="⚠️" color="var(--red)" onClick={() => navigate('/items')} />
      </div>

      {/* Quick Actions */}
      <div style={{ marginBottom: 22 }}>
        <h4 style={{ marginBottom: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Quick Actions</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
          {QUICK_ACTIONS.map((qa) => (
            <button key={qa.label} onClick={() => navigate(qa.path)}
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 12, padding: '14px 10px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-bg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.background = 'var(--bg-surface)' }}>
              <div style={{ fontSize: 22, marginBottom: 7 }}>{qa.icon}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 500 }}>{qa.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Charts row */}
      <div className="grid-65" style={{ marginBottom: 18 }}>
        <Card
          title="Sales & Purchase Trend"
          titleRight={
            <div style={{ display: 'flex', gap: 4 }}>
              {['7d', '14d', '30d'].map((p) => (
                <button key={p} className={`btn btn-xs ${trendPeriod === p ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTrendPeriod(p)}>{p}</button>
              ))}
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={salesTrend} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gPurch" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} tickFormatter={(v) => `Rf ${(v/1000).toFixed(0)}K`} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
              <Area type="monotone" dataKey="sales" name="Sales" stroke="#6366f1" strokeWidth={2.5} fill="url(#gSales)" dot={false} />
              <Area type="monotone" dataKey="purchases" name="Purchases" stroke="#a78bfa" strokeWidth={2} fill="url(#gPurch)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 20, marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total ({trendPeriod})</div><div style={{ fontSize: 17, fontWeight: 600 }}>{fmtCompact(trendTotal)}</div></div>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Avg/Day</div><div style={{ fontSize: 17, fontWeight: 600 }}>{fmtCompact(trendAvg)}</div></div>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Peak</div><div style={{ fontSize: 17, fontWeight: 600, color: 'var(--green)' }}>{fmtCompact(trendPeak)}</div></div>
          </div>
        </Card>

        <Card title="Branch Comparison (Today)">
          <BarList
            items={branchData.map((b, i) => ({ label: b.branch, value: b.sales, color: BRANCH_COLORS[i % BRANCH_COLORS.length] }))}
            valueFormatter={(v) => fmt(v)}
          />
          <div style={{ marginTop: 16 }}>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={branchData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="branch" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
                <YAxis hide />
                <Bar dataKey="sales" radius={[4, 4, 0, 0]}>
                  {branchData.map((_, i) => <Cell key={i} fill={BRANCH_COLORS[i % BRANCH_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid-3" style={{ marginBottom: 18 }}>
        <Card title="Top Products (Today)" bodyPadding={false}>
          <BarList
            items={topProducts.map((p) => ({ label: p.name, value: p.revenue }))}
            valueFormatter={(v) => fmt(v)}
            style={{ padding: '16px 20px' }}
          />
        </Card>

        <Card title="Recent Alerts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {alerts.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No alerts.</div>
            ) : alerts.map((a, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 12px',
                background: 'var(--bg-raised)', borderRadius: 8,
                borderLeft: `3px solid ${alertBorder(a.type)}`,
                cursor: 'pointer', fontSize: 12.5, color: 'var(--text-secondary)',
              }}>
                <span>{ALERT_ICON[a.type] || '🔵'}</span>
                <span style={{ lineHeight: 1.4 }}>{a.text}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Snapshot">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Row label="Items expiring (30d)" value={String(kpis.expiring_count ?? 0)} />
            <Row label="Low stock items" value={String(kpis.low_stock_count ?? 0)} />
            <Row label="Overdue invoices" value={String(kpis.overdue_invoices ?? 0)} />
            <Row label="Active branch" value={activeBranch?.name || '—'} />
          </div>
        </Card>
      </div>

    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', background: 'var(--bg-raised)', borderRadius: 8, fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'DM Mono', color: 'var(--text-primary)', fontWeight: 500 }}>{value}</span>
    </div>
  )
}

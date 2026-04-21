import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { KPICard, Card, BarList, AlertBar } from '@/components/ui'
import { fmt } from '@/utils/helpers'
import { SALES_TREND, PRODUCTS, CUSTOMERS } from '@/utils/seedData'

const QUICK_ACTIONS = [
  { icon: '🧾', label: 'New Sale', path: '/pos' },
  { icon: '📄', label: 'Quotation', path: '/sales' },
  { icon: '📥', label: 'Receive Stock', path: '/purchases' },
  { icon: '💸', label: 'Add Expense', path: '/cash' },
  { icon: '💳', label: 'Record Payment', path: '/sales' },
  { icon: '🔄', label: 'Transfer Stock', path: '/transfers' },
]

const ALERTS = [
  { type: 'red',   icon: '🔴', text: 'Basmati Rice critical stock at T.Nagar — only 8 units left' },
  { type: 'amber', icon: '🟡', text: 'INV-2024-1840 overdue by 12 days — Krishnan Stores ₹4,484' },
  { type: 'amber', icon: '🟡', text: 'Cash variance ₹340 detected at Vadapalani on Apr 15' },
  { type: 'blue',  icon: '🔵', text: 'Stock transfer TRF-041 awaiting your approval (3 items)' },
  { type: 'red',   icon: '🔴', text: '6 items approaching expiry in next 30 days — Dairy shelf' },
  { type: 'amber', icon: '🟡', text: 'PUR-2024-0408 payment overdue — Parle Distributor ₹15,198' },
]

const BRANCH_DATA = [
  { name: 'Anna Nagar', sales: 124850,  color: '#6366f1' },
  { name: 'T. Nagar',   sales: 98400,   color: '#a78bfa' },
  { name: 'Vadapalani', sales: 72600,   color: '#2dd4bf' },
  { name: 'Velachery',  sales: 46200,   color: '#f5a623' },
]

const TOP_PRODUCTS = [
  { label: 'Basmati Rice 5kg', value: 25200 },
  { label: 'Toor Dal 1kg',     value: 16800 },
  { label: 'Sunflower Oil 1L', value: 14400 },
  { label: 'Parle-G 800g',     value: 12000 },
  { label: 'Amul Butter 500g', value: 10200 },
]

const TOP_CUSTOMERS = [
  { label: 'Anand Traders',    value: 4280000 },
  { label: 'Rajesh Stores',    value: 1864000 },
  { label: 'Krishnan Stores',  value: 680000 },
  { label: 'Priya Sharma',     value: 482000 },
  { label: 'Meena Krishnan',   value: 112400 },
]

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
  const [trendPeriod, setTrendPeriod] = useState('14d')

  return (
    <div className="page-container">

      {/* KPI Grid */}
      <div className="grid-kpi" style={{ marginBottom: 22 }}>
        <KPICard label="Today's Sales" value={fmt(124850)} delta="12.4% vs yesterday" deltaUp icon="💰" color="var(--accent)" onClick={() => navigate('/sales')} />
        <KPICard label="Today's Purchases" value={fmt(48200)} delta="3.1% vs yesterday" deltaUp={false} icon="📦" color="var(--purple)" onClick={() => navigate('/purchases')} />
        <KPICard label="Cash in Hand" value={fmt(22640)} sub="Anna Nagar branch" icon="🏦" color="var(--green)" onClick={() => navigate('/cash')} />
        <KPICard label="Outstanding Receivables" value={fmt(342100)} delta="18 invoices overdue" deltaUp={false} icon="📋" color="var(--red)" onClick={() => navigate('/sales')} />
        <KPICard label="Outstanding Payables" value={fmt(118400)} sub="8 vendor bills pending" icon="💳" color="var(--amber)" onClick={() => navigate('/purchases')} />
        <KPICard label="Low Stock Items" value="24" delta="Across all branches" deltaUp={false} icon="⚠️" color="var(--red)" onClick={() => navigate('/items')} />
      </div>

      {/* Quick Actions */}
      <div style={{ marginBottom: 22 }}>
        <h4 style={{ marginBottom: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Quick Actions</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
          {QUICK_ACTIONS.map((qa) => (
            <div key={qa.label} onClick={() => navigate(qa.path)}
              style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 12, padding: '14px 10px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-bg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; e.currentTarget.style.background = 'var(--bg-surface)' }}>
              <div style={{ fontSize: 22, marginBottom: 7 }}>{qa.icon}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 500 }}>{qa.label}</div>
            </div>
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
            <AreaChart data={SALES_TREND.slice(-14)} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
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
              <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${(v/1000).toFixed(0)}K`} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
              <Area type="monotone" dataKey="sales" name="Sales" stroke="#6366f1" strokeWidth={2.5} fill="url(#gSales)" dot={false} />
              <Area type="monotone" dataKey="purchases" name="Purchases" stroke="#a78bfa" strokeWidth={2} fill="url(#gPurch)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 20, marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total (14d)</div><div style={{ fontSize: 17, fontWeight: 600 }}>₹14.8L</div></div>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Avg/Day</div><div style={{ fontSize: 17, fontWeight: 600 }}>₹1.06L</div></div>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Peak</div><div style={{ fontSize: 17, fontWeight: 600, color: 'var(--green)' }}>₹1.46L</div></div>
          </div>
        </Card>

        <Card title="Branch Comparison (Today)">
          <BarList
            items={BRANCH_DATA.map((b) => ({ label: b.name, value: b.sales, color: b.color }))}
            valueFormatter={(v) => fmt(v)}
          />
          <div style={{ marginTop: 16 }}>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={BRANCH_DATA} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} />
                <YAxis hide />
                <Bar dataKey="sales" radius={[4, 4, 0, 0]}>
                  {BRANCH_DATA.map((b) => <rect key={b.name} fill={b.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid-3" style={{ marginBottom: 18 }}>
        <Card title="Top Products (Today)" bodyPadding={false}>
          <BarList items={TOP_PRODUCTS} valueFormatter={(v) => fmt(v)} style={{ padding: '16px 20px' }} />
          <div style={{ padding: '0 20px 16px' }}>
            <BarList items={TOP_PRODUCTS} valueFormatter={(v) => fmt(v)} />
          </div>
        </Card>

        <Card title="Top Customers (Apr)" bodyPadding={false}>
          <div style={{ padding: '8px 0' }}>
            {TOP_CUSTOMERS.map((c, i) => (
              <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 20px', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer' }}
                onClick={() => navigate('/customers')}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-raised)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>{c.label}</span>
                <span style={{ fontSize: 12.5, fontFamily: 'DM Mono', color: 'var(--text-primary)' }}>{fmt(c.value)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Alerts">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {ALERTS.map((a, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 12px',
                background: 'var(--bg-raised)', borderRadius: 8,
                borderLeft: `3px solid ${a.type === 'red' ? 'var(--red)' : a.type === 'amber' ? 'var(--amber)' : 'var(--blue)'}`,
                cursor: 'pointer', fontSize: 12.5, color: 'var(--text-secondary)',
              }}>
                <span>{a.icon}</span>
                <span style={{ lineHeight: 1.4 }}>{a.text}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

    </div>
  )
}

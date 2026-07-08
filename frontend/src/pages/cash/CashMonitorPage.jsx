import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { cashAPI } from '@/api'
import { SectionHeader, EmptyState, DatePicker, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'
import { fmt } from '@/utils/helpers'

function VarianceBadge({ variance, threshold = 500 }) {
  if (variance === null || variance === undefined) return null
  const abs = Math.abs(variance)
  const color = abs === 0 ? 'var(--green)' : abs <= threshold ? 'var(--amber)' : 'var(--red)'
  return (
    <span style={{ color, fontWeight: 700, fontFamily: 'DM Mono,monospace', fontSize: 13 }}>
      {variance >= 0 ? '+' : ''}{fmt(variance)}
    </span>
  )
}

function StatusChip({ status }) {
  const map = {
    closed: { bg: 'var(--bg-raised)', color: 'var(--text-muted)', label: 'CLOSED', icon: '🔒' },
    open: { bg: '#e6f9ee', color: 'var(--green)', label: 'OPEN', icon: '✅' },
    not_started: { bg: 'var(--bg-raised)', color: 'var(--text-muted)', label: 'NOT STARTED', icon: '⬜' },
  }
  const s = map[status] || map.not_started
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.color,
    }}>
      {s.icon} {s.label}
    </span>
  )
}

function BranchCard({ item, onClick }) {
  const borderColor = {
    closed: item.variance_flag === 'red' ? 'var(--red)' : item.variance_flag === 'amber' ? 'var(--amber)' : 'var(--green)',
    open: 'var(--amber)',
    not_started: 'var(--border-default)',
  }[item.day_status] || 'var(--border-default)'

  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg-surface)',
        border: `2px solid ${borderColor}`,
        borderRadius: 12, padding: '16px 18px',
        cursor: 'pointer',
        transition: 'box-shadow 0.15s',
      }}
      onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'}
      onMouseLeave={(e) => e.currentTarget.style.boxShadow = 'none'}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{item.branch_name}</div>
        <StatusChip status={item.day_status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12.5 }}>
        {[
          { label: 'Opening', value: fmt(item.opening_balance) },
          { label: 'Cash In', value: fmt(item.cash_in), color: 'var(--green)' },
          { label: 'Cash Out', value: fmt(item.cash_out), color: 'var(--red)' },
          { label: 'Expected', value: fmt(item.expected_balance) },
        ].map((r) => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>{r.label}</span>
            <span style={{ fontFamily: 'DM Mono,monospace', color: r.color || 'var(--text-primary)', fontWeight: 600 }}>
              {r.value}
            </span>
          </div>
        ))}

        {item.day_status === 'closed' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Physical</span>
              <span style={{ fontFamily: 'DM Mono,monospace', fontWeight: 600 }}>
                {fmt(item.physical_count)}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Variance</span>
              <VarianceBadge variance={item.variance} />
            </div>
          </>
        )}
      </div>

      {item.day_status === 'closed' && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          Closed by {item.closed_by} · {item.entry_count} entries
        </div>
      )}
      {item.day_status === 'open' && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          {item.entry_count} entries · Day in progress
        </div>
      )}
    </div>
  )
}

export default function CashMonitorPage() {
  const navigate = useNavigate()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    cashAPI.monitor({ date }).then((res) => {
      if (!cancelled) setData(res)
    }).catch(() => {}).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [date, version])

  const branches = data?.branches || []
  const summary = data?.summary || {}

  const chips = [
    { label: 'Total Branches', value: summary.total_branches ?? 0, color: 'var(--text-primary)' },
    { label: 'Closed', value: summary.closed_count ?? 0, color: 'var(--green)' },
    { label: 'Open', value: summary.open_count ?? 0, color: 'var(--amber)' },
    { label: 'Not Started', value: summary.not_started_count ?? 0, color: 'var(--text-muted)' },
    { label: 'With Variance', value: summary.branches_with_variance ?? 0, color: 'var(--red)' },
  ]

  return (
    <div className="page-container">
      <SectionHeader
        title="Branch Cash Monitor"
        subtitle={`Petty cash status across all branches — ${date}`}
      >
        <DatePicker
          value={date}
          onChange={setDate}
          style={{ width: 148 }}
        />
        <PageActionsMenu actions={buildListPageMenuActions({
          hideExport: true,
          onRefresh: () => {
            setVersion((v) => v + 1)
            toast.success('List refreshed')
          },
        })} />
      </SectionHeader>

      {/* Summary chips */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        {chips.map((c) => (
          <div key={c.label} style={{
            padding: '8px 16px', borderRadius: 20, fontSize: 13,
            background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            display: 'flex', gap: 8, alignItems: 'center',
          }}>
            <span style={{ color: 'var(--text-muted)' }}>{c.label}:</span>
            <span style={{ fontWeight: 700, color: c.color, fontFamily: 'DM Mono,monospace' }}>{c.value}</span>
          </div>
        ))}
      </div>

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : branches.length === 0 ? (
        <EmptyState icon="🏪" title="No branches found" />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
          {branches.map((item) => (
            <BranchCard
              key={item.branch_id}
              item={item}
              onClick={() => navigate(`/cash?branch=${item.branch_id}&date=${date}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

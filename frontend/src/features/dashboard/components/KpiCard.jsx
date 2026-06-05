import { memo } from 'react'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import PermissionGate from './PermissionGate'

const toneColor = {
  success: 'var(--green)',
  warning: 'var(--amber)',
  danger: 'var(--red)',
  info: 'var(--blue)',
  neutral: 'var(--accent)',
}

function KpiCard({ title, value, delta, tone = 'neutral', sparkline = [], loading = false, permission }) {
  const color = toneColor[tone] || toneColor.neutral
  const card = (
    <div className="card" style={{ minHeight: 136 }}>
      <div className="card-body" style={{ padding: 16 }}>
        {loading ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="skeleton" style={{ height: 14, width: '52%' }} />
            <div className="skeleton" style={{ height: 30, width: '72%' }} />
            <div className="skeleton" style={{ height: 34, width: '100%' }} />
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{title}</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 24, lineHeight: 1, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
                {delta !== undefined && delta !== null && (
                  <div style={{ marginTop: 8, fontSize: 12, color: Number(delta) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {Number(delta) >= 0 ? '+' : ''}{Number(delta).toFixed(1)}% vs previous
                  </div>
                )}
              </div>
              <div style={{ width: 88, height: 42, flexShrink: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparkline || []}>
                    <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )

  if (!permission) return card
  return <PermissionGate permission={permission}>{card}</PermissionGate>
}

export default memo(KpiCard)

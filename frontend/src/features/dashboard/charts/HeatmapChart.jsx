import { Fragment } from 'react'
import { seriesPalette } from '../utils/chartConfig'
import { formatCompactCurrency } from '../utils/formatCurrency'

const hours = Array.from({ length: 14 }, (_, index) => `${index + 8}:00`)
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function HeatmapChart({ data = [] }) {
  const byKey = new Map(data.map((item) => [`${item.day}-${item.hour}`, item.value || item.sales || 0]))
  const max = Math.max(1, ...data.map((item) => item.value || item.sales || 0))

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `42px repeat(${hours.length}, minmax(42px, 1fr))`, gap: 4, minWidth: 720 }}>
        <div />
        {hours.map((hour) => (
          <div key={hour} style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>{hour}</div>
        ))}
        {days.map((day) => (
          <Fragment key={day}>
            <div key={`${day}-label`} style={{ fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>{day}</div>
            {hours.map((hour) => {
              const value = byKey.get(`${day}-${hour}`) || 0
              const strength = value / max
              return (
                <div
                  key={`${day}-${hour}`}
                  title={`${day} ${hour}: ${formatCompactCurrency(value)}`}
                  style={{
                    height: 26,
                    borderRadius: 4,
                    background: seriesPalette[0],
                    opacity: 0.12 + strength * 0.78,
                    border: '1px solid var(--border-subtle)',
                  }}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

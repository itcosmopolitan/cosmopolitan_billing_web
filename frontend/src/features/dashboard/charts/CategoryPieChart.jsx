import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { seriesPalette } from '../utils/chartConfig'
import { formatCompactCurrency } from '../utils/formatCurrency'

export default function CategoryPieChart({
  data = [],
  nameKey = 'name',
  valueKey = 'value',
  donut = false,
  valueFormatter = formatCompactCurrency,
  showPercent = true,
}) {
  const total = data.reduce((sum, entry) => sum + Number(entry[valueKey] || 0), 0)

  if (!data.length || total <= 0) {
    return (
      <div style={{ height: 220, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
        No chart data
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(120px, 220px)', gap: 12, alignItems: 'center', minWidth: 0 }}>
      <div style={{ minWidth: 0, width: '100%', height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <Pie
              data={data}
              dataKey={valueKey}
              nameKey={nameKey}
              cx="50%"
              cy="50%"
              innerRadius={donut ? '40%' : '0%'}
              outerRadius="80%"
              paddingAngle={1}
            >
              {data.map((_, index) => (
                <Cell key={index} fill={seriesPalette[index % seriesPalette.length]} />
              ))}
            </Pie>
            <Tooltip
              content={<CustomTooltip valueFormatter={valueFormatter} nameKey={nameKey} itemsKey="items" />}
              contentStyle={tooltipStyle}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gap: 8, maxHeight: 220, overflowY: 'auto', paddingRight: 8 }}>
        {data.map((entry, index) => {
          const value = Number(entry[valueKey] || 0)
          const percent = total ? (value / total) * 100 : 0
          return (
            <div key={`${entry[nameKey]}-${index}`} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: seriesPalette[index % seriesPalette.length], flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {entry[nameKey]}
                </span>
                <span className="currency">{valueFormatter(value)}</span>
              </div>
              {showPercent && (
                <div className="progress-bar" style={{ height: 4, marginLeft: 16 }}>
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.max(2, percent)}%`, background: seriesPalette[index % seriesPalette.length] }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CustomTooltip({ active, payload, valueFormatter = (v) => v, nameKey = 'name', itemsKey = 'items' }) {
  if (!active || !payload || !payload.length) return null
  const entry = payload[0].payload || {}
  const name = entry[nameKey] || payload[0].name || ''
  const value = payload[0].value
  const items = entry[itemsKey]

  return (
    <div style={{ padding: 10, background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 8, color: 'var(--text-primary)', minWidth: 140 }}>
      <div style={{ fontWeight: 700, marginBottom: items && items.length ? 8 : 0 }}>
        {name} : {valueFormatter ? valueFormatter(value) : value}
      </div>
      {items && items.length ? (
        <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 13 }}>
          {items.map((label, i) => (
            <div key={`${label}-${i}`} style={{ padding: '4px 0', color: 'var(--text-secondary)' }}>{label}</div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const tooltipStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-default)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 12,
}

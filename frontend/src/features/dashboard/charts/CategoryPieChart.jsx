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
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) minmax(130px, 180px)', gap: 12, alignItems: 'center' }}>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={nameKey}
            innerRadius={donut ? 54 : 0}
            outerRadius={86}
            paddingAngle={2}
          >
            {data.map((_, index) => (
              <Cell key={index} fill={seriesPalette[index % seriesPalette.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => valueFormatter(value)} contentStyle={tooltipStyle} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ display: 'grid', gap: 8 }}>
        {data.slice(0, 6).map((entry, index) => {
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

const tooltipStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-default)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 12,
}

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisStyle, chartColors, gridStroke } from '../utils/chartConfig'
import { formatCompactCurrency } from '../utils/formatCurrency'

export default function SalesTrendChart({ data = [], valueKey = 'sales', label = 'Sales', color = chartColors.primary }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id={`area-${valueKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.28} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
        <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={formatCompactCurrency} />
        <Tooltip formatter={(value) => formatCompactCurrency(value)} contentStyle={tooltipStyle} />
        <Area type="monotone" dataKey={valueKey} name={label} stroke={color} strokeWidth={2.5} fill={`url(#area-${valueKey})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

const tooltipStyle = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-default)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 12,
}

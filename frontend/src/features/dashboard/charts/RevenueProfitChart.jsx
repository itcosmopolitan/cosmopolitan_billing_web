import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisStyle, chartColors, gridStroke } from '../utils/chartConfig'
import { formatCompactCurrency } from '../utils/formatCurrency'

export default function RevenueProfitChart({ data = [] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
        <XAxis dataKey="date" tick={axisStyle} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={formatCompactCurrency} />
        <Tooltip formatter={(value) => formatCompactCurrency(value)} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="revenue" name="Revenue" stroke={chartColors.blue} fill={chartColors.blue} fillOpacity={0.12} dot={false} />
        <Area type="monotone" dataKey="profit" name="Profit" stroke={chartColors.emerald} fill={chartColors.emerald} fillOpacity={0.12} dot={false} />
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

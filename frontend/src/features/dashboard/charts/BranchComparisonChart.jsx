import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisStyle, chartColors, gridStroke } from '../utils/chartConfig'
import { formatCompactCurrency } from '../utils/formatCurrency'

export default function BranchComparisonChart({ data = [], valueKey = 'sales' }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 12, left: 18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
        <XAxis type="number" tick={axisStyle} tickFormatter={formatCompactCurrency} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="branch" tick={axisStyle} axisLine={false} tickLine={false} width={86} />
        <Tooltip formatter={(value) => formatCompactCurrency(value)} contentStyle={tooltipStyle} />
        <Bar dataKey={valueKey} fill={chartColors.emerald} radius={[0, 4, 4, 0]} />
      </BarChart>
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

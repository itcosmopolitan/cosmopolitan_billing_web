import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisStyle, chartColors, gridStroke } from '../utils/chartConfig'
import { formatCompactCurrency } from '../utils/formatCurrency'

export default function PaymentMethodChart({ data = [] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 10, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
        <XAxis dataKey="method" tick={axisStyle} tickLine={false} axisLine={false} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={formatCompactCurrency} />
        <Tooltip cursor={{ fill: 'transparent' }} formatter={(value) => formatCompactCurrency(value)} contentStyle={tooltipStyle} />
        <Bar dataKey="amount" name="Amount" fill={chartColors.primary} radius={[4, 4, 0, 0]} cursor={{ fill: 'transparent' }} />
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

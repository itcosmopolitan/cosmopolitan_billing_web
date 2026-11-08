import { formatCompactCurrency, formatCurrency } from '../utils/formatCurrency'

export default function CompactCurrency({ value }) {
  return (
    <span title={`MVR ${formatCurrency(value)}`}>
      {formatCompactCurrency(value)}
    </span>
  )
}

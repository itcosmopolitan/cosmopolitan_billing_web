import { Link } from 'react-router-dom'

export function txnHref(area, tab, id) {
  if (!area || !tab || !id) return null
  return `/${area}?tab=${tab}&view=${encodeURIComponent(id)}`
}

export function salesTxnHref(kind, id) {
  const tab = { invoice: 'invoices', quote: 'quotes', order: 'orders', return: 'returns', payment: 'payments' }[kind]
  return txnHref('sales', tab, id)
}

export function purchaseTxnHref(kind, id) {
  const tab = { bill: 'bills', order: 'orders', grn: 'grns', return: 'returns', payment: 'payments' }[kind]
  return txnHref('purchases', tab, id)
}

/**
 * Document number that opens the related transaction detail drawer.
 */
export default function TxnLink({ to, children, style }) {
  if (!children) return '—'
  if (!to) {
    return <span className="mono" style={{ fontSize: 12, ...style }}>{children}</span>
  }
  return (
    <Link
      to={to}
      className="mono"
      style={{
        color: 'var(--accent)',
        fontSize: 12,
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        ...style,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  )
}

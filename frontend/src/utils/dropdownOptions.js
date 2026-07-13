/** Shared option lists for AutocompleteDropdown / Select. */

export const PAYMENT_METHOD_OPTIONS = [
  { id: 'cash', label: '💵 Cash' },
  { id: 'card', label: '💳 Card' },
  { id: 'upi', label: '📱 UPI' },
  { id: 'bank_transfer', label: '🏦 Bank Transfer' },
]

export const PAYMENT_METHOD_WITH_CREDIT_OPTIONS = [
  ...PAYMENT_METHOD_OPTIONS,
  { id: 'credit', label: '🏦 Credit' },
]

export const PAYMENT_MODE_LABEL_OPTIONS = [
  { id: 'cash', label: 'CASH' },
  { id: 'card', label: 'CARD' },
  { id: 'upi', label: 'UPI' },
  { id: 'bank_transfer', label: 'BANK TRANSFER' },
]

export const CUSTOMER_TYPE_OPTIONS = [
  { id: 'retail', label: 'Retail' },
  { id: 'wholesale', label: 'Wholesale / B2B' },
]

export const VENDOR_PAYMENT_TERMS_OPTIONS = [
  'Advance', 'COD', '7 days', '15 days', '30 days', '45 days', '60 days', 'Weekly',
].map((t) => ({ id: t, label: t }))

export const TRANSFER_PRIORITY_OPTIONS = ['Normal', 'Urgent', 'Planned'].map((p) => ({ id: p, label: p }))

export const FINANCIAL_YEAR_OPTIONS = [
  { id: 'Jan-Dec', label: 'Jan–Dec' },
  { id: 'Jul-Jun', label: 'Jul–Jun' },
]

export const ADJUSTMENT_REASON_OPTIONS = [
  'Physical count',
  'Damage',
  'Expiry write-off',
  'Found stock',
  'System correction',
].map((r) => ({ id: r, label: r }))

export function statusOptions(statuses) {
  return statuses.map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
  }))
}

export const INVOICE_STATUS_FILTER_OPTIONS = statusOptions(['paid', 'pending', 'partial', 'overdue', 'cancelled'])
export const QUOTE_STATUS_FILTER_OPTIONS = statusOptions(['draft', 'sent', 'accepted', 'rejected', 'converted'])
export const ORDER_STATUS_FILTER_OPTIONS = statusOptions(['draft', 'confirmed', 'partial', 'fulfilled', 'cancelled', 'converted'])
export const RETURN_STATUS_FILTER_OPTIONS = statusOptions(['draft', 'posted', 'void'])

export function branchesToOptions(branches = []) {
  return branches.map((b) => ({ id: b.id, label: b.name }))
}

export function vendorsToOptions(vendors = []) {
  return vendors.map((v) => ({ id: v.id, label: v.name }))
}

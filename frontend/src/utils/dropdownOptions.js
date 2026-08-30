/** Shared option lists for AutocompleteDropdown / Select. */
import { formatLabel } from '@/utils/helpers'

export const PAYMENT_METHOD_OPTIONS = [
  { id: 'cash', label: '💵 Cash' },
  { id: 'card', label: '💳 Card' },
  { id: 'upi', label: '📱 UPI' },
  { id: 'bank_transfer', label: `🏦 ${formatLabel('bank_transfer')}` },
]

export const PAYMENT_METHOD_WITH_CREDIT_OPTIONS = [
  ...PAYMENT_METHOD_OPTIONS,
  { id: 'credit', label: '🏦 Store credit' },
]

export const PAYMENT_MODE_LABEL_OPTIONS = [
  { id: 'cash', label: formatLabel('cash') },
  { id: 'card', label: formatLabel('card') },
  { id: 'upi', label: formatLabel('upi') },
  { id: 'bank_transfer', label: formatLabel('bank_transfer') },
]

export const CUSTOMER_TYPE_OPTIONS = [
  { id: 'retail', label: 'Retail' },
  { id: 'wholesale', label: 'Wholesale' },
  { id: 'staff', label: 'Staff' },
]

export const CUSTOMER_TYPE_LABELS = {
  retail: 'Retail',
  wholesale: 'Wholesale',
  staff: 'Staff',
}

export const VENDOR_PAYMENT_TERMS_OPTIONS = [
  'Advance', 'COD', '7 days', '15 days', '30 days', '45 days', '60 days', 'Weekly',
].map((t) => ({ id: t, label: t }))

export const TRANSFER_PRIORITY_OPTIONS = ['Normal', 'Urgent', 'Planned'].map((p) => ({ id: p, label: p }))

export const FINANCIAL_YEAR_OPTIONS = [
  { id: 'Jan-Dec', label: 'Jan–Dec' },
  { id: 'Jul-Jun', label: 'Jul–Jun' },
]

export const DECIMAL_PRECISION_OPTIONS = [
  { id: '0', label: '0 (whole numbers)' },
  { id: '1', label: '1 (e.g. 12.5)' },
  { id: '2', label: '2 (e.g. 12.50)' },
  { id: '3', label: '3 (e.g. 12.505)' },
  { id: '4', label: '4 (e.g. 12.5050)' },
  { id: '5', label: '5' },
  { id: '6', label: '6' },
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
    label: formatLabel(id),
  }))
}

export const INVOICE_STATUS_FILTER_OPTIONS = statusOptions(['paid', 'pending', 'partial', 'overdue', 'cancelled'])
export const QUOTE_STATUS_FILTER_OPTIONS = statusOptions(['draft', 'sent', 'accepted', 'rejected', 'converted'])
export const ORDER_STATUS_FILTER_OPTIONS = statusOptions(['draft', 'confirmed', 'partial', 'fulfilled', 'cancelled', 'converted'])
export const RETURN_STATUS_FILTER_OPTIONS = statusOptions(['draft', 'posted', 'void'])
export const PAYMENT_STATUS_FILTER_OPTIONS = statusOptions(['recorded', 'voided'])

export function branchesToOptions(branches = []) {
  return branches.map((b) => ({ id: b.id, label: b.name }))
}

export function vendorsToOptions(vendors = []) {
  return vendors.map((v) => ({ id: v.id, label: v.name }))
}

export const AUDIT_FILTER_FIELD_OPTIONS = [
  { id: 'module', label: 'Module' },
  { id: 'risk', label: 'Risk Level' },
  { id: 'user_name', label: 'User' },
  { id: 'action', label: 'Operation Type' },
  { id: 'customer_name', label: 'Customer Name' },
  { id: 'vendor_name', label: 'Vendor Name' },
]

export const AUDIT_MODULE_OPTIONS = [
  'Sales', 'Inventory', 'Finance', 'Cash', 'Purchases', 'Auth',
].map((m) => ({ id: m, label: m }))

export const AUDIT_RISK_OPTIONS = ['LOW', 'MEDIUM', 'HIGH'].map((r) => ({ id: r, label: r }))

export const AUDIT_OPERATION_OPTIONS = [
  { id: 'created', label: 'Created' },
  { id: 'deleted', label: 'Deleted' },
  { id: 'updated', label: 'Updated' },
]

export const AUDIT_JOINER_OPTIONS = [
  { id: 'and', label: 'AND' },
  { id: 'or', label: 'OR' },
]

export function defaultAuditJoiners(rowCount) {
  return Array(Math.max(0, rowCount - 1)).fill('and')
}

export const AUDIT_SELECT_CONDITION_OPTIONS = ['is', 'is not'].map((c) => ({ id: c, label: c }))

export const AUDIT_TEXT_CONDITION_OPTIONS = ['contains', 'is', 'starts with', 'is empty'].map((c) => ({ id: c, label: c }))

const AUDIT_VALUE_OPTIONS_BY_FIELD = {
  module: AUDIT_MODULE_OPTIONS,
  risk: AUDIT_RISK_OPTIONS,
  action: AUDIT_OPERATION_OPTIONS,
}

export function auditValueOptionsForField(fieldKey) {
  return AUDIT_VALUE_OPTIONS_BY_FIELD[fieldKey] ?? []
}

export function auditFieldType(fieldKey) {
  if (['module', 'risk', 'action'].includes(fieldKey)) return 'select'
  return 'text'
}

export const AUDIT_DATE_RANGE_OPTIONS = [
  { id: '', label: 'All dates' },
  { id: 'today', label: 'Today' },
  { id: 'this_week', label: 'This Week' },
  { id: 'this_month', label: 'This Month' },
  { id: 'last_month', label: 'Last Month' },
  { id: 'custom', label: 'Custom Range' },
]

const formatAuditDate = (date) => date.toISOString().slice(0, 10)

export function getAuditDateRangeForPreset(presetId) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (presetId === 'today') {
    const value = formatAuditDate(today)
    return { from: value, to: value }
  }

  if (presetId === 'this_week') {
    const day = today.getDay()
    const monday = new Date(today)
    monday.setDate(today.getDate() - ((day + 6) % 7))
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    return { from: formatAuditDate(monday), to: formatAuditDate(sunday) }
  }

  if (presetId === 'this_month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1)
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return { from: formatAuditDate(first), to: formatAuditDate(last) }
  }

  if (presetId === 'last_month') {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const last = new Date(today.getFullYear(), today.getMonth(), 0)
    return { from: formatAuditDate(first), to: formatAuditDate(last) }
  }

  return { from: '', to: '' }
}

export function inferAuditDateRangePreset(from, to) {
  if (!from && !to) return ''
  for (const opt of AUDIT_DATE_RANGE_OPTIONS) {
    if (!opt.id || opt.id === 'custom') continue
    const range = getAuditDateRangeForPreset(opt.id)
    if (from === range.from && to === range.to) return opt.id
  }
  return 'custom'
}

export function getAuditDateRangeChipLabel(from, to) {
  if (!from && !to) return ''
  const preset = inferAuditDateRangePreset(from, to)
  if (preset && preset !== 'custom') {
    return AUDIT_DATE_RANGE_OPTIONS.find((o) => o.id === preset)?.label ?? preset
  }
  return `Date between ${from || '…'} and ${to || '…'}`
}

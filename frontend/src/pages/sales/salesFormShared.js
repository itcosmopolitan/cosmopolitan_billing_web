/** Shared helpers for sales document form pages. */

import { itemsAPI } from '@/api'
import { unwrapPaged } from '@/utils/pagination'
import { customerPricingType, customerClassification } from '@/utils/pricingDiscounts'

export {
  suggestedDiscountForCustomer,
  customerPricingType,
  customerClassification,
  isInternalCustomer,
  taxRateForCustomer,
  linePricingForCustomer,
  applyInternalGstToSaleLines,
  applyCustomerPricingToSaleLines,
  internalGstReverseSummary,
  discountPatternFromItem,
  applySuggestedDiscountsToSaleLines,
  resolveCategoryLinePricing,
} from '@/utils/pricingDiscounts'

export function lineDiscountToPercent(line) {
  const qty = Number(line.qty || 0)
  const price = Number(line.price || 0)
  const gross = qty * price
  const raw = Math.max(0, Number(line.lineDiscount || 0))
  if (line.lineDiscountType === 'MVR') {
    if (gross <= 0) return 0
    return Math.min(100, (raw / gross) * 100)
  }
  return Math.min(100, raw)
}

export const emptySaleLine = () => ({
  item_id: null,
  name: '',
  qty: 1,
  price: 0,
  costPrice: 0,
  taxRate: 0,
  catalogTaxRate: 0,
  catalogInclusivePrice: 0,
  gstReversed: 0,
  lineDiscount: 0,
  lineDiscountType: '%',
  wholesale_discount_pct: 0,
  wholesale_pricing_mode: 'pct',
  wholesale_price: 0,
  staff_discount_pct: 0,
  staff_pricing_mode: 'pct',
  staff_price: 0,
  retailPrice: 0,
  batchTracking: false,
  expiryTracking: false,
  batchAllocation: [],
  batchAllocationCustom: false,
})

export function mapSaleLines(items, { withOrderLineId = false } = {}) {
  return (items || []).map((it) => ({
    ...emptySaleLine(),
    item_id: it.itemId || it.item_id || null,
    name: it.name || '',
    qty: it.qty,
    price: it.price,
    costPrice: it.costPrice ?? it.cost_price ?? 0,
    taxRate: it.taxRate ?? 0,
    lineDiscount: it.discount ?? it.lineDiscount ?? 0,
    lineDiscountType: '%',
    wholesale_discount_pct: Number(it.wholesale_discount_pct ?? it.wholesaleDiscountPct ?? 0) || 0,
    wholesale_pricing_mode: it.wholesale_pricing_mode === 'price' ? 'price' : 'pct',
    wholesale_price: Number(it.wholesale_price ?? it.wholesalePrice ?? 0) || 0,
    staff_discount_pct: Number(it.staff_discount_pct ?? it.staffDiscountPct ?? 0) || 0,
    staff_pricing_mode: it.staff_pricing_mode === 'price' ? 'price' : 'pct',
    staff_price: Number(it.staff_price ?? it.staffPrice ?? 0) || 0,
    retailPrice: Number(it.retailPrice ?? it.price ?? 0) || 0,
    batchAllocation: it.batchAllocation || [],
    batchAllocationCustom: Boolean(it.batchAllocation?.length),
    ...(withOrderLineId && it.id ? { orderLineId: it.id } : {}),
  }))
}

export const WALK_IN_CUSTOMER_NAME = 'Walk-in'
export const WALK_IN_CUSTOMER_OPTION = { id: '', label: 'Walk-in Customer' }

export const emptyQuoteForm = (branchId) => ({
  customerName: WALK_IN_CUSTOMER_NAME,
  customerId: '',
  customerType: 'retail',
  customerClassification: 'external',
  branchId,
  number: '',
  items: [emptySaleLine()],
  discount: 0,
  discountType: '%',
  validUntil: '',
  shipmentDate: '',
  paymentTerms: '',
  shipmentMethod: '',
  pricesIncludingVat: false,
  paymentDiscountOnVat: 0,
  notes: '',
})

export const emptyOrderForm = (branchId) => ({
  customerName: WALK_IN_CUSTOMER_NAME,
  customerId: '',
  customerType: 'retail',
  customerClassification: 'external',
  branchId,
  number: '',
  items: [emptySaleLine()],
  discount: 0,
  discountType: '%',
  expectedDate: '',
  notes: '',
})

export const emptyInvoiceForm = (branchId) => ({
  customerName: WALK_IN_CUSTOMER_NAME,
  customerId: '',
  customerType: 'retail',
  customerClassification: 'external',
  customerCreditBalance: 0,
  customerCreditLimit: 0,
  customerOutstanding: 0,
  customerCreditEligible: false,
  branchId,
  childCounterId: '',
  childCounterName: '',
  number: '',
  items: [emptySaleLine()],
  discount: 0,
  discountType: '%',
  invoiceDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  paymentReceived: false,
  paymentMethod: null,
  paymentRef: '',
  cashCollected: '',
  notes: '',
})

export function quoteFromRow(q, branchId) {
  return {
    customerName: q.customerName || '',
    customerId: q.customerId || '',
    customerClassification: customerClassification(q),
    branchId: q.branchId || branchId,
    items: mapSaleLines(q.items),
    discount: q.discount || 0,
    discountType: 'MVR',
    validUntil: q.validUntil || '',
    shipmentDate: q.shipmentDate || '',
    paymentTerms: q.paymentTerms || '',
    shipmentMethod: q.shipmentMethod || '',
    pricesIncludingVat: Boolean(q.pricesIncludingVat),
    paymentDiscountOnVat: q.paymentDiscountOnVat || 0,
    notes: q.notes || '',
  }
}

export function orderFromRow(so, branchId) {
  return {
    customerName: so.customerName || '',
    customerId: so.customerId || '',
    customerClassification: customerClassification(so),
    branchId: so.branchId || branchId,
    items: mapSaleLines(so.items),
    discount: so.discount || 0,
    discountType: 'MVR',
    expectedDate: so.expectedDate || '',
    notes: so.notes || '',
  }
}

export function invoiceFromRow(doc, branchId, { withOrderLineId = false, keepNumber = false } = {}) {
  return {
    ...emptyInvoiceForm(doc.branchId || branchId),
    // Conversion must leave number blank so DocumentNumberField / server
    // auto-allocate the next invoice #. Keep only when editing an existing invoice.
    number: keepNumber ? (doc.number || '') : '',
    customerName: doc.customerName || '',
    customerId: doc.customerId || '',
    branchId: doc.branchId || branchId,
    childCounterId: doc.childCounterId || doc.child_counter_id || '',
    childCounterName: doc.childCounterName || doc.child_counter_name || '',
    items: mapSaleLines(doc.items, { withOrderLineId }),
    discount: doc.discount || 0,
    discountType: 'MVR',
    invoiceDate: doc.date || doc.invoiceDate || new Date().toISOString().split('T')[0],
    dueDate: doc.dueDate || '',
    paymentReceived: Boolean(doc.paymentMode),
    paymentMethod: doc.paymentMode || null,
    paymentRef: doc.paymentRef || '',
    customerType: customerPricingType(doc.customerType || doc.customer_type || 'retail'),
    customerClassification: customerClassification(doc),
    customerCreditBalance: Number(doc.creditBalance ?? doc.credit_balance ?? 0) || 0,
    customerCreditLimit: Number(doc.creditLimit ?? doc.credit_limit ?? 0) || 0,
    customerOutstanding: Number(doc.outstanding ?? 0) || 0,
    customerCreditEligible: Boolean(
      doc.is_credit_eligible ?? doc.isCreditEligible ?? doc.customerCreditEligible,
    ),
    notes: doc.notes || '',
  }
}

export function isPosInvoice(inv) {
  return String(inv?.origin || 'invoice').toLowerCase() === 'pos'
}

export function invoiceHasPayment(inv) {
  if (!inv) return false
  if (Number((inv.paidAmount ?? inv.paid_amount) || 0) > 0) return true
  const status = String(inv.status || '').toLowerCase()
  return status === 'paid' || status === 'partial'
}

export function invoiceHasReturn(inv) {
  if (!inv) return false
  if (Number((inv.creditedAmount ?? inv.credited_amount) || 0) > 0) return true
  const returns = String(inv.returnStatus || 'none').toLowerCase()
  return Boolean(returns && returns !== 'none')
}

export function invoiceLockedForEdit(inv) {
  const status = String(inv?.status || '')
  return status === 'cancelled' || status === 'pending_approval'
}

export function canShowInvoiceEdit(inv, can) {
  if (!inv || invoiceLockedForEdit(inv)) return false
  if (inv.status === 'draft') return can('invoices.create', 'invoices.edit')
  if (isPosInvoice(inv)) return can('pos.use', 'invoices.edit')
  return can('invoices.edit')
}

export function invoiceEditPath(inv, can) {
  if (isPosInvoice(inv) && can('pos.use')) return `/pos?edit=${inv.id}`
  return `/sales/invoices/${inv.id}/edit`
}

export function canShowDeletePayment(inv, can) {
  if (!inv || !invoiceHasPayment(inv)) return false
  if (['cancelled', 'draft', 'pending_approval'].includes(String(inv.status || ''))) return false
  // Anyone who can work invoices or the till can unwind a recorded payment.
  return can('invoices.edit', 'invoices.delete', 'invoices.create', 'pos.use')
}

export function canShowDeleteReturn(inv, can) {
  if (!inv || !invoiceHasReturn(inv)) return false
  if (['cancelled', 'draft', 'pending_approval'].includes(String(inv.status || ''))) return false
  return can('invoices.edit', 'invoices.delete', 'invoices.create', 'pos.use')
}

export function canShowCreditNoteAction(inv, can) {
  if (!inv || !can('invoices.create')) return false
  if (['cancelled', 'draft', 'pending_approval'].includes(inv.status)) return false
  return String(inv.returnStatus || 'none').toLowerCase() !== 'full'
}

/** Open the desk credit-note form for this invoice (POS and desk alike). */
export function invoiceReturnPath(inv) {
  return `/sales/returns/new?invoiceId=${encodeURIComponent(inv.id)}`
}

export function creditNotePath(invoiceId, mode) {
  const params = new URLSearchParams({ invoiceId })
  if (mode) params.set('mode', mode)
  return `/sales/returns/new?${params.toString()}`
}

function lineItemId(line) {
  return line?.item_id || line?.itemId || null
}

function lineItemName(line) {
  return line?.name || lineItemId(line) || 'Unnamed item'
}

export function unlistedItemsFromError(err) {
  const detail = err?.response?.data?.detail
  if (detail && typeof detail === 'object' && detail.code === 'items_not_listed_at_branch') {
    return Array.isArray(detail.items) ? detail.items.filter(Boolean) : []
  }
  return []
}

/** Catalog lines that are not listed for this branch in item master. */
export async function findUnlistedItemsAtBranch(lines, branchId) {
  if (!branchId) return []
  const unique = []
  const seen = new Set()
  for (const line of lines || []) {
    const id = lineItemId(line)
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push(line)
  }
  if (unique.length === 0) return []

  const missing = await Promise.all(unique.map(async (line) => {
    const id = lineItemId(line)
    const name = lineItemName(line)
    try {
      const raw = await itemsAPI.list({
        branch_id: branchId,
        listed_only: false,
        pos_mode: true,
        search: name || undefined,
        per_page: 50,
        page_no: 1,
        include_total: false,
      })
      const rows = unwrapPaged(raw).items || []
      const match = rows.find((row) => row.id === id)
      if (match && match.is_available !== false) return null
      return name
    } catch {
      return name
    }
  }))
  return missing.filter(Boolean)
}

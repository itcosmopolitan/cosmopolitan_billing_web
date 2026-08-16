/** Shared helpers for sales document form pages. */

export {
  suggestedDiscountForCustomer,
  customerPricingType,
  discountPatternFromItem,
  applySuggestedDiscountsToSaleLines,
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
  lineDiscount: 0,
  lineDiscountType: '%',
  wholesale_discount_pct: 0,
  staff_discount_pct: 0,
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
    staff_discount_pct: Number(it.staff_discount_pct ?? it.staffDiscountPct ?? 0) || 0,
    batchAllocation: it.batchAllocation || [],
    batchAllocationCustom: Boolean(it.batchAllocation?.length),
    ...(withOrderLineId && it.id ? { orderLineId: it.id } : {}),
  }))
}

export const emptyQuoteForm = (branchId) => ({
  customerName: '',
  customerId: '',
  customerType: 'retail',
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
  customerName: '',
  customerId: '',
  customerType: 'retail',
  branchId,
  number: '',
  items: [emptySaleLine()],
  discount: 0,
  discountType: '%',
  expectedDate: '',
  notes: '',
})

export const emptyInvoiceForm = (branchId) => ({
  customerName: '',
  customerId: '',
  customerType: 'retail',
  branchId,
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
    branchId: so.branchId || branchId,
    items: mapSaleLines(so.items),
    discount: so.discount || 0,
    discountType: 'MVR',
    expectedDate: so.expectedDate || '',
    notes: so.notes || '',
  }
}

export function invoiceFromRow(doc, branchId, { withOrderLineId = false } = {}) {
  return {
    ...emptyInvoiceForm(doc.branchId || branchId),
    number: doc.number || '',
    customerName: doc.customerName || '',
    customerId: doc.customerId || '',
    branchId: doc.branchId || branchId,
    items: mapSaleLines(doc.items, { withOrderLineId }),
    discount: doc.discount || 0,
    discountType: 'MVR',
    invoiceDate: doc.date || doc.invoiceDate || new Date().toISOString().split('T')[0],
    dueDate: doc.dueDate || '',
    paymentReceived: Boolean(doc.paymentMode),
    paymentMethod: doc.paymentMode || null,
    paymentRef: doc.paymentRef || '',
    notes: doc.notes || '',
  }
}

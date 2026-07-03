/** Shared helpers for purchase document form pages. */

export function lineDiscountToPercent(line) {
  const qty = Number(line.qty || 0)
  const cost = Number(line.cost || 0)
  const gross = qty * cost
  const raw = Math.max(0, Number(line.lineDiscount || 0))
  if (line.lineDiscountType === 'MVR') {
    if (gross <= 0) return 0
    return Math.min(100, (raw / gross) * 100)
  }
  return Math.min(100, raw)
}

export function mapPurchaseLines(items) {
  return (items || []).map((it) => ({
    ...emptyPurchaseLine(),
    item_id: it.itemId || it.item_id || null,
    name: it.name || '',
    qty: it.qty ?? it.receivedQty ?? 0,
    cost: it.cost,
    taxRate: it.taxRate ?? 0,
    lineDiscount: it.discount ?? it.lineDiscount ?? 0,
    batchTracking: Boolean(it.batchTracking),
    expiryTracking: Boolean(it.expiryTracking),
    batchNumber: it.batchNumber || '',
    mfgDate: it.mfgDate || '',
    expiryDate: it.expiryDate || '',
  }))
}

export const emptyPurchaseLine = () => ({
  item_id: null,
  name: '',
  qty: 1,
  cost: 0,
  taxRate: 0,
  lineDiscount: 0,
  lineDiscountType: '%',
  batchTracking: false,
  expiryTracking: false,
  batchNumber: '',
  mfgDate: '',
  expiryDate: '',
})

export const emptyBillForm = (branchId) => ({
  vendorId: '',
  vendorName: '',
  branchId,
  number: '',
  billDate: new Date().toISOString().split('T')[0],
  dueDate: '',
  items: [emptyPurchaseLine()],
  discount: 0,
  discountType: '%',
  paymentReceived: false,
  paymentMethod: null,
  notes: '',
})

export const emptyPoForm = (branchId) => ({
  vendorId: '',
  vendorName: '',
  branchId,
  number: '',
  items: [emptyPurchaseLine()],
  discount: 0,
  discountType: '%',
  expectedDate: '',
  notes: '',
})

export function poFromRow(po, branchId) {
  return {
    vendorId: po.vendorId || '',
    vendorName: po.vendorName || '',
    branchId: po.branchId || branchId,
    items: mapPurchaseLines(po.items),
    discount: po.discount || 0,
    discountType: 'MVR',
    expectedDate: po.expectedDate || '',
    notes: po.notes || '',
  }
}

export function billFromRow(doc, branchId) {
  return {
    ...emptyBillForm(doc.branchId || branchId),
    vendorId: doc.vendorId || '',
    vendorName: doc.vendorName || '',
    number: doc.number || '',
    billDate: doc.date || new Date().toISOString().split('T')[0],
    dueDate: doc.dueDate || '',
    items: mapPurchaseLines(doc.items),
    discount: doc.discount || 0,
    discountType: 'MVR',
    notes: doc.notes || '',
  }
}

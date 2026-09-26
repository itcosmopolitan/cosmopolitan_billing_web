import { formatLabel, statusLabel, conversionStatusDisplay } from '@/utils/helpers'
import { getAuditDateRangeForPreset } from '@/utils/dropdownOptions'

/** Cap export window so large lists don't blow the API timeout. Operators can
 *  export adjacent ranges and merge CSVs offline. */
export const MAX_EXPORT_DATE_RANGE_DAYS = 93

/** Endpoints with `le=200` (payments, some orders/GRNs) need a smaller page. */
export const EXPORT_PAGE_SIZE_SAFE = 200

export function defaultExportDateRange() {
  const { from, to } = getAuditDateRangeForPreset('this_month')
  return { dateFrom: from, dateTo: to }
}

/** Coerce the first usable numeric candidate (handles totalAmount vs amount). */
export function exportNum(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return 0
}

export function exportDash(v, fallback = '—') {
  if (v === null || v === undefined || v === '') return fallback
  return v
}

/** Join document / allocation numbers into one CSV cell. */
export function exportRefNumbers(...vals) {
  const parts = []
  for (const v of vals) {
    if (v == null || v === '') continue
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item == null || item === '') continue
        parts.push(String(item))
      }
      continue
    }
    parts.push(String(v))
  }
  const unique = [...new Set(parts)]
  return unique.length ? unique.join(', ') : '—'
}

function allocationDocNumbers(allocations, numberKey) {
  if (!Array.isArray(allocations) || !allocations.length) return []
  return allocations.map((a) => a?.[numberKey]).filter(Boolean)
}

export function validateExportDateRange(dateFrom, dateTo, maxDays = MAX_EXPORT_DATE_RANGE_DAYS) {
  if (!dateFrom || !dateTo) {
    return 'From and To dates are required.'
  }
  const start = new Date(`${dateFrom}T00:00:00`)
  const end = new Date(`${dateTo}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Invalid date range. Use YYYY-MM-DD.'
  }
  if (end < start) {
    return "To date must be on or after From date."
  }
  const days = Math.floor((end - start) / 86_400_000) + 1
  if (days > maxDays) {
    return `Date range cannot exceed ${maxDays} days. Export smaller ranges and combine the files.`
  }
  return null
}

function paymentModeLabel(raw) {
  if (!raw) return '—'
  return formatLabel(raw)
}

function paymentStatusLabel(row) {
  if (row?.voided) return 'Voided'
  if (row?.status) return statusLabel(row.status)
  return 'Recorded'
}

function outstanding(total, paid) {
  return Math.round((exportNum(total) - exportNum(paid)) * 100) / 100
}

function returnStatusLabel(raw) {
  if (!raw || raw === 'none') return '—'
  return statusLabel(raw) || formatLabel(raw)
}

function keyAccountManager(row) {
  return exportDash(
    row?.customerKeyAccountManager
    || row?.customer_key_account_manager
    || row?.keyAccountManager
    || row?.key_account_manager_name
    || row?.key_account_manager,
  )
}

/** Map API rows → CSV objects with the columns operators need per tab. */
export const SALES_EXPORT_MAPPERS = {
  invoices: (i) => {
    const total = exportNum(i.total, i.totalAmount)
    const paid = exportNum(i.paidAmount, i.paid)
    return {
      'Invoice Number': exportDash(i.number || i.id),
      Customer: exportDash(i.customerName, 'Walk-in'),
      'Key Account Manager': keyAccountManager(i),
      Branch: exportDash(i.branchName),
      Date: exportDash(i.date),
      'Due Date': exportDash(i.dueDate),
      Cashier: exportDash(i.cashier),
      'Quotation Number': exportDash(i.quotationNumber),
      'Sales Order Number': exportDash(i.salesOrderNumber),
      'Payment Reference': exportDash(i.paymentRef, ''),
      'Subtotal (MVR)': exportNum(i.subtotal),
      'Tax (MVR)': exportNum(i.taxTotal),
      'Discount (MVR)': exportNum(i.discount),
      'Amount (MVR)': total,
      'Paid (MVR)': paid,
      'Outstanding (MVR)': outstanding(total, paid),
      'Credited (MVR)': exportNum(i.creditedAmount),
      Mode: paymentModeLabel(i.paymentMode),
      Returns: returnStatusLabel(i.returnStatus),
      Origin: exportDash(i.origin),
      Status: statusLabel(i.status),
      Notes: exportDash(i.notes, ''),
    }
  },
  orders: (o) => {
    const conv = conversionStatusDisplay('order', o)
    return {
      'Order Number': exportDash(o.number || o.id),
      Customer: exportDash(o.customerName, 'Walk-in'),
      'Key Account Manager': keyAccountManager(o),
      Branch: exportDash(o.branchName),
      Date: exportDash(o.date),
      'Expected Date': exportDash(o.expectedDate),
      'Invoice Number': exportDash(o.convertedInvoiceNumber),
      'Subtotal (MVR)': exportNum(o.subtotal),
      'Tax (MVR)': exportNum(o.taxTotal),
      'Discount (MVR)': exportNum(o.discount),
      'Amount (MVR)': exportNum(o.total, o.totalAmount),
      Status: conv.label || statusLabel(o.status),
      Notes: exportDash(o.notes, ''),
    }
  },
  quotes: (q) => {
    const conv = conversionStatusDisplay('quote', q)
    return {
      'Quote Number': exportDash(q.number || q.id),
      Customer: exportDash(q.customerName, 'Walk-in'),
      'Key Account Manager': keyAccountManager(q),
      Branch: exportDash(q.branchName),
      Date: exportDash(q.date),
      'Valid Until': exportDash(q.validUntil),
      'Sales Order Number': exportDash(q.convertedOrderNumber),
      'Invoice Number': exportDash(q.convertedInvoiceNumber),
      'Subtotal (MVR)': exportNum(q.subtotal),
      'Tax (MVR)': exportNum(q.taxTotal),
      'Discount (MVR)': exportNum(q.discount),
      'Amount (MVR)': exportNum(q.total, q.totalAmount),
      Status: conv.label || statusLabel(q.status),
      Notes: exportDash(q.notes, ''),
    }
  },
  returns: (r) => ({
    'Credit Note Number': exportDash(r.number || r.id),
    'Invoice Number': exportDash(r.invoiceNumber),
    Customer: exportDash(r.customerName, 'Walk-in'),
    'Key Account Manager': keyAccountManager(r),
    Branch: exportDash(r.branchName),
    Date: exportDash(r.date),
    'Subtotal (MVR)': exportNum(r.subtotal),
    'Tax (MVR)': exportNum(r.taxTotal),
    'Amount (MVR)': exportNum(r.total, r.totalAmount),
    'Credited (MVR)': exportNum(r.creditedAmount),
    Refund: paymentModeLabel(r.refundMethod),
    Reason: exportDash(r.reason, ''),
    Status: statusLabel(r.status),
    Notes: exportDash(r.notes, ''),
  }),
  payments: (p) => ({
    'Payment Number': exportDash(p.number || p.id),
    Customer: exportDash(p.customerName, 'Walk-in'),
    'Key Account Manager': keyAccountManager(p),
    Branch: exportDash(p.branchName),
    Date: exportDash(p.date),
    Method: paymentModeLabel(p.paymentMode),
    'Invoice Numbers': exportRefNumbers(allocationDocNumbers(p.allocations, 'invoiceNumber')),
    'Invoice Count': exportNum(p.invoiceCount, p.allocations?.length),
    'Amount (MVR)': exportNum(p.totalAmount, p.amount, p.total),
    'Store Credit (MVR)': exportNum(p.creditApplied),
    'Payment Reference': exportDash(p.paymentRef, ''),
    Status: paymentStatusLabel(p),
    Notes: exportDash(p.notes, ''),
  }),
}

export const PURCHASE_EXPORT_MAPPERS = {
  bills: (b) => {
    const total = exportNum(b.total, b.totalAmount)
    const paid = exportNum(b.paidAmount, b.paid)
    return {
      'Bill Number': exportDash(b.number || b.id),
      Vendor: exportDash(b.vendorName),
      Branch: exportDash(b.branchName),
      'Bill Date': exportDash(b.date),
      'Due Date': exportDash(b.dueDate),
      'PO Number': exportDash(b.purchaseOrderNumber),
      'GRN Number': exportDash(b.grnNumber),
      'Payment Reference': exportDash(b.paymentRef, ''),
      'Subtotal (MVR)': exportNum(b.subtotal),
      'Tax (MVR)': exportNum(b.taxTotal),
      'Discount (MVR)': exportNum(b.discount),
      'Amount (MVR)': total,
      'Paid (MVR)': paid,
      'Outstanding (MVR)': outstanding(total, paid),
      'Credited (MVR)': exportNum(b.creditedAmount),
      Mode: paymentModeLabel(b.paymentMode),
      Returns: returnStatusLabel(b.returnStatus),
      Status: statusLabel(b.status),
      Notes: exportDash(b.notes, ''),
    }
  },
  orders: (o) => {
    const conv = conversionStatusDisplay('po', o)
    return {
      'PO Number': exportDash(o.number || o.id),
      Vendor: exportDash(o.vendorName),
      Branch: exportDash(o.branchName),
      Date: exportDash(o.date),
      'Expected Date': exportDash(o.expectedDate),
      'Bill Number': exportDash(o.convertedBillNumber),
      'Subtotal (MVR)': exportNum(o.subtotal),
      'Tax (MVR)': exportNum(o.taxTotal),
      'Discount (MVR)': exportNum(o.discount),
      'Amount (MVR)': exportNum(o.total, o.totalAmount),
      Status: conv.label || statusLabel(o.status),
      Notes: exportDash(o.notes, ''),
    }
  },
  grns: (g) => ({
    'GRN Number': exportDash(g.number || g.id),
    'PO Number': exportDash(g.poNumber),
    'Bill Number': exportDash(g.convertedBillNumber),
    Vendor: exportDash(g.vendorName),
    Branch: exportDash(g.branchName),
    Date: exportDash(g.date),
    'Subtotal (MVR)': exportNum(g.subtotal),
    'Tax (MVR)': exportNum(g.taxTotal),
    'Discount (MVR)': exportNum(g.discount),
    'Amount (MVR)': exportNum(g.total, g.totalAmount),
    Status: statusLabel(g.status),
    Notes: exportDash(g.notes, ''),
  }),
  returns: (r) => ({
    'Return Number': exportDash(r.number || r.id),
    'Bill Number': exportDash(r.billNumber),
    Vendor: exportDash(r.vendorName),
    Branch: exportDash(r.branchName),
    Date: exportDash(r.date),
    'Subtotal (MVR)': exportNum(r.subtotal),
    'Tax (MVR)': exportNum(r.taxTotal),
    'Amount (MVR)': exportNum(r.total, r.totalAmount),
    'Credited (MVR)': exportNum(r.creditedAmount),
    Reason: exportDash(r.reason, ''),
    Status: statusLabel(r.status),
    Notes: exportDash(r.notes, ''),
  }),
  payments: (p) => ({
    'Payment Number': exportDash(p.number || p.id),
    Vendor: exportDash(p.vendorName),
    Branch: exportDash(p.branchName),
    Date: exportDash(p.date),
    Method: paymentModeLabel(p.paymentMode),
    'Bill Numbers': exportRefNumbers(allocationDocNumbers(p.allocations, 'billNumber')),
    'Bill Count': exportNum(p.billCount, p.allocations?.length),
    'Amount (MVR)': exportNum(p.totalAmount, p.amount, p.total),
    'Payment Reference': exportDash(p.paymentRef, ''),
    Status: paymentStatusLabel(p),
    Notes: exportDash(p.notes, ''),
  }),
}

export const SALES_EXPORT_FILENAMES = {
  invoices: 'Invoices',
  orders: 'SalesOrders',
  quotes: 'Quotations',
  returns: 'CreditNotes',
  payments: 'Payments',
}

export const PURCHASE_EXPORT_FILENAMES = {
  bills: 'PurchaseBills',
  orders: 'PurchaseOrders',
  grns: 'GRNs',
  returns: 'VendorReturns',
  payments: 'VendorPayments',
}

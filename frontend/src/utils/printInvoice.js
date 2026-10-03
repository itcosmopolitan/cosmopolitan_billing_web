import amountToWords from '@/utils/amountToWords'
import { calcInvoiceSummary } from '@/utils/taxCalc'
import { childCounterInvoiceAddress } from '@/utils/address'

function withCashTender(sale) {
  if (!sale) return sale
  const paymentMode = String(sale.paymentMode || sale.payment_mode || '').toLowerCase()
  if (paymentMode !== 'cash' || !Array.isArray(sale.payments)) return sale

  const cashPayments = sale.payments.filter((payment) => {
    return !payment.voided && String(payment.paymentMode || payment.payment_mode || '').toLowerCase() === 'cash'
  })
  if (cashPayments.length === 0) return sale

  const tendered = cashPayments.reduce((sum, payment) => {
    return sum + Number(payment.totalAmount ?? payment.total_amount ?? payment.amount ?? 0)
  }, 0)
  const applied = cashPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  return {
    ...sale,
    cashCollected: sale.cashCollected ?? roundCurrency(tendered),
    cashChange: sale.cashChange ?? roundCurrency(Math.max(0, tendered - applied)),
  }
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100
}

function calculatePrintedInvoiceTotal(sale) {
  return calcInvoiceSummary(sale?.items || [], sale).total
}

export async function prepareInvoicePayload(sale, branch, { documentType = 'Tax Invoice', fetchSale = true } = {}) {
  if (typeof window === 'undefined') return null
  const authToken = window.localStorage.getItem('retailos_token')
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

  let fullSale = sale
  try {
    const isPurchaseOrder = documentType === 'Purchase Order'
    const isPurchaseBill = documentType === 'Purchase Bill'
    const isGrnReceipt = documentType === 'GRN Receipt'
    const isPurchaseDocument = isPurchaseOrder || isPurchaseBill || isGrnReceipt
    const paymentMode = String(sale?.paymentMode || sale?.payment_mode || '').toLowerCase()
    const needsCashPaymentDetails = paymentMode === 'cash' && sale?.cashCollected == null
    const needsPurchaseOrderFetch = sale?.id && (!Array.isArray(sale?.items) || sale.items.length === 0)
    const needsInvoiceFetch = !sale || (sale?.id && (
      needsCashPaymentDetails || (!sale.customerPhone && !sale.customer_phone) || !sale.salesperson || !sale.email || !sale.phoneNo ||
      !sale.orderNo || !sale.purchaseOrderNo || (!sale.gstNo && !sale.gst_no && !sale.gst)
    ))
    const needsFetch = fetchSale && (isPurchaseDocument ? needsPurchaseOrderFetch : needsInvoiceFetch)
    if (needsFetch && sale?.id) {
      const endpoint = isPurchaseOrder
        ? `/api/v1/purchases/orders/${sale.id}`
        : isPurchaseBill
          ? `/api/v1/purchases/${sale.id}`
          : isGrnReceipt ? `/api/v1/purchases/grns/${sale.id}` : `/api/v1/sales/${sale.id}`
      const res = await fetch(endpoint, { headers: { Accept: 'application/json', ...authHeaders } })
      if (res.ok) {
        const fetchedSale = await res.json()
        fullSale = isPurchaseDocument
          ? { ...sale, ...fetchedSale }
          : withCashTender({
            ...fetchedSale,
            cashCollected: sale.cashCollected ?? fetchedSale.cashCollected,
            cashChange: sale.cashChange ?? fetchedSale.cashChange,
          })
      }
    }
  } catch (e) { /* ignore */ }

  fullSale = withCashTender(fullSale)
  if (['Purchase Order', 'Purchase Bill', 'GRN Receipt'].includes(documentType)) {
    fullSale = {
      ...fullSale,
      customerName: fullSale?.vendorName || '',
      salesperson: fullSale?.createdBy || '',
      items: (fullSale?.items || []).map((item) => ({
        ...item,
        qty: documentType === 'GRN Receipt' ? item.receivedQty ?? item.qty ?? item.orderedQty ?? 0 : item.qty,
        price: item.cost ?? item.price,
        taxRate: item.taxRate ?? item.tax_rate ?? 0,
      })),
    }
  }

  // fetch organisation as fallback
  let org = null
  try {
    const r = await fetch('/api/v1/settings/organisation', { headers: { Accept: 'application/json', ...authHeaders } })
    if (r.ok) org = await r.json()
  } catch (e) { /* ignore */ }

  const branchMerged = { ...(branch || {}) }
  const counterAddress = childCounterInvoiceAddress(branchMerged, fullSale)
  if (documentType === 'Tax Invoice' && counterAddress !== null) {
    branchMerged.invoiceAddressUsesCounter = true
    branchMerged.invoiceAddressLines = counterAddress
  }
  if (org) {
    branchMerged.gstin = branchMerged.gstin || org.gstin || org.gstin
    branchMerged.website = branchMerged.website || org.website
    branchMerged.homePage = branchMerged.homePage || org.website || org.homePage
    branchMerged.email = branchMerged.email || org.email
    branchMerged.phone = branchMerged.phone || org.phone || ''
  }

  const totalInWords = Array.isArray(fullSale?.items) && fullSale.items.length > 0
    ? amountToWords(calcInvoiceSummary(fullSale.items, fullSale).total)
    : fullSale?.totalInWords || amountToWords(fullSale?.total)
  const saleToSend = {
    ...fullSale,
    salesperson: fullSale?.salesperson || fullSale?.cashier || fullSale?.cashierName || fullSale?.salesperson_name || fullSale?.salesPerson || fullSale?.createdBy || fullSale?.created_by || '',
    customerPhone: fullSale?.customerPhone || fullSale?.customer_phone || '',
    phoneNo: fullSale?.phoneNo || fullSale?.phone_no || branchMerged?.phone || branchMerged?.tel || org?.phone || '',
    email: fullSale?.email || branchMerged?.email || org?.email || '',
    totalInWords,
  }

  branchMerged.gstin = branchMerged.gstin || branchMerged.gst || branchMerged.gstNo || branchMerged.gst_no || ''
  branchMerged.gst = branchMerged.gst || branchMerged.gstin || ''
  branchMerged.gstNo = branchMerged.gstNo || branchMerged.gst || branchMerged.gstin || ''
  branchMerged.gst_no = branchMerged.gst_no || branchMerged.gstin || ''
  branchMerged.website = branchMerged.website || branchMerged.homepage || ''
  branchMerged.homePage = branchMerged.homePage || branchMerged.homepage || branchMerged.website || ''
  branchMerged.email = branchMerged.email || branchMerged.emailAddress || branchMerged.email_address || ''
  branchMerged.phone = branchMerged.phone || branchMerged.tel || branchMerged.phoneNo || branchMerged.phone_no || ''

  const payload = { sale: saleToSend, branch: branchMerged, documentType, printedAt: new Date().toISOString() }
  return payload
}

async function openDocumentPrintWindow(sale, branch, documentType, fetchSale) {
  if (typeof window === 'undefined') return
  const win = window.open('/invoice-cosmo.html', '_blank')
  const payload = await prepareInvoicePayload(sale, branch, { documentType, fetchSale })
  if (!payload) return

  const sendPayload = () => {
    try {
      if (!win || win.closed) return false
      win.postMessage({ type: 'renderInvoice', payload }, window.location.origin)
      return true
    } catch (e) {
      return false
    }
  }

  const interval = setInterval(() => {
    if (!win || win.closed) { clearInterval(interval); return }
    if (sendPayload()) { clearInterval(interval) }
  }, 200)

  if (win) {
    win.addEventListener('load', () => {
      sendPayload()
      clearInterval(interval)
    })
  }

  setTimeout(() => { try { win.focus() } catch (e) {} }, 500)
}

export function openInvoicePrintWindow(sale, branch) {
  return openDocumentPrintWindow(sale, branch, 'Tax Invoice', true)
}

export function openSalesOrderPrintWindow(order, branch) {
  return openDocumentPrintWindow(order, branch, 'Sales Order', false)
}

export function openPurchaseOrderPrintWindow(order, branch) {
  return openDocumentPrintWindow(order, branch, 'Purchase Order', true)
}

export function openPurchaseBillPrintWindow(bill, branch) {
  return openDocumentPrintWindow(bill, branch, 'Purchase Bill', true)
}

export function openGrnPrintWindow(grn, branch) {
  return openDocumentPrintWindow(grn, branch, 'GRN Receipt', true)
}

export async function prepareQuotePayload(quote, branch) {
  if (typeof window === 'undefined') return
  const authToken = window.localStorage.getItem('retailos_token')
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

  let fullQuote = quote
  try {
    const missingCustomerAddress = !quote?.customerAddress && !quote?.customer_address && !quote?.customerStreet1 && !quote?.customer_street1 && !quote?.customerCity && !quote?.customer_country
    const needsFetch = !quote || (quote?.id && (missingCustomerAddress || (!quote.customerPhone && !quote.customer_phone) || !quote.customerName || !quote.total || !quote.items || !quote.items.length))
    if (needsFetch && quote?.id) {
      const res = await fetch(`/api/v1/sales/quotations/${quote.id}`, { headers: { Accept: 'application/json', ...authHeaders } })
      if (res.ok) fullQuote = await res.json()
    }
  } catch (e) { /* ignore */ }

  let org = null
  try {
    const r = await fetch('/api/v1/settings/organisation', { headers: { Accept: 'application/json', ...authHeaders } })
    if (r.ok) org = await r.json()
  } catch (e) { /* ignore */ }

  const branchMerged = { ...(branch || {}) }
  if (org) {
    branchMerged.gstin = branchMerged.gstin || org.gstin || org.gstin
    branchMerged.website = branchMerged.website || org.website
    branchMerged.homePage = branchMerged.homePage || org.website || org.homePage
    branchMerged.email = branchMerged.email || org.email
    branchMerged.phone = branchMerged.phone || org.phone || ''
  }

  const quoteToSend = {
    ...fullQuote,
    salesperson: fullQuote?.salesperson || fullQuote?.createdBy || fullQuote?.created_by || '',
    customerPhone: fullQuote?.customerPhone || fullQuote?.customer_phone || '',
    phoneNo: fullQuote?.phoneNo || fullQuote?.phone_no || branchMerged?.phone || branchMerged?.tel || org?.phone || '',
    email: fullQuote?.email || branchMerged?.email || org?.email || '',
    totalInWords: fullQuote?.totalInWords || ''
  }

  branchMerged.gstin = branchMerged.gstin || branchMerged.gst || branchMerged.gstNo || branchMerged.gst_no || ''
  branchMerged.gst = branchMerged.gst || branchMerged.gstin || ''
  branchMerged.gstNo = branchMerged.gstNo || branchMerged.gst || branchMerged.gstin || ''
  branchMerged.gst_no = branchMerged.gst_no || branchMerged.gstin || ''
  branchMerged.website = branchMerged.website || branchMerged.homepage || branchMerged.website || ''
  branchMerged.homePage = branchMerged.homePage || branchMerged.homepage || branchMerged.website || ''
  branchMerged.email = branchMerged.email || branchMerged.emailAddress || branchMerged.email_address || ''
  branchMerged.phone = branchMerged.phone || branchMerged.tel || branchMerged.phoneNo || branchMerged.phone_no || ''

  return { quote: quoteToSend, branch: branchMerged, printedAt: new Date().toISOString() }
}

export async function openQuotePrintWindow(quote, branch) {
  if (typeof window === 'undefined') return
  const payload = await prepareQuotePayload(quote, branch)
  if (!payload) return
  const fullQuote = payload.quote
  const quoteId = fullQuote?.id ?? quote?.id
  const printUrl = quoteId ? `/quote-cosmo.html?quote_id=${encodeURIComponent(String(quoteId))}` : '/quote-cosmo.html'

  const win = window.open(printUrl, '_blank')
  const sendPayload = () => {
    try {
      if (!win || win.closed) return false
      win.postMessage({ type: 'renderQuote', payload }, window.location.origin)
      return true
    } catch (e) {
      return false
    }
  }

  const interval = setInterval(() => {
    if (!win || win.closed) { clearInterval(interval); return }
    if (sendPayload()) { clearInterval(interval) }
  }, 200)

  if (win) {
    win.addEventListener('load', () => {
      sendPayload()
      clearInterval(interval)
    })
  }

  setTimeout(() => { try { win.focus() } catch (e) {} }, 500)
}

export default openInvoicePrintWindow

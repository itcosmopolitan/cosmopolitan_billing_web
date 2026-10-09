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

const ORG_CACHE_TTL_MS = 5 * 60 * 1000
let orgCache = { promise: null, key: null, at: 0 }

export function clearOrganisationCache() {
  orgCache = { promise: null, key: null, at: 0 }
}

export function loadOrganisation(authHeaders) {
  const key = authHeaders?.Authorization || ''
  const now = Date.now()
  if (orgCache.promise && orgCache.key === key && now - orgCache.at < ORG_CACHE_TTL_MS) return orgCache.promise

  const promise = fetch('/api/v1/settings/organisation', { headers: { Accept: 'application/json', ...authHeaders } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((org) => {
      if (!org && orgCache.promise === promise) clearOrganisationCache()
      return org
    })
  orgCache = { promise, key, at: now }
  return promise
}

function calculatePrintedInvoiceTotal(sale) {
  return calcInvoiceSummary(sale?.items || [], sale).total
}

export async function prepareInvoicePayload(sale, branch, { documentType = 'Tax Invoice', fetchSale = true } = {}) {
  if (typeof window === 'undefined') return null
  const authToken = window.localStorage.getItem('retailos_token')
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

  const orgPromise = loadOrganisation(authHeaders)

  let fullSale = sale
  let detailsFailed = false
  try {
    const isPurchaseOrder = documentType === 'Purchase Order'
    const isPurchaseBill = documentType === 'Purchase Bill'
    const isGrnReceipt = documentType === 'GRN Receipt'
    const isPurchaseDocument = isPurchaseOrder || isPurchaseBill || isGrnReceipt
    const isSalesOrder = documentType === 'Sales Order'
    const paymentMode = String(sale?.paymentMode || sale?.payment_mode || '').toLowerCase()
    const needsCashPaymentDetails = paymentMode === 'cash' && sale?.cashCollected == null
    const needsPurchaseOrderFetch = sale?.id && (!Array.isArray(sale?.items) || sale.items.length === 0)
    // List rows carry no line items, so the detail fetch here is the only sale load.
    const needsInvoiceFetch = !sale || (sale?.id && (
      needsCashPaymentDetails || !sale.items?.length || (!sale.customerPhone && !sale.customer_phone) || !sale.salesperson || !sale.email || !sale.phoneNo ||
      !sale.orderNo || !sale.purchaseOrderNo || (!sale.gstNo && !sale.gst_no && !sale.gst)
    ))
    const needsFetch = fetchSale && (isPurchaseDocument ? needsPurchaseOrderFetch : needsInvoiceFetch)
    if (needsFetch && sale?.id) {
      const endpoint = isPurchaseOrder
        ? `/api/v1/purchases/orders/${sale.id}`
        : isPurchaseBill
          ? `/api/v1/purchases/${sale.id}`
          : isGrnReceipt
            ? `/api/v1/purchases/grns/${sale.id}`
            : isSalesOrder ? `/api/v1/sales/orders/${sale.id}` : `/api/v1/sales/${sale.id}`
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
      } else {
        detailsFailed = true
      }
    }
  } catch (e) {
    detailsFailed = true
  }
  if (detailsFailed && !fullSale?.items?.length) {
    throw new Error('Could not load the document details. Please try again.')
  }

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

  // fetch organisation as fallback (started above, in parallel with the sale fetch)
  const org = await orgPromise

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

export async function prepareStockTransferPayload(transfer, branch = {}) {
  if (typeof window === 'undefined') return null
  if (!transfer?.id) throw new Error('A stock transfer ID is required to print the transfer.')

  const authToken = window.localStorage.getItem('retailos_token')
  const headers = { Accept: 'application/json' }
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  const response = await fetch(`/api/v1/transfers/${encodeURIComponent(transfer.id)}`, { headers })
  if (!response.ok) {
    throw new Error(`Failed to load stock transfer (${response.status}).`)
  }

  const fullTransfer = { ...transfer, ...(await response.json()) }
  const sale = {
    ...fullTransfer,
    number: fullTransfer.ref_number || fullTransfer.number || '',
    date: fullTransfer.request_date || fullTransfer.created_at || '',
    items: (fullTransfer.items || []).map((item) => ({
      ...item,
      name: item.name || item.item_name || '',
      packing: item.packing || item.packaging || '',
      unit: item.unit || item.units || '',
      qty: item.qty ?? item.quantity ?? 0,
    })),
  }

  return { sale, branch: branch || {}, documentType: 'Stock Transfer' }
}

export async function prepareQuotePayload(quote, branch) {
  if (typeof window === 'undefined') return
  const authToken = window.localStorage.getItem('retailos_token')
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

  const orgPromise = loadOrganisation(authHeaders)

  let fullQuote = quote
  let detailsFailed = false
  try {
    const missingCustomerAddress = !quote?.customerAddress && !quote?.customer_address && !quote?.customerStreet1 && !quote?.customer_street1 && !quote?.customerCity && !quote?.customer_country
    const needsFetch = !quote || (quote?.id && (missingCustomerAddress || (!quote.customerPhone && !quote.customer_phone) || !quote.customerName || !quote.total || !quote.items || !quote.items.length))
    if (needsFetch && quote?.id) {
      const res = await fetch(`/api/v1/sales/quotations/${quote.id}`, { headers: { Accept: 'application/json', ...authHeaders } })
      if (res.ok) fullQuote = await res.json()
      else detailsFailed = true
    }
  } catch (e) {
    detailsFailed = true
  }
  if (detailsFailed && !fullQuote?.items?.length) {
    throw new Error('Could not load the document details. Please try again.')
  }

  const org = await orgPromise

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

export function prepareDocumentPayload(documentType, document, branch) {
  return documentType === 'Quote'
    ? prepareQuotePayload(document, branch)
    : prepareInvoicePayload(document, branch, { documentType })
}

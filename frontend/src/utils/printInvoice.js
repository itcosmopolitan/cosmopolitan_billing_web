export async function openInvoicePrintWindow(sale, branch) {
  if (typeof window === 'undefined') return
  const authToken = window.localStorage.getItem('retailos_token')
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

  let fullSale = sale
  try {
    const needsFetch = !sale || (sale?.id && (!sale.salesperson || !sale.email || !sale.phoneNo || !sale.orderNo || !sale.purchaseOrderNo || (!sale.gstNo && !sale.gst_no && !sale.gst)))
    if (needsFetch && sale?.id) {
      const res = await fetch(`/api/v1/sales/${sale.id}`, { headers: { Accept: 'application/json', ...authHeaders } })
      if (res.ok) fullSale = await res.json()
    }
  } catch (e) { /* ignore */ }

  // fetch organisation as fallback
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

  const totalInWords = ''
  const saleToSend = {
    ...fullSale,
    salesperson: fullSale?.salesperson || fullSale?.cashier || fullSale?.cashierName || fullSale?.salesperson_name || fullSale?.salesPerson || '',
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

  const payload = { sale: saleToSend, branch: branchMerged, printedAt: new Date().toISOString() }
  const invoiceId = fullSale?.id ?? sale?.id ?? sale?.invoice_id ?? sale?.invoiceId
  const printUrl = invoiceId ? `/invoice-cosmo.html?invoice_id=${encodeURIComponent(String(invoiceId))}` : '/invoice-cosmo.html'

  const win = window.open(printUrl, '_blank')
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

export async function openQuotePrintWindow(quote, branch) {
  if (typeof window === 'undefined') return
  const authToken = window.localStorage.getItem('retailos_token')
  const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

  let fullQuote = quote
  try {
    const missingCustomerAddress = !quote?.customerAddress && !quote?.customer_address && !quote?.customerStreet1 && !quote?.customer_street1 && !quote?.customerCity && !quote?.customer_country
    const needsFetch = !quote || (quote?.id && (missingCustomerAddress || !quote.customerName || !quote.total || !quote.items || !quote.items.length))
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

  const payload = { quote: quoteToSend, branch: branchMerged, printedAt: new Date().toISOString() }
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

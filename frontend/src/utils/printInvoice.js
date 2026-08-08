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

  const win = window.open('/invoice-cosmo.html', '_blank')
  const interval = setInterval(() => {
    try {
      if (!win || win.closed) { clearInterval(interval); return }
      win.postMessage({ type: 'renderInvoice', payload }, '*')
      clearInterval(interval)
    } catch (e) {
      // retry
    }
  }, 200)
  setTimeout(() => { try { win.focus() } catch (e) {} }, 500)
}

export default openInvoicePrintWindow

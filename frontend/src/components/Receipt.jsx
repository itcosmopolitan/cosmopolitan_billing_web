import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { fmtDate } from '@/utils/helpers'
import { getColumnDefinitions, getColumnStructure, useInvoiceConfig } from '@/utils/invoiceConfig'
import { ThermalReceipt } from '@/components/ThermalReceipt'
import { prepareDocumentPayload } from '@/utils/printInvoice'
import { downloadDocumentPdf, downloadElementPdf, printDocumentPdf, warmDocumentPdf } from '@/utils/documentPdf'
import { settingsAPI } from '@/api'
import { formatSettlementLabel } from '@/utils/storeCredit'
import { calcInvoiceSummary, lineTaxableFromInclusive } from '@/utils/taxCalc'

// ─── Invoice Print Component ────────────────────────────────────────────────
export const Receipt = forwardRef(function Receipt({ sale, branch, documentType = 'Tax Invoice' }, forwardedRef) {
  const ref = useRef(null)
  const standardPreviewRef = useRef(null)
  const thermalRef = useRef(null)
  const [invoiceFormat, setInvoiceFormat] = useState('standard') // 'standard' or 'thermal'
  const [pdfBusy, setPdfBusy] = useState(null) // 'export' | 'print' | null
  const [orgProfile, setOrgProfile] = useState(null)
  const config = useInvoiceConfig()
  const columns = getColumnDefinitions(config)

  useEffect(() => {
    let active = true
    settingsAPI.getOrganisation()
      .then((res) => {
        const data = res?.data ?? res
        if (active) setOrgProfile(data)
      })
      .catch(() => {
        if (active) setOrgProfile(null)
      })
    return () => {
      active = false
    }
  }, [])

  const mergedBranch = useMemo(() => {
    const base = { ...(branch || {}) }
    const org = orgProfile || {}

    base.gstin = base.gstin || base.gst || base.gstNo || base.gst_no || org.gstin || ''
    base.gst = base.gst || base.gstin || org.gstin || ''
    base.gstNo = base.gstNo || base.gst || base.gstin || org.gstin || ''
    base.gst_no = base.gst_no || base.gstin || org.gstin || ''

    base.website = base.website || base.homepage || base.homePage || org.website || ''
    base.homePage = base.homePage || base.homepage || base.website || org.website || org.homePage || ''
    base.email = base.email || base.emailAddress || base.email_address || org.email || ''
    base.phone = base.phone || base.tel || base.phoneNo || base.phone_no || org.phone || ''

    return base
  }, [branch, orgProfile])

  useEffect(() => {
    const frame = standardPreviewRef.current
    if (!frame || !sale) return undefined

    let active = true
    let frameLoaded = frame.contentDocument?.readyState === 'complete'
    let payload = null
    const isQuote = documentType === 'Quote'

    const sendPayload = () => {
      if (!active || !frameLoaded || !payload || !frame.contentWindow) return
      frame.contentWindow.postMessage({ type: isQuote ? 'renderQuote' : 'renderInvoice', payload }, window.location.origin)
    }
    const handleLoad = () => {
      frameLoaded = true
      sendPayload()
    }
    const handleMessage = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return
      if (event.data?.type !== (isQuote ? 'quoteRendered' : 'invoiceRendered')) return
      frame.style.height = `${Math.max(900, Number(event.data.height) || 0)}px`
    }

    frame.addEventListener('load', handleLoad)
    window.addEventListener('message', handleMessage)
    prepareDocumentPayload(documentType, sale, branch)
      .then((preparedPayload) => {
        if (!active) return
        payload = preparedPayload
        sendPayload()
      })
      .catch((error) => {
        console.error('Failed to prepare invoice preview:', error)
      })

    return () => {
      active = false
      frame.removeEventListener('load', handleLoad)
      window.removeEventListener('message', handleMessage)
    }
  }, [sale, branch, documentType])

  const shareWhatsApp = () => {
    const summary = calcInvoiceSummary(sale.items || [], sale)
    const items = (sale.items || []).map((item) => {
      const net = lineTaxableFromInclusive(item)
      return `• ${item.name} x${item.qty} = MVR${net}`
    }).join('\n')
    const msg = `*Cosmopolitan — ${branch?.name}*\n` +
      `Invoice: *${sale.number}*\n` +
      `Date: ${fmtDate(sale.date || new Date())}\n` +
      `─────────────────\n${items}\n` +
      `─────────────────\n` +
      `Subtotal: MVR${summary.subtotal.toLocaleString('en-MV')}\n` +
      (summary.discountAmount ? `Discount: -MVR${summary.discountAmount.toLocaleString('en-MV')}\n` : '') +
      `GST: MVR${summary.taxTotal.toLocaleString('en-MV')}\n` +
      `*TOTAL: MVR${summary.total.toLocaleString('en-MV')}*\n` +
      `Payment: ${formatSettlementLabel({
        paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
        storeCreditApplied: sale.storeCreditApplied,
        payments: sale.payments,
      })}\n` +
      (Number(sale.storeCreditApplied || 0) > 0
        ? `Account credit: MVR${Number(sale.storeCreditApplied).toLocaleString('en-MV')}\n`
        : '') +
      (sale.cashCollected != null && Number(sale.cashCollected) > 0
        ? `Cash collected: MVR${Number(sale.cashCollected).toLocaleString('en-MV')}\nChange: MVR${Number(sale.cashChange || 0).toLocaleString('en-MV')}\n`
        : '') +
      `\nThank you for your purchase! 🙏`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  const buildPdfPayload = () => prepareDocumentPayload(documentType, sale, branch)

  const runPdfJob = async (kind, job) => {
    setPdfBusy(kind)
    try {
      await job()
      return true
    } catch (error) {
      console.error(`Failed to ${kind} PDF:`, error)
      toast.error(error?.message || `Could not ${kind} this document.`)
      return false
    } finally {
      setPdfBusy(null)
    }
  }

  const handlePrint = () => {
    if (invoiceFormat === 'thermal') {
      thermalRef.current?.print()
      return
    }
    if (pdfBusy) return
    warmDocumentPdf(documentType, branch)
    runPdfJob('print', async () => printDocumentPdf(documentType, await buildPdfPayload()))
  }

  const exportPdf = async () => {
    if (!sale || pdfBusy) return false
    if (invoiceFormat !== 'thermal') warmDocumentPdf(documentType, branch)
    return runPdfJob('export', async () => {
      if (invoiceFormat === 'thermal') {
        await downloadElementPdf(ref.current, documentType, { sale })
        return
      }
      await downloadDocumentPdf(documentType, await buildPdfPayload())
    })
  }

  useImperativeHandle(forwardedRef, () => ({ exportPdf }))

  if (!sale) return null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 16 }}>
        <div className="tabs-bar" role="tablist" style={{ marginBottom: 0, justifySelf: 'start', maxWidth: '100%', minWidth: 0 }}>
          <button
            className={`tab-btn ${invoiceFormat === 'standard' ? 'active' : ''}`}
            role="tab"
            aria-selected={invoiceFormat === 'standard'}
            onClick={() => setInvoiceFormat('standard')}
          >
            📄 Standard Format
          </button>
          <button
            className={`tab-btn ${invoiceFormat === 'thermal' ? 'active' : ''}`}
            role="tab"
            aria-selected={invoiceFormat === 'thermal'} 
            onClick={() => setInvoiceFormat('thermal')}
          >
            🖨 Thermal Receipt
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <button className="btn btn-secondary" onClick={exportPdf} disabled={pdfBusy !== null} style={{ flexShrink: 0 }}>{pdfBusy === 'export' ? 'Generating PDF…' : '📤 Export'}</button>
          <button className="btn btn-primary" onClick={handlePrint} disabled={pdfBusy !== null} style={{ flexShrink: 0 }}>{pdfBusy === 'print' ? 'Preparing PDF…' : '🖨 Print'}</button>
        </div>
      </div>

      <div ref={ref} style={{
        background: '#fff',
        padding: 0,
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        maxWidth: invoiceFormat === 'thermal' ? 420 : 920,
        margin: '0 auto',
      }}>
        <iframe
          ref={standardPreviewRef}
          title={documentType === 'Quote' ? 'Quote preview' : 'Standard invoice preview'}
          src={documentType === 'Quote' ? '/document-templates/quotation.html' : '/document-templates/invoice.html'}
          style={{
            width: '100%',
            height: 900,
            display: invoiceFormat === 'standard' ? 'block' : 'none',
            border: 0,
          }}
        />
        {invoiceFormat === 'thermal' ? (
          <ThermalReceipt ref={thermalRef} sale={sale} branch={mergedBranch} />
        ) : null}
      </div>

    </div>
  )
})

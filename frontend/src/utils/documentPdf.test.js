// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportsAPI } from '@/api'
import {
  PAGE_PRESETS,
  buildFileName,
  downloadDocumentPdf,
  downloadInvoiceListPdf,
  downloadListPdf,
  printDocumentPdf,
  requestDocumentPdf,
  safePdfName,
  warmDocumentPdf,
} from './documentPdf'

vi.mock('@/api', () => ({
  reportsAPI: {
    createPdfExport: vi.fn(),
    getPdfExport: vi.fn(),
    downloadPdfExport: vi.fn(),
  },
}))

const pdfBlob = () => new Blob(['%PDF-1.4 test'], { type: 'application/pdf' })

function jsonError(status, detail) {
  return new Response(JSON.stringify({ detail }), { status, headers: { 'Content-Type': 'application/json' } })
}

function lastRequestBody(fetchMock) {
  const [, init] = fetchMock.mock.calls.at(-1)
  return JSON.parse(init.body)
}

const TEMPLATE_HTML = '<!doctype html><html><head></head><body></body></html>'
const PDF_ENDPOINT_URL = '/api/v1/documents/invoice-pdf'

// Routes the template and brand-image loads, so each test only controls the PDF replies.
function mockFetch(pdfReplies = []) {
  const queue = [...pdfReplies]
  return vi.fn(async (url) => {
    if (url === PDF_ENDPOINT_URL) return queue.shift() ?? new Response(pdfBlob(), { status: 200 })
    if (url.includes('/document-templates/')) return new Response(TEMPLATE_HTML, { status: 200 })
    // A jsdom Blob is needed here: FileReader stringifies Blobs created by Node's Response.
    return { ok: true, status: 200, blob: async () => new Blob(['png'], { type: 'image/png' }) }
  })
}

// Drives the hidden render iframe the way the real template would: wait for the iframe
// to be attached, fire its load event, write the rendered markup, then send the ready message.
async function completeRender(readyType, markup) {
  await vi.waitFor(() => {
    if (!document.querySelector('iframe[aria-hidden="true"]')) throw new Error('render frame not attached')
  })
  const frame = document.querySelector('iframe[aria-hidden="true"]')
  const doc = frame.contentDocument
  doc.open()
  doc.write(`<!doctype html><html><body>${markup}</body></html>`)
  doc.close()
  frame.dispatchEvent(new Event('load'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: readyType },
    origin: window.location.origin,
    source: frame.contentWindow,
  }))
}

describe('PAGE_PRESETS', () => {
  it('defines A5 at 8mm for print and A4 at 12mm for export', () => {
    expect(PAGE_PRESETS).toEqual({
      print: { size: 'A5', margin_mm: 8 },
      export: { size: 'A4', margin_mm: 12 },
    })
  })
})

describe('file names', () => {
  it('replaces unsafe characters and adds the pdf extension once', () => {
    expect(safePdfName('Tax Invoice/INV 0001')).toBe('Tax_Invoice_INV_0001.pdf')
    expect(safePdfName('Quote.PDF')).toBe('Quote.PDF')
    expect(safePdfName('   ')).toBe('Document.pdf')
  })

  it('keeps non-Latin letters and marks in names', () => {
    expect(safePdfName('ޢަލީ Ali-INV-1')).toBe('ޢަލީ_Ali-INV-1.pdf')
    expect(safePdfName('Café-INV-1')).toBe('Café-INV-1.pdf')
  })

  it('builds names as customer name and number for sales and purchase documents', () => {
    expect(buildFileName('Tax Invoice', { sale: { customerName: 'Ali Hassan', number: 'INV-0001' } })).toBe('Ali_Hassan-INV-0001.pdf')
    expect(buildFileName('Quote', { quote: { customerName: 'Ali Hassan', number: 'QT-0001' } })).toBe('Ali_Hassan-QT-0001.pdf')
    expect(buildFileName('Sales Order', { sale: { customerName: 'Walk-in', number: 'SO-0002' } })).toBe('Walk-in-SO-0002.pdf')
    expect(buildFileName('Purchase Order', { sale: { customerName: 'Vendor Co', number: 'PO-0003' } })).toBe('Vendor_Co-PO-0003.pdf')
    expect(buildFileName('Purchase Bill', { sale: { customerName: 'Vendor Co', number: 'BILL-0004' } })).toBe('Vendor_Co-BILL-0004.pdf')
  })

  it('caps the customer part so long names stay within the server limit', () => {
    const name = buildFileName('Tax Invoice', { sale: { customerName: 'A'.repeat(300), number: 'INV-0001' } })
    expect(name).toBe(`${'A'.repeat(100)}-INV-0001.pdf`)
  })

  it('falls back to the document type and number when there is no customer', () => {
    expect(buildFileName('Tax Invoice', { sale: { number: 'INV-0001' } })).toBe('Tax_Invoice_INV-0001.pdf')
    expect(buildFileName('Stock Transfer', { sale: { number: 'TR-0005' } })).toBe('Stock_Transfer_TR-0005.pdf')
    expect(buildFileName('Purchase Bill', {})).toBe('Purchase_Bill.pdf')
  })
})

describe('requestDocumentPdf', () => {
  let fetchMock

  beforeEach(() => {
    fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts only html, file name and mode, so the client cannot pick size or margins', async () => {
    await requestDocumentPdf({ html: '<p>x</p>', fileName: 'a.pdf', mode: 'print' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/documents/invoice-pdf')
    expect(init.method).toBe('POST')
    expect(lastRequestBody(fetchMock)).toEqual({ html: '<p>x</p>', file_name: 'a.pdf', mode: 'print' })
  })

  it('rejects an unknown mode before making a request', async () => {
    await expect(requestDocumentPdf({ html: '', fileName: 'a.pdf', mode: 'A3' })).rejects.toThrow('Unknown PDF mode')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces the server detail message on failure', async () => {
    fetchMock = mockFetch([jsonError(413, 'PDF request is too large.')])
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestDocumentPdf({ html: 'x', fileName: 'a.pdf', mode: 'export' }))
      .rejects.toThrow('PDF request is too large.')
  })
})

describe('downloadDocumentPdf', () => {
  let fetchMock
  let clicks

  beforeEach(() => {
    clicks = []
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicks.push(this.download)
    })
    fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the shared template, requests an export PDF and downloads it', async () => {
    const job = downloadDocumentPdf('Tax Invoice', { sale: { number: 'INV-0001' }, branch: {} })
    await completeRender('invoiceRendered', '<div class="page">Rice 25kg</div>')
    await job

    const body = lastRequestBody(fetchMock)
    expect(body.mode).toBe('export')
    expect(body.file_name).toBe('Tax_Invoice_INV-0001.pdf')
    expect(body.html).toContain('Rice 25kg')
    expect(clicks).toEqual(['Tax_Invoice_INV-0001.pdf'])
    expect(document.querySelector('iframe[aria-hidden="true"]')).toBeNull()
  })

  it('does not refetch the template or brand images on the next export', async () => {
    const first = downloadDocumentPdf('Tax Invoice', { sale: { number: 'INV-0001' }, branch: {} })
    await completeRender('invoiceRendered', '<div>One</div>')
    await first

    const before = fetchMock.mock.calls.length
    const second = downloadDocumentPdf('Tax Invoice', { sale: { number: 'INV-0002' }, branch: {} })
    await completeRender('invoiceRendered', '<div>Two</div>')
    await second

    const newUrls = fetchMock.mock.calls.slice(before).map(([url]) => url)
    expect(newUrls).toEqual([PDF_ENDPOINT_URL])
    expect(clicks).toEqual(['Tax_Invoice_INV-0001.pdf', 'Tax_Invoice_INV-0002.pdf'])
  })

  it('does not download anything when the server rejects the request', async () => {
    fetchMock = mockFetch([jsonError(504, 'PDF generation timed out.')])
    vi.stubGlobal('fetch', fetchMock)
    const job = downloadDocumentPdf('Quote', { quote: { number: 'QT-0001' } })
    await completeRender('quoteRendered', '<div>Quote</div>')

    await expect(job).rejects.toThrow('PDF generation timed out.')
    expect(clicks).toEqual([])
  })
})

describe('downloadListPdf', () => {
  let fetchMock
  let clicks

  beforeEach(() => {
    clicks = []
    reportsAPI.createPdfExport.mockReset()
    reportsAPI.getPdfExport.mockReset()
    reportsAPI.downloadPdfExport.mockReset()
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:async-export'),
      revokeObjectURL: vi.fn(),
    }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicks.push(this.download)
    })
    fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders branded HTML and submits it as a PDF export job', async () => {
    reportsAPI.createPdfExport.mockResolvedValue({
      job_id: 'pdf-job-1',
      status: 'completed',
      filename: 'Stock_Transfers_2026-10-19.pdf',
    })
    reportsAPI.downloadPdfExport.mockResolvedValue(pdfBlob())
    const job = downloadListPdf('Stock Transfers', ['Transfer #', 'Status'], [['TR-001', 'Received']], {})
    await vi.waitFor(() => {
      if (!document.querySelector('iframe[aria-hidden="true"]')) throw new Error('render frame not attached')
    })
    const frame = document.querySelector('iframe[aria-hidden="true"]')
    const post = vi.spyOn(frame.contentWindow, 'postMessage')
    await completeRender('invoiceRendered', '<table><tr><td>TR-001</td><td>Received</td></tr></table>')
    await job

    const renderMessage = post.mock.calls.find(([message]) => message?.type)?.[0]
    expect(renderMessage.payload.listExport).toMatchObject({
      title: 'Stock Transfers',
      columns: ['Transfer #', 'Status'],
      rows: [['TR-001', 'Received']],
    })
    const [request] = reportsAPI.createPdfExport.mock.calls[0]
    expect(request).toMatchObject({
      format: 'pdf',
      report_api: 'list_pdf',
      total_rows: 1,
      title: 'Stock Transfers',
      filename: expect.stringMatching(/^Stock_Transfers_\d{4}-\d{2}-\d{2}\.pdf$/),
      pdf_html: expect.stringContaining('TR-001'),
    })
    expect(reportsAPI.getPdfExport).not.toHaveBeenCalled()
    expect(reportsAPI.downloadPdfExport).toHaveBeenCalledWith('pdf-job-1')
    expect(clicks).toEqual(['Stock_Transfers_2026-10-19.pdf'])
  })

  it('submits invoice filters and column metadata without preloading invoice rows', async () => {
    reportsAPI.createPdfExport.mockResolvedValue({
      job_id: 'invoice-pdf-job',
      status: 'completed',
      filename: 'Invoices_2026-10-19.pdf',
    })
    reportsAPI.downloadPdfExport.mockResolvedValue(pdfBlob())
    const columns = [
      { key: 'number', label: 'Invoice Number' },
      { key: 'total', label: 'Amount (MVR)', format: 'currency' },
    ]
    const params = { branch_id: 'b1', search: 'INV', status: 'paid' }
    const job = downloadInvoiceListPdf('Invoices', columns, params, {})
    await completeRender('invoiceRendered', '<table><tbody data-list-export-rows></tbody></table>')
    await job

    const [request] = reportsAPI.createPdfExport.mock.calls[0]
    expect(request).toMatchObject({
      report_api: 'sales_invoices_pdf',
      format: 'pdf',
      params,
      columns,
      filename: expect.stringMatching(/^Invoices_\d{4}-\d{2}-\d{2}\.pdf$/),
    })
    expect(request.pdf_html).not.toContain('INV-')
    expect(request).not.toHaveProperty('total_rows')
  })
})

describe('warmDocumentPdf', () => {
  let fetchMock

  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('starts the branch logo load before the render, so the render needs no extra fetches', async () => {
    await warmDocumentPdf('Tax Invoice', { logo: '/uploads/warm-logo.png' })
    const warmedUrls = fetchMock.mock.calls.map(([url]) => url)
    expect(warmedUrls).toEqual(expect.arrayContaining([expect.stringContaining('/uploads/warm-logo.png')]))

    const before = fetchMock.mock.calls.length
    const job = downloadDocumentPdf('Tax Invoice', { sale: { number: 'INV-0003' }, branch: { logo: '/uploads/warm-logo.png' } })
    await completeRender('invoiceRendered', '<div>Warm</div>')
    await job

    const newUrls = fetchMock.mock.calls.slice(before).map(([url]) => url)
    expect(newUrls).toEqual([PDF_ENDPOINT_URL])
  })

  it('passes the branch logo to the template as a data URI', async () => {
    const job = downloadDocumentPdf('Tax Invoice', { sale: { number: 'INV-0004' }, branch: { logo: '/uploads/render-logo.png' } })
    await vi.waitFor(() => {
      if (!document.querySelector('iframe[aria-hidden="true"]')) throw new Error('render frame not attached')
    })
    const frame = document.querySelector('iframe[aria-hidden="true"]')
    const post = vi.spyOn(frame.contentWindow, 'postMessage')
    await completeRender('invoiceRendered', '<div>Logo</div>')
    await job

    const renderMessage = post.mock.calls.find(([message]) => message?.type)?.[0]
    expect(renderMessage.payload.branch.logo).toMatch(/^data:image\/png;base64,/)
  })
})

describe('printDocumentPdf', () => {
  let fetchMock

  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:print'),
      revokeObjectURL: vi.fn(),
    }))
    fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('requests a print PDF and loads that exact blob into a hidden frame', async () => {
    const job = printDocumentPdf('Sales Order', { sale: { number: 'SO-0002' }, branch: {} })
    await completeRender('invoiceRendered', '<div class="page">Order</div>')
    await vi.waitFor(() => {
      if (!document.querySelector('iframe[title="Document print"]')) throw new Error('print frame not attached')
    })
    const printFrame = document.querySelector('iframe[title="Document print"]')
    expect(printFrame.getAttribute('src')).toBe('blob:print')
    printFrame.dispatchEvent(new Event('load'))
    await job

    expect(lastRequestBody(fetchMock).mode).toBe('print')
  })
})

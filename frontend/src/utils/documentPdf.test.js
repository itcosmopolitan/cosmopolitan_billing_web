// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAGE_PRESETS,
  buildFileName,
  downloadDocumentPdf,
  printDocumentPdf,
  requestDocumentPdf,
  safePdfName,
} from './documentPdf'

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
    if (url.startsWith('/document-templates/')) return new Response(TEMPLATE_HTML, { status: 200 })
    return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 })
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

  it('builds names from the document type and number', () => {
    expect(buildFileName('Tax Invoice', { sale: { number: 'INV-0001' } })).toBe('Tax_Invoice_INV-0001.pdf')
    expect(buildFileName('Quote', { quote: { id: 'q-9' } })).toBe('Quote_q-9.pdf')
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

export const PDF_ENDPOINT = '/api/v1/documents/invoice-pdf'

// Mirrors PAGE_PRESETS in backend/src/pdf_renderer.py. The server owns paper size and margins;
// the client only sends `mode`.
export const PAGE_PRESETS = {
  print: { size: 'A5', margin_mm: 8 },
  export: { size: 'A4', margin_mm: 12 },
}

export const DOCUMENT_TYPES = {
  TAX_INVOICE: 'Tax Invoice',
  SALES_ORDER: 'Sales Order',
  QUOTATION: 'Quote',
  PURCHASE_ORDER: 'Purchase Order',
  PURCHASE_BILL: 'Purchase Bill',
  GRN_RECEIPT: 'GRN Receipt',
  STOCK_TRANSFER: 'Stock Transfer',
}

const TEMPLATES = {
  invoice: {
    url: '/document-templates/invoice.html',
    renderMessage: 'renderInvoice',
    renderedMessage: 'invoiceRendered',
  },
  quotation: {
    url: '/document-templates/quotation.html',
    renderMessage: 'renderQuote',
    renderedMessage: 'quoteRendered',
  },
}

const BRAND_ASSET_PATHS = {
  logo: '/assets/cosmopolitan-logo.png',
  seal: '/assets/gold-100-seal.png',
}

const RENDER_TIMEOUT_MS = 15000
const IMAGE_FETCH_TIMEOUT_MS = 10000
const PRINT_CLEANUP_DELAY_MS = 60000

const inFlight = new Map()

function templateKeyFor(documentType) {
  return documentType === DOCUMENT_TYPES.QUOTATION ? 'quotation' : 'invoice'
}

function documentNumber(data) {
  const source = data?.sale || data?.quote || {}
  return source.number || source.quote_no || source.invoiceNumber || source.invoice_no || source.ref_number || source.id || ''
}

export function safePdfName(fileName) {
  const raw = String(fileName || 'Document').trim()
  const base = raw
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Document'
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

export function buildFileName(documentType, data) {
  const prefix = String(documentType || 'Document').replace(/\s+/g, '_')
  const number = documentNumber(data)
  return safePdfName(number ? `${prefix}_${number}` : prefix)
}

function authHeaders() {
  try {
    const token = window.localStorage?.getItem('retailos_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (error) {
    return {}
  }
}

async function readErrorMessage(response) {
  const fallback = `PDF generation failed (${response.status})`
  try {
    const body = await response.json()
    if (typeof body?.detail === 'string') return body.detail
    if (Array.isArray(body?.detail) && body.detail[0]?.msg) return body.detail[0].msg
  } catch (error) {
    // Non-JSON error bodies fall back to the status-based message.
  }
  return fallback
}

export async function requestDocumentPdf({ html, fileName, mode }) {
  if (!PAGE_PRESETS[mode]) throw new Error(`Unknown PDF mode: ${mode}`)
  const response = await fetch(PDF_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/pdf',
      ...authHeaders(),
    },
    body: JSON.stringify({ html, file_name: fileName, mode }),
  })
  if (!response.ok) throw new Error(await readErrorMessage(response))
  return response.blob()
}

function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// Template text and brand images are static, so they are fetched once per page session.
// Failed loads are dropped from the cache so the next attempt can retry.
const memo = new Map()

function memoize(key, load) {
  if (!memo.has(key)) {
    memo.set(key, load().catch((error) => {
      memo.delete(key)
      throw error
    }))
  }
  return memo.get(key)
}

async function fetchOk(url, ms) {
  const response = await withTimeout(
    fetch(url, { credentials: 'same-origin' }),
    ms,
    `Request timed out: ${url}`,
  )
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`)
  return response
}

function loadTemplateText(template) {
  return memoize(`template:${template.url}`, async () => (await fetchOk(template.url, RENDER_TIMEOUT_MS)).text())
}

function loadImageDataUrl(src) {
  return memoize(`image:${src}`, async () => blobToDataUrl(await (await fetchOk(src, IMAGE_FETCH_TIMEOUT_MS)).blob()))
}

// Templates are passed these as data URIs so they render without any image requests.
// A missing asset falls back to the template's own default path.
async function loadBrandAssets() {
  const entries = await Promise.all(Object.entries(BRAND_ASSET_PATHS).map(async ([key, path]) => {
    try {
      return [key, await loadImageDataUrl(path)]
    } catch (error) {
      console.warn(`Brand image unavailable for PDF (${key}):`, error)
      return null
    }
  }))
  return Object.fromEntries(entries.filter(Boolean))
}

// Images must be data URIs: the server sanitizer drops every non-data image source.
async function inlineImages(doc) {
  const images = Array.from(doc.images)
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute('src') || ''
    if (!src || src.startsWith('data:')) return
    try {
      const response = await withTimeout(
        fetch(img.src, { credentials: 'same-origin' }),
        IMAGE_FETCH_TIMEOUT_MS,
        'Image fetch timed out',
      )
      if (!response.ok) throw new Error(`Image request failed (${response.status})`)
      img.setAttribute('src', await blobToDataUrl(await response.blob()))
    } catch (error) {
      console.warn('Skipping image in PDF:', src, error)
      if (img.id === 'goldSealImg') {
        const fallback = doc.getElementById('goldSealFallback')
        if (fallback) fallback.style.display = 'inline-block'
      }
      img.remove()
    }
  }))
}

function serializeDocument(doc) {
  doc.querySelectorAll('script').forEach((node) => node.remove())
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

// Renders the shared template off-screen, waits for the template to report it is ready,
// then returns the fully inlined HTML for the server.
// The template is loaded from a blob URL built from its text. A blob iframe keeps the page
// origin, which the template's postMessage checks need. The <base> tag makes relative
// URLs (API calls, default asset paths) resolve against the app origin, not the blob.
export async function renderDocumentHtml(documentType, data) {
  const templateKey = templateKeyFor(documentType)
  const template = TEMPLATES[templateKey]
  const [templateText, assets] = await Promise.all([loadTemplateText(template), loadBrandAssets()])
  const templateHtml = templateText.replace(/<head>/i, `<head><base href="${window.location.origin}/">`)
  const templateUrl = URL.createObjectURL(new Blob([templateHtml], { type: 'text/html' }))

  const frame = document.createElement('iframe')
  frame.title = `${documentType} render`
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1200px;border:0;'
  document.body.appendChild(frame)

  try {
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }))
    frame.src = templateUrl
    await withTimeout(loaded, RENDER_TIMEOUT_MS, `${documentType} template did not load.`)

    const frameWindow = frame.contentWindow
    const rendered = new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.source !== frameWindow || event.origin !== window.location.origin) return
        if (event.data?.type !== template.renderedMessage) return
        window.removeEventListener('message', onMessage)
        resolve()
      }
      window.addEventListener('message', onMessage)
    })
    const payload = templateKey === 'quotation'
      ? { quote: data.quote, branch: data.branch, assets }
      : { sale: data.sale, branch: data.branch, documentType, assets }
    frameWindow.postMessage({ type: template.renderMessage, payload }, window.location.origin)
    await withTimeout(rendered, RENDER_TIMEOUT_MS, `${documentType} template did not finish rendering.`)

    const doc = frame.contentDocument
    if (!doc?.documentElement) throw new Error('The document template is not available.')
    await inlineImages(doc)
    return serializeDocument(doc)
  } finally {
    frame.remove()
    URL.revokeObjectURL(templateUrl)
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function printPdfBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')
    frame.title = 'Document print'
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      frame.remove()
      URL.revokeObjectURL(url)
    }

    frame.addEventListener('load', () => {
      try {
        frame.contentWindow.focus()
        frame.contentWindow.print()
        setTimeout(cleanup, PRINT_CLEANUP_DELAY_MS)
        resolve()
      } catch (error) {
        cleanup()
        reject(new Error('Unable to open the print dialog for this PDF.'))
      }
    }, { once: true })

    frame.src = url
    document.body.appendChild(frame)
  })
}

// Concurrent calls for the same document and mode share one job, so a double click
// cannot start two renders.
function runOnce(key, job) {
  if (inFlight.has(key)) return inFlight.get(key)
  const promise = job().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

export function downloadDocumentPdf(documentType, data) {
  const fileName = buildFileName(documentType, data)
  return runOnce(`export:${fileName}`, async () => {
    const html = await renderDocumentHtml(documentType, data)
    const blob = await requestDocumentPdf({ html, fileName, mode: 'export' })
    downloadBlob(blob, fileName)
  })
}

// Thermal receipts are rendered by the app itself, so their live DOM is exported directly.
export function downloadElementPdf(element, documentType, data) {
  if (!element?.ownerDocument) throw new Error('A rendered document is required to export the PDF.')
  const fileName = buildFileName(documentType, data)
  return runOnce(`export:${fileName}`, async () => {
    const doc = new DOMParser().parseFromString(
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      'text/html',
    )
    doc.body.appendChild(doc.importNode(element, true))
    doc.querySelectorAll('iframe').forEach((node) => node.remove())
    await inlineImages(doc)
    const html = serializeDocument(doc)
    const blob = await requestDocumentPdf({ html, fileName, mode: 'export' })
    downloadBlob(blob, fileName)
  })
}

export function printDocumentPdf(documentType, data) {
  const fileName = buildFileName(documentType, data)
  return runOnce(`print:${fileName}`, async () => {
    const html = await renderDocumentHtml(documentType, data)
    const blob = await requestDocumentPdf({ html, fileName, mode: 'print' })
    await printPdfBlob(blob)
  })
}

export const INVOICE_PDF_ENDPOINT = '/api/v1/documents/invoice-pdf'

function safePdfName(fileName) {
  const raw = String(fileName || 'Tax_Invoice').trim()
  const base = raw.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Tax_Invoice'
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`
}

function serializeInvoiceDocument(element) {
  const doc = element?.ownerDocument
  if (!doc?.documentElement) {
    throw new Error('A rendered invoice document is required to export the PDF.')
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function exportInvoicePdf(element, fileName = 'Tax_Invoice') {
  if (!element || typeof element === 'string') {
    throw new Error('A DOM element is required to export the invoice PDF.')
  }

  const pdfName = safePdfName(fileName)
  let token = ''
  try {
    token = window.localStorage?.getItem('retailos_token') || ''
  } catch (error) {
    token = ''
  }
  const response = await fetch(INVOICE_PDF_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      html: serializeInvoiceDocument(element),
      file_name: pdfName,
    }),
  })

  if (!response.ok) {
    let message = `PDF export failed (${response.status})`
    try {
      const body = await response.json()
      message = body?.detail || message
    } catch (error) {
      // Keep the status-based message when the server returned non-JSON.
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  downloadBlob(blob, pdfName)
}

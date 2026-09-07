import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'

export const MAX_INVOICE_PDF_BYTES = 2 * 1024 * 1024

function buildPdf(canvas, imageQuality) {
  const imgData = canvas.toDataURL('image/jpeg', imageQuality)
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    compress: true,
  })

  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 24
  const availableWidth = pageWidth - margin * 2
  const ratio = canvas.width / canvas.height
  const imageWidth = Math.min(availableWidth, pageWidth - margin * 2)
  const imageHeight = imageWidth / ratio
  const pageContentHeight = pageHeight - margin * 2
  let remainingHeight = imageHeight
  let offset = margin

  pdf.addImage(imgData, 'JPEG', margin, offset, imageWidth, imageHeight, undefined, 'MEDIUM')
  remainingHeight -= pageContentHeight

  while (remainingHeight > 0) {
    pdf.addPage()
    offset = margin - (pageContentHeight - remainingHeight)
    pdf.addImage(imgData, 'JPEG', margin, offset, imageWidth, imageHeight, undefined, 'MEDIUM')
    remainingHeight -= pageContentHeight
  }

  return pdf
}

export async function exportInvoicePdf(element, fileName = 'invoice') {
  if (!element || typeof element === 'string') {
    throw new Error('A DOM element is required to export the invoice PDF.')
  }

  let selectedPdf = null
  const scales = [1.5, 1]
  const qualities = [0.72, 0.55, 0.4]

  for (const scale of scales) {
    const canvas = await html2canvas(element, {
      backgroundColor: '#ffffff',
      scale,
      useCORS: true,
      allowTaint: true,
    })

    for (const quality of qualities) {
      const pdf = buildPdf(canvas, quality)
      // `output('blob')` is supported by jsPDF in the browser. Keep the
      // fallback for lightweight test doubles and older integrations.
      if (typeof pdf.output !== 'function') {
        selectedPdf = pdf
        break
      }
      const blob = pdf.output('blob')
      if (blob.size <= MAX_INVOICE_PDF_BYTES) {
        selectedPdf = pdf
        break
      }
    }
    if (selectedPdf) break
  }

  if (!selectedPdf) {
    throw new Error('The invoice PDF could not be compressed below 2 MB.')
  }

  const safeName = String(fileName).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]+/g, '') || 'invoice'
  selectedPdf.save(`${safeName}.pdf`)
}

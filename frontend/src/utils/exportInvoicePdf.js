import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'

export async function exportInvoicePdf(element, fileName = 'invoice') {
  if (!element || typeof element === 'string') {
    throw new Error('A DOM element is required to export the invoice PDF.')
  }

  const canvas = await html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    allowTaint: true,
  })

  const imgData = canvas.toDataURL('image/png')
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
  })

  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 24
  const availableWidth = pageWidth - margin * 2
  const ratio = canvas.width / canvas.height
  const imageWidth = Math.min(availableWidth, pageWidth - margin * 2)
  const imageHeight = imageWidth / ratio

  let remainingHeight = imageHeight
  let offset = margin

  pdf.addImage(imgData, 'PNG', margin, offset, imageWidth, imageHeight)
  remainingHeight -= pageHeight - margin * 2

  while (remainingHeight > 0) {
    pdf.addPage()
    offset = margin - (pageHeight - margin * 2 - remainingHeight)
    pdf.addImage(imgData, 'PNG', margin, offset, imageWidth, imageHeight)
    remainingHeight -= pageHeight - margin * 2
  }

  pdf.save(`${String(fileName).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]+/g, '') || 'invoice'}.pdf`)
}

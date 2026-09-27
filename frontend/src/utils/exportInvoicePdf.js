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

const A4_WIDTH_PX = (210 * 96) / 25.4
const A4_HEIGHT_PX = (297 * 96) / 25.4
const A4_MARGIN_PX = (8 * 96) / 25.4

function createA4InvoiceLayout(invoiceContainer) {
  const sourcePages = Array.from(invoiceContainer.querySelectorAll('.page'))
  const firstSourcePage = sourcePages[0]
  const lastSourcePage = sourcePages[sourcePages.length - 1]
  const sourceItemsTable = firstSourcePage?.querySelector('.items')
  if (!firstSourcePage || !lastSourcePage || !sourceItemsTable) return null

  const sourceTables = sourcePages.map((page) => page.querySelector('.items')).filter(Boolean)
  const itemRows = sourceTables.flatMap((table) => Array.from(table.querySelectorAll('tbody tr')))
  const lastItemsTable = lastSourcePage.querySelector('.items')
  const lastChildren = Array.from(lastSourcePage.children)
  const footerTemplates = lastChildren
    .slice(lastChildren.indexOf(lastItemsTable) + 1)
    .map((element) => element.cloneNode(true))
  const document = invoiceContainer.ownerDocument
  const staging = document.createElement('div')
  staging.className = 'invoice-export-staging'
  staging.style.cssText = `position:absolute;left:-10000px;top:0;width:${A4_WIDTH_PX}px;background:#fff;`
  document.body.appendChild(staging)

  const pages = []
  const createPage = (isFirstPage) => {
    const page = document.createElement('div')
    page.className = isFirstPage ? 'page invoice-export-page' : 'page continuation-page invoice-export-page'
    page.style.cssText = `box-sizing:border-box;width:${A4_WIDTH_PX}px;height:${A4_HEIGHT_PX}px;margin:0;padding:${A4_MARGIN_PX}px;overflow:hidden;background:#fff;page-break-after:auto;`

    if (isFirstPage) {
      for (const selector of ['.header', '.title-row', '.parties']) {
        const element = firstSourcePage.querySelector(selector)
        if (element) page.appendChild(element.cloneNode(true))
      }
    }

    const itemsTable = sourceItemsTable.cloneNode(true)
    const tbody = itemsTable.querySelector('tbody')
    tbody.replaceChildren()
    page.appendChild(itemsTable)
    staging.appendChild(page)

    const pageData = { element: page, tbody }
    pages.push(pageData)
    return pageData
  }

  const overflows = (page) => page.element.scrollHeight > page.element.clientHeight + 1
  let currentPage = createPage(true)

  for (const sourceRow of itemRows) {
    const row = sourceRow.cloneNode(true)
    currentPage.tbody.appendChild(row)
    if (!overflows(currentPage) || currentPage.tbody.rows.length === 1) continue

    currentPage.tbody.removeChild(row)
    currentPage = createPage(false)
    currentPage.tbody.appendChild(row)
  }

  let finalPage = pages[pages.length - 1]
  for (const footer of footerTemplates) finalPage.element.appendChild(footer)

  if (overflows(finalPage)) {
    for (const footer of footerTemplates) footer.remove()
    finalPage = createPage(false)
    for (const footer of footerTemplates) finalPage.element.appendChild(footer)

    let sourcePageIndex = pages.length - 2
    while (overflows(finalPage) && sourcePageIndex >= 0) {
      const sourcePage = pages[sourcePageIndex]
      if (sourcePage.tbody.rows.length === 0) {
        if (sourcePageIndex > 0) {
          sourcePage.element.remove()
          pages.splice(sourcePageIndex, 1)
        }
        sourcePageIndex -= 1
        continue
      }

      const row = sourcePage.tbody.lastElementChild
      finalPage.tbody.insertBefore(row, finalPage.tbody.firstChild)
      if (overflows(finalPage)) {
        sourcePage.tbody.appendChild(row)
        break
      }
      if (sourcePage.tbody.rows.length === 0 && sourcePageIndex > 0) {
        sourcePage.element.remove()
        pages.splice(sourcePageIndex, 1)
      }
      sourcePageIndex = Math.min(sourcePageIndex, pages.length - 2)
    }
  }

  const pageNumber = pages[0]?.element.querySelector('.pageno')
  if (pageNumber) pageNumber.textContent = `Page 1 of ${pages.length}`

  return {
    pages: pages.map((page) => page.element),
    cleanup: () => staging.remove(),
  }
}

function buildInvoicePagesPdf(canvases, imageQuality) {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    compress: true,
  })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()

  canvases.forEach((canvas, index) => {
    if (index > 0) pdf.addPage()
    const imageData = canvas.toDataURL('image/jpeg', imageQuality)
    pdf.addImage(imageData, 'JPEG', 0, 0, pageWidth, pageHeight, undefined, 'MEDIUM')
  })

  return pdf
}

export async function exportInvoicePdf(element, fileName = 'invoice') {
  if (!element || typeof element === 'string') {
    throw new Error('A DOM element is required to export the invoice PDF.')
  }

  let selectedPdf = null
  const scales = [1.5, 1]
  const qualities = [0.72, 0.55, 0.4]
  const invoiceLayout = createA4InvoiceLayout(element)

  try {
    for (const scale of scales) {
      const targets = invoiceLayout?.pages || [element]
      const canvases = await Promise.all(targets.map((target) => html2canvas(target, {
        backgroundColor: '#ffffff',
        scale,
        useCORS: true,
        allowTaint: true,
      })))

      for (const quality of qualities) {
        const pdf = invoiceLayout
          ? buildInvoicePagesPdf(canvases, quality)
          : buildPdf(canvases[0], quality)
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
  } finally {
    invoiceLayout?.cleanup()
  }

  if (!selectedPdf) {
    throw new Error('The invoice PDF could not be compressed below 2 MB.')
  }

  const safeName = String(fileName).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]+/g, '') || 'invoice'
  selectedPdf.save(`${safeName}.pdf`)
}

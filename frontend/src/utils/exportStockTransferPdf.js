import { exportInvoicePdf } from '@/utils/exportInvoicePdf'
import { prepareStockTransferPayload } from '@/utils/printInvoice'

function waitForFrameLoad(frame) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Stock transfer print template did not load.')), 15000)
    frame.addEventListener('load', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
}

export async function exportStockTransferPdf(transfer, branch) {
  if (typeof document === 'undefined') throw new Error('PDF export is only available in a browser.')

  const frame = document.createElement('iframe')
  frame.title = 'Stock transfer PDF export'
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;'
  frame.src = '/invoice-export-a4.html?preview=1'
  const frameLoaded = waitForFrameLoad(frame)
  document.body.appendChild(frame)

  try {
    await frameLoaded
    const payload = await prepareStockTransferPayload(transfer, branch)
    const frameWindow = frame.contentWindow
    const frameDocument = frame.contentDocument
    if (!frameWindow || !frameDocument) throw new Error('Unable to access the stock transfer print template.')

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onRendered)
        reject(new Error('Stock transfer print template did not finish rendering.'))
      }, 15000)
      const onRendered = (event) => {
        if (event.source !== frameWindow || event.origin !== window.location.origin || event.data?.type !== 'invoiceRendered') return
        clearTimeout(timeout)
        window.removeEventListener('message', onRendered)
        resolve()
      }
      window.addEventListener('message', onRendered)
      frameWindow.postMessage({ type: 'renderInvoice', payload }, window.location.origin)
    })

    const pages = frameDocument.getElementById('invoicePages')
    if (!pages) throw new Error('Stock transfer print content was not generated.')
    const ref = transfer?.ref_number || transfer?.number || transfer?.id || 'transfer'
    await exportInvoicePdf(pages, `stock-transfer-${ref}`)
  } finally {
    frame.remove()
  }
}

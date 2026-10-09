import { downloadDocumentPdf, DOCUMENT_TYPES, printDocumentPdf } from '@/utils/documentPdf'
import { prepareStockTransferPayload } from '@/utils/printInvoice'

export async function exportStockTransferPdf(transfer, branch) {
  const payload = await prepareStockTransferPayload(transfer, branch)
  if (!payload) throw new Error('Stock transfer details are not available.')
  return downloadDocumentPdf(DOCUMENT_TYPES.STOCK_TRANSFER, payload)
}

export async function printStockTransferPdf(transfer, branch) {
  const payload = await prepareStockTransferPayload(transfer, branch)
  if (!payload) throw new Error('Stock transfer details are not available.')
  return printDocumentPdf(DOCUMENT_TYPES.STOCK_TRANSFER, payload)
}

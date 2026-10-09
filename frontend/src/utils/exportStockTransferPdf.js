import { downloadDocumentPdf, DOCUMENT_TYPES, printDocumentPdf, warmDocumentPdf } from '@/utils/documentPdf'
import { prepareStockTransferPayload } from '@/utils/printInvoice'

export async function exportStockTransferPdf(transfer, branch) {
  const warmed = warmDocumentPdf(DOCUMENT_TYPES.STOCK_TRANSFER, branch)
  const payload = await prepareStockTransferPayload(transfer, branch)
  if (!payload) throw new Error('Stock transfer details are not available.')
  await warmed
  return downloadDocumentPdf(DOCUMENT_TYPES.STOCK_TRANSFER, payload)
}

export async function printStockTransferPdf(transfer, branch) {
  const warmed = warmDocumentPdf(DOCUMENT_TYPES.STOCK_TRANSFER, branch)
  const payload = await prepareStockTransferPayload(transfer, branch)
  if (!payload) throw new Error('Stock transfer details are not available.')
  await warmed
  return printDocumentPdf(DOCUMENT_TYPES.STOCK_TRANSFER, payload)
}

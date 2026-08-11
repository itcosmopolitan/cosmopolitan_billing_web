import SalesTxnDetailPanel from './SalesTxnDetailPanel'

/** @deprecated Prefer SalesTxnDetailPanel with kind="invoice" */
export default function InvoiceDetailPanel({ invoice, onCancel, ...props }) {
  return (
    <SalesTxnDetailPanel
      kind="invoice"
      document={invoice}
      onCancelInvoice={onCancel}
      {...props}
    />
  )
}

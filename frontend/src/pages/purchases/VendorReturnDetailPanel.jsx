import PurchaseTxnDetailPanel from './PurchaseTxnDetailPanel'

/** @deprecated Prefer PurchaseTxnDetailPanel with kind="return" */
export default function VendorReturnDetailPanel({ returnDoc, canVoid, onVoid, ...props }) {
  return (
    <PurchaseTxnDetailPanel
      kind="return"
      document={returnDoc}
      onVoidReturn={canVoid ? onVoid : undefined}
      {...props}
    />
  )
}

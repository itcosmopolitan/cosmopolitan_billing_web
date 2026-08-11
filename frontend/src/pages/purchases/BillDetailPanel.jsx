import PurchaseTxnDetailPanel from './PurchaseTxnDetailPanel'

/** @deprecated Prefer PurchaseTxnDetailPanel with kind="bill" */
export default function BillDetailPanel({ bill, ...props }) {
  return <PurchaseTxnDetailPanel kind="bill" document={bill} {...props} />
}

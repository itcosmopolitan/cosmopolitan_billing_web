import { Modal, FormGroup, FormRow } from '@/components/ui'
import { fmt } from '@/utils/helpers'

/**
 * "New Purchase Bill" modal extracted from PurchasesPage. Stateless — the
 * parent owns `newBill`, the patcher, and the persistence call.
 */
export default function NewBillModal({
  open, onClose, onSave,
  newBill, patchBill, patchBillItem, addItem, removeItem,
  vendors, branches, items,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Purchase Bill"
      icon="📋"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Save Bill</button>
        </>
      }
    >
      <FormRow>
        <FormGroup label="Vendor" required>
          <select className="form-input" value={newBill.vendorId} onChange={(e) => patchBill('vendorId', e.target.value)}>
            <option value="">Select vendor…</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </FormGroup>
        <FormGroup label="Receiving Branch">
          <select className="form-input" value={newBill.branchId} onChange={(e) => patchBill('branchId', e.target.value)}>
            <option value="">Select branch…</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Bill Date"><input className="form-input" type="date" value={newBill.billDate} onChange={(e) => patchBill('billDate', e.target.value)} /></FormGroup>
        <FormGroup label="Due Date"><input className="form-input" type="date" value={newBill.dueDate} onChange={(e) => patchBill('dueDate', e.target.value)} /></FormGroup>
      </FormRow>
      <div className="form-label" style={{ marginBottom: 8 }}>Items Received</div>
      {newBill.items.map((item, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 100px auto', gap: 8, marginBottom: 6 }}>
          <select className="form-input" value={item.itemId} onChange={(e) => patchBillItem(i, 'itemId', e.target.value)}>
            <option value="">Select item…</option>
            {items.map((it) => <option key={it.id} value={it.id}>{it.name} (₹{fmt(it.costPrice)})</option>)}
          </select>
          <input className="form-input" type="number" placeholder="Qty" value={item.qty} onChange={(e) => patchBillItem(i, 'qty', e.target.value)} />
          <input className="form-input" type="number" placeholder="Cost ₹" value={item.cost} onChange={(e) => patchBillItem(i, 'cost', e.target.value)} />
          <button className="btn btn-ghost btn-sm" onClick={() => removeItem(i)}>✕</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={addItem}>+ Add item</button>
      <FormRow>
        <FormGroup label="Discount (₹)"><input className="form-input" type="number" value={newBill.discount} onChange={(e) => patchBill('discount', e.target.value)} /></FormGroup>
      </FormRow>
    </Modal>
  )
}

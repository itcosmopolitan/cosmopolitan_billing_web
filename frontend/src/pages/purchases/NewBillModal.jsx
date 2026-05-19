import { Modal, FormGroup, FormRow, AlertBar } from '@/components/ui'
import { fmt } from '@/utils/helpers'
import { todayISO } from '@/utils/batchDates'

/**
 * "New Purchase Bill" modal extracted from PurchasesPage. Stateless — the
 * parent owns `newBill`, the patcher, and the persistence call.
 *
 * Each line shows compact batch capture (lot #, mfg, expiry) when the picked
 * item has batch_tracking enabled. The fields are stored on the line itself
 * (`item.batchNumber`, `item.mfgDate`, `item.expiryDate`) and the backend
 * adds them to the new ItemBatch row created during purchase posting.
 */
export default function NewBillModal({
  open, onClose, onSave,
  newBill, patchBill, patchBillItem, addItem, removeItem,
  vendors, branches, items,
}) {
  const itemById = (id) => items.find((x) => x.id === id)
  const today = todayISO()

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

      <AlertBar type="blue" icon="🧴">
        For batch-tracked items, capture lot # and expiry so FIFO/FEFO consumption stays accurate.
        Leave the batch # blank to auto-generate one.
      </AlertBar>
      <div style={{ height: 10 }} />

      {newBill.items.map((item, i) => {
        const it = itemById(item.itemId)
        const tracked = it?.batch_tracking
        const fefo    = it?.expiry_tracking
        return (
          <div key={i} style={{
            padding: tracked ? '10px 12px' : 0,
            background: tracked ? 'var(--bg-raised)' : 'transparent',
            border: tracked ? '1px solid var(--border)' : 'none',
            borderRadius: 8,
            marginBottom: 8,
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 100px auto', gap: 8 }}>
              <select className="form-input" value={item.itemId} onChange={(e) => patchBillItem(i, 'itemId', e.target.value)}>
                <option value="">Select item…</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.name} (₹{fmt(it.costPrice ?? it.cost_price)}){it.batch_tracking ? (it.expiry_tracking ? ' • FEFO' : ' • FIFO') : ''}</option>)}
              </select>
              <input className="form-input" type="number" placeholder="Qty" value={item.qty} onChange={(e) => patchBillItem(i, 'qty', e.target.value)} />
              <input className="form-input" type="number" placeholder="Cost ₹" value={item.cost} onChange={(e) => patchBillItem(i, 'cost', e.target.value)} />
              <button className="btn btn-ghost btn-sm" onClick={() => removeItem(i)}>✕</button>
            </div>
            {tracked && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, marginTop: 8 }}>
                <input className="form-input" placeholder="Batch / Lot # (auto)" value={item.batchNumber || ''} onChange={(e) => patchBillItem(i, 'batchNumber', e.target.value)} />
                <input className="form-input" type="date" max={today} placeholder="Mfg Date" value={item.mfgDate || ''} onChange={(e) => patchBillItem(i, 'mfgDate', e.target.value)} title="Mfg date — not in the future" />
                <input className="form-input" type="date" min={today} placeholder={fefo ? 'Expiry Date *' : 'Expiry Date'} value={item.expiryDate || ''} onChange={(e) => patchBillItem(i, 'expiryDate', e.target.value)} title="Expiry — today or later" />
                <div style={{ fontSize: 10.5, alignSelf: 'center', color: fefo ? 'var(--red)' : 'var(--accent)', fontWeight: 600 }}>
                  {fefo ? 'FEFO' : 'FIFO'}
                </div>
              </div>
            )}
          </div>
        )
      })}
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={addItem}>+ Add item</button>
      <FormRow>
        <FormGroup label="Discount (₹)"><input className="form-input" type="number" value={newBill.discount} onChange={(e) => patchBill('discount', e.target.value)} /></FormGroup>
      </FormRow>
    </Modal>
  )
}

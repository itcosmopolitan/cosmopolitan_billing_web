import { Modal, FormGroup } from '@/components/ui'

/**
 * Create-Quotation modal extracted from SalesPage. Stateless — the parent
 * owns `quoteForm` and the patcher; we just render the controls.
 */
export default function QuoteFormModal({ open, onClose, onSave, quoteForm, pqf, branches }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Quotation"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Create</button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Customer Name" required><input className="form-input" value={quoteForm.customerName} onChange={e => pqf('customerName', e.target.value)} /></FormGroup>
        <FormGroup label="Branch">
          <select className="form-input" value={quoteForm.branchId} onChange={e => pqf('branchId', e.target.value)}>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </FormGroup>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Valid Until"><input className="form-input" type="date" value={quoteForm.validUntil} onChange={e => pqf('validUntil', e.target.value)} /></FormGroup>
        <FormGroup label="Discount"><input className="form-input" type="number" value={quoteForm.discount} onChange={e => pqf('discount', Number(e.target.value))} /></FormGroup>
      </div>
      <FormGroup label="Items" required>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead><tr><th>Item</th><th style={{ width: 80 }}>Qty</th><th style={{ width: 100 }}>Price</th><th style={{ width: 80 }}>Tax %</th><th /></tr></thead>
          <tbody>
            {quoteForm.items.map((it, i) => (
              <tr key={i}>
                <td><input className="form-input" placeholder="Item name" value={it.name} onChange={e => { const n = [...quoteForm.items]; n[i].name = e.target.value; pqf('items', n) }} /></td>
                <td><input className="form-input" type="number" value={it.qty} onChange={e => { const n = [...quoteForm.items]; n[i].qty = e.target.value; pqf('items', n) }} /></td>
                <td><input className="form-input" type="number" value={it.price} onChange={e => { const n = [...quoteForm.items]; n[i].price = e.target.value; pqf('items', n) }} /></td>
                <td><input className="form-input" type="number" value={it.taxRate} onChange={e => { const n = [...quoteForm.items]; n[i].taxRate = e.target.value; pqf('items', n) }} /></td>
                <td><button className="btn btn-danger btn-xs" onClick={() => pqf('items', quoteForm.items.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-secondary btn-sm" onClick={() => pqf('items', [...quoteForm.items, { name: '', qty: 1, price: 0, taxRate: 0 }])}>+ Add Item</button>
      </FormGroup>
      <FormGroup label="Notes"><textarea className="form-input" style={{ height: 72 }} value={quoteForm.notes} onChange={e => pqf('notes', e.target.value)} /></FormGroup>
    </Modal>
  )
}

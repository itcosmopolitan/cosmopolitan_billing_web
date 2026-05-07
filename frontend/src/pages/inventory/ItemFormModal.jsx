import { Modal, FormGroup, FormRow } from '@/components/ui'

/**
 * Add / Edit item modal extracted from ItemsPage. Stateless — all form
 * state lives in ItemsPage; we just render the controls and wire onChange.
 */
export default function ItemFormModal({
  open, onClose, editing, form, patchForm, onSave, categories,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Item' : 'Add New Item'}
      icon="📦"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>{editing ? 'Update Item' : 'Save Item'}</button>
        </>
      }
    >
      <FormRow>
        <FormGroup label="Item Name" required><input className="form-input" value={form.name} onChange={(e) => patchForm('name', e.target.value)} placeholder="e.g. Basmati Rice 5kg" /></FormGroup>
        <FormGroup label="Brand"><input className="form-input" value={form.brand} onChange={(e) => patchForm('brand', e.target.value)} placeholder="e.g. India Gate" /></FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="SKU"><input className="form-input" value={form.sku} onChange={(e) => patchForm('sku', e.target.value)} placeholder="Auto-generated if blank" /></FormGroup>
        <FormGroup label="Barcode"><input className="form-input" value={form.barcode} onChange={(e) => patchForm('barcode', e.target.value)} placeholder="Scan or enter" /></FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Category">
          <select className="form-input" value={form.categoryId} onChange={(e) => patchForm('categoryId', e.target.value)}>
            <option value="">Select Category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FormGroup>
        <FormGroup label="Unit">
          <select className="form-input" value={form.unit} onChange={(e) => patchForm('unit', e.target.value)}>
            {['Pcs', 'Kg', 'Gram', 'Litre', 'ML', 'Pack', 'Box', 'Dozen'].map((u) => <option key={u}>{u}</option>)}
          </select>
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Cost Price (₹)" required><input className="form-input" type="number" value={form.cost_price} onChange={(e) => patchForm('cost_price', e.target.value)} placeholder="0.00" /></FormGroup>
        <FormGroup label="Selling Price (₹)" required><input className="form-input" type="number" value={form.selling_price} onChange={(e) => patchForm('selling_price', e.target.value)} placeholder="0.00" /></FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="GST Rate">
          <select className="form-input" value={form.tax_rate} onChange={(e) => patchForm('tax_rate', e.target.value)}>
            {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </FormGroup>
        <FormGroup label="HSN Code"><input className="form-input" value={form.hsn_code} onChange={(e) => patchForm('hsn_code', e.target.value)} placeholder="e.g. 1006" /></FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Reorder Level"><input className="form-input" type="number" value={form.reorder_level} onChange={(e) => patchForm('reorder_level', e.target.value)} placeholder="Min stock trigger" /></FormGroup>
        <FormGroup label="Opening Stock"><input className="form-input" type="number" value={form.opening_stock} onChange={(e) => patchForm('opening_stock', e.target.value)} placeholder="0" /></FormGroup>
      </FormRow>
      <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.batch_tracking} onChange={(e) => patchForm('batch_tracking', e.target.checked)} />
          Batch tracking
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.expiry_tracking} onChange={(e) => patchForm('expiry_tracking', e.target.checked)} />
          Expiry date tracking
        </label>
      </div>
    </Modal>
  )
}

import { Modal, FormGroup, FormRow, AlertBar } from '@/components/ui'
import { todayISO } from '@/utils/batchDates'

/**
 * Add / Edit item modal extracted from ItemsPage. Stateless — all form
 * state lives in ItemsPage; we just render the controls and wire onChange.
 *
 * Batch tracking section (bottom): when the user enables batch_tracking the
 * modal reveals an opening-batch capture block (batch #, mfg, expiry). When
 * `expiry_tracking` is also on, the parent will use FEFO at sale time; with
 * batch_tracking alone it falls back to FIFO. The toggles drive the strategy
 * picker copy so the operator sees which behavior they're enabling.
 */
export default function ItemFormModal({
  open, onClose, editing, editWasTracked, form, patchForm, onSave, categories, taxRates = [],
}) {
  const rateOptions = taxRates.length > 0
    ? taxRates.filter((t) => t.active !== false).map((t) => t.rate)
    : [0, 8]
  const showBatchOpening = !editing && form.batch_tracking && Number(form.opening_stock) > 0
  const strategyHint = !form.batch_tracking
    ? 'Aggregate stock only — no batch / expiry tracking.'
    : form.expiry_tracking
      ? 'FEFO — nearest-expiry lot is consumed first on sales & transfers.'
      : 'FIFO — oldest-received lot is consumed first on sales & transfers.'
  const today = todayISO()

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
            {rateOptions.map((r) => <option key={r} value={r}>{r}%</option>)}
          </select>
        </FormGroup>
        <FormGroup label="HSN Code"><input className="form-input" value={form.hsn_code} onChange={(e) => patchForm('hsn_code', e.target.value)} placeholder="e.g. 1006" /></FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Reorder Level"><input className="form-input" type="number" value={form.reorder_level} onChange={(e) => patchForm('reorder_level', e.target.value)} placeholder="Min stock trigger" /></FormGroup>
        <FormGroup label="Opening Stock"><input className="form-input" type="number" value={form.opening_stock} onChange={(e) => patchForm('opening_stock', e.target.value)} placeholder="0" disabled={editing} /></FormGroup>
      </FormRow>

      {/* Tracking toggles */}
      <div style={{
        marginTop: 10, padding: '12px 14px', background: 'var(--bg-raised)',
        borderRadius: 8, border: '1px solid var(--border)',
      }}>
        <div className="form-label" style={{ marginBottom: 8 }}>Inventory tracking</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.batch_tracking} onChange={(e) => {
              const v = e.target.checked
              patchForm('batch_tracking', v)
              if (!v) patchForm('expiry_tracking', false)
            }} />
            Batch / Lot tracking
          </label>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            color: form.batch_tracking ? 'var(--text-secondary)' : 'var(--text-muted)',
            cursor: form.batch_tracking ? 'pointer' : 'not-allowed',
            opacity: form.batch_tracking ? 1 : 0.5,
          }}>
            <input type="checkbox" disabled={!form.batch_tracking} checked={form.expiry_tracking} onChange={(e) => patchForm('expiry_tracking', e.target.checked)} />
            Expiry tracking (enables FEFO)
          </label>
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
          Strategy: <strong style={{ color: 'var(--text-secondary)' }}>{strategyHint}</strong>
        </div>
        {editing && editWasTracked && !form.batch_tracking && (
          <div style={{ marginTop: 10 }}>
            <AlertBar type="amber" icon="⚠️">
              Saving will <strong>delete all existing batches</strong> for this item. Stock counts stay as aggregate-only.
            </AlertBar>
          </div>
        )}
        {editing && !editWasTracked && form.batch_tracking && (
          <div style={{ marginTop: 10 }}>
            <AlertBar type="blue" icon="🧴">
              Saving will create an <strong>opening batch per branch</strong> from current stock on hand.
            </AlertBar>
          </div>
        )}
      </div>

      {/* Opening batch (only on Add, when batch tracking + opening stock > 0) */}
      {showBatchOpening && (
        <div style={{ marginTop: 12 }}>
          <AlertBar type="blue" icon="🧴">
            Opening stock of <strong>{form.opening_stock}</strong> units will be recorded as your first batch.
            Capture lot details so {form.expiry_tracking ? 'FEFO' : 'FIFO'} consumption can sequence correctly.
          </AlertBar>
          <FormRow>
            <FormGroup label="Batch / Lot Number">
              <input className="form-input" value={form.opening_batch_number || ''} onChange={(e) => patchForm('opening_batch_number', e.target.value)} placeholder="Auto-generated if blank" />
            </FormGroup>
            <FormGroup label="Mfg. Date">
              <input className="form-input" type="date" max={today} value={form.opening_mfg_date || ''} onChange={(e) => patchForm('opening_mfg_date', e.target.value)} title="Cannot be in the future" />
            </FormGroup>
          </FormRow>
          {form.expiry_tracking && (
            <FormRow>
              <FormGroup label="Expiry Date" required>
                <input className="form-input" type="date" min={today} value={form.opening_expiry_date || ''} onChange={(e) => patchForm('opening_expiry_date', e.target.value)} title="Must be today or later" />
              </FormGroup>
              <div />
            </FormRow>
          )}
        </div>
      )}
    </Modal>
  )
}

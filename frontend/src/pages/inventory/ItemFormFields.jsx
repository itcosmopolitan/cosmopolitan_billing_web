import { FormGroup, FormRow, AlertBar } from '@/components/ui'
import BranchPricingSection from './BranchPricingSection'

/** Shared catalog + branch fields for New / Edit Item pages. */
export default function ItemFormFields({
  form,
  patchForm,
  categories,
  taxRates = [],
  editing = false,
  editWasTracked = false,
  branches = [],
  branchConfigs = [],
  onBranchConfigsChange,
  branchSectionMode = 'create',
}) {
  const showBranchSection = Boolean(onBranchConfigsChange) && branchSectionMode !== 'hidden'
  const rateOptions = taxRates.length > 0
    ? taxRates.filter((t) => t.active !== false).map((t) => t.rate)
    : [0, 8]
  const strategyHint = !form.batch_tracking
    ? 'Untracked — set stock per branch from Items & Stock.'
    : form.expiry_tracking
      ? 'FEFO — add batches per branch from Items & Stock; nearest expiry consumed first.'
      : 'FIFO — add batches per branch from Items & Stock; oldest received consumed first.'

  return (
    <>
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
        <FormGroup label="Default Cost Price (₹)" required><input className="form-input" type="number" value={form.cost_price} onChange={(e) => patchForm('cost_price', e.target.value)} placeholder="0.00" /></FormGroup>
        <FormGroup label="Default Selling Price (₹)" required><input className="form-input" type="number" value={form.selling_price} onChange={(e) => patchForm('selling_price', e.target.value)} placeholder="0.00" /></FormGroup>
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
        <FormGroup label="Default Reorder Level"><input className="form-input" type="number" value={form.reorder_level} onChange={(e) => patchForm('reorder_level', e.target.value)} placeholder="Min stock trigger" /></FormGroup>
        <div />
      </FormRow>

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

      {showBranchSection && (
        <BranchPricingSection
          mode={branchSectionMode}
          branches={branches}
          branchConfigs={branchConfigs}
          defaultCost={form.cost_price}
          defaultPrice={form.selling_price}
          defaultReorder={form.reorder_level}
          onChange={onBranchConfigsChange}
        />
      )}
    </>
  )
}

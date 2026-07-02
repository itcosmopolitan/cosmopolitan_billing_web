import { useMemo } from 'react'
import { FormGroup, AlertBar, AutocompleteDropdown } from '@/components/ui'
import BranchPricingSection from './BranchPricingSection'

/** Shared catalog + branch fields for New / Edit Item pages. */
export default function ItemFormFields({
  form,
  patchForm,
  categories = [],
  unitOptions = [],
  taxRates = [],
  editing = false,
  editWasTracked = false,
  branches = [],
  branchConfigs = [],
  initialListedIds = [],
  onBranchConfigsChange,
  branchSectionMode = 'create',
  itemId = null,
  onAddCategory,
  onAddUnit,
  categoryActionBusy = false,
}) {
  const showBranchSection = Boolean(onBranchConfigsChange) && branchSectionMode !== 'hidden'
  const categoryLabel = categories.find((c) => c.id === form.categoryId)?.name
  const strategyHint = !form.batch_tracking
    ? 'Untracked — set stock per branch from Items & Stock.'
    : form.expiry_tracking
      ? 'FEFO — add batches per branch from Items & Stock; nearest expiry consumed first.'
      : 'FIFO — add batches per branch from Items & Stock; oldest received consumed first.'
  const compactSelectStyle = { width: '100%', maxWidth: 420 }
  const dropdownStyle = { flex: 1, width: '100%', minWidth: 0 }

  const categoryOptions = useMemo(
    () => categories.map((c) => ({ id: c.id, label: c.name })),
    [categories],
  )
  const unitDropdownOptions = useMemo(
    () => unitOptions.map((u) => ({ id: u, label: u })),
    [unitOptions],
  )
  const taxDropdownOptions = useMemo(() => {
    const currentRate = form.tax_rate
    const rows = taxRates.length > 0
      ? taxRates.filter((t) => t.is_active !== false || String(t.rate) === String(currentRate))
      : [{ rate: 0, is_active: true }, { rate: 8, is_active: true }]
    return rows.map((t) => ({
      id: String(t.rate),
      label: `${t.rate}%${t.is_active === false ? ' (inactive)' : ''}`,
    }))
  }, [taxRates, form.tax_rate])

  return (
    <>
      <div className="item-form-shell item-form-layout">
        <div className="item-form-column">
          <div className="item-form-panel">
            <div className="item-form-panel__head">Identity</div>
            <div className="item-form-grid">
              <FormGroup label="Item Name" required><input className="form-input" value={form.name} onChange={(e) => patchForm('name', e.target.value)} placeholder="e.g. Basmati Rice 5kg" /></FormGroup>
              <FormGroup label="Brand"><input className="form-input" value={form.brand} onChange={(e) => patchForm('brand', e.target.value)} placeholder="e.g. India Gate" /></FormGroup>
              <FormGroup label="SKU"><input className="form-input" value={form.sku} onChange={(e) => patchForm('sku', e.target.value)} placeholder="Auto-generated if blank" /></FormGroup>
              <FormGroup label="Barcode"><input className="form-input" value={form.barcode} onChange={(e) => patchForm('barcode', e.target.value)} placeholder="Scan or enter" /></FormGroup>
            </div>
          </div>

          <div className="item-form-panel">
            <div className="item-form-panel__head">Classification</div>
            <div className="item-form-grid">
              <FormGroup label="Category">
                <div className="item-form-select-action" style={compactSelectStyle}>
                  <AutocompleteDropdown
                    value={form.categoryId || ''}
                    onSelectOption={(opt) => patchForm('categoryId', opt?.id || '')}
                    options={categoryOptions}
                    isSearchFieldRequired
                    selectedLabel={categoryLabel}
                    placeholder="Select category…"
                    searchPlaceholder="Search categories…"
                    emptyLabel="No categories found"
                    style={dropdownStyle}
                  />
                  {onAddCategory && (
                    <button type="button" className="btn btn-ghost btn-sm item-form-add-btn" onClick={onAddCategory} disabled={categoryActionBusy}>
                      {categoryActionBusy ? '…' : '+'}
                    </button>
                  )}
                </div>
              </FormGroup>
              <FormGroup label="Unit">
                <div className="item-form-select-action" style={compactSelectStyle}>
                  <AutocompleteDropdown
                    value={form.unit || ''}
                    onSelectOption={(opt) => patchForm('unit', opt?.id || '')}
                    options={unitDropdownOptions}
                    isSearchFieldRequired
                    selectedLabel={form.unit || undefined}
                    placeholder="Select unit…"
                    searchPlaceholder="Search units…"
                    emptyLabel="No units found"
                    style={dropdownStyle}
                  />
                  {onAddUnit && (
                    <button type="button" className="btn btn-ghost btn-sm item-form-add-btn" onClick={onAddUnit}>
                      +
                    </button>
                  )}
                </div>
              </FormGroup>
              <FormGroup label="GST Rate">
                <AutocompleteDropdown
                  value={form.tax_rate != null && form.tax_rate !== '' ? String(form.tax_rate) : ''}
                  onSelectOption={(opt) => patchForm('tax_rate', opt?.id ?? '')}
                  options={taxDropdownOptions}
                  isSearchFieldRequired={false}
                  selectedLabel={form.tax_rate !== '' && form.tax_rate != null ? `${form.tax_rate}%` : undefined}
                  placeholder="Select GST rate…"
                  emptyLabel="No tax rates found"
                  style={compactSelectStyle}
                />
              </FormGroup>
              <FormGroup label="HSN Code"><input className="form-input" value={form.hsn_code} onChange={(e) => patchForm('hsn_code', e.target.value)} placeholder="e.g. 1006" /></FormGroup>
            </div>
          </div>
        </div>

        <div className="item-form-column">
          <div className="item-form-panel">
            <div className="item-form-panel__head">Pricing</div>
            <div className="item-form-grid item-form-grid--single">
              <FormGroup label="Default Cost Price (MVR)" required><input className="form-input" type="number" value={form.cost_price} onChange={(e) => patchForm('cost_price', e.target.value)} placeholder="0.00" /></FormGroup>
              <FormGroup label="Default Selling Price (MVR)" required><input className="form-input" type="number" value={form.selling_price} onChange={(e) => patchForm('selling_price', e.target.value)} placeholder="0.00" /></FormGroup>
              <FormGroup label="Default Reorder Level"><input className="form-input" type="number" value={form.reorder_level} onChange={(e) => patchForm('reorder_level', e.target.value)} placeholder="Min stock trigger" /></FormGroup>
            </div>
          </div>

          <div className="item-form-panel item-form-panel--muted">
            <div className="item-form-panel__head">Inventory tracking</div>
            <div className="item-form-checks">
              <label className="item-form-check">
                <input type="checkbox" checked={form.batch_tracking} onChange={(e) => {
                  const v = e.target.checked
                  patchForm('batch_tracking', v)
                  if (!v) patchForm('expiry_tracking', false)
                }} />
                Batch / Lot tracking
              </label>
              <label className={`item-form-check ${!form.batch_tracking ? 'is-disabled' : ''}`}>
                <input type="checkbox" disabled={!form.batch_tracking} checked={form.expiry_tracking} onChange={(e) => patchForm('expiry_tracking', e.target.checked)} />
                Expiry tracking (enables FEFO)
              </label>
            </div>
            <div className="item-form-strategy">
              Strategy: <strong>{strategyHint}</strong>
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
        </div>
      </div>

      {showBranchSection && (
        <BranchPricingSection
          mode={branchSectionMode}
          branches={branches}
          branchConfigs={branchConfigs}
          initialListedIds={initialListedIds}
          defaultCost={form.cost_price}
          defaultPrice={form.selling_price}
          defaultReorder={form.reorder_level}
          batchTracking={Boolean(form.batch_tracking)}
          onChange={onBranchConfigsChange}
          itemId={itemId}
        />
      )}
    </>
  )
}

import { FormGroup, AlertBar, AutocompleteDropdown } from '@/components/ui'
import { AUTOCOMPLETE_CATEGORY_URL, AUTOCOMPLETE_UNIT_URL, AUTOCOMPLETE_TAX_RATE_URL } from '@/api'
import BranchPricingSection from './BranchPricingSection'
import TaxedPriceInput, { GST_TAX_MODE_OPTIONS, normalizeTaxMode } from './TaxedPriceInput'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { convertEnteredTaxAmount } from '@/utils/taxCalc'

/** Shared catalog + branch fields for New / Edit Item pages. */
export default function ItemFormFields({
  form,
  patchForm,
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
  const strategyHint = !form.batch_tracking
    ? 'Untracked — set stock per branch from Items & Stock.'
    : form.expiry_tracking
      ? 'FEFO — add batches per branch from Items & Stock; nearest expiry consumed first.'
      : 'FIFO — add batches per branch from Items & Stock; oldest received consumed first.'
  const compactSelectStyle = { width: '100%', maxWidth: 420 }
  const dropdownStyle = { flex: 1, width: '100%', minWidth: 0 }
  const priceTaxMode = normalizeTaxMode(form.priceTaxMode)

  const setPriceTaxMode = (next) => {
    const normalized = normalizeTaxMode(next)
    if (normalized === priceTaxMode) return
    const rate = form.tax_rate
    patchForm('cost_price', convertEnteredTaxAmount(form.cost_price, priceTaxMode, normalized, rate))
    patchForm('selling_price', convertEnteredTaxAmount(form.selling_price, priceTaxMode, normalized, rate))
    patchForm('priceTaxMode', normalized)
    if (onBranchConfigsChange) {
      onBranchConfigsChange((prev) => (prev || []).map((r) => ({
        ...r,
        cost_price: convertEnteredTaxAmount(r.cost_price, priceTaxMode, normalized, rate),
        selling_price: convertEnteredTaxAmount(r.selling_price, priceTaxMode, normalized, rate),
      })))
    }
  }

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
              <FormGroup label="County of Orgin"><input className="form-input" value={form.country_of_origin || ''} onChange={(e) => patchForm('country_of_origin', e.target.value)} placeholder="e.g. Maldives" /></FormGroup>
            </div>
          </div>

          <div className="item-form-panel">
            <div className="item-form-panel__head">Classification</div>
            <div className="item-form-grid">
              <FormGroup label="Category" required>
                <div className="item-form-select-action" style={compactSelectStyle}>
                  <AutocompleteDropdown
                    value={form.categoryId || ''}
                    selectedLabel={form.categoryName || ''}
                    onSelectOption={(opt) => {
                      patchForm('categoryId', opt?.id || '')
                      patchForm('categoryName', opt?.label || opt?.text || '')
                    }}
                    fetchUrl={AUTOCOMPLETE_CATEGORY_URL}
                    isSearchFieldRequired
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
              <FormGroup label="Unit" required>
                <div className="item-form-select-action" style={compactSelectStyle}>
                  <AutocompleteDropdown
                    value={form.unit || ''}
                    selectedLabel={form.unit || ''}
                    onSelectOption={(opt) => patchForm('unit', opt?.id || '')}
                    fetchUrl={AUTOCOMPLETE_UNIT_URL}
                    isSearchFieldRequired
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
                  fetchUrl={AUTOCOMPLETE_TAX_RATE_URL}
                  fetchParams={{ include_rate: form.tax_rate }}
                  isSearchFieldRequired={false}
                  placeholder="Select GST rate…"
                  emptyLabel="No tax rates found"
                  style={compactSelectStyle}
                />
              </FormGroup>
              <FormGroup label="HSN Code"><input className="form-input" value={form.hsn_code} onChange={(e) => patchForm('hsn_code', e.target.value)} placeholder="e.g. 1006" /></FormGroup>
              <FormGroup label="Packaging / Set">
                <label className="item-form-check" style={{ marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(form.is_packaging)}
                    onChange={(e) => {
                      const checked = e.target.checked
                      patchForm('is_packaging', checked)
                      if (!checked) patchForm('packaging_quantity', '')
                    }}
                  />
                  This item is sold as a pack, box, or set
                </label>
              </FormGroup>
              {Boolean(form.is_packaging) && (
                  <div style={{ marginTop: 6 }}>
                    <FormGroup label="Quantity per pack / set" required>
                      <input
                        className="form-input"
                        type="number"
                        min={qtyInputStep()}
                        step={qtyInputStep()}
                        value={form.packaging_quantity ?? ''}
                        onChange={(e) => patchForm('packaging_quantity', e.target.value)}
                        placeholder="e.g. 12"
                      />
                    </FormGroup>
                  </div>
              )}
            </div>
          </div>
        </div>

        <div className="item-form-column">
          <div className="item-form-panel">
            <div className="item-form-panel__head">Pricing</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
              Choose how amounts are entered. Catalog prices are saved GST-inclusive.
            </p>
            <div className="item-form-grid item-form-grid--single">
              <FormGroup label="Price entry">
                <select
                  className="form-input"
                  value={priceTaxMode}
                  onChange={(e) => setPriceTaxMode(e.target.value)}
                  style={compactSelectStyle}
                >
                  {GST_TAX_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </FormGroup>
              <TaxedPriceInput
                label="Default Cost Price (MVR)"
                required
                value={form.cost_price}
                mode={priceTaxMode}
                taxRate={form.tax_rate}
                onValueChange={(v) => patchForm('cost_price', v)}
              />
              <TaxedPriceInput
                label="Default Selling Price — Retail (MVR)"
                required
                value={form.selling_price}
                mode={priceTaxMode}
                taxRate={form.tax_rate}
                onValueChange={(v) => patchForm('selling_price', v)}
              />
              <FormGroup label="Default Reorder Level"><input className="form-input" type="number" min="0" step={qtyInputStep()} value={form.reorder_level} onChange={(e) => patchForm('reorder_level', e.target.value)} placeholder="Min stock trigger" /></FormGroup>
            </div>
            <div className="item-form-panel__head" style={{ marginTop: 14 }}>Discount pattern</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
              Suggested % off retail for Wholesale / Staff. Cashier applies the discount on the bill and checks GP%.
            </p>
            <div className="item-form-grid item-form-grid--single">
              <FormGroup label="Wholesale discount %">
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.wholesale_discount_pct}
                  onChange={(e) => patchForm('wholesale_discount_pct', e.target.value)}
                  placeholder="e.g. 10"
                />
              </FormGroup>
              <FormGroup label="Staff discount %">
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.staff_discount_pct}
                  onChange={(e) => patchForm('staff_discount_pct', e.target.value)}
                  placeholder="e.g. 15"
                />
              </FormGroup>
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
          priceTaxMode={priceTaxMode}
          defaultReorder={form.reorder_level}
          taxRate={form.tax_rate}
          batchTracking={Boolean(form.batch_tracking)}
          onChange={onBranchConfigsChange}
          itemId={itemId}
        />
      )}
    </>
  )
}

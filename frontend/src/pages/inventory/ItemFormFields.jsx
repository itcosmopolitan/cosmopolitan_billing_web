import { FormGroup, AlertBar, AutocompleteDropdown } from '@/components/ui'
import { AUTOCOMPLETE_CATEGORY_URL, AUTOCOMPLETE_UNIT_URL, AUTOCOMPLETE_TAX_RATE_URL } from '@/api'
import BranchPricingSection from './BranchPricingSection'
import TaxedPriceInput, { GST_TAX_MODE_OPTIONS, normalizeTaxMode } from './TaxedPriceInput'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { convertEnteredTaxAmount } from '@/utils/taxCalc'

function SegmentedControl({ value, options, onChange, ariaLabel }) {
  return (
    <div className="item-form-seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`item-form-seg__btn${value === opt.value ? ' is-active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

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
    ? 'Aggregate stock — manage quantities from Items & Stock.'
    : form.expiry_tracking
      ? 'FEFO — nearest expiry first.'
      : 'FIFO — oldest received first.'
  const dropdownStyle = { flex: 1, width: '100%', minWidth: 0 }
  const priceTaxMode = normalizeTaxMode(form.priceTaxMode)
  const categoryMode = form.categoryPricingMode === 'price' ? 'price' : 'pct'

  const setPriceTaxMode = (next) => {
    const normalized = normalizeTaxMode(next)
    if (normalized === priceTaxMode) return
    const rate = form.tax_rate
    patchForm('cost_price', convertEnteredTaxAmount(form.cost_price, priceTaxMode, normalized, rate))
    patchForm('selling_price', convertEnteredTaxAmount(form.selling_price, priceTaxMode, normalized, rate))
    if (categoryMode === 'price') {
      patchForm('wholesale_price', convertEnteredTaxAmount(form.wholesale_price, priceTaxMode, normalized, rate))
      patchForm('staff_price', convertEnteredTaxAmount(form.staff_price, priceTaxMode, normalized, rate))
    }
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
      <div className="item-form-shell">
        <section className="item-form-section">
          <div className="item-form-section__head">
            <h3>Basics</h3>
          </div>
          <div className="item-form-grid item-form-grid--3">
            <FormGroup label="Item name" required>
              <input
                className="form-input"
                value={form.name}
                onChange={(e) => patchForm('name', e.target.value)}
                placeholder="e.g. Basmati Rice 5kg"
              />
            </FormGroup>
            <FormGroup label="Brand">
              <input
                className="form-input"
                value={form.brand}
                onChange={(e) => patchForm('brand', e.target.value)}
                placeholder="e.g. India Gate"
              />
            </FormGroup>
            <FormGroup label="Country of origin">
              <input
                className="form-input"
                value={form.country_of_origin || ''}
                onChange={(e) => patchForm('country_of_origin', e.target.value)}
                placeholder="e.g. Maldives"
              />
            </FormGroup>

            <FormGroup label="SKU">
              <input
                className="form-input"
                value={form.sku}
                onChange={(e) => patchForm('sku', e.target.value)}
                placeholder="Auto if blank"
              />
            </FormGroup>
            <FormGroup label="Barcode">
              <input
                className="form-input"
                value={form.barcode}
                onChange={(e) => patchForm('barcode', e.target.value)}
                placeholder="Scan or enter"
              />
            </FormGroup>
            <FormGroup label="HSN code">
              <input
                className="form-input"
                value={form.hsn_code}
                onChange={(e) => patchForm('hsn_code', e.target.value)}
                placeholder="e.g. 1006"
              />
            </FormGroup>

            <FormGroup label="Category" required>
              <div className="item-form-select-action">
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
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm item-form-add-btn"
                    onClick={onAddCategory}
                    disabled={categoryActionBusy}
                    title="Add category"
                  >
                    {categoryActionBusy ? '…' : '+'}
                  </button>
                )}
              </div>
            </FormGroup>
            <FormGroup label="Unit" required>
              <div className="item-form-select-action">
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
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm item-form-add-btn"
                    onClick={onAddUnit}
                    title="Add unit"
                  >
                    +
                  </button>
                )}
              </div>
            </FormGroup>
            <FormGroup label="GST rate">
              <AutocompleteDropdown
                value={form.tax_rate != null && form.tax_rate !== '' ? String(form.tax_rate) : ''}
                onSelectOption={(opt) => patchForm('tax_rate', opt?.id ?? '')}
                fetchUrl={AUTOCOMPLETE_TAX_RATE_URL}
                fetchParams={{ include_rate: form.tax_rate }}
                isSearchFieldRequired={false}
                placeholder="Select GST rate…"
                emptyLabel="No tax rates found"
              />
            </FormGroup>
          </div>

          <div className="item-form-inline-opts">
            <label className="item-form-check">
              <input
                type="checkbox"
                checked={Boolean(form.is_packaging)}
                onChange={(e) => {
                  const checked = e.target.checked
                  patchForm('is_packaging', checked)
                  if (!checked) patchForm('packaging_quantity', '')
                }}
              />
              Sold as pack / set
            </label>
            {Boolean(form.is_packaging) && (
              <FormGroup label="Qty per pack" required>
                <input
                  className="form-input item-form-input--narrow"
                  type="number"
                  min={qtyInputStep()}
                  step={qtyInputStep()}
                  value={form.packaging_quantity ?? ''}
                  onChange={(e) => patchForm('packaging_quantity', e.target.value)}
                  placeholder="12"
                />
              </FormGroup>
            )}
          </div>
        </section>

        <section className="item-form-section">
          <div className="item-form-section__head">
            <h3>Pricing</h3>
            <SegmentedControl
              ariaLabel="Price entry mode"
              value={priceTaxMode}
              onChange={setPriceTaxMode}
              options={GST_TAX_MODE_OPTIONS}
            />
          </div>
          <div className="item-form-grid">
            <TaxedPriceInput
              label="Cost (MVR)"
              required
              value={form.cost_price}
              mode={priceTaxMode}
              taxRate={form.tax_rate}
              onValueChange={(v) => patchForm('cost_price', v)}
              dense
            />
            <TaxedPriceInput
              label="Selling — retail (MVR)"
              required
              value={form.selling_price}
              mode={priceTaxMode}
              taxRate={form.tax_rate}
              onValueChange={(v) => patchForm('selling_price', v)}
              dense
            />
          </div>

          <div className="item-form-subsection">
            <div className="item-form-section__head item-form-section__head--sub">
              <h4>Wholesale &amp; staff</h4>
              <SegmentedControl
                ariaLabel="Category pricing mode"
                value={categoryMode}
                onChange={(v) => patchForm('categoryPricingMode', v)}
                options={[
                  { value: 'pct', label: 'Discount %' },
                  { value: 'price', label: 'Fixed price' },
                ]}
              />
            </div>
            <div className="item-form-grid">
              {categoryMode === 'price' ? (
                <>
                  <TaxedPriceInput
                    label="Wholesale price"
                    value={form.wholesale_price}
                    mode={priceTaxMode}
                    taxRate={form.tax_rate}
                    onValueChange={(v) => patchForm('wholesale_price', v)}
                    placeholder="0.00"
                    dense
                  />
                  <TaxedPriceInput
                    label="Staff price"
                    value={form.staff_price}
                    mode={priceTaxMode}
                    taxRate={form.tax_rate}
                    onValueChange={(v) => patchForm('staff_price', v)}
                    placeholder="0.00"
                    dense
                  />
                </>
              ) : (
                <>
                  <FormGroup label="Wholesale discount %">
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={form.wholesale_discount_pct}
                      onChange={(e) => patchForm('wholesale_discount_pct', e.target.value)}
                      placeholder="0"
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
                      placeholder="0"
                    />
                  </FormGroup>
                </>
              )}
            </div>
          </div>
        </section>

        <section className="item-form-section">
          <div className="item-form-section__head">
            <h3>Inventory</h3>
          </div>
          <div className="item-form-grid item-form-grid--3">
            <FormGroup label="Reorder level">
              <input
                className="form-input"
                type="number"
                min="0"
                step={qtyInputStep()}
                value={form.reorder_level}
                onChange={(e) => patchForm('reorder_level', e.target.value)}
                placeholder="Min stock"
              />
            </FormGroup>
            <div className="item-form-field item-form-field--span2">
              <div className="form-label">Tracking</div>
              <div className="item-form-checks">
                <label className="item-form-check">
                  <input
                    type="checkbox"
                    checked={form.batch_tracking}
                    onChange={(e) => {
                      const v = e.target.checked
                      patchForm('batch_tracking', v)
                      if (!v) patchForm('expiry_tracking', false)
                    }}
                  />
                  Batch / lot
                </label>
                <label className={`item-form-check ${!form.batch_tracking ? 'is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={!form.batch_tracking}
                    checked={form.expiry_tracking}
                    onChange={(e) => patchForm('expiry_tracking', e.target.checked)}
                  />
                  Expiry (FEFO)
                </label>
              </div>
              <div className="item-form-strategy">{strategyHint}</div>
            </div>
          </div>
          {editing && editWasTracked && !form.batch_tracking && (
            <div className="item-form-alert">
              <AlertBar type="amber" icon="⚠️">
                Saving deletes existing batches. Stock remains aggregate-only.
              </AlertBar>
            </div>
          )}
          {editing && !editWasTracked && form.batch_tracking && (
            <div className="item-form-alert">
              <AlertBar type="blue" icon="🧴">
                Saving creates an opening batch per branch from current stock.
              </AlertBar>
            </div>
          )}
        </section>
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

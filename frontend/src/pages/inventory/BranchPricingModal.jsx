import { useEffect, useState } from 'react'
import { AutocompleteDropdown, FormGroup, Modal } from '@/components/ui'
import TaxedPriceInput from './TaxedPriceInput'
import { createBranchRow, profitPercentage, retailBranches } from './itemFormShared'
import { catalogInclusiveAmount } from '@/utils/taxCalc'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { fmt } from '@/utils/helpers'

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

function GpBadge({ value, show = true }) {
  if (!show || value == null) return null
  return (
    <span className={`branch-price-table__gp${value < 0 ? ' is-neg' : ''}`}>
      {value.toFixed(1)}%
    </span>
  )
}

function blankDraft(defaults) {
  return {
    ...createBranchRow(null),
    categoryPricingMode: defaults.categoryPricingMode || 'pct',
  }
}

/**
 * Top-aligned modal to add / edit one branch listing with full pricing.
 * Blank cost/sell/wholesale/staff inherit catalog defaults.
 */
export default function BranchPricingModal({
  open,
  onClose,
  onSave,
  editingRow = null,
  branches = [],
  usedBranchIds = new Set(),
  defaultCost,
  defaultPrice,
  defaultReorder,
  defaultCategoryMode = 'pct',
  defaultWholesalePct = '',
  defaultWholesalePrice = '',
  defaultStaffPct = '',
  defaultStaffPrice = '',
  priceTaxMode = 'inclusive',
  taxRate,
  showOpeningStock = false,
  canEditOpening = true,
}) {
  const options = retailBranches(branches)
  const [draft, setDraft] = useState(() => blankDraft({ categoryPricingMode: defaultCategoryMode }))
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    if (editingRow) {
      setDraft({
        ...editingRow,
        categoryPricingMode:
          editingRow.wholesale_pricing_mode === 'price'
          || editingRow.staff_pricing_mode === 'price'
          || editingRow.categoryPricingMode === 'price'
            ? 'price'
            : (editingRow.wholesale_pricing_mode || editingRow.staff_pricing_mode)
              ? 'pct'
              : (defaultCategoryMode || 'pct'),
      })
    } else {
      const taken = usedBranchIds
      const next = options.find((b) => !taken.has(b.id))
      setDraft({
        ...blankDraft({ categoryPricingMode: defaultCategoryMode }),
        branch_id: next?.id || '',
        branch_name: next?.name || '',
      })
    }
  }, [open, editingRow, defaultCategoryMode]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (field, value) => {
    if (typeof field === 'object' && field !== null && value === undefined) {
      setDraft((d) => ({ ...d, ...field }))
      return
    }
    setDraft((d) => ({ ...d, [field]: value }))
  }

  const categoryMode = draft.categoryPricingMode === 'price' ? 'price' : 'pct'
  const costIncl = catalogInclusiveAmount(
    draft.cost_price === '' || draft.cost_price == null ? defaultCost : draft.cost_price,
    priceTaxMode,
    taxRate,
  )
  const sellIncl = catalogInclusiveAmount(
    draft.selling_price === '' || draft.selling_price == null ? defaultPrice : draft.selling_price,
    priceTaxMode,
    taxRate,
  )
  const retailGp = profitPercentage(costIncl, sellIncl)

  const wholesaleTouched = categoryMode === 'price'
    ? draft.wholesale_price !== '' && draft.wholesale_price != null
    : draft.wholesale_discount_pct !== '' && draft.wholesale_discount_pct != null
  const staffTouched = categoryMode === 'price'
    ? draft.staff_price !== '' && draft.staff_price != null
    : draft.staff_discount_pct !== '' && draft.staff_discount_pct != null

  const wholesaleAmount = !wholesaleTouched
    ? null
    : categoryMode === 'price'
      ? catalogInclusiveAmount(draft.wholesale_price, priceTaxMode, taxRate)
      : sellIncl * (1 - Number(draft.wholesale_discount_pct || 0) / 100)
  const staffAmount = !staffTouched
    ? null
    : categoryMode === 'price'
      ? catalogInclusiveAmount(draft.staff_price, priceTaxMode, taxRate)
      : sellIncl * (1 - Number(draft.staff_discount_pct || 0) / 100)
  const wholesaleGp = wholesaleTouched ? profitPercentage(costIncl, wholesaleAmount) : null
  const staffGp = staffTouched ? profitPercentage(costIncl, staffAmount) : null

  const handleSave = () => {
    if (!draft.branch_id) {
      setError('Select a branch')
      return
    }
    if (usedBranchIds.has(draft.branch_id) && draft.branch_id !== editingRow?.branch_id) {
      setError('That branch is already listed')
      return
    }
    const br = options.find((b) => b.id === draft.branch_id)
    const saved = {
      ...draft,
      branch_name: br?.name || draft.branch_name,
      wholesale_pricing_mode: wholesaleTouched ? categoryMode : '',
      staff_pricing_mode: staffTouched ? categoryMode : '',
      wholesale_discount_pct: categoryMode === 'pct' && wholesaleTouched ? draft.wholesale_discount_pct : (wholesaleTouched ? 0 : ''),
      wholesale_price: categoryMode === 'price' && wholesaleTouched ? draft.wholesale_price : (wholesaleTouched ? 0 : ''),
      staff_discount_pct: categoryMode === 'pct' && staffTouched ? draft.staff_discount_pct : (staffTouched ? 0 : ''),
      staff_price: categoryMode === 'price' && staffTouched ? draft.staff_price : (staffTouched ? 0 : ''),
      categoryPricingMode: categoryMode,
    }
    // Preserve existing override modes when editing and fields left blank intentionally
    // but mode was already set — blank still means inherit (clears override).
    onSave(saved)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingRow ? 'Edit branch pricing' : 'Add branch'}
      icon="🏪"
      size="md"
      align="top"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleSave}>
            {editingRow ? 'Save changes' : 'Add branch'}
          </button>
        </>
      )}
    >
      <div className="branch-price-modal">
        <FormGroup label="Branch" required>
          <AutocompleteDropdown
            value={draft.branch_id || ''}
            onSelectOption={(opt) => patch({
              branch_id: opt?.id || '',
              branch_name: opt?.label || '',
            })}
            options={options.map((b) => ({
              id: b.id,
              label: b.name,
              disabled: usedBranchIds.has(b.id) && b.id !== editingRow?.branch_id,
            }))}
            isSearchFieldRequired={false}
            selectedLabel={draft.branch_name || undefined}
            placeholder="Select branch…"
            searchPlaceholder="Search branches…"
            emptyLabel="No branches found"
          />
        </FormGroup>

        <div className="branch-price-modal__block">
          <div className="branch-price-modal__block-head">
            <h4>Retail pricing</h4>
            <span className="branch-price-modal__gp-label">
              GP%
              {retailGp == null
                ? <span className="branch-price-table__gp">—</span>
                : <GpBadge value={retailGp} />}
            </span>
          </div>
          <p className="item-form-section__hint" style={{ marginTop: 0 }}>
            Blank uses catalog defaults (cost {fmt(Number(defaultCost) || 0)}, sell {fmt(Number(defaultPrice) || 0)}).
          </p>
          <div className="item-form-grid">
            <TaxedPriceInput
              label="Cost (MVR)"
              dense
              value={draft.cost_price ?? ''}
              mode={priceTaxMode}
              taxRate={taxRate}
              placeholder={`Default ${defaultCost || 0}`}
              onValueChange={(v) => patch('cost_price', v)}
            />
            <TaxedPriceInput
              label="Selling — retail (MVR)"
              dense
              value={draft.selling_price ?? ''}
              mode={priceTaxMode}
              taxRate={taxRate}
              placeholder={`Default ${defaultPrice || 0}`}
              onValueChange={(v) => patch('selling_price', v)}
            />
          </div>
        </div>

        <div className="branch-price-modal__block">
          <div className="branch-price-modal__block-head">
            <h4>Wholesale &amp; staff</h4>
            <SegmentedControl
              ariaLabel="Branch category pricing mode"
              value={categoryMode}
              onChange={(v) => patch('categoryPricingMode', v)}
              options={[
                { value: 'price', label: 'Fixed price' },
                { value: 'pct', label: 'Discount %' },
              ]}
            />
          </div>
          <p className="item-form-section__hint" style={{ marginTop: 0 }}>
            Blank inherits catalog wholesale / staff. Enter a value to override for this branch.
          </p>
          <div className="item-form-grid">
            {categoryMode === 'price' ? (
              <>
                <div>
                  <TaxedPriceInput
                    label="Wholesale price"
                    dense
                    value={draft.wholesale_price ?? ''}
                    mode={priceTaxMode}
                    taxRate={taxRate}
                    placeholder={defaultWholesalePrice !== '' && defaultWholesalePrice != null
                      ? `Default ${defaultWholesalePrice}`
                      : 'Catalog default'}
                    onValueChange={(v) => patch('wholesale_price', v)}
                  />
                  <div className="branch-price-modal__field-gp">
                    {wholesaleTouched ? (
                      <>
                        GP%
                        <GpBadge value={wholesaleGp} />
                      </>
                    ) : null}
                  </div>
                </div>
                <div>
                  <TaxedPriceInput
                    label="Staff price"
                    dense
                    value={draft.staff_price ?? ''}
                    mode={priceTaxMode}
                    taxRate={taxRate}
                    placeholder={defaultStaffPrice !== '' && defaultStaffPrice != null
                      ? `Default ${defaultStaffPrice}`
                      : 'Catalog default'}
                    onValueChange={(v) => patch('staff_price', v)}
                  />
                  <div className="branch-price-modal__field-gp">
                    {staffTouched ? (
                      <>
                        GP%
                        <GpBadge value={staffGp} />
                      </>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <FormGroup label="Wholesale discount %">
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={draft.wholesale_discount_pct ?? ''}
                      onChange={(e) => patch('wholesale_discount_pct', e.target.value)}
                      placeholder={defaultWholesalePct !== '' && defaultWholesalePct != null
                        ? `Default ${defaultWholesalePct}`
                        : '0'}
                    />
                  </FormGroup>
                  <div className="branch-price-modal__field-gp">
                    {wholesaleTouched ? (
                      <>
                        GP%
                        <GpBadge value={wholesaleGp} />
                      </>
                    ) : null}
                  </div>
                </div>
                <div>
                  <FormGroup label="Staff discount %">
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={draft.staff_discount_pct ?? ''}
                      onChange={(e) => patch('staff_discount_pct', e.target.value)}
                      placeholder={defaultStaffPct !== '' && defaultStaffPct != null
                        ? `Default ${defaultStaffPct}`
                        : '0'}
                    />
                  </FormGroup>
                  <div className="branch-price-modal__field-gp">
                    {staffTouched ? (
                      <>
                        GP%
                        <GpBadge value={staffGp} />
                      </>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="branch-price-modal__block">
          <h4>Inventory</h4>
          <div className="item-form-grid">
            {showOpeningStock && (
              <FormGroup label="Opening stock">
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step={qtyInputStep()}
                  disabled={!canEditOpening}
                  placeholder="0"
                  value={draft.opening_stock ?? ''}
                  onChange={(e) => patch('opening_stock', e.target.value)}
                  title={!canEditOpening ? 'Opening qty can be set only for newly added branches' : undefined}
                />
              </FormGroup>
            )}
            <FormGroup label="Reorder level">
              <input
                className="form-input"
                type="number"
                min="0"
                step={qtyInputStep()}
                placeholder={String(defaultReorder || 10)}
                value={draft.reorder_level ?? ''}
                onChange={(e) => patch('reorder_level', e.target.value)}
              />
            </FormGroup>
          </div>
        </div>

        {error ? (
          <p style={{ margin: 0, color: 'var(--red)', fontSize: 13 }}>{error}</p>
        ) : null}
      </div>
    </Modal>
  )
}

/**
 * Sales Order modal — Create / Edit / View in one component.
 *
 *   • Create:  editingNumber=null, readOnly=false  → "Create Sales Order"
 *   • Edit:    editingNumber=<#>,  readOnly=false  → "Edit Sales Order — <#>"
 *   • View:    editingNumber=<#>,  readOnly=true   → "Sales Order — <#>"
 *
 * Same fields in all three modes so the operator's mental map is
 * identical — view-only just disables inputs + hides Save. View mode is
 * used for terminal-status SOs (converted / cancelled) where the SO is
 * locked to preserve downstream accounting state.
 *
 * No stock side-effect at create or edit — the SO is intent-only; stock
 * moves only when convert is invoked. See SALES_PHASE_1.md.
 *
 * 2026-05-24: Item Name input replaced with InventoryItemPicker. Every
 * new line now carries a real `item_id` (the SO line is linked to an
 * inventory row). Legacy lines (item_id missing on edit of older SOs)
 * load fine; their picker shows the cached name as "selected" so the
 * operator can still review or × out and re-pick.
 */
import { Modal, FormGroup, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { AUTOCOMPLETE_CUSTOMER_URL } from '@/api'
import InventoryItemPicker from './InventoryItemPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import { emptySaleLine, discountPatternFromItem, applySuggestedDiscountsToSaleLines, customerPricingType, resolveCategoryLinePricing } from './salesFormShared'
import { fmt } from '@/utils/helpers'
import { amountInputStep, qtyInputStep } from '@/utils/decimalPrecision'
import MarginBadge from '@/components/MarginBadge'
import { computeDocumentTotals, lineNetAmount } from '@/utils/documentFormTotals'
import { entityDiscountShares, lineMargin } from '@/utils/marginCalc'

// Per-row discount in % or MVR via lineDiscountType. Backend stores percent only.

export default function OrderFormModal({
  open,
  onClose,
  onSave,
  orderForm,
  pof,
  // `branches` prop dropped 2026-05-24 (no longer needed — branch is
  // sourced from the operator's active branch via SalesPage). Parent
  // can stop passing it; we accept extra props silently for now.
  saving = false,
  editingNumber = null,
  readOnly = false,
  conversionLabel = null,
  /** When true, render only the form body (for full-page DocumentFormShell). */
  embedded = false,
}) {
  const isEdit = !!editingNumber
  const title = readOnly
    ? `Sales Order — ${editingNumber}`
    : conversionLabel
      ? `Create Sales Order — from ${conversionLabel}`
      : isEdit
        ? `Edit Sales Order — ${editingNumber}`
        : 'Create Sales Order'
  const saveLabel = saving
    ? (isEdit ? 'Saving…' : 'Creating…')
    : (isEdit ? 'Save Changes' : 'Create')

  // IDs of items already on other rows — passed to each picker so the
  // operator can't accidentally double-pick the same SKU.
  const pickedIds = orderForm.items.map((it) => it.item_id).filter(Boolean)

  const handlePick = (i, inv) => {
    const pattern = discountPatternFromItem(inv)
    const retailPrice = Number(inv.selling_price || 0) || 0
    const resolved = resolveCategoryLinePricing(
      { ...inv, ...pattern, retailPrice, price: retailPrice },
      orderForm.customerType,
    )
    const next = [...orderForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      price: resolved.price,
      retailPrice,
      costPrice: inv.cost_price ?? inv.costPrice ?? 0,
      taxRate: inv.tax_rate || 0,
      ...pattern,
      lineDiscount: resolved.discountPct,
      lineDiscountType: '%',
    }
    pof('items', next)
  }

  const handleClear = (i) => {
    const next = [...orderForm.items]
    // Wipe identity + name only; keep qty so the operator doesn't have to
    // retype if they just want to swap to a different SKU at the same qty.
    next[i] = { ...next[i], item_id: null, name: '', costPrice: 0 }
    pof('items', next)
  }

  // Toggle the per-row discount unit (% ↔ MVR) and AUTO-CONVERT the value
  // so the effective discount stays constant across the unit switch.
  // Example: 10% on a MVR500 line → toggle to MVR → input becomes 50.
  // Operator no longer has to do the math in their head when changing units.
  const toggleDiscountType = (i) => {
    const next = [...orderForm.items]
    const it = next[i]
    const gross = Number(it.qty || 0) * Number(it.price || 0)
    const raw = Math.max(0, Number(it.lineDiscount || 0))
    const wasAmount = it.lineDiscountType === 'MVR'
    let newVal
    if (wasAmount) {
      newVal = gross > 0 ? (raw / gross) * 100 : 0
    } else {
      newVal = gross * (Math.min(raw, 100) / 100)
    }
    next[i] = {
      ...it,
      lineDiscount: Math.round(newVal * 100) / 100,
      lineDiscountType: wasAmount ? '%' : 'MVR',
    }
    pof('items', next)
  }

  const disableLineDiscount = readOnly || shouldDisableLineDiscount(orderForm.discount)
  const rollup = computeDocumentTotals(orderForm.items, {
    entityDiscount: orderForm.discount,
    entityDiscountType: orderForm.discountType || '%',
    enforceExclusive: !readOnly,
  })
  const discShares = rollup.discountMode === 'entity'
    ? entityDiscountShares(orderForm.items, rollup.entityDiscount)
    : orderForm.items.map(() => 0)

  const formBody = (
    <div className="order-form-shell">
      <div className="order-form-panel">
        <div className="order-form-panel__head">Order basics</div>
        <div className="order-form-grid">
          <DocumentNumberField
            label="Order #"
            docType="sales_order"
            branchId={orderForm.branchId}
            value={orderForm.number}
            onChange={(v) => pof('number', v)}
            isEdit={isEdit}
            editingNumber={editingNumber}
            readOnly={readOnly}
          />
          <FormGroup label="Customer" required>
            <AutocompleteDropdown
              disabled={readOnly}
              value={orderForm.customerId || ''}
              onSelectOption={(opt) => {
                if (!opt) {
                  pof('customerId', '')
                  pof('customerName', '')
                  pof('customerType', 'retail')
                  pof('items', applySuggestedDiscountsToSaleLines(orderForm.items, 'retail'))
                  return
                }
                const type = customerPricingType(opt.raw?.customer_type || 'retail')
                pof('customerId', opt.id)
                pof('customerName', opt.label)
                pof('customerType', type)
                pof('items', applySuggestedDiscountsToSaleLines(orderForm.items, type))
              }}
              fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
              isSearchFieldRequired
              selectedLabel={orderForm.customerName || undefined}
              placeholder="Search customers…"
              searchPlaceholder="Search customers…"
              emptyLabel="No customers found. Add via the Customers page."
              style={{ width: '100%' }}
            />
          </FormGroup>
          <FormGroup label="Expected Date">
            <DatePicker disabled={readOnly}
              value={orderForm.expectedDate}
              onChange={(v) => pof('expectedDate', v)} />
          </FormGroup>
        </div>
      </div>

      <div className="order-form-panel">
        <div className="order-form-items-head">
          <div>
            <div className="order-form-panel__head" style={{ marginBottom: 2 }}>Line items</div>
            <div className="order-form-panel__sub">Pick SKUs, quantities, and line-level discount before review.</div>
          </div>
        </div>

        {/* 2026-05-24: Tax % column removed (defaults to 0 on save —
            backend reapplies if needed). Per-line Discount added.
            Numeric columns are 95px wide (~5 chars at 13.5px font);
            inputs are right-aligned so values read like accounting
            figures. Native number-input spinner buttons hidden globally
            in globals.css so the full 95px is text room. */}
        <div className="order-form-table-wrap">
        <table className="data-table order-form-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 95, textAlign: 'right' }}>Price</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ width: 90, textAlign: 'right' }}>Margin</th>
              <th style={{ width: 110, textAlign: 'right' }}>Total</th>
              {!readOnly && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {orderForm.items.map((it, i) => {
              // value passed to picker: presence of an id OR a name (for
              // legacy rows without item_id) marks it as "selected".
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              // Exclude OTHER rows' picked ids — keep this row's own id off
              // the list so we don't filter ourselves out of the dropdown
              // during a re-pick.
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === 'MVR' ? 'MVR' : '%'
              const lineTotal = lineNetAmount(it)
              const margin = lineMargin(it, { entityDiscountShare: discShares[i] || 0 })
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <InventoryItemPicker
                      branchId={orderForm.branchId}
                      value={pickerValue}
                      onPick={(inv) => handlePick(i, inv)}
                      onClear={() => handleClear(i)}
                      disabled={readOnly}
                      excludeIds={otherPickedIds}
                    />
                  </td>
                  <td>
                    <input className="form-input" type="number" disabled={readOnly}
                      min={qtyInputStep()}
                      step={qtyInputStep()}
                      style={numInputStyle}
                      value={it.qty}
                      onChange={e => { const n = [...orderForm.items]; n[i].qty = e.target.value; pof('items', n) }} />
                  </td>
                  <td>
                    <input className="form-input" type="number" disabled={readOnly}
                      min="0"
                      step={amountInputStep()}
                      style={numInputStyle}
                      value={it.price}
                      onChange={e => { const n = [...orderForm.items]; n[i].price = e.target.value; pof('items', n) }} />
                  </td>
                  <td>
                    {/* Discount = input + tiny toggle. Toggle auto-converts
                        the value across unit change so the EFFECTIVE
                        discount stays the same when switching MVR ↔ %.
                        Backend only stores percent — saveOrder converts
                        before POST. */}
                    <div style={{ display: 'flex', gap: 4, opacity: disableLineDiscount ? 0.6 : 1 }}>
                      <input className="form-input" type="number" disabled={readOnly || disableLineDiscount}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={e => { const n = [...orderForm.items]; n[i].lineDiscount = e.target.value; pof('items', n) }} />
                      <button
                        type="button"
                        disabled={readOnly || disableLineDiscount}
                        onClick={() => toggleDiscountType(i)}
                        title={type === '%' ? 'Switch to amount (MVR)' : 'Switch to percent (%)'}
                        style={discountToggleStyle}
                      >
                        {type}
                      </button>
                    </div>
                  </td>
                  <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    <MarginBadge margin={margin} />
                  </td>
                  <td className="text-right mono" style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
                    {fmt(lineTotal)}
                  </td>
                  {!readOnly && (
                    <td>
                      {orderForm.items.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-danger btn-xs"
                          onClick={() => pof('items', orderForm.items.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        {!readOnly && (
          <button className="btn btn-secondary btn-sm"
            onClick={() => pof('items', [...orderForm.items, emptySaleLine()])}>
            + Add Item
          </button>
        )}
      </div>

      <div className="order-form-panel order-form-panel--muted">
        <DocumentTotalsStrip
          items={orderForm.items}
          entityDiscount={orderForm.discount}
          entityDiscountType={orderForm.discountType || '%'}
          onEntityDiscountChange={readOnly ? undefined : (v) => pof('discount', v)}
          onEntityDiscountTypeChange={readOnly ? undefined : (t) => pof('discountType', t)}
          readOnly={readOnly}
          lineGross={(it) => Number(it.qty || 0) * Number(it.price || 0)}
          showWhenEmpty
          notes={orderForm.notes}
          onNotesChange={readOnly ? undefined : (v) => pof('notes', v)}
          notesHint="Will be displayed on the sales order"
        />
      </div>
    </div>
  )

  if (embedded) return formBody

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={saving}
      title={title}
      icon="📦"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button className="btn btn-primary" onClick={onSave} disabled={saving}>
              {saveLabel}
            </button>
          )}
        </>
      }
    >
      {formBody}
    </Modal>
  )
}

// 2026-05-24: right-aligned + tabular-numerals for SO/Quote item cells.
// Pairs with the right-aligned column headers and the hidden number
// spinner (globals.css) so 4-5 digits fit comfortably in the 95px cells.
const numInputStyle = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

// Compact %/MVR toggle button used inside the Discount cell. Sized to
// match form-input height so the input + toggle align on the same
// baseline. Mono font so % and MVR glyphs are the same width.
const discountToggleStyle = {
  width: 32,
  padding: 0,
  background: 'var(--bg-raised)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'monospace',
  cursor: 'pointer',
  flexShrink: 0,
}

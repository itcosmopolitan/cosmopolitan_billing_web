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
import { fmt } from '@/utils/helpers'
import { Modal, FormGroup } from '@/components/ui'
import InventoryItemPicker from './InventoryItemPicker'
import CustomerPicker from './CustomerPicker'

// 2026-05-24: simplified. Tax column + cart-level Discount were removed
// from the modal at user request ("If needed we can add later"). Per-row
// discount can be expressed in % OR ₹ via the inline toggle — the
// `lineDiscountType` flag on each row picks the interpretation. Math:
//   • '%' (default) → discountAmt = gross × value / 100, capped at gross
//   • '₹'           → discountAmt = value, capped at gross
// Backend stores percent only — saveOrder converts ₹ → % before POST.
function lineDiscountAmount(it, gross) {
  const raw = Math.max(0, Number(it.lineDiscount || 0))
  if (it.lineDiscountType === '₹') return Math.min(gross, raw)
  // '%' — also handles legacy rows without the type field.
  return Math.min(gross, gross * (Math.min(raw, 100) / 100))
}

function computeTotals(items) {
  let gross = 0
  let discount = 0
  items.forEach((it) => {
    const g = Number(it.qty || 0) * Number(it.price || 0)
    gross += g
    discount += lineDiscountAmount(it, g)
  })
  return { gross, discount, total: Math.max(0, gross - discount) }
}

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
}) {
  const isEdit = !!editingNumber
  const title = readOnly
    ? `Sales Order — ${editingNumber}`
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
    const next = [...orderForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      price: inv.selling_price,
      taxRate: inv.tax_rate || 0,
    }
    pof('items', next)
  }

  const handleClear = (i) => {
    const next = [...orderForm.items]
    // Wipe identity + name only; keep qty so the operator doesn't have to
    // retype if they just want to swap to a different SKU at the same qty.
    next[i] = { ...next[i], item_id: null, name: '' }
    pof('items', next)
  }

  // Toggle the per-row discount unit (% ↔ ₹) and AUTO-CONVERT the value
  // so the effective discount stays constant across the unit switch.
  // Example: 10% on a ₹500 line → toggle to ₹ → input becomes 50.
  // Operator no longer has to do the math in their head when changing units.
  const toggleDiscountType = (i) => {
    const next = [...orderForm.items]
    const it = next[i]
    const gross = Number(it.qty || 0) * Number(it.price || 0)
    const raw = Math.max(0, Number(it.lineDiscount || 0))
    const wasAmount = it.lineDiscountType === '₹'
    let newVal
    if (wasAmount) {
      newVal = gross > 0 ? (raw / gross) * 100 : 0
    } else {
      newVal = gross * (Math.min(raw, 100) / 100)
    }
    next[i] = {
      ...it,
      lineDiscount: Math.round(newVal * 100) / 100,
      lineDiscountType: wasAmount ? '%' : '₹',
    }
    pof('items', next)
  }

  const totals = computeTotals(orderForm.items)

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
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
      {/* 2026-05-24: simplified header to just Customer + Expected Date.
          Branch is implicit (always the active branch — see
          SalesPage.openCreateOrder). Cart-level discount field was
          removed in favour of per-line discounts in the items table —
          "If needed we can add later" per user. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Customer" required>
          <CustomerPicker
            disabled={readOnly}
            value={orderForm.customerId
              ? { id: orderForm.customerId, name: orderForm.customerName }
              : null}
            onPick={(c) => {
              // Set both fields together — saveOrder forwards `customer_id`
              // to the backend; `customer_name` is also persisted (denormalised)
              // so detail panels stay readable even if the customer is later
              // renamed or deleted.
              pof('customerId', c.id)
              pof('customerName', c.name)
            }}
            onClear={() => {
              pof('customerId', '')
              pof('customerName', '')
            }}
          />
        </FormGroup>
        <FormGroup label="Expected Date">
          <input className="form-input" type="date" disabled={readOnly}
            value={orderForm.expectedDate}
            onChange={e => pof('expectedDate', e.target.value)} />
        </FormGroup>
      </div>
      <FormGroup label="Items" required>
        {/* 2026-05-24: Tax % column removed (defaults to 0 on save —
            backend reapplies if needed). Per-line Discount added.
            Numeric columns are 95px wide (~5 chars at 13.5px font);
            inputs are right-aligned so values read like accounting
            figures. Native number-input spinner buttons hidden globally
            in globals.css so the full 95px is text room. */}
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 95, textAlign: 'right' }}>Price</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
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
              const type = it.lineDiscountType === '₹' ? '₹' : '%'
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
                      style={numInputStyle}
                      value={it.qty}
                      onChange={e => { const n = [...orderForm.items]; n[i].qty = e.target.value; pof('items', n) }} />
                  </td>
                  <td>
                    <input className="form-input" type="number" disabled={readOnly}
                      style={numInputStyle}
                      value={it.price}
                      onChange={e => { const n = [...orderForm.items]; n[i].price = e.target.value; pof('items', n) }} />
                  </td>
                  <td>
                    {/* Discount = input + tiny toggle. Toggle auto-converts
                        the value across unit change so the EFFECTIVE
                        discount stays the same when switching ₹ ↔ %.
                        Backend only stores percent — saveOrder converts
                        before POST. */}
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input className="form-input" type="number" disabled={readOnly}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={e => { const n = [...orderForm.items]; n[i].lineDiscount = e.target.value; pof('items', n) }} />
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => toggleDiscountType(i)}
                        title={type === '%' ? 'Switch to amount (₹)' : 'Switch to percent (%)'}
                        style={discountToggleStyle}
                      >
                        {type}
                      </button>
                    </div>
                  </td>
                  {!readOnly && (
                    <td>
                      <button className="btn btn-danger btn-xs"
                        onClick={() => pof('items', orderForm.items.filter((_, j) => j !== i))}>Remove</button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!readOnly && (
          <button className="btn btn-secondary btn-sm"
            onClick={() => pof('items', [...orderForm.items, { item_id: null, name: '', qty: 1, price: 0, taxRate: 0, lineDiscount: 0, lineDiscountType: '%' }])}>
            + Add Item
          </button>
        )}
      </FormGroup>

      {/* Totals strip — Subtotal = sum of qty × price; Discount = sum of
          line discounts (shown only when > 0 so plain-pricing SOs stay
          quiet); Total = the bottom line. No GST / no cart-level
          discount in this build — see computeTotals + the user note from
          2026-05-24 ("If needed we can add later"). */}
      {orderForm.items.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <div style={{ minWidth: 240 }}>
            <div style={totalsRowStyle}>
              <span style={totalsLabelStyle}>Subtotal</span>
              <span className="mono" style={totalsValueStyle}>{fmt(totals.gross)}</span>
            </div>
            {totals.discount > 0 && (
              <div style={totalsRowStyle}>
                <span style={totalsLabelStyle}>Discount</span>
                <span className="mono" style={{ ...totalsValueStyle, color: 'var(--green)' }}>−{fmt(totals.discount)}</span>
              </div>
            )}
            <div style={{ ...totalsRowStyle, borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 4 }}>
              <span style={{ ...totalsLabelStyle, fontWeight: 600, color: 'var(--text-primary)' }}>Total</span>
              <span className="mono" style={{ ...totalsValueStyle, fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{fmt(totals.total)}</span>
            </div>
          </div>
        </div>
      )}

      <FormGroup label="Notes">
        <textarea className="form-input" style={{ height: 72 }} disabled={readOnly}
          value={orderForm.notes} onChange={e => pof('notes', e.target.value)} />
      </FormGroup>
    </Modal>
  )
}

const totalsRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  padding: '3px 0',
  fontSize: 13,
}
const totalsLabelStyle = { color: 'var(--text-muted)' }
const totalsValueStyle = { color: 'var(--text-primary)' }

// 2026-05-24: right-aligned + tabular-numerals for SO/Quote item cells.
// Pairs with the right-aligned column headers and the hidden number
// spinner (globals.css) so 4-5 digits fit comfortably in the 95px cells.
const numInputStyle = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

// Compact %/₹ toggle button used inside the Discount cell. Sized to
// match form-input height so the input + toggle align on the same
// baseline. Mono font so % and ₹ glyphs are the same width.
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

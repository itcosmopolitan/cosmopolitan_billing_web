/**
 * Purchase Order modal — Create / Edit / View in one component.
 * Mirror of sales/OrderFormModal so the two flows feel identical.
 *
 *   • Create:  editingNumber=null, readOnly=false  → "Create Purchase Order"
 *   • Edit:    editingNumber=<#>,  readOnly=false  → "Edit Purchase Order — <#>"
 *   • View:    editingNumber=<#>,  readOnly=true   → "Purchase Order — <#>"
 *
 * No stock side-effect at create / edit — the PO is intent-only; stock
 * moves only when convert is invoked (which spawns a PurchaseBill,
 * which is what creates batches via add_batch_atomic).
 *
 * Branch is implicit (operator's active branch from Topbar) — no inline
 * branch picker, matching the sales SO modal. Vendor uses the strict
 * VendorPicker; items use the shared InventoryItemPicker.
 */
import { fmt } from '@/utils/helpers'
import { Modal, FormGroup } from '@/components/ui'
import InventoryItemPicker from '@/pages/sales/InventoryItemPicker'
import VendorPicker from './VendorPicker'

// Same shape as sales/OrderFormModal — supports % or ₹ per-line discount
// via lineDiscountType. Backend stores percent only (parent's save mapper
// converts ₹ → % before POST).
function lineDiscountAmount(it, gross) {
  const raw = Math.max(0, Number(it.lineDiscount || 0))
  if (it.lineDiscountType === '₹') return Math.min(gross, raw)
  return Math.min(gross, gross * (Math.min(raw, 100) / 100))
}

function computeTotals(items) {
  let gross = 0
  let discount = 0
  items.forEach((it) => {
    // Note: purchase lines use `cost`, not `price`. Same math, different name.
    const g = Number(it.qty || 0) * Number(it.cost || 0)
    gross += g
    discount += lineDiscountAmount(it, g)
  })
  return { gross, discount, total: Math.max(0, gross - discount) }
}

export default function PurchaseOrderFormModal({
  open,
  onClose,
  onSave,
  poForm,
  ppof,                     // patcher: (key, value) => setForm({...form, [key]: value})
  saving = false,
  editingNumber = null,
  readOnly = false,
}) {
  const isEdit = !!editingNumber
  const title = readOnly
    ? `Purchase Order — ${editingNumber}`
    : isEdit
      ? `Edit Purchase Order — ${editingNumber}`
      : 'Create Purchase Order'
  const saveLabel = saving
    ? (isEdit ? 'Saving…' : 'Creating…')
    : (isEdit ? 'Save Changes' : 'Create')

  const pickedIds = poForm.items.map((it) => it.item_id).filter(Boolean)

  const handlePick = (i, inv) => {
    const next = [...poForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      // Purchase context: prefer the item's `cost_price` (what we usually
      // pay the vendor) over `selling_price`. Operator can override per
      // line if this vendor quoted a different rate.
      cost: inv.cost_price ?? inv.selling_price ?? 0,
      taxRate: inv.tax_rate || 0,
    }
    ppof('items', next)
  }

  const handleClear = (i) => {
    const next = [...poForm.items]
    next[i] = { ...next[i], item_id: null, name: '' }
    ppof('items', next)
  }

  // Toggle discount unit on a row — auto-converts the value so the
  // EFFECTIVE discount stays constant. Identical logic to sales/OrderFormModal.
  const toggleDiscountType = (i) => {
    const next = [...poForm.items]
    const it = next[i]
    const gross = Number(it.qty || 0) * Number(it.cost || 0)
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
    ppof('items', next)
  }

  const totals = computeTotals(poForm.items)

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
      {/* Header: Vendor + Expected Date. Branch is implicit. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Vendor" required>
          <VendorPicker
            disabled={readOnly}
            value={poForm.vendorId
              ? { id: poForm.vendorId, name: poForm.vendorName }
              : null}
            onPick={(v) => {
              ppof('vendorId', v.id)
              ppof('vendorName', v.name)
            }}
            onClear={() => {
              ppof('vendorId', '')
              ppof('vendorName', '')
            }}
          />
        </FormGroup>
        <FormGroup label="Expected Date">
          <input className="form-input" type="date" disabled={readOnly}
            value={poForm.expectedDate}
            onChange={e => ppof('expectedDate', e.target.value)} />
        </FormGroup>
      </div>

      <FormGroup label="Items" required>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 95, textAlign: 'right' }}>Cost</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              {!readOnly && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {poForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === '₹' ? '₹' : '%'
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <InventoryItemPicker
                      branchId={poForm.branchId}
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
                      onChange={e => { const n = [...poForm.items]; n[i].qty = e.target.value; ppof('items', n) }} />
                  </td>
                  <td>
                    <input className="form-input" type="number" disabled={readOnly}
                      style={numInputStyle}
                      value={it.cost}
                      onChange={e => { const n = [...poForm.items]; n[i].cost = e.target.value; ppof('items', n) }} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input className="form-input" type="number" disabled={readOnly}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={e => { const n = [...poForm.items]; n[i].lineDiscount = e.target.value; ppof('items', n) }} />
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
                        onClick={() => ppof('items', poForm.items.filter((_, j) => j !== i))}>Remove</button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!readOnly && (
          <button className="btn btn-secondary btn-sm"
            onClick={() => ppof('items', [...poForm.items, { item_id: null, name: '', qty: 1, cost: 0, taxRate: 0, lineDiscount: 0, lineDiscountType: '%' }])}>
            + Add Item
          </button>
        )}
      </FormGroup>

      {poForm.items.length > 0 && (
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
          value={poForm.notes} onChange={e => ppof('notes', e.target.value)} />
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
const numInputStyle = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}
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

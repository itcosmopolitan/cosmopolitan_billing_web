/**
 * Quotation modal — Create / Edit / View in one component. Mirrors the
 * shape of OrderFormModal (same editingNumber + readOnly props) so the
 * two intents feel identical to operators. Stateless — parent owns
 * `quoteForm` and the patcher; we just render the controls.
 *
 *   • Create:  editingNumber=null, readOnly=false  → "Create Quotation"
 *   • Edit:    editingNumber=<#>,  readOnly=false  → "Edit Quotation — <#>"
 *   • View:    editingNumber=<#>,  readOnly=true   → "Quotation — <#>"
 *
 * View mode is used for terminal-status quotes (accepted / converted /
 * rejected) where editing would orphan downstream SOs/invoices that were
 * created from the original prices.
 *
 * 2026-05-24: Item Name input replaced with InventoryItemPicker. See
 * OrderFormModal for the rationale + legacy-row handling notes — the
 * implementation here is the same.
 */
import { Modal, FormGroup } from '@/components/ui'
import InventoryItemPicker from './InventoryItemPicker'
import CustomerPicker from './CustomerPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'

export default function QuoteFormModal({
  open,
  onClose,
  onSave,
  quoteForm,
  pqf,
  saving = false,
  editingNumber = null,
  readOnly = false,
  /** When true, render only the form body (for full-page DocumentFormShell). */
  embedded = false,
}) {
  const isEdit = !!editingNumber
  const title = readOnly
    ? `Quotation — ${editingNumber}`
    : isEdit
      ? `Edit Quotation — ${editingNumber}`
      : 'Create Quotation'
  const saveLabel = saving
    ? (isEdit ? 'Saving…' : 'Creating…')
    : (isEdit ? 'Save Changes' : 'Create')

  const pickedIds = quoteForm.items.map((it) => it.item_id).filter(Boolean)

  const handlePick = (i, inv) => {
    const next = [...quoteForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      price: inv.selling_price,
      taxRate: inv.tax_rate || 0,
    }
    pqf('items', next)
  }

  const handleClear = (i) => {
    const next = [...quoteForm.items]
    next[i] = { ...next[i], item_id: null, name: '' }
    pqf('items', next)
  }

  // See OrderFormModal#toggleDiscountType — same auto-conversion logic.
  const toggleDiscountType = (i) => {
    const next = [...quoteForm.items]
    const it = next[i]
    const gross = Number(it.qty || 0) * Number(it.price || 0)
    const raw = Math.max(0, Number(it.lineDiscount || 0))
    const wasAmount = it.lineDiscountType === 'Rf'
    let newVal
    if (wasAmount) {
      newVal = gross > 0 ? (raw / gross) * 100 : 0
    } else {
      newVal = gross * (Math.min(raw, 100) / 100)
    }
    next[i] = {
      ...it,
      lineDiscount: Math.round(newVal * 100) / 100,
      lineDiscountType: wasAmount ? '%' : 'Rf',
    }
    pqf('items', next)
  }

  const disableLineDiscount = readOnly || shouldDisableLineDiscount(quoteForm.discount)

  const formBody = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
        <DocumentNumberField
          label="Quotation #"
          docType="quotation"
          branchId={quoteForm.branchId}
          value={quoteForm.number}
          onChange={(v) => pqf('number', v)}
          isEdit={isEdit}
          editingNumber={editingNumber}
          readOnly={readOnly}
        />
        <FormGroup label="Customer" required>
          <CustomerPicker
            disabled={readOnly}
            value={quoteForm.customerId
              ? { id: quoteForm.customerId, name: quoteForm.customerName }
              : null}
            onPick={(c) => {
              pqf('customerId', c.id)
              pqf('customerName', c.name)
            }}
            onClear={() => {
              pqf('customerId', '')
              pqf('customerName', '')
            }}
          />
        </FormGroup>
        <FormGroup label="Valid Until">
          <input className="form-input" type="date" disabled={readOnly}
            value={quoteForm.validUntil} onChange={e => pqf('validUntil', e.target.value)} />
        </FormGroup>
      </div>
      <FormGroup label="Items" required>
        {/* 2026-05-24: same column changes as OrderFormModal — Tax % out,
            per-line Discount in, 95px right-aligned numeric columns
            (native number spinner hidden globally; see globals.css). */}
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
            {quoteForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === 'Rf' ? 'Rf' : '%'
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <InventoryItemPicker
                      branchId={quoteForm.branchId}
                      value={pickerValue}
                      onPick={(inv) => handlePick(i, inv)}
                      onClear={() => handleClear(i)}
                      disabled={readOnly}
                      excludeIds={otherPickedIds}
                    />
                  </td>
                  <td><input className="form-input" type="number" disabled={readOnly} style={numInputStyle}
                    value={it.qty} onChange={e => { const n = [...quoteForm.items]; n[i].qty = e.target.value; pqf('items', n) }} /></td>
                  <td><input className="form-input" type="number" disabled={readOnly} style={numInputStyle}
                    value={it.price} onChange={e => { const n = [...quoteForm.items]; n[i].price = e.target.value; pqf('items', n) }} /></td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, opacity: disableLineDiscount ? 0.6 : 1 }}>
                      <input className="form-input" type="number" disabled={readOnly || disableLineDiscount}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={e => { const n = [...quoteForm.items]; n[i].lineDiscount = e.target.value; pqf('items', n) }} />
                      <button
                        type="button"
                        disabled={readOnly || disableLineDiscount}
                        onClick={() => toggleDiscountType(i)}
                        title={type === '%' ? 'Switch to amount (Rf)' : 'Switch to percent (%)'}
                        style={discountToggleStyle}
                      >
                        {type}
                      </button>
                    </div>
                  </td>
                  {!readOnly && (
                    <td><button className="btn btn-danger btn-xs"
                      onClick={() => pqf('items', quoteForm.items.filter((_, j) => j !== i))}>Remove</button></td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!readOnly && (
          <button className="btn btn-secondary btn-sm"
            onClick={() => pqf('items', [...quoteForm.items, { item_id: null, name: '', qty: 1, price: 0, taxRate: 0, lineDiscount: 0, lineDiscountType: '%' }])}>+ Add Item</button>
        )}
      </FormGroup>

      <DocumentTotalsStrip
        items={quoteForm.items}
        entityDiscount={quoteForm.discount}
        entityDiscountType={quoteForm.discountType || '%'}
        onEntityDiscountChange={readOnly ? undefined : (v) => pqf('discount', v)}
        onEntityDiscountTypeChange={readOnly ? undefined : (t) => pqf('discountType', t)}
        readOnly={readOnly}
        lineGross={(it) => Number(it.qty || 0) * Number(it.price || 0)}
      />

      <FormGroup label="Notes">
        <textarea className="form-input" style={{ height: 72 }} disabled={readOnly}
          value={quoteForm.notes} onChange={e => pqf('notes', e.target.value)} />
      </FormGroup>
    </>
  )

  if (embedded) return formBody

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={title}
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

// See OrderFormModal — same right-aligned + tabular-numerals style.
const numInputStyle = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

// See OrderFormModal#discountToggleStyle — same %/Rf toggle.
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

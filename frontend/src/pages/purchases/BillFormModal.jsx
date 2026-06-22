/**
 * Purchase Bill modal — Create only (bills are immutable per the user
 * decision; only Record Payment + Cancel are allowed once a bill exists).
 *
 * Layout mirrors PurchaseOrderFormModal / sales OrderFormModal:
 *   • Vendor (picker) + Bill Date in row 1.
 *   • Due Date + "Payment received?" checkbox in row 2.
 *   • Items: Item picker, Qty, Cost, Discount (% / MVR toggle).
 *   • For batch-tracked items, a compact second row under the line
 *     captures lot # / mfg date / expiry date (same shape as the old
 *     NewBillModal, just rendered inline below the line instead of
 *     beside it).
 *   • Totals strip.
 *   • Notes.
 *
 * Branch is implicit (parent passes the active branch).
 *
 * Backend stock side-effect: tracked items create a new ItemBatch
 * (auto-numbered if batch # blank); untracked items just bump aggregate.
 * That all happens server-side in create_bill.
 */
import { Fragment } from 'react'
import { todayISO } from '@/utils/batchDates'
import { Modal, FormGroup, AlertBar } from '@/components/ui'
import InventoryItemPicker from '@/pages/sales/InventoryItemPicker'
import VendorPicker from './VendorPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'

export default function BillFormModal({
  open,
  onClose,
  onSave,
  billForm,
  pbf,                     // patcher
  saving = false,
  /** `bill` (default) or `grn` — GRN mode hides payment fields and labels receipt date. */
  mode = 'bill',
  conversionLabel = null,
  /** When true, render only the form body (for full-page DocumentFormShell). */
  embedded = false,
  /** When true, hide payment fields (editing an existing bill — payment is handled separately). */
  editMode = false,
}) {
  const isGrn = mode === 'grn'
  const pickedIds = billForm.items.map((it) => it.item_id).filter(Boolean)
  const title = conversionLabel
    ? (isGrn ? `Receive Stock — from ${conversionLabel}` : `Create Bill — from ${conversionLabel}`)
    : (isGrn ? 'New Goods Receipt (GRN)' : 'New Purchase Bill')

  const handlePick = (i, inv) => {
    const next = [...billForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      cost: inv.cost_price ?? inv.selling_price ?? 0,
      taxRate: inv.tax_rate || 0,
      // Cache batch flags for the conditional row render below.
      batchTracking: Boolean(inv.batch_tracking),
      expiryTracking: Boolean(inv.expiry_tracking),
    }
    pbf('items', next)
  }

  const handleClear = (i) => {
    const next = [...billForm.items]
    next[i] = { ...next[i], item_id: null, name: '', batchTracking: false, expiryTracking: false }
    pbf('items', next)
  }

  const toggleDiscountType = (i) => {
    const next = [...billForm.items]
    const it = next[i]
    const gross = Number(it.qty || 0) * Number(it.cost || 0)
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
    pbf('items', next)
  }

  const hasTrackedItems = billForm.items.some((it) => it.batchTracking)
  const disableLineDiscount = shouldDisableLineDiscount(billForm.discount)

  const formBody = (
    <div className="bill-form-shell">
      <div className="bill-form-panel">
        <div className="bill-form-panel__head">Bill basics</div>
        <div className="bill-form-grid">
          <DocumentNumberField
            label={isGrn ? 'GRN #' : 'Bill #'}
            docType={isGrn ? 'grn' : 'purchase_bill'}
            branchId={billForm.branchId}
            value={billForm.number}
            onChange={(v) => pbf('number', v)}
          />
          <FormGroup label="Vendor" required>
            <VendorPicker
              value={billForm.vendorId
                ? { id: billForm.vendorId, name: billForm.vendorName }
                : null}
              onPick={(v) => {
                pbf('vendorId', v.id)
                pbf('vendorName', v.name)
              }}
              onClear={() => {
                pbf('vendorId', '')
                pbf('vendorName', '')
              }}
            />
          </FormGroup>
          <FormGroup label={isGrn ? 'Receipt Date' : 'Bill Date'}>
            <input className="form-input" type="date"
              value={billForm.billDate || todayISO()}
              onChange={(e) => pbf('billDate', e.target.value)} />
          </FormGroup>
        </div>

        {!isGrn && !editMode && (
          <div className="bill-form-meta-grid">
            <FormGroup label="Due Date">
              <input className="form-input" type="date"
                value={billForm.dueDate || ''}
                onChange={(e) => pbf('dueDate', e.target.value)} />
            </FormGroup>
            <FormGroup label="Payment">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px',
                  border: `1.5px solid ${billForm.paymentReceived ? 'var(--accent)' : 'var(--border-default)'}`,
                  background: billForm.paymentReceived ? 'var(--accent-bg)' : 'transparent',
                  borderRadius: 6, cursor: 'pointer',
                  fontSize: 13, fontWeight: 500,
                  color: billForm.paymentReceived ? 'var(--accent)' : 'var(--text-secondary)',
                }}>
                  <input
                    type="checkbox"
                    checked={!!billForm.paymentReceived}
                    onChange={(e) => pbf('paymentReceived', e.target.checked)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span>Payment paid?</span>
                </label>
                {billForm.paymentReceived && (
                  <select
                    className="form-input"
                    value={billForm.paymentMethod || ''}
                    onChange={(e) => pbf('paymentMethod', e.target.value || null)}
                    style={{ fontSize: 13 }}
                  >
                    <option value="" disabled>Select method…</option>
                    <option value="cash">💵 Cash</option>
                    <option value="card">💳 Card</option>
                    <option value="upi">📱 UPI</option>
                    <option value="bank_transfer">🏦 Bank Transfer</option>
                  </select>
                )}
              </div>
            </FormGroup>
          </div>
        )}
      </div>

      {editMode && (
        <div style={{ marginBottom: 16 }}>
          <FormGroup label="Due Date">
            <input className="form-input" type="date"
              value={billForm.dueDate || ''}
              onChange={(e) => pbf('dueDate', e.target.value)} />
          </FormGroup>
        </div>
      )}

      {isGrn && (
        <div style={{ marginBottom: 16 }}>
          <AlertBar type="blue" icon="ℹ️">
            Stock is added immediately. Create a bill later from the GRN tab via <strong>To Bill</strong>.
          </AlertBar>
        </div>
      )}

      <div className="bill-form-panel">
        <div className="bill-form-panel__head">Line items</div>
        <FormGroup label="Items" required>
        {hasTrackedItems && (
          <>
            <AlertBar type="blue" icon="🧴">
              Batch-tracked items need a lot # and expiry for FIFO/FEFO consumption.
              Leave the batch # blank to auto-generate one.
            </AlertBar>
            <div style={{ height: 10 }} />
          </>
        )}
        <div className="bill-form-table-wrap">
        <table className="data-table bill-form-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 95, textAlign: 'right' }}>Cost</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {billForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === 'MVR' ? 'MVR' : '%'
              return (
                <Fragment key={i}>
                  <tr>
                    <td style={{ minWidth: 220 }}>
                      <InventoryItemPicker
                        branchId={billForm.branchId}
                        value={pickerValue}
                        onPick={(inv) => handlePick(i, inv)}
                        onClear={() => handleClear(i)}
                        excludeIds={otherPickedIds}
                      />
                    </td>
                    <td>
                      <input className="form-input" type="number"
                        style={numInputStyle}
                        value={it.qty}
                        onChange={(e) => { const n = [...billForm.items]; n[i].qty = e.target.value; pbf('items', n) }} />
                    </td>
                    <td>
                      <input className="form-input" type="number"
                        style={numInputStyle}
                        value={it.cost}
                        onChange={(e) => { const n = [...billForm.items]; n[i].cost = e.target.value; pbf('items', n) }} />
                    </td>
                    <td>
                      <div className="line-discount-field" style={{ opacity: disableLineDiscount ? 0.6 : 1 }}>
                        <input className="form-input" type="number" disabled={disableLineDiscount}
                          style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                          value={it.lineDiscount || 0}
                          onChange={(e) => { const n = [...billForm.items]; n[i].lineDiscount = e.target.value; pbf('items', n) }} />
                        <button
                          type="button"
                          disabled={disableLineDiscount}
                          onClick={() => toggleDiscountType(i)}
                          title={type === '%' ? 'Switch to amount (MVR)' : 'Switch to percent (%)'}
                          style={discountToggleStyle}
                        >
                          {type}
                        </button>
                      </div>
                    </td>
                    <td>
                      <button className="btn btn-danger btn-xs"
                        onClick={() => pbf('items', billForm.items.filter((_, j) => j !== i))}>Remove</button>
                    </td>
                  </tr>
                  {it.batchTracking && (
                    <tr>
                      {/* Batch capture row spans all 5 columns. Compact
                          inputs for lot # / mfg / expiry. */}
                      <td colSpan={5} style={{ padding: '6px 10px 12px', background: 'var(--bg-raised)' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', fontSize: 12 }}>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 500, minWidth: 90, paddingBottom: 8 }}>
                            🧴 Batch capture:
                          </span>
                          <label style={batchFieldStyle}>
                            <span style={batchLabelStyle}>Batch / Lot #</span>
                            <input className="form-input" type="text"
                              placeholder="Auto-generated if blank"
                              value={it.batchNumber || ''}
                              onChange={(e) => { const n = [...billForm.items]; n[i].batchNumber = e.target.value; pbf('items', n) }}
                              style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} />
                          </label>
                          <label style={{ ...batchFieldStyle, flex: '0 0 145px' }}>
                            <span style={batchLabelStyle}>Mfg date</span>
                            <input className="form-input" type="date"
                              value={it.mfgDate || ''}
                              onChange={(e) => { const n = [...billForm.items]; n[i].mfgDate = e.target.value; pbf('items', n) }}
                              style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} />
                          </label>
                          <label style={{ ...batchFieldStyle, flex: '0 0 145px' }}>
                            <span style={batchLabelStyle}>
                              Expiry date{it.expiryTracking && <span style={{ color: 'var(--red)' }}> *</span>}
                            </span>
                            <input className="form-input" type="date"
                              value={it.expiryDate || ''}
                              onChange={(e) => { const n = [...billForm.items]; n[i].expiryDate = e.target.value; pbf('items', n) }}
                              style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} />
                          </label>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        </div>
        <button className="btn btn-secondary btn-sm"
          onClick={() => pbf('items', [...billForm.items, { item_id: null, name: '', qty: 1, cost: 0, taxRate: 0, lineDiscount: 0, lineDiscountType: '%', batchTracking: false, expiryTracking: false, batchNumber: '', mfgDate: '', expiryDate: '' }])}>
          + Add Item
        </button>
        </FormGroup>
      </div>

      <div className="bill-form-panel bill-form-panel--muted">
        <DocumentTotalsStrip
          items={billForm.items}
          entityDiscount={billForm.discount}
          entityDiscountType={billForm.discountType || '%'}
          onEntityDiscountChange={(v) => pbf('discount', v)}
          onEntityDiscountTypeChange={(t) => pbf('discountType', t)}
          lineGross={(it) => Number(it.qty || 0) * Number(it.cost || 0)}
        />

        <FormGroup label="Notes">
          <textarea className="form-input" style={{ height: 72 }}
            value={billForm.notes || ''}
            onChange={(e) => pbf('notes', e.target.value)} />
        </FormGroup>
      </div>
    </div>
  )

  if (embedded) return formBody

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={title}
      icon={isGrn ? '📦' : '📋'}
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : (isGrn ? 'Receive Stock' : 'Save Bill')}
          </button>
        </>
      }
    >
      {formBody}
    </Modal>
  )
}

// 2026-05-31: labeled batch-capture fields (Batch # / Mfg / Expiry).
const batchFieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  flex: 1,
  minWidth: 0,
}
const batchLabelStyle = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
}
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

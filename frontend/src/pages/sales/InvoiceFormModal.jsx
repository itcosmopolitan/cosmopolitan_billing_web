/**
 * Invoice modal — create from scratch or from a prefilled conversion
 * (quotation → invoice, sales order → invoice).
 */
import { useState } from 'react'
import { Modal, FormGroup } from '@/components/ui'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import LineBatchAllocationField from '@/components/LineBatchAllocationField'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import InventoryItemPicker from './InventoryItemPicker'
import CustomerPicker from './CustomerPicker'
import { emptySaleLine } from './salesFormShared'

export default function InvoiceFormModal({
  open,
  onClose,
  onSave,
  invoiceForm,
  pif,
  saving = false,
  conversionLabel = null,
  /** When true, render only the form body (for full-page DocumentFormShell). */
  embedded = false,
}) {
  const title = conversionLabel
    ? `Create Invoice — from ${conversionLabel}`
    : 'Create Invoice'
  const pickedIds = invoiceForm.items.map((it) => it.item_id).filter(Boolean)
  const [allocEditor, setAllocEditor] = useState(null)

  const patchLine = (i, patch) => {
    const next = [...invoiceForm.items]
    next[i] = { ...next[i], ...patch }
    pif('items', next)
  }

  const handlePick = (i, inv) => {
    patchLine(i, {
      item_id: inv.id,
      name: inv.name,
      price: inv.selling_price,
      taxRate: inv.tax_rate || 0,
      batchTracking: Boolean(inv.batch_tracking),
      expiryTracking: Boolean(inv.expiry_tracking),
      batchAllocation: [],
      batchAllocationCustom: false,
    })
  }

  const handleClear = (i) => {
    patchLine(i, {
      item_id: null,
      name: '',
      batchTracking: false,
      expiryTracking: false,
      batchAllocation: [],
      batchAllocationCustom: false,
    })
  }

  const toggleDiscountType = (i) => {
    const next = [...invoiceForm.items]
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
    pif('items', next)
  }

  const disableLineDiscount = shouldDisableLineDiscount(invoiceForm.discount)

  const formBody = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
        <DocumentNumberField
          label="Invoice #"
          docType="sales_invoice"
          branchId={invoiceForm.branchId}
          value={invoiceForm.number}
          onChange={(v) => pif('number', v)}
        />
        <FormGroup label="Customer" required>
          <CustomerPicker
            value={invoiceForm.customerId
              ? { id: invoiceForm.customerId, name: invoiceForm.customerName }
              : null}
            onPick={(c) => {
              pif('customerId', c.id)
              pif('customerName', c.name)
            }}
            onClear={() => {
              pif('customerId', '')
              pif('customerName', '')
            }}
          />
        </FormGroup>
        <FormGroup label="Invoice Date">
          <input className="form-input" type="date"
            value={invoiceForm.invoiceDate}
            onChange={(e) => pif('invoiceDate', e.target.value)} />
        </FormGroup>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Payment">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px',
              border: `1.5px solid ${invoiceForm.paymentReceived ? 'var(--accent)' : 'var(--border-default)'}`,
              background: invoiceForm.paymentReceived ? 'var(--accent-bg)' : 'transparent',
              borderRadius: 6, cursor: 'pointer',
              fontSize: 13, fontWeight: 500,
              color: invoiceForm.paymentReceived ? 'var(--accent)' : 'var(--text-secondary)',
            }}>
              <input
                type="checkbox"
                checked={!!invoiceForm.paymentReceived}
                onChange={(e) => pif('paymentReceived', e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span>Payment received?</span>
            </label>
            {invoiceForm.paymentReceived && (
              <select
                className="form-input"
                value={invoiceForm.paymentMethod || ''}
                onChange={(e) => pif('paymentMethod', e.target.value || null)}
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

      <FormGroup label="Items" required>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 95, textAlign: 'right' }}>Price</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ minWidth: 160 }}>Lots</th>
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {invoiceForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === '₹' ? '₹' : '%'
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <InventoryItemPicker
                      branchId={invoiceForm.branchId}
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
                      onChange={(e) => {
                        patchLine(i, {
                          qty: e.target.value,
                          batchAllocationCustom: false,
                        })
                      }} />
                  </td>
                  <td>
                    <input className="form-input" type="number"
                      style={numInputStyle}
                      value={it.price}
                      onChange={(e) => { const n = [...invoiceForm.items]; n[i].price = e.target.value; pif('items', n) }} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, opacity: disableLineDiscount ? 0.6 : 1 }}>
                      <input className="form-input" type="number" disabled={disableLineDiscount}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={(e) => { const n = [...invoiceForm.items]; n[i].lineDiscount = e.target.value; pif('items', n) }} />
                      <button type="button" disabled={disableLineDiscount} onClick={() => toggleDiscountType(i)} style={discountToggleStyle}>
                        {type}
                      </button>
                    </div>
                  </td>
                  <td>
                    <LineBatchAllocationField
                      itemId={it.item_id}
                      branchId={invoiceForm.branchId}
                      qty={it.qty}
                      batchTracking={it.batchTracking}
                      expiryTracking={it.expiryTracking}
                      allocation={it.batchAllocation}
                      allocationCustom={it.batchAllocationCustom}
                      onChange={(alloc, custom) => patchLine(i, {
                        batchAllocation: alloc,
                        batchAllocationCustom: custom,
                      })}
                      onEdit={({ batches, expiryTracked }) => setAllocEditor({
                        index: i,
                        batches,
                        expiryTracked,
                      })}
                    />
                  </td>
                  <td>
                    <button className="btn btn-danger btn-xs"
                      onClick={() => pif('items', invoiceForm.items.filter((_, j) => j !== i))}>Remove</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <button className="btn btn-secondary btn-sm"
          onClick={() => pif('items', [...invoiceForm.items, emptySaleLine()])}>
          + Add Item
        </button>
      </FormGroup>

      {allocEditor != null && invoiceForm.items[allocEditor.index] && (
        <BatchAllocationModal
          open
          onClose={() => setAllocEditor(null)}
          item={{
            name: invoiceForm.items[allocEditor.index].name,
            expiry_tracking: allocEditor.expiryTracked,
          }}
          qty={Math.max(1, Number(invoiceForm.items[allocEditor.index].qty) || 1)}
          batches={allocEditor.batches}
          allocation={invoiceForm.items[allocEditor.index].batchAllocation || []}
          strategyLabel={allocEditor.expiryTracked ? 'FEFO' : 'FIFO'}
          onSave={(next) => {
            patchLine(allocEditor.index, {
              batchAllocation: next,
              batchAllocationCustom: true,
            })
            setAllocEditor(null)
          }}
        />
      )}

      {invoiceForm.items.some((it) => it.batchTracking) && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Batch-tracked items use FIFO/FEFO auto-split. Click <strong>✎ Edit split</strong> to pick specific lots.
        </p>
      )}

      <DocumentTotalsStrip
        items={invoiceForm.items}
        entityDiscount={invoiceForm.discount}
        entityDiscountType={invoiceForm.discountType || '%'}
        onEntityDiscountChange={(v) => pif('discount', v)}
        onEntityDiscountTypeChange={(t) => pif('discountType', t)}
        lineGross={(it) => Number(it.qty || 0) * Number(it.price || 0)}
      />

      <FormGroup label="Notes">
        <textarea className="form-input" style={{ height: 72 }}
          value={invoiceForm.notes} onChange={(e) => pif('notes', e.target.value)} />
      </FormGroup>
    </>
  )

  if (embedded) return formBody

  return (
    <Modal
      open={open}
      onClose={saving ? () => {} : onClose}
      title={title}
      icon="🧾"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Creating…' : 'Create Invoice'}
          </button>
        </>
      }
    >
      {formBody}
    </Modal>
  )
}

const numInputStyle = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
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

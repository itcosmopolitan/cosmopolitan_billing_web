/**
 * Invoice modal — create from scratch or from a prefilled conversion
 * (quotation → invoice, sales order → invoice).
 */
import { useState } from 'react'
import { Modal, FormGroup, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { AUTOCOMPLETE_CUSTOMER_URL } from '@/api'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import LineBatchAllocationField from '@/components/LineBatchAllocationField'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import InventoryItemPicker from './InventoryItemPicker'
import { emptySaleLine, discountPatternFromItem, applySuggestedDiscountsToSaleLines, customerPricingType, resolveCategoryLinePricing } from './salesFormShared'
import { PAYMENT_METHOD_OPTIONS } from '@/utils/dropdownOptions'
import CashTenderFields from '@/components/CashTenderFields'
import { fmt } from '@/utils/helpers'
import { amountInputStep, qtyInputStep } from '@/utils/decimalPrecision'
import MarginBadge from '@/components/MarginBadge'
import { computeDocumentTotals, lineNetAmount } from '@/utils/documentFormTotals'
import { entityDiscountShares, lineMargin } from '@/utils/marginCalc'

export default function InvoiceFormModal({
  open,
  onClose,
  onSave,
  invoiceForm,
  pif,
  saving = false,
  conversionLabel = null,
  editMode = false,
  /** When true, render only the form body (for full-page DocumentFormShell). */
  embedded = false,
}) {
  const title = editMode
    ? `Edit Invoice — ${invoiceForm.number || ''}`
    : conversionLabel
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
    const pattern = discountPatternFromItem(inv)
    const retailPrice = Number(inv.selling_price || 0) || 0
    const resolved = resolveCategoryLinePricing(
      { ...inv, ...pattern, retailPrice, price: retailPrice },
      invoiceForm.customerType,
    )
    patchLine(i, {
      item_id: inv.id,
      name: inv.name,
      price: resolved.price,
      retailPrice,
      costPrice: inv.cost_price ?? inv.costPrice ?? 0,
      taxRate: inv.tax_rate || 0,
      ...pattern,
      lineDiscount: resolved.discountPct,
      lineDiscountType: '%',
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
      costPrice: 0,
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
    pif('items', next)
  }

  const disableLineDiscount = shouldDisableLineDiscount(invoiceForm.discount)
  const hasBatchLines = invoiceForm.items.some((it) => it.batchTracking)
  const rollup = computeDocumentTotals(invoiceForm.items, {
    entityDiscount: invoiceForm.discount,
    entityDiscountType: invoiceForm.discountType || '%',
    enforceExclusive: true,
  })
  const discShares = rollup.discountMode === 'entity'
    ? entityDiscountShares(invoiceForm.items, rollup.entityDiscount)
    : invoiceForm.items.map(() => 0)

  const formBody = (
    <div className="invoice-form-shell">
      <div className="invoice-form-panel">
        <div className="invoice-form-panel__head">Invoice basics</div>
        <div className="invoice-form-grid">
          {editMode ? (
            <FormGroup label="Invoice #">
              <input className="form-input" value={invoiceForm.number || ''} readOnly
                style={{ background: 'var(--bg-subtle)', cursor: 'default' }} />
            </FormGroup>
          ) : (
            <DocumentNumberField
              label="Invoice #"
              docType="sales_invoice"
              branchId={invoiceForm.branchId}
              value={invoiceForm.number}
              onChange={(v) => pif('number', v)}
            />
          )}
          <FormGroup label="Customer" required>
            <AutocompleteDropdown
              value={invoiceForm.customerId || ''}
              onSelectOption={(opt) => {
                if (!opt) {
                  pif('customerId', '')
                  pif('customerName', '')
                  pif('customerType', 'retail')
                  pif('items', applySuggestedDiscountsToSaleLines(invoiceForm.items, 'retail'))
                  return
                }
                const type = customerPricingType(opt.raw?.customer_type || 'retail')
                pif('customerId', opt.id)
                pif('customerName', opt.label)
                pif('customerType', type)
                pif('items', applySuggestedDiscountsToSaleLines(invoiceForm.items, type))
              }}
              fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
              isSearchFieldRequired
              selectedLabel={invoiceForm.customerName || undefined}
              placeholder="Search customers…"
              searchPlaceholder="Search customers…"
              emptyLabel="No customers found. Add via the Customers page."
              style={{ width: '100%' }}
            />
          </FormGroup>
          <FormGroup label="Invoice Date">
            <DatePicker
              value={invoiceForm.invoiceDate}
              onChange={(v) => pif('invoiceDate', v)} />
          </FormGroup>
        </div>

        <div className="invoice-form-payment">
          <FormGroup label="Payment">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxWidth: 520 }}>
              {PAYMENT_METHOD_OPTIONS.map((option) => {
                const selected = invoiceForm.paymentMethod === option.id
                const disabled = Boolean(option.disabled)

                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return
                      const nextMethod = selected ? null : option.id
                      pif('paymentMethod', nextMethod)
                      pif('paymentReceived', !!nextMethod)
                      if (!['upi', 'bank_transfer'].includes(nextMethod || '')) {
                        pif('paymentRef', '')
                      }
                      if (nextMethod !== 'cash') pif('cashCollected', '')
                    }}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 999,
                      border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
                      background: selected ? 'var(--accent-bg)' : 'transparent',
                      color: selected ? 'var(--accent)' : disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.6 : 1,
                      transition: 'all 0.12s ease',
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
              {invoiceForm.paymentMethod === 'cash' && !editMode && (
                <div style={{ width: '100%', maxWidth: 300 }}>
                  <CashTenderFields
                    due={rollup.total}
                    value={invoiceForm.cashCollected || ''}
                    onChange={(v) => pif('cashCollected', v)}
                  />
                </div>
              )}
              {['upi', 'bank_transfer'].includes(invoiceForm.paymentMethod || '') && (
                <div style={{ width: '100%', maxWidth: 300 }}>
                  <input
                    className="form-input"
                    value={invoiceForm.paymentRef || ''}
                    onChange={(e) => pif('paymentRef', e.target.value)}
                    placeholder="Payment reference"
                    style={{ fontSize: 13, width: '100%' }}
                  />
                </div>
              )}
            </div>
          </FormGroup>
        </div>
      </div>

      {editMode && (
        <div style={{ marginBottom: 16 }}>
          <FormGroup label="Due Date">
            <input className="form-input" type="date"
              value={invoiceForm.dueDate || ''}
              onChange={(e) => pif('dueDate', e.target.value)} />
          </FormGroup>
        </div>
      )}

      <div className="invoice-form-panel">
        <div className="invoice-form-panel__head">Line items</div>
        <div className="invoice-form-panel__sub">Add inventory lines, then adjust discount and lot split where needed.</div>
        <div className="invoice-form-table-wrap">
        <table className="data-table invoice-form-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 95, textAlign: 'right' }}>Price</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ width: 90, textAlign: 'right' }}>Margin</th>
              <th style={{ width: 110, textAlign: 'right' }}>Total</th>
              {hasBatchLines && <th style={{ minWidth: 160 }}>Lots</th>}
              <th style={{ width: 60 }} />
            </tr>
          </thead>
          <tbody>
            {invoiceForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === 'MVR' ? 'MVR' : '%'
              const lineTotal = lineNetAmount(it)
              const margin = lineMargin(it, { entityDiscountShare: discShares[i] || 0 })
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
                      min={qtyInputStep()}
                      step={qtyInputStep()}
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
                      min="0"
                      step={amountInputStep()}
                      style={numInputStyle}
                      value={it.price}
                      onChange={(e) => { const n = [...invoiceForm.items]; n[i].price = e.target.value; pif('items', n) }} />
                  </td>
                  <td>
                    <div className="line-discount-field" style={{ opacity: disableLineDiscount ? 0.6 : 1 }}>
                      <input className="form-input" type="number" disabled={disableLineDiscount}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={(e) => { const n = [...invoiceForm.items]; n[i].lineDiscount = e.target.value; pif('items', n) }} />
                      <button type="button" disabled={disableLineDiscount} onClick={() => toggleDiscountType(i)} style={discountToggleStyle}>
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
                  {hasBatchLines && (
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
                  )}
                  <td>
                    {invoiceForm.items.length > 1 && (
                      <button
                        type="button"
                        className="btn btn-danger btn-xs"
                        onClick={() => pif('items', invoiceForm.items.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        <button className="btn btn-secondary btn-sm"
          onClick={() => pif('items', [...invoiceForm.items, emptySaleLine()])}>
          + Add Item
        </button>
      </div>

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

      {hasBatchLines && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Batch-tracked items use FIFO/FEFO auto-split. Click <strong>✎ Edit split</strong> to pick specific lots.
        </p>
      )}

      <div className="invoice-form-panel invoice-form-panel--muted">
        <DocumentTotalsStrip
          items={invoiceForm.items}
          entityDiscount={invoiceForm.discount}
          entityDiscountType={invoiceForm.discountType || '%'}
          onEntityDiscountChange={(v) => pif('discount', v)}
          onEntityDiscountTypeChange={(t) => pif('discountType', t)}
          lineGross={(it) => Number(it.qty || 0) * Number(it.price || 0)}
          showWhenEmpty
          notes={invoiceForm.notes}
          onNotesChange={(v) => pif('notes', v)}
          notesLabel="Remarks"
          notesPlaceholder="Delivery instructions / details…"
          notesHint="Shown on the invoice for delivery and special instructions"
        />
      </div>
    </div>
  )

  if (embedded) return formBody

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon="🧾"
      size="lg"
      busy={saving}
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

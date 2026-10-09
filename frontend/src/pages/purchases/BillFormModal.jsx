/**
 * Purchase Bill modal — create a new bill or edit an existing unpaid one
 * (payment is recorded separately via Record Payment).
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
 * Branch cost_price is also updated with moving weighted-average cost
 * (on-hand value + receipt value) / total qty so POS margin uses WAC.
 * That all happens server-side in create_bill / GRN receive.
 */
import { Fragment } from 'react'
import { todayISO } from '@/utils/batchDates'
import { Modal, FormGroup, AlertBar, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { AUTOCOMPLETE_VENDOR_URL } from '@/api'
import { useQuickVendor } from '@/components/useQuickParty'
import InventoryItemPicker from '@/pages/sales/InventoryItemPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import { PAYMENT_METHOD_OPTIONS } from '@/utils/dropdownOptions'
import { emptyPurchaseLine, projectedBranchCost } from './purchaseFormShared'
import { fmt } from '@/utils/helpers'
import { amountInputStep, ENTRY_DECIMALS, entryInputStep, formatAmountNumber, roundAmount, roundQty } from '@/utils/decimalPrecision'
import MarginBadge from '@/components/MarginBadge'
import {
  computeDocumentTotals,
  lineTaxableDisplay,
  lineTaxDisplay,
  displayExclRate,
  exclRateInputValue,
  inclusiveRateFromExclInput,
  commitSaleQty,
  commitSaleExclRate,
  purchaseLineGross,
  qtyInputValue,
} from '@/utils/documentFormTotals'
import { entityDiscountShares, purchaseDocumentMargin, purchaseLineMargin } from '@/utils/marginCalc'

const costLineGross = purchaseLineGross

function lineBranchCostPreview(it) {
  if (!it.item_id || it.branchCost == null) return null
  const current = Number(it.branchCost) || 0
  const purchase = Number(it.cost) || 0
  const onHandQty = Math.max(0, Number(it.branchStock) || 0)
  const purchaseQty = Math.max(0, Number(it.qty) || 0)
  if (purchaseQty <= 0) return null
  const next = projectedBranchCost(current, purchase, { onHandQty, purchaseQty })
  if (Math.abs(current - next) < 0.000001) return null
  return { current, purchase, next, onHandQty, purchaseQty }
}

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
  const { footerAction: addVendorAction, modal: addVendorModal } = useQuickVendor({
    onCreated: (v) => {
      pbf('vendorId', v.id)
      pbf('vendorName', v.name)
    },
  })
  const title = conversionLabel
    ? (isGrn ? `Receive Stock — from ${conversionLabel}` : `Create Bill — from ${conversionLabel}`)
    : (isGrn ? 'New Goods Receipt (GRN)' : 'New Purchase Bill')

  const handlePick = (i, inv) => {
    const branchCost = roundAmount(Number(inv.cost_price ?? inv.costPrice ?? 0) || 0)
    const branchStock = roundQty(Number(inv.available_stock ?? inv.availableStock ?? 0) || 0)
    const next = [...billForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      cost: roundAmount(Number(inv.cost_price ?? inv.selling_price ?? 0) || 0),
      branchCost,
      branchStock,
      sellingPrice: roundAmount(Number(inv.selling_price ?? inv.sellingPrice ?? 0) || 0),
      taxRate: inv.tax_rate || 0,
      // Cache batch flags for the conditional row render below.
      batchTracking: Boolean(inv.batch_tracking),
      expiryTracking: Boolean(inv.expiry_tracking),
    }
    pbf('items', next)
  }

  const handleClear = (i) => {
    const next = [...billForm.items]
    next[i] = {
      ...next[i],
      item_id: null,
      name: '',
      sellingPrice: 0,
      branchCost: null,
      branchStock: null,
      batchTracking: false,
      expiryTracking: false,
    }
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
  const rollup = computeDocumentTotals(billForm.items, {
    entityDiscount: billForm.discount,
    entityDiscountType: billForm.discountType || '%',
    lineGross: costLineGross,
    enforceExclusive: true,
  })
  const discShares = rollup.discountMode === 'entity'
    ? entityDiscountShares(billForm.items, rollup.entityDiscount, costLineGross)
    : billForm.items.map(() => 0)
  const purchaseMargin = purchaseDocumentMargin(billForm.items, {
    entityDiscount: billForm.discount,
    entityDiscountType: billForm.discountType || '%',
    lineGross: costLineGross,
    enforceExclusive: true,
  })

  const formBody = (
    <div className="bill-form-shell">
      <div className="bill-form-panel">
        <div className="bill-form-panel__head">Bill basics</div>
        <div className="bill-form-grid">
          {editMode ? (
            <FormGroup label={isGrn ? 'GRN #' : 'Bill #'}>
              <input className="form-input" value={billForm.number || ''} readOnly
                style={{ background: 'var(--bg-subtle)', cursor: 'default' }} />
            </FormGroup>
          ) : (
            <DocumentNumberField
              label={isGrn ? 'GRN #' : 'Bill #'}
              docType={isGrn ? 'grn' : 'purchase_bill'}
              branchId={billForm.branchId}
              value={billForm.number}
              onChange={(v) => pbf('number', v)}
            />
          )}
          <FormGroup label="Vendor" required>
            <AutocompleteDropdown
              value={billForm.vendorId || ''}
              onSelectOption={(opt) => {
                if (!opt) {
                  pbf('vendorId', '')
                  pbf('vendorName', '')
                  return
                }
                pbf('vendorId', opt.id)
                pbf('vendorName', opt.label)
              }}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              isSearchFieldRequired
              selectedLabel={billForm.vendorName || undefined}
              placeholder="Search vendors…"
              searchPlaceholder="Search vendors…"
              emptyLabel="No vendors found"
              footerAction={addVendorAction}
              style={{ width: '100%' }}
            />
          </FormGroup>
          <FormGroup label={isGrn ? 'Receipt Date' : 'Bill Date'}>
            <DatePicker
              value={billForm.billDate || todayISO()}
              onChange={(v) => pbf('billDate', v)} />
          </FormGroup>
        </div>

        {!isGrn && !editMode && (
          <div className="bill-form-meta-grid">
            <FormGroup label="Due Date">
              <DatePicker
                value={billForm.dueDate || ''}
                onChange={(v) => pbf('dueDate', v)} />
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
                  <AutocompleteDropdown
                    value={billForm.paymentMethod || ''}
                    onChange={(v) => pbf('paymentMethod', v || null)}
                    options={PAYMENT_METHOD_OPTIONS}
                    prependOptions={[{ id: '', label: 'Select method…', disabled: true }]}
                    isSearchFieldRequired={false}
                    placeholder="Select method…"
                    style={{ fontSize: 13 }}
                  />
                )}
              </div>
            </FormGroup>
          </div>
        )}
      </div>

      {editMode && (
        <div style={{ marginBottom: 16 }}>
          <FormGroup label="Due Date">
            <DatePicker
              value={billForm.dueDate || ''}
              onChange={(v) => pbf('dueDate', v)} />
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
              <th style={{ width: 110, textAlign: 'right' }}>Cost (Excl.)</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ width: 90, textAlign: 'right' }}>Tax</th>
              <th style={{ width: 90, textAlign: 'right' }}>Margin</th>
              <th style={{ width: 110, textAlign: 'right' }}>Total (Excl.)</th>
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
              const lineTotal = lineTaxableDisplay(it, costLineGross, discShares[i] || 0)
              const lineTax = lineTaxDisplay(it, costLineGross, discShares[i] || 0)
              const margin = purchaseLineMargin(it, { entityDiscountShare: discShares[i] || 0 })
              const costPreview = lineBranchCostPreview(it)
              return (
                <Fragment key={i}>
                  <tr>
                    <td style={{ minWidth: 220 }}>
                      <InventoryItemPicker
                        branchId={billForm.branchId}
                        listedOnly={false}
                        value={pickerValue}
                        onPick={(inv) => handlePick(i, inv)}
                        onClear={() => handleClear(i)}
                        excludeIds={otherPickedIds}
                      />
                    </td>
                    <td>
                      <input className="form-input" type="number"
                        min={entryInputStep()}
                        step={entryInputStep()}
                        style={numInputStyle}
                        value={qtyInputValue(it.qty)}
                        title="Type any decimals; rounded to settings on blur"
                        onChange={(e) => { const n = [...billForm.items]; n[i].qty = e.target.value; pbf('items', n) }}
                        onBlur={(e) => {
                          const n = [...billForm.items]
                          n[i].qty = commitSaleQty(e.target.value, it.qty)
                          pbf('items', n)
                        }} />
                    </td>
                    <td>
                      <input className="form-input" type="number"
                        min="0"
                        step={entryInputStep()}
                        style={numInputStyle}
                        value={it._rateText ?? exclRateInputValue(it.cost, it.taxRate)}
                        title="Cost excl. GST — type any decimals; rounded to settings on blur"
                        onChange={(e) => {
                          const n = [...billForm.items]
                          n[i]._rateText = e.target.value
                          n[i].cost = inclusiveRateFromExclInput(e.target.value, it.taxRate, ENTRY_DECIMALS)
                          pbf('items', n)
                        }}
                        onBlur={(e) => {
                          const n = [...billForm.items]
                          delete n[i]._rateText
                          n[i].cost = commitSaleExclRate(
                            e.target.value,
                            it.taxRate,
                            displayExclRate(it.cost, it.taxRate),
                          )
                          pbf('items', n)
                        }} />
                      {costPreview && (
                        <div
                          style={{
                            marginTop: 3,
                            fontSize: 10,
                            lineHeight: 1.25,
                            color: 'var(--amber)',
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}
                          title={
                            `WAC: (${costPreview.onHandQty} × ${fmt(costPreview.current)}`
                            + ` + ${costPreview.purchaseQty} × ${fmt(costPreview.purchase)})`
                            + ` / ${costPreview.onHandQty + costPreview.purchaseQty}`
                          }
                        >
                          WAC {formatAmountNumber(costPreview.current)}→{formatAmountNumber(costPreview.next)}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="line-discount-field" style={{ opacity: disableLineDiscount ? 0.6 : 1 }}>
                        <input className="form-input" type="number" disabled={disableLineDiscount}
                          min="0"
                          max={type === '%' ? 100 : undefined}
                          step={type === 'MVR' ? amountInputStep() : '0.01'}
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
                    <td className="text-right mono" style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {fmt(lineTax)}
                    </td>
                    <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                      <MarginBadge margin={margin} />
                    </td>
                    <td className="text-right mono" style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
                      {fmt(lineTotal)}
                    </td>
                    <td>
                      {billForm.items.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-danger btn-xs"
                          onClick={() => pbf('items', billForm.items.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                  {it.batchTracking && (
                    <tr>
                      {/* Batch capture row spans all line-item columns. Compact
                          inputs for lot # / mfg / expiry. */}
                      <td colSpan={8} style={{ padding: '6px 10px 12px', background: 'var(--bg-raised)' }}>
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
                            <DatePicker
                              value={it.mfgDate || ''}
                              onChange={(e) => { const n = [...billForm.items]; n[i].mfgDate = e.target.value; pbf('items', n) }}
                              style={{ width: '100%', fontSize: 12, padding: '6px 8px' }} />
                          </label>
                          <label style={{ ...batchFieldStyle, flex: '0 0 145px' }}>
                            <span style={batchLabelStyle}>
                              Expiry date{it.expiryTracking && <span style={{ color: 'var(--red)' }}> *</span>}
                            </span>
                            <DatePicker
                              value={it.expiryDate || ''}
                              onChange={(v) => { const n = [...billForm.items]; n[i].expiryDate = v; pbf('items', n) }}
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
          onClick={() => pbf('items', [...billForm.items, emptyPurchaseLine()])}>
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
          lineGross={purchaseLineGross}
          showWhenEmpty
          marginOverride={purchaseMargin}
          notes={billForm.notes || ''}
          onNotesChange={(v) => pbf('notes', v)}
          notesHint={isGrn ? 'Will be displayed on the goods receipt' : 'Will be displayed on the bill'}
        />
      </div>
    </div>
  )

  if (embedded) {
    return (
      <>
        {formBody}
        {addVendorModal}
      </>
    )
  }

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon={isGrn ? '📦' : '📋'}
      size="lg"
      busy={saving}
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
    {addVendorModal}
    </>
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

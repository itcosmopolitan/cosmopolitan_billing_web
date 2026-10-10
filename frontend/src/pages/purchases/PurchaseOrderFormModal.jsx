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
import { useEffect } from 'react'
import { Modal, FormGroup, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { AUTOCOMPLETE_VENDOR_URL } from '@/api'
import { useQuickVendor } from '@/components/useQuickParty'
import InventoryItemPicker from '@/pages/sales/InventoryItemPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import { emptyPurchaseLine } from './purchaseFormShared'
import { fmt } from '@/utils/helpers'
import { amountInputStep, ENTRY_DECIMALS, entryInputStep } from '@/utils/decimalPrecision'
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
import { useAppStore } from '@/store'
import { useVendorGstin } from '@/hooks/useVendorGstin'
import { applyVendorTransferPricingToPurchaseLines, isInternalTransferByGstin } from '@/utils/pricingDiscounts'

const costLineGross = purchaseLineGross

// Per-row discount via lineDiscountType. Backend stores percent only.

export default function PurchaseOrderFormModal({
  open,
  onClose,
  onSave,
  poForm,
  ppof,                     // patcher: (key, value) => setForm({...form, [key]: value})
  saving = false,
  editingNumber = null,
  readOnly = false,
  /** When true, render only the form body (for full-page DocumentFormShell). */
  embedded = false,
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
  const { footerAction: addVendorAction, modal: addVendorModal } = useQuickVendor({
    enabled: !readOnly,
    onCreated: (v) => {
      ppof('vendorId', v.id)
      ppof('vendorName', v.name)
    },
  })

  const organisationGstin = useAppStore((s) => s.organisationGstin)
  const vendorGstin = useVendorGstin(poForm.vendorId)
  const internalVendor = isInternalTransferByGstin({ gstin: vendorGstin }, organisationGstin)

  useEffect(() => {
    if (readOnly) return
    const next = applyVendorTransferPricingToPurchaseLines(poForm.items, internalVendor)
    if (next !== poForm.items) ppof('items', next)
    // Re-run only when the vendor's internal status flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalVendor])

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
      sellingPrice: inv.selling_price ?? inv.sellingPrice ?? 0,
      taxRate: inv.tax_rate || 0,
      branchCost: Number(inv.cost_price ?? inv.costPrice ?? 0) || 0,
      catalog: undefined,
    }
    ppof('items', internalVendor ? applyVendorTransferPricingToPurchaseLines(next, true) : next)
  }

  const handleClear = (i) => {
    const next = [...poForm.items]
    next[i] = { ...next[i], item_id: null, name: '', sellingPrice: 0, catalog: undefined }
    ppof('items', next)
  }

  // Toggle discount unit on a row — auto-converts the value so the
  // EFFECTIVE discount stays constant. Identical logic to sales/OrderFormModal.
  const toggleDiscountType = (i) => {
    const next = [...poForm.items]
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
    ppof('items', next)
  }

  const disableLineDiscount = readOnly || shouldDisableLineDiscount(poForm.discount)
  const rollup = computeDocumentTotals(poForm.items, {
    entityDiscount: poForm.discount,
    entityDiscountType: poForm.discountType || '%',
    lineGross: costLineGross,
    enforceExclusive: !readOnly,
  })
  const discShares = rollup.discountMode === 'entity'
    ? entityDiscountShares(poForm.items, rollup.entityDiscount, costLineGross)
    : poForm.items.map(() => 0)
  const purchaseMargin = purchaseDocumentMargin(poForm.items, {
    entityDiscount: poForm.discount,
    entityDiscountType: poForm.discountType || '%',
    lineGross: costLineGross,
    enforceExclusive: !readOnly,
  })

  const formBody = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
        <DocumentNumberField
          label="PO #"
          docType="purchase_order"
          branchId={poForm.branchId}
          value={poForm.number}
          onChange={(v) => ppof('number', v)}
          isEdit={isEdit}
          editingNumber={editingNumber}
          readOnly={readOnly}
        />
        <FormGroup label="Vendor" required>
          <AutocompleteDropdown
            disabled={readOnly}
            value={poForm.vendorId || ''}
            onSelectOption={(opt) => {
              if (!opt) {
                ppof('vendorId', '')
                ppof('vendorName', '')
                return
              }
              ppof('vendorId', opt.id)
              ppof('vendorName', opt.label)
            }}
            fetchUrl={AUTOCOMPLETE_VENDOR_URL}
            isSearchFieldRequired
            selectedLabel={poForm.vendorName || undefined}
            placeholder="Search vendors…"
            searchPlaceholder="Search vendors…"
            emptyLabel="No vendors found"
            footerAction={addVendorAction}
            style={{ width: '100%' }}
          />
          {internalVendor ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Same GSTIN as organisation — priced at cost (internal transfer), GST 0%
            </div>
          ) : null}
        </FormGroup>
        <FormGroup label="Expected Date">
          <DatePicker disabled={readOnly}
            value={poForm.expectedDate}
            onChange={(v) => ppof('expectedDate', v)} />
        </FormGroup>
      </div>

      <FormGroup label="Items" required>
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 110, textAlign: 'right' }}>Cost (Excl.)</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ width: 90, textAlign: 'right' }}>Tax</th>
              <th style={{ width: 90, textAlign: 'right' }}>Margin</th>
              <th style={{ width: 110, textAlign: 'right' }}>Total (Excl.)</th>
              {!readOnly && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {poForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === 'MVR' ? 'MVR' : '%'
              const lineTotal = lineTaxableDisplay(it, costLineGross, discShares[i] || 0)
              const lineTax = lineTaxDisplay(it, costLineGross, discShares[i] || 0)
              const margin = purchaseLineMargin(it, { entityDiscountShare: discShares[i] || 0 })
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <InventoryItemPicker
                      branchId={poForm.branchId}
                      listedOnly={false}
                      value={pickerValue}
                      onPick={(inv) => handlePick(i, inv)}
                      onClear={() => handleClear(i)}
                      disabled={readOnly}
                      excludeIds={otherPickedIds}
                    />
                  </td>
                  <td>
                    <input className="form-input" type="number" disabled={readOnly}
                      min={entryInputStep()}
                      step={entryInputStep()}
                      style={numInputStyle}
                      value={qtyInputValue(it.qty)}
                      title="Type any decimals; rounded to settings on blur"
                      onChange={e => { const n = [...poForm.items]; n[i].qty = e.target.value; ppof('items', n) }}
                      onBlur={e => {
                        const n = [...poForm.items]
                        n[i].qty = commitSaleQty(e.target.value, it.qty)
                        ppof('items', n)
                      }} />
                  </td>
                  <td>
                    <input className="form-input" type="number" disabled={readOnly}
                      min="0"
                      step={entryInputStep()}
                      style={numInputStyle}
                      value={it._rateText ?? exclRateInputValue(it.cost, it.taxRate)}
                      title="Cost excl. GST — type any decimals; rounded to settings on blur"
                      onChange={e => {
                        const n = [...poForm.items]
                        n[i]._rateText = e.target.value
                        n[i].cost = inclusiveRateFromExclInput(e.target.value, it.taxRate, ENTRY_DECIMALS)
                        ppof('items', n)
                      }}
                      onBlur={e => {
                        const n = [...poForm.items]
                        delete n[i]._rateText
                        n[i].cost = commitSaleExclRate(
                          e.target.value,
                          it.taxRate,
                          displayExclRate(it.cost, it.taxRate),
                        )
                        ppof('items', n)
                      }} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, opacity: disableLineDiscount ? 0.6 : 1 }}>
                      <input className="form-input" type="number" disabled={readOnly || disableLineDiscount}
                        min="0"
                        max={type === '%' ? 100 : undefined}
                        step={type === 'MVR' ? amountInputStep() : '0.01'}
                        style={{ ...numInputStyle, flex: 1, minWidth: 0 }}
                        value={it.lineDiscount || 0}
                        onChange={e => { const n = [...poForm.items]; n[i].lineDiscount = e.target.value; ppof('items', n) }} />
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
                  <td className="text-right mono" style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {fmt(lineTax)}
                  </td>
                  <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    <MarginBadge margin={margin} />
                  </td>
                  <td className="text-right mono" style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
                    {fmt(lineTotal)}
                  </td>
                  {!readOnly && (
                    <td>
                      {poForm.items.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-danger btn-xs"
                          onClick={() => ppof('items', poForm.items.filter((_, j) => j !== i))}
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
        {!readOnly && (
          <button className="btn btn-secondary btn-sm"
            onClick={() => ppof('items', [...poForm.items, emptyPurchaseLine()])}>
            + Add Item
          </button>
        )}
      </FormGroup>

      <div className="invoice-form-panel invoice-form-panel--muted">
        <DocumentTotalsStrip
          items={poForm.items}
          entityDiscount={poForm.discount}
          entityDiscountType={poForm.discountType || '%'}
          onEntityDiscountChange={readOnly ? undefined : (v) => ppof('discount', v)}
          onEntityDiscountTypeChange={readOnly ? undefined : (t) => ppof('discountType', t)}
          readOnly={readOnly}
          lineGross={purchaseLineGross}
          showWhenEmpty
          marginOverride={purchaseMargin}
          notes={poForm.notes}
          onNotesChange={readOnly ? undefined : (v) => ppof('notes', v)}
          notesHint="Will be displayed on the purchase order"
        />
      </div>
    </>
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
    {addVendorModal}
    </>
  )
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

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
import { Modal, FormGroup, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { AUTOCOMPLETE_CUSTOMER_URL, customersAPI } from '@/api'
import { useAppStore } from '@/store'
import { useQuickCustomer } from '@/components/useQuickParty'
import InventoryItemPicker from './InventoryItemPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import {
  emptySaleLine,
  discountPatternFromItem,
  applyCustomerPricingToSaleLines,
  customerPricingType,
  customerClassification,
  customerGstin,
  isInternalTransferByGstin,
  linePricingForCustomer,
  resolveSaleLinePricing,
  WALK_IN_CUSTOMER_OPTION,
  WALK_IN_CUSTOMER_NAME,
} from './salesFormShared'
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
  qtyInputValue,
  saleLineGross,
} from '@/utils/documentFormTotals'
import { entityDiscountShares, lineMargin } from '@/utils/marginCalc'

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
  const organisationGstin = useAppStore((s) => s.organisationGstin)
  const customerCtx = {
    customer_type: quoteForm.customerType,
    classification: quoteForm.customerClassification,
    gst_in: quoteForm.customerGstin,
  }
  const internalTransfer = isInternalTransferByGstin(customerCtx, organisationGstin)
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
  const { footerAction: addCustomerAction, modal: addCustomerModal } = useQuickCustomer({
    defaultBranchId: quoteForm.branchId,
    enabled: !readOnly,
    onCreated: (c) => {
      const type = customerPricingType(c.customer_type || c.type || 'retail')
      pqf('customerId', c.id)
      pqf('customerName', c.name)
      pqf('customerType', type)
      pqf('customerClassification', customerClassification(c))
      pqf('customerGstin', customerGstin(c))
      pqf('items', applyCustomerPricingToSaleLines(quoteForm.items, c, organisationGstin))
    },
  })

  const handlePick = (i, inv) => {
    const pattern = discountPatternFromItem(inv)
    const retailPrice = Number(inv.selling_price || 0) || 0
    const costPrice = Number(inv.cost_price ?? inv.costPrice ?? 0) || 0
    const resolved = resolveSaleLinePricing(
      { ...inv, ...pattern, retailPrice, price: retailPrice, costPrice },
      customerCtx,
      organisationGstin,
    )
    const priced = linePricingForCustomer(
      resolved.price,
      inv.tax_rate || 0,
      customerCtx,
      organisationGstin,
    )
    const next = [...quoteForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      retailPrice,
      costPrice,
      unit: inv.unit || '',
      ...pattern,
      ...priced,
      lineDiscount: resolved.discountPct,
      lineDiscountType: '%',
    }
    pqf('items', next)
  }

  const handleClear = (i) => {
    const next = [...quoteForm.items]
    next[i] = { ...next[i], item_id: null, name: '', costPrice: 0 }
    pqf('items', next)
  }

  // See OrderFormModal#toggleDiscountType — same auto-conversion logic (%/MVR).
  const toggleDiscountType = (i) => {
    const next = [...quoteForm.items]
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
    pqf('items', next)
  }

  const disableLineDiscount = readOnly || shouldDisableLineDiscount(quoteForm.discount)
  const rollup = computeDocumentTotals(quoteForm.items, {
    entityDiscount: quoteForm.discount,
    entityDiscountType: quoteForm.discountType || '%',
    enforceExclusive: !readOnly,
  })
  const discShares = rollup.discountMode === 'entity'
    ? entityDiscountShares(quoteForm.items, rollup.entityDiscount)
    : quoteForm.items.map(() => 0)

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
          <AutocompleteDropdown
            disabled={readOnly}
            value={quoteForm.customerId || ''}
            onSelectOption={async (opt) => {
              if (!opt?.id) {
                pqf('customerId', '')
                pqf('customerName', WALK_IN_CUSTOMER_NAME)
                pqf('customerType', 'retail')
                pqf('customerClassification', 'external')
                pqf('customerGstin', '')
                pqf('items', applyCustomerPricingToSaleLines(quoteForm.items, 'retail', organisationGstin))
                return
              }
              const type = customerPricingType(opt.raw?.customer_type || 'retail')
              const cls = customerClassification(opt.raw)
              const gst = customerGstin(opt.raw)
              const ctx = { customer_type: type, classification: cls, gst_in: gst }
              pqf('customerId', opt.id)
              pqf('customerName', opt.label)
              pqf('customerType', type)
              pqf('customerClassification', cls)
              pqf('customerGstin', gst)
              pqf('items', applyCustomerPricingToSaleLines(quoteForm.items, ctx, organisationGstin))
              try {
                const c = await customersAPI.get(opt.id)
                pqf('customerType', customerPricingType(c.customer_type || c.type || type))
                pqf('customerClassification', customerClassification(c))
                pqf('customerGstin', customerGstin(c))
                pqf('items', applyCustomerPricingToSaleLines(quoteForm.items, c, organisationGstin))
              } catch { /* keep autocomplete fields */ }
            }}
            fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
            isSearchFieldRequired
            prependOptions={[WALK_IN_CUSTOMER_OPTION]}
            selectedLabel={quoteForm.customerName || WALK_IN_CUSTOMER_OPTION.label}
            placeholder="Walk-in Customer"
            footerAction={addCustomerAction}
            style={{ width: '100%' }}
          />
          {internalTransfer ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Same GSTIN as organisation — priced at cost (internal transfer), GST 0%
            </div>
          ) : quoteForm.customerClassification === 'internal' ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Internal customer — GST is subtracted from item amounts
            </div>
          ) : null}
        </FormGroup>
        <FormGroup label="Valid Until">
          <DatePicker disabled={readOnly}
            value={quoteForm.validUntil} onChange={(v) => pqf('validUntil', v)} />
        </FormGroup>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Shipment Date">
          <DatePicker disabled={readOnly}
            value={quoteForm.shipmentDate} onChange={(v) => pqf('shipmentDate', v)} />
        </FormGroup>
        <FormGroup label="Payment Terms">
          <input className="form-input" type="text" disabled={readOnly}
            value={quoteForm.paymentTerms || ''}
            onChange={(e) => pqf('paymentTerms', e.target.value)} />
        </FormGroup>
        <FormGroup label="Shipment Method">
          <input className="form-input" type="text" disabled={readOnly}
            value={quoteForm.shipmentMethod || ''}
            onChange={(e) => pqf('shipmentMethod', e.target.value)} />
        </FormGroup>
      </div>
      {/* <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <FormGroup label="Prices Include VAT">
          <label className="form-checkbox" style={{ alignItems: 'center' }}>
            <input type="checkbox" disabled={readOnly}
              checked={!!quoteForm.pricesIncludingVat}
              onChange={(e) => pqf('pricesIncludingVat', e.target.checked)} />
            <span style={{ marginLeft: 8 }}>{quoteForm.pricesIncludingVat ? 'Yes' : 'No'}</span>
          </label>
        </FormGroup>
        <FormGroup label="Payment Discount on VAT">
          <input className="form-input" type="number" min="0" disabled={readOnly}
            value={quoteForm.paymentDiscountOnVat || 0}
            onChange={(e) => pqf('paymentDiscountOnVat', e.target.value)} />
        </FormGroup>
      </div> */}
      <FormGroup label="Items" required>
        {/* 2026-05-24: same column changes as OrderFormModal — Tax % out,
            per-line Discount in, 95px right-aligned numeric columns
            (native number spinner hidden globally; see globals.css). */}
        <table className="data-table" style={{ marginBottom: 12 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
              <th style={{ width: 110, textAlign: 'right' }}>Rate (Excl.)</th>
              <th style={{ width: 130, textAlign: 'right' }}>Discount</th>
              <th style={{ width: 90, textAlign: 'right' }}>Tax</th>
              <th style={{ width: 90, textAlign: 'right' }}>Margin</th>
              <th style={{ width: 110, textAlign: 'right' }}>Total (Excl.)</th>
              {!readOnly && <th style={{ width: 60 }} />}
            </tr>
          </thead>
          <tbody>
            {quoteForm.items.map((it, i) => {
              const pickerValue = it.item_id
                ? { id: it.item_id, name: it.name }
                : (it.name ? { id: null, name: it.name } : null)
              const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
              const type = it.lineDiscountType === 'MVR' ? 'MVR' : '%'
              const lineTotal = lineTaxableDisplay(it, undefined, discShares[i] || 0)
              const lineTax = lineTaxDisplay(it, undefined, discShares[i] || 0)
              const margin = lineMargin(it, { entityDiscountShare: discShares[i] || 0 })
              return (
                <tr key={i}>
                  <td style={{ minWidth: 220 }}>
                    <InventoryItemPicker
                      branchId={quoteForm.branchId}
                      listedOnly={false}
                      value={pickerValue}
                      onPick={(inv) => handlePick(i, inv)}
                      onClear={() => handleClear(i)}
                      disabled={readOnly}
                      excludeIds={otherPickedIds}
                    />
                  </td>
                  <td><input className="form-input" type="number" disabled={readOnly} min={entryInputStep()} step={entryInputStep()} style={numInputStyle}
                    title="Type any decimals; rounded to settings on blur"
                    value={qtyInputValue(it.qty)}
                    onChange={e => { const n = [...quoteForm.items]; n[i].qty = e.target.value; pqf('items', n) }}
                    onBlur={e => {
                      const n = [...quoteForm.items]
                      n[i].qty = commitSaleQty(e.target.value, it.qty)
                      pqf('items', n)
                    }} /></td>
                  <td><input className="form-input" type="number" disabled={readOnly} min="0" step={entryInputStep()} style={numInputStyle}
                    value={exclRateInputValue(it.price, it.taxRate)}
                    title="Rate excl. GST — type any decimals; rounded to settings on blur"
                    onChange={e => {
                      const n = [...quoteForm.items]
                      n[i].price = inclusiveRateFromExclInput(e.target.value, it.taxRate, ENTRY_DECIMALS)
                      pqf('items', n)
                    }}
                    onBlur={e => {
                      const n = [...quoteForm.items]
                      n[i].price = commitSaleExclRate(
                        e.target.value,
                        it.taxRate,
                        displayExclRate(it.price, it.taxRate),
                      )
                      pqf('items', n)
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
                        onChange={e => { const n = [...quoteForm.items]; n[i].lineDiscount = e.target.value; pqf('items', n) }} />
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
                      {quoteForm.items.length > 1 && (
                        <button type="button" className="btn btn-danger btn-xs"
                          onClick={() => pqf('items', quoteForm.items.filter((_, j) => j !== i))}>Remove</button>
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
            onClick={() => pqf('items', [...quoteForm.items, emptySaleLine()])}>+ Add Item</button>
        )}
      </FormGroup>

      <div className="invoice-form-panel invoice-form-panel--muted">
        <DocumentTotalsStrip
          items={quoteForm.items}
          entityDiscount={quoteForm.discount}
          entityDiscountType={quoteForm.discountType || '%'}
          onEntityDiscountChange={readOnly ? undefined : (v) => pqf('discount', v)}
          onEntityDiscountTypeChange={readOnly ? undefined : (t) => pqf('discountType', t)}
          readOnly={readOnly}
          lineGross={saleLineGross}
          showWhenEmpty
          notes={quoteForm.notes}
          onNotesChange={readOnly ? undefined : (v) => pqf('notes', v)}
          notesHint="Will be displayed on the quotation"
        />
      </div>
    </>
  )

  if (embedded) {
    return (
      <>
        {formBody}
        {addCustomerModal}
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
    {addCustomerModal}
    </>
  )
}

// See OrderFormModal — same right-aligned + tabular-numerals style.
const numInputStyle = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}

// See OrderFormModal#discountToggleStyle — same %/MVR toggle.
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

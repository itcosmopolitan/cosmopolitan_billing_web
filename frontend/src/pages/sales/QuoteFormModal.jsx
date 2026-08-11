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
import { AUTOCOMPLETE_CUSTOMER_URL } from '@/api'
import InventoryItemPicker from './InventoryItemPicker'
import DocumentNumberField from '@/components/DocumentNumberField'
import DocumentTotalsStrip, { shouldDisableLineDiscount } from '@/components/DocumentTotalsStrip'
import { emptySaleLine, suggestedDiscountForCustomer, discountPatternFromItem, applySuggestedDiscountsToSaleLines, customerPricingType } from './salesFormShared'
import { fmt } from '@/utils/helpers'
import MarginBadge from '@/components/MarginBadge'
import { computeDocumentTotals, lineNetAmount } from '@/utils/documentFormTotals'
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
    const pattern = discountPatternFromItem(inv)
    const suggested = suggestedDiscountForCustomer({ ...inv, ...pattern }, quoteForm.customerType)
    const next = [...quoteForm.items]
    next[i] = {
      ...next[i],
      item_id: inv.id,
      name: inv.name,
      price: inv.selling_price,
      costPrice: inv.cost_price ?? inv.costPrice ?? 0,
      taxRate: inv.tax_rate || 0,
      ...pattern,
      lineDiscount: suggested,
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
            onSelectOption={(opt) => {
              if (!opt) {
                pqf('customerId', '')
                pqf('customerName', '')
                pqf('customerType', 'retail')
                pqf('items', applySuggestedDiscountsToSaleLines(quoteForm.items, 'retail'))
                return
              }
              const type = customerPricingType(opt.raw?.customer_type || 'retail')
              pqf('customerId', opt.id)
              pqf('customerName', opt.label)
              pqf('customerType', type)
              pqf('items', applySuggestedDiscountsToSaleLines(quoteForm.items, type))
            }}
            fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
            isSearchFieldRequired
            selectedLabel={quoteForm.customerName || undefined}
            placeholder="Search customers…"
            searchPlaceholder="Search customers…"
            emptyLabel="No customers found. Add via the Customers page."
            style={{ width: '100%' }}
          />
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
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
              <th style={{ width: 90, textAlign: 'right' }}>Margin</th>
              <th style={{ width: 110, textAlign: 'right' }}>Total</th>
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
              const lineTotal = lineNetAmount(it)
              const margin = lineMargin(it, { entityDiscountShare: discShares[i] || 0 })
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
          lineGross={(it) => Number(it.qty || 0) * Number(it.price || 0)}
          showWhenEmpty
          notes={quoteForm.notes}
          onNotesChange={readOnly ? undefined : (v) => pqf('notes', v)}
          notesHint="Will be displayed on the quotation"
        />
      </div>
    </>
  )

  if (embedded) return formBody

  return (
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

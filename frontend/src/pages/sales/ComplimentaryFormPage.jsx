/**
 * Complimentary / sample issue. Stock leaves the branch at cost, no sale is
 * recorded, and the taxable amount is always zero.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, itemsAPI, AUTOCOMPLETE_CUSTOMER_URL } from '@/api'
import { useAppStore, usePOSStore } from '@/store'
import { useCan } from '@/auth/permissions'
import DocumentFormShell from '@/components/DocumentFormShell'
import DocumentNumberField from '@/components/DocumentNumberField'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import LineBatchAllocationField from '@/components/LineBatchAllocationField'
import { AutocompleteDropdown, DatePicker, FormGroup, Select } from '@/components/ui'
import InventoryItemPicker from './InventoryItemPicker'
import { WALK_IN_CUSTOMER_NAME, WALK_IN_CUSTOMER_OPTION } from './salesFormShared'
import { toApiPayload } from '@/utils/batchAllocation'
import { todayISO } from '@/utils/batchDates'
import { commitSaleQty, qtyInputValue } from '@/utils/documentFormTotals'
import { entryInputStep } from '@/utils/decimalPrecision'
import { fmt } from '@/utils/helpers'
import { COMPLIMENTARY_REASONS } from './complimentaryOptions'
import { getChildCounterBranch, getConfiguredChildCounters } from '@/utils/childCounters'

const emptyLine = () => ({
  item_id: null,
  name: '',
  qty: 1,
  costPrice: 0,
  batchTracking: false,
  expiryTracking: false,
  batchAllocation: [],
  batchAllocationCustom: false,
})

const emptyForm = (branchId) => ({
  number: '',
  reason: '',
  branchId,
  customerId: '',
  customerName: WALK_IN_CUSTOMER_NAME,
  date: todayISO(),
  notes: '',
  items: [emptyLine()],
})

const numInputStyle = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

export default function ComplimentaryFormPage() {
  const navigate = useNavigate()
  const can = useCan()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const activeBranchId = activeBranch?.id || 'br-001'
  const branches = useAppStore((s) => s.branches)
  const selectedChildCounter = usePOSStore((s) => s.selectedChildCounter)
  const setChildCounterBranchId = usePOSStore((s) => s.setChildCounterBranchId)

  const [form, setForm] = useState(() => emptyForm(activeBranchId))
  const [saving, setSaving] = useState(false)
  const [allocEditor, setAllocEditor] = useState(null)
  const pif = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const patchLine = (i, patch) => setForm((f) => {
    const items = [...f.items]
    items[i] = { ...items[i], ...patch }
    return { ...f, items }
  })

  useEffect(() => {
    if (!can('invoices.create')) {
      navigate('/sales?tab=complimentary', { replace: true })
    }
  }, [can, navigate])

  useEffect(() => {
    if (!activeBranchId) return
    setForm((current) => (
      current.branchId === activeBranchId ? current : { ...current, branchId: activeBranchId }
    ))
  }, [activeBranchId])

  useEffect(() => {
    setChildCounterBranchId(activeBranchId || '')
    return () => setChildCounterBranchId('')
  }, [activeBranchId, setChildCounterBranchId])

  const handlePick = async (i, inv) => {
    // Fall back to the master cost if branch costs can't be loaded.
    let costPrice = Number(inv.cost_price ?? inv.costPrice ?? 0) || 0
    try {
      const data = await itemsAPI.getBranches(inv.id)
      const row = (data?.branches || []).find((b) => b.branch_id === form.branchId)
      const branchCost = Number(row?.effective_cost_price ?? row?.cost_price)
      if (row && Number.isFinite(branchCost)) costPrice = branchCost
    } catch {
      // keep master cost
    }
    patchLine(i, {
      item_id: inv.id,
      name: inv.name,
      costPrice,
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

  const pickedIds = form.items.map((it) => it.item_id).filter(Boolean)
  const hasBatchLines = form.items.some((it) => it.batchTracking)
  const totalQty = form.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0)
  const costValue = form.items.reduce(
    (sum, it) => sum + (Number(it.qty) || 0) * (Number(it.costPrice) || 0),
    0,
  )

  const summaryCards = [
    { label: 'Lines', value: form.items.filter((i) => i.item_id).length },
    { label: 'Qty', value: totalQty },
    { label: 'Cost value', value: fmt(costValue) },
  ]

  const save = async () => {
    const lines = form.items.filter((it) => it.item_id)
    if (!form.reason) {
      toast.error('Select a reason (Complimentary or Sample)')
      return
    }
    if (!lines.length) {
      toast.error('Add at least one item')
      return
    }
    if (lines.some((it) => !(Number(it.qty) > 0))) {
      toast.error('Each item needs a quantity greater than zero')
      return
    }
    const selectedBranch = getChildCounterBranch(branches, form.branchId, activeBranch)
    const childCounters = getConfiguredChildCounters(selectedBranch)
    const selectedCounter = childCounters.find(
      (counter) => String(counter.id) === String(selectedChildCounter),
    )
    if (childCounters.length > 0 && !selectedCounter) {
      toast.error('Select a valid child counter for this entry')
      return
    }
    setSaving(true)
    try {
      const res = await salesAPI.complimentary.create({
        number: form.number || undefined,
        reason: form.reason,
        branch_id: form.branchId,
        child_counter_id: selectedCounter?.id || null,
        child_counter_name: selectedCounter?.name || null,
        customer_id: form.customerId || null,
        date: form.date,
        notes: form.notes || undefined,
        items: lines.map((it) => ({
          item_id: it.item_id,
          qty: Number(it.qty),
          batch_allocation: toApiPayload(it.batchAllocation),
        })),
      })
      toast.success(`${form.reason} entry ${res?.number || ''} saved`)
      navigate('/sales?tab=complimentary')
    } catch (err) {
      console.error('Failed to save complimentary entry:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <DocumentFormShell
      title="Complimentary"
      subtitle="Sales"
      icon="🎁"
      hideHeader
      onBack={() => navigate('/sales?tab=complimentary')}
      onSave={save}
      saveLabel="Save entry"
      saving={saving}
      summaryCards={summaryCards}
    >
      <div className="invoice-form-shell">
        <div className="invoice-form-panel">
          <div className="invoice-form-panel__head">Basic info</div>
          <div className="invoice-form-grid">
            <DocumentNumberField
              label="Complimentary #"
              docType="complimentary"
              branchId={form.branchId}
              value={form.number}
              onChange={(v) => pif('number', v)}
            />
            <FormGroup label="Customer">
              <AutocompleteDropdown
                value={form.customerId || ''}
                onSelectOption={(opt) => {
                  if (!opt?.id) {
                    pif('customerId', '')
                    pif('customerName', WALK_IN_CUSTOMER_NAME)
                    return
                  }
                  pif('customerId', opt.id)
                  pif('customerName', opt.label)
                }}
                fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
                isSearchFieldRequired
                prependOptions={[WALK_IN_CUSTOMER_OPTION]}
                selectedLabel={form.customerName || WALK_IN_CUSTOMER_OPTION.label}
                placeholder="Walk-in Customer"
                style={{ width: '100%' }}
              />
            </FormGroup>
            <Select
              label="Reason"
              required
              value={form.reason}
              onChange={(v) => pif('reason', v)}
              options={COMPLIMENTARY_REASONS}
              placeholder="Select reason…"
            />
            <FormGroup label="Date">
              <DatePicker value={form.date} onChange={(v) => pif('date', v)} />
            </FormGroup>
          </div>
        </div>

        <div className="invoice-form-panel">
          <div className="invoice-form-panel__head">Line items</div>
          <div className="invoice-form-panel__sub">
            Stock is issued at cost. Tax, discount and margin do not apply.
          </div>
          <div className="invoice-form-table-wrap">
            <table className="data-table invoice-form-table" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ width: 95, textAlign: 'right' }}>Qty</th>
                  <th style={{ width: 120, textAlign: 'right' }}>Rate (Cost)</th>
                  <th style={{ width: 120, textAlign: 'right' }}>Total (Excl.)</th>
                  {hasBatchLines && <th style={{ minWidth: 160 }}>Lots</th>}
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {form.items.map((it, i) => {
                  const pickerValue = it.item_id
                    ? { id: it.item_id, name: it.name }
                    : (it.name ? { id: null, name: it.name } : null)
                  const otherPickedIds = pickedIds.filter((id) => id !== it.item_id)
                  return (
                    <tr key={i}>
                      <td style={{ minWidth: 220 }}>
                        <InventoryItemPicker
                          branchId={form.branchId}
                          value={pickerValue}
                          onPick={(inv) => handlePick(i, inv)}
                          onClear={() => handleClear(i)}
                          excludeIds={otherPickedIds}
                          portalDropdown
                        />
                      </td>
                      <td>
                        <input
                          className="form-input"
                          type="number"
                          min={entryInputStep()}
                          step={entryInputStep()}
                          style={numInputStyle}
                          value={qtyInputValue(it.qty)}
                          title="Type any decimals; rounded to settings on blur"
                          onChange={(e) => patchLine(i, { qty: e.target.value, batchAllocationCustom: false })}
                          onBlur={(e) => patchLine(i, {
                            qty: commitSaleQty(e.target.value, it.qty),
                            batchAllocationCustom: false,
                          })}
                        />
                      </td>
                      <td className="text-right mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                        {it.item_id ? fmt(it.costPrice) : '—'}
                      </td>
                      <td className="text-right mono" style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
                        {fmt((Number(it.qty) || 0) * (Number(it.costPrice) || 0))}
                      </td>
                      {hasBatchLines && (
                        <td>
                          <LineBatchAllocationField
                            itemId={it.item_id}
                            branchId={form.branchId}
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
                        {form.items.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-danger btn-xs"
                            onClick={() => pif('items', form.items.filter((_, j) => j !== i))}
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
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => pif('items', [...form.items, emptyLine()])}
          >
            + Add Item
          </button>
        </div>

        {allocEditor != null && form.items[allocEditor.index] && (
          <BatchAllocationModal
            open
            onClose={() => setAllocEditor(null)}
            item={{
              name: form.items[allocEditor.index].name,
              expiry_tracking: allocEditor.expiryTracked,
            }}
            qty={Math.max(1, Number(form.items[allocEditor.index].qty) || 1)}
            batches={allocEditor.batches}
            allocation={form.items[allocEditor.index].batchAllocation || []}
            strategyLabel={allocEditor.expiryTracked ? 'FEFO' : 'FIFO'}
            onSave={(next) => {
              patchLine(allocEditor.index, { batchAllocation: next, batchAllocationCustom: true })
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
          <div className="document-totals-footer">
            <div className="document-totals-footer__notes">
              <label className="form-label">Remarks</label>
              <textarea
                className="form-input document-totals-footer__notes-input"
                value={form.notes}
                onChange={(e) => pif('notes', e.target.value)}
                placeholder="Reason details, recipient, etc."
              />
            </div>
            <div className="document-totals-footer__gap" aria-hidden="true" />
            <div className="document-totals-footer__summary">
              <div className="document-summary-card">
                <div className="document-summary-row">
                  <span className="document-summary-row__label">Taxable amount</span>
                  <span className="document-summary-row__spacer" />
                  <span className="document-summary-row__value mono">{fmt(0)}</span>
                </div>
                <div className="document-summary-row document-summary-row--total">
                  <span className="document-summary-row__label">Total</span>
                  <span className="document-summary-row__spacer" />
                  <span className="document-summary-row__value mono document-summary-row__value--total">{fmt(0)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </DocumentFormShell>
  )
}

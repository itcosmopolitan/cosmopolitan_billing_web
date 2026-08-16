/**
 * Reusable "create an invoice from this" prompt. Today's consumers:
 *   • Sales Order → Invoice (`SalesPage.convertOrder`)
 * The dialog mirrors the POS payment UX deliberately — same checkbox,
 * same method dropdown — so cashiers see one mental model regardless of
 * where the sale originated. See ../cosmopolitan_billing_web_notes/
 * SALES_PHASE_1.md for the locked decision.
 *
 * 2026-05-24 (Option B — user-chosen plan for batch tracking on SO/Quote):
 * The modal also gained a STOCK ALLOCATION section. SO lines are
 * batch-free at create time, so this is the operator's single chance to
 * pre-pick batches for batch-tracked items. Per-line picks are bundled
 * into `payload.line_allocations` and passed to the convert endpoint,
 * which forwards them to `consume_batches_atomic(explicit_allocation=…)`.
 * Skipping a row → backend falls back to auto FIFO/FEFO (unchanged from
 * pre-2026-05-24 behavior). Untracked items are listed too with a "Not
 * batch-tracked" pill so the operator sees the full conversion scope.
 *
 * Props:
 *   • open                — boolean
 *   • onClose             — fn
 *   • onConfirm(body)     — Promise<void>;
 *                           body = { payment_received, payment_mode, notes,
 *                                    line_allocations? }
 *   • title               — header text
 *   • source              — optional { number, total, customerName } header
 *   • lines               — array of SO lines: { item_id, name, qty } —
 *                           the modal lazily fetches batch_tracking +
 *                           batches per tracked line on open. Required
 *                           to render the stock allocation section; omit
 *                           to hide that section entirely (back to
 *                           pre-2026-05-24 behavior).
 *   • branchId            — required when `lines` provided. Scopes the
 *                           batches query.
 *   • confirming          — disable submit while parent is awaiting.
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, AlertBar, AutocompleteDropdown } from '@/components/ui'
import { PAYMENT_METHOD_OPTIONS } from '@/utils/dropdownOptions'
import { fmt, fmtQty } from '@/utils/helpers'
import CashTenderFields from '@/components/CashTenderFields'
import { cashTenderError } from '@/utils/cashTender'
import { itemsAPI } from '@/api'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import { toApiPayload, formatAllocationSummary } from '@/utils/batchAllocation'

export default function ConvertToInvoiceModal({
  open,
  onClose,
  onConfirm,
  title = 'Convert to Invoice',
  source,
  lines = null,
  branchId = null,
  confirming = false,
}) {
  const [paymentReceived, setPaymentReceived] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState(null)
  const [cashCollected, setCashCollected] = useState('')
  const [notes, setNotes] = useState('')

  // Per-item batch info populated lazily on modal open. Shape:
  //   { [item_id]: { tracked, expiryTracked, batches: [...], allocation: [] } }
  // `tracked` + `expiryTracked` come from the /items/{id}/batches response's
  // top-level `item` field — one round-trip per tracked line gives us
  // both the flag AND the batch list, which is what we need for the
  // BatchAllocationModal anyway.
  const [stockByItem, setStockByItem] = useState({})
  const [stockLoading, setStockLoading] = useState(false)
  const [pickerOpenFor, setPickerOpenFor] = useState(null)
  // Phase 2: per-line convert qty (keyed by order_line_id).
  const [lineQtys, setLineQtys] = useState({})

  const lineKey = (line, idx) => line.order_line_id || `idx-${idx}`

  // Reset on every open so a previous attempt's choice doesn't bleed
  // into the next convert.
  useEffect(() => {
    if (open) {
      setPaymentReceived(false)
      setPaymentMethod(null)
      setCashCollected('')
      setNotes('')
      setStockByItem({})
      setPickerOpenFor(null)
      const initial = {}
      ;(lines || []).forEach((l, idx) => {
        initial[lineKey(l, idx)] = l.qty
      })
      setLineQtys(initial)
    }
  }, [open, lines])

  // Fetch batches per line on open. Unique by item_id so two rows of the
  // same SKU only cost one fetch (rare for SOs but cheap to handle).
  useEffect(() => {
    if (!open || !lines || !branchId) return
    const uniqueItemIds = Array.from(
      new Set(
        (lines || [])
          .map((l) => l.item_id)
          .filter(Boolean),
      ),
    )
    if (uniqueItemIds.length === 0) return
    let cancelled = false
    setStockLoading(true)
    Promise.all(
      uniqueItemIds.map((id) =>
        itemsAPI.batches
          .list(id, { branch_id: branchId, include_empty: false })
          .then((res) => [id, res])
          .catch(() => [id, null]),
      ),
    )
      .then((results) => {
        if (cancelled) return
        const next = {}
        for (const [id, res] of results) {
          if (!res || !res.item) {
            next[id] = { tracked: false, expiryTracked: false, batches: [], allocation: [] }
            continue
          }
          next[id] = {
            tracked: Boolean(res.item.batch_tracking),
            expiryTracked: Boolean(res.item.expiry_tracking),
            // The /batches endpoint returns rows in the FEFO-friendly
            // shape `{ id, batchNumber, expiryDate, mfgDate, receivedDate,
            // quantity, ... }`. BatchAllocationModal consumes exactly
            // this shape — no remapping needed.
            batches: res.items || [],
            allocation: [],
          }
        }
        setStockByItem(next)
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, lines, branchId])

  const handleConfirm = () => {
    if (paymentReceived && !paymentMethod) {
      return
    }
    if (paymentReceived && paymentMethod === 'cash') {
      const err = cashTenderError(cashCollected, previewTotal)
      if (err) {
        toast.error(err)
        return
      }
    }
    const line_allocations = []
    for (const [item_id, info] of Object.entries(stockByItem)) {
      if (!info.tracked || !info.allocation || info.allocation.length === 0) continue
      const payload = toApiPayload(info.allocation)
      if (payload) line_allocations.push({ item_id, batch_allocation: payload })
    }
    const body = {
      payment_received: paymentReceived,
      payment_mode: paymentReceived ? paymentMethod : null,
      notes: notes.trim() || null,
      line_allocations: line_allocations.length ? line_allocations : null,
    }
    const convertLines = (lines || [])
      .map((l, idx) => {
        if (!l.order_line_id) return null
        const key = lineKey(l, idx)
        const qty = Math.min(Math.max(1, parseInt(lineQtys[key], 10) || 0), l.qty)
        if (qty <= 0) return null
        return { order_line_id: l.order_line_id, qty }
      })
      .filter(Boolean)
    if (convertLines.length > 0) {
      body.lines = convertLines
    }
    onConfirm(body)
  }

  const previewTotal = useMemo(() => {
    if (!lines?.length) return source?.total
    let subtotal = 0
    let tax = 0
    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx]
      const key = lineKey(l, idx)
      const qty = Math.min(
        Math.max(0, parseInt(lineQtys[key], 10) || 0),
        l.qty,
      )
      if (qty <= 0) continue
      const gross = qty * (l.price || 0)
      const disc = l.discount || 0
      const net = gross * (1 - disc / 100)
      // Prices are tax-inclusive — do not add tax on top.
      subtotal += net
      const rate = Number(l.taxRate || 0)
      if (rate > 0 && net > 0) {
        tax += Math.round((net * rate / (100 + rate)) * 100) / 100
      }
    }
    return Math.round(subtotal * 100) / 100
  }, [lines, lineQtys, source?.total])

  const buttonDisabled = confirming
    || (paymentReceived && !paymentMethod)
    || (paymentReceived && paymentMethod === 'cash' && !!cashTenderError(cashCollected, previewTotal))

  // Convenience: line currently being edited in the BatchAllocationModal,
  // and its associated stock info.
  const pickerLine = useMemo(() => {
    if (!pickerOpenFor || !lines) return null
    return lines.find((l) => l.item_id === pickerOpenFor) || null
  }, [pickerOpenFor, lines])
  const pickerStock = pickerOpenFor ? stockByItem[pickerOpenFor] : null

  const showStockSection = Array.isArray(lines) && lines.length > 0

  return (
    <Modal
      open={open}
      onClose={confirming ? () => {} : onClose}
      title={title}
      icon="🧾"
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={confirming}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={buttonDisabled}
          >
            {confirming ? 'Converting…' : 'Create Invoice'}
          </button>
        </>
      }
    >
      {source && (
        <AlertBar type="blue" icon="ℹ">
          Creating invoice from <strong>{source.number}</strong>
          {source.customerName ? <> for <strong>{source.customerName}</strong></> : null}
          {typeof previewTotal === 'number' ? <> · Invoice total: <strong>{fmt(previewTotal)}</strong></> : null}
        </AlertBar>
      )}

      {/* ── STOCK ALLOCATION ──────────────────────────────────────────
          Only rendered when caller passed `lines`. Each line gets one
          row showing the appropriate affordance based on the item's
          tracking flag + current allocation state. Untracked items are
          included for transparency. */}
      {showStockSection && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>
            Stock allocation
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, marginBottom: 10 }}>
            Pick batches for tracked items, or skip to use the default strategy.
          </div>
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--bg-raised)',
            overflow: 'hidden',
          }}>
            {stockLoading && (
              <div style={{ padding: '12px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
                Loading batch info…
              </div>
            )}
            {!stockLoading && lines.map((line, idx) => {
              const key = lineKey(line, idx)
              const convertQty = Math.min(
                Math.max(1, parseInt(lineQtys[key], 10) || line.qty),
                line.qty,
              )
              const info = (line.item_id && stockByItem[line.item_id]) || null
              const tracked = info?.tracked
              const expiryTracked = info?.expiryTracked
              const allocation = info?.allocation || []
              const strategyLabel = expiryTracked ? 'FEFO' : 'FIFO'
              return (
                <div key={`${line.item_id || 'noid'}-${idx}`} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 12px',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {line.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                      {line.order_line_id ? (
                        <span>
                          {fmtQty(convertQty)} of {fmtQty(line.qty)} {Number(line.qty) === 1 ? 'unit' : 'units'} to invoice
                        </span>
                      ) : (
                        <span>{fmtQty(line.qty)} {Number(line.qty) === 1 ? 'unit' : 'units'}</span>
                      )}
                    </div>
                  </div>
                  {line.order_line_id && line.qty > 1 && (
                    <input
                      type="number"
                      className="form-input"
                      min={1}
                      max={line.qty}
                      value={lineQtys[key] ?? line.qty}
                      onChange={(e) => setLineQtys((prev) => ({ ...prev, [key]: e.target.value }))}
                      style={{ width: 64, textAlign: 'right', fontSize: 12 }}
                      title="Qty to invoice"
                    />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {!info && line.item_id && (
                      <span style={mutedPillStyle}>—</span>
                    )}
                    {info && !tracked && (
                      <span style={mutedPillStyle}>Not batch-tracked</span>
                    )}
                    {info && tracked && allocation.length === 0 && (
                      <>
                        <span style={mutedPillStyle}>Auto {strategyLabel}</span>
                        <button
                          type="button"
                          onClick={() => setPickerOpenFor(line.item_id)}
                          style={linkButtonStyle}
                        >
                          Allocate batches
                        </button>
                      </>
                    )}
                    {info && tracked && allocation.length > 0 && (
                      <>
                        <div style={{
                          fontSize: 11, color: 'var(--text-primary)',
                          fontFamily: 'monospace',
                          textAlign: 'right',
                          maxWidth: 220,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={formatAllocationSummary(allocation, 10)}>
                          {formatAllocationSummary(allocation, 3)}
                        </div>
                        <button
                          type="button"
                          onClick={() => setPickerOpenFor(line.item_id)}
                          style={linkButtonStyle}
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ height: showStockSection ? 16 : 14 }} />

      {/* Same dual-step payment UX as POS — see SALES_PHASE_1.md */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px',
        border: `1.5px solid ${paymentReceived ? 'var(--accent)' : 'var(--border-default)'}`,
        background: paymentReceived ? 'var(--accent-bg)' : 'transparent',
        borderRadius: 7, cursor: 'pointer',
        fontSize: 13, fontWeight: 500,
        color: paymentReceived ? 'var(--accent)' : 'var(--text-secondary)',
        transition: 'all 0.12s',
      }}>
        <input
          type="checkbox"
          checked={paymentReceived}
          onChange={(e) => {
            setPaymentReceived(e.target.checked)
            if (!e.target.checked) setCashCollected('')
          }}
          style={{ accentColor: 'var(--accent)' }}
        />
        <span>Payment received?</span>
      </label>

      {paymentReceived && (
        <div style={{ marginTop: 10 }}>
          <FormGroup label="Method" required>
            <AutocompleteDropdown
              value={paymentMethod || ''}
              onChange={(v) => {
                const next = v || null
                setPaymentMethod(next)
                if (next !== 'cash') setCashCollected('')
              }}
              options={PAYMENT_METHOD_OPTIONS}
              prependOptions={[{ id: '', label: 'Select method…', disabled: true }]}
              isSearchFieldRequired={false}
              placeholder="Select method…"
            />
          </FormGroup>
          {paymentMethod === 'cash' && (
            <CashTenderFields
              due={previewTotal}
              value={cashCollected}
              onChange={setCashCollected}
            />
          )}
        </div>
      )}

      {!paymentReceived && (
        <div style={{
          marginTop: 10, padding: '8px 10px',
          fontSize: 11.5, color: 'var(--text-muted)',
          background: 'var(--bg-raised)', borderRadius: 6,
          lineHeight: 1.5,
        }}>
          Invoice will be created as <strong>pending</strong>. Record the
          payment from Sales → Invoices when the customer pays.
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <FormGroup label="Notes (optional)">
          <textarea
            className="form-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ height: 60 }}
          />
        </FormGroup>
      </div>

      {/* Nested batch picker — opens over the convert modal when the
          operator clicks "Allocate batches" / "Edit". Uses the existing
          BatchAllocationModal that POS + Transfers already use, so the
          UX is identical across all three flows. */}
      {pickerLine && pickerStock && (
        <BatchAllocationModal
          open={pickerOpenFor !== null}
          onClose={() => setPickerOpenFor(null)}
          item={{ name: pickerLine.name, expiry_tracking: pickerStock.expiryTracked }}
          qty={(() => {
            if (!pickerLine || !lines) return pickerLine?.qty || 1
            const idx = lines.findIndex((l) => l.item_id === pickerOpenFor)
            if (idx < 0) return pickerLine.qty
            const key = lineKey(lines[idx], idx)
            return Math.min(
              Math.max(1, parseInt(lineQtys[key], 10) || lines[idx].qty),
              lines[idx].qty,
            )
          })()}
          batches={pickerStock.batches}
          allocation={pickerStock.allocation}
          strategyLabel={pickerStock.expiryTracked ? 'FEFO' : 'FIFO'}
          onSave={(newAllocation) => {
            setStockByItem((prev) => ({
              ...prev,
              [pickerOpenFor]: { ...prev[pickerOpenFor], allocation: newAllocation },
            }))
            setPickerOpenFor(null)
          }}
        />
      )}
    </Modal>
  )
}

const mutedPillStyle = {
  display: 'inline-block',
  padding: '2px 8px',
  fontSize: 11,
  borderRadius: 4,
  background: 'var(--bg-surface)',
  color: 'var(--text-muted)',
  border: '1px solid var(--border-subtle)',
  whiteSpace: 'nowrap',
}

const linkButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
  fontWeight: 500,
}

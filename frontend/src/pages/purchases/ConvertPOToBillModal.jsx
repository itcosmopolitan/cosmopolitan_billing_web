/**
 * "Convert PO to Bill" prompt. Mirror of sales/ConvertToInvoiceModal but
 * for the purchase side. Key behavioural difference: purchases ADD stock
 * (we're receiving goods), they don't consume it. So the per-line section
 * is "Batch capture" — operator types the actual lot # / mfg / expiry
 * from the physical delivery — not "Stock allocation".
 *
 * Lines not batch-tracked don't need capture; show a muted "Not batch-
 * tracked" pill (parity with the sales convert modal).
 *
 * Payment fields exactly mirror sales: "Payment paid?" checkbox + method
 * dropdown when checked. Backend ConvertPOToBillIn accepts these as
 * payment_received + payment_mode + payment_ref.
 *
 * Props:
 *   • open / onClose
 *   • onConfirm(body) → Promise<void>
 *       body = { payment_received, payment_mode, payment_ref, notes,
 *                due_date, line_receipts }
 *   • title, source — same shape as ConvertToInvoiceModal
 *   • lines    — [{ item_id, name, qty, batch_tracking, expiry_tracking }]
 *   • confirming — disables submit while parent awaits
 *   • mode — 'convert' (default) creates GRN+bill; 'receive' stock only
 */
import { useEffect, useState } from 'react'
import { Modal, FormGroup, AlertBar, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { PAYMENT_METHOD_OPTIONS } from '@/utils/dropdownOptions'
import { fmt } from '@/utils/helpers'
import { itemsAPI } from '@/api'

export default function ConvertPOToBillModal({
  open,
  onClose,
  onConfirm,
  title = 'Convert to Bill',
  source,
  lines = null,
  confirming = false,
  mode = 'convert',
}) {
  const isReceiveOnly = mode === 'receive'
  const [paymentReceived, setPaymentReceived] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState(null)
  const [paymentRef, setPaymentRef] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  // Per-item-id batch capture state. Shape: { [item_id]: { batchNumber, mfgDate, expiryDate } }
  const [batchByItem, setBatchByItem] = useState({})
  // 2026-05-31: tracking flags fetched per item on open. The `lines` prop
  // only carries { item_id, name, qty } (PO line items don't store the
  // item-level batch_tracking / expiry_tracking flags), so without this
  // fetch every line rendered as "Not batch-tracked". Shape:
  // { [item_id]: { batch_tracking, expiry_tracking } }. Mirrors the lazy
  // fetch in sales/ConvertToInvoiceModal.
  const [flagsByItem, setFlagsByItem] = useState({})

  // Reset on every open so a previous attempt doesn't bleed in.
  useEffect(() => {
    if (open) {
      setPaymentReceived(false)
      setPaymentMethod(null)
      setPaymentRef('')
      setDueDate('')
      setNotes('')
      setBatchByItem({})
      setFlagsByItem({})
    }
  }, [open])

  // Fetch each unique line item's tracking flags when the modal opens.
  // Unique by item_id so repeated SKUs cost one request.
  //
  // NB: uses the /items/{id}/batches endpoint (which returns the item's
  // `batch_tracking` / `expiry_tracking` in its `item` field) rather than
  // a single-item GET — there is NO `GET /items/{id}` route in the backend
  // (only list / PUT / PATCH), so calling it 405s. This mirrors the sales
  // ConvertToInvoiceModal, which uses the same batches endpoint.
  useEffect(() => {
    if (!open || !Array.isArray(lines) || lines.length === 0) return
    const uniqueItemIds = Array.from(
      new Set(lines.map((l) => l.item_id).filter(Boolean)),
    )
    if (uniqueItemIds.length === 0) return
    const branchId = source?.branchId || null
    const params = branchId ? { branch_id: branchId, include_empty: false } : {}
    let cancelled = false
    Promise.all(
      uniqueItemIds.map((id) =>
        itemsAPI.batches
          .list(id, params)
          .then((res) => [id, res])
          .catch(() => [id, null]),
      ),
    ).then((results) => {
      if (cancelled) return
      const next = {}
      for (const [id, res] of results) {
        next[id] = {
          batch_tracking: Boolean(res?.item?.batch_tracking),
          expiry_tracking: Boolean(res?.item?.expiry_tracking),
        }
      }
      setFlagsByItem(next)
    })
    return () => { cancelled = true }
  }, [open, lines, source])

  const updateBatch = (item_id, key, value) => {
    setBatchByItem((prev) => ({
      ...prev,
      [item_id]: { ...(prev[item_id] || {}), [key]: value },
    }))
  }

  // Resolve a line's tracking flags: prefer a flag the caller put on the
  // line, else fall back to the per-item flags fetched on open.
  const resolveFlags = (line) => {
    const flags = (line.item_id && flagsByItem[line.item_id]) || {}
    return {
      tracked: line.batch_tracking != null
        ? Boolean(line.batch_tracking)
        : Boolean(flags.batch_tracking),
      expiryTracked: line.expiry_tracking != null
        ? Boolean(line.expiry_tracking)
        : Boolean(flags.expiry_tracking),
    }
  }

  // 2026-05-31: expiry is mandatory for expiry-tracked (FEFO) lines — the
  // backend rejects a receipt without it. Block submit client-side so the
  // operator fixes it before the round-trip; the offending field is
  // outlined red in the render below. item_ids of FEFO lines missing expiry:
  const missingExpiryItemIds = (Array.isArray(lines) ? lines : [])
    .filter((line) => {
      const { tracked, expiryTracked } = resolveFlags(line)
      if (!tracked || !expiryTracked || !line.item_id) return false
      const b = batchByItem[line.item_id] || {}
      return !b.expiryDate
    })
    .map((line) => line.item_id)
  const hasMissingExpiry = missingExpiryItemIds.length > 0

  const handleConfirm = () => {
    if (paymentReceived && !paymentMethod) {
      return
    }
    // Guard: every FEFO line must carry an expiry date (backend requires it).
    if (hasMissingExpiry) {
      return
    }
    // Build line_receipts array — only include entries where the operator
    // actually filled something. Lines without an entry let the backend
    // auto-generate the batch # via add_batch_atomic.
    const line_receipts = []
    for (const [item_id, b] of Object.entries(batchByItem)) {
      if (b && (b.batchNumber || b.mfgDate || b.expiryDate)) {
        line_receipts.push({
          item_id,
          batch_number: b.batchNumber || null,
          mfg_date: b.mfgDate || null,
          expiry_date: b.expiryDate || null,
        })
      }
    }
    onConfirm({
      payment_received: isReceiveOnly ? false : paymentReceived,
      payment_mode: isReceiveOnly ? null : (paymentReceived ? paymentMethod : null),
      payment_ref: isReceiveOnly ? null : (paymentRef.trim() || null),
      notes: notes.trim() || null,
      due_date: isReceiveOnly ? null : (dueDate || null),
      line_receipts: line_receipts.length ? line_receipts : null,
    })
  }

  const buttonDisabled = confirming
    || (!isReceiveOnly && paymentReceived && !paymentMethod)
    || hasMissingExpiry
  const showStockSection = Array.isArray(lines) && lines.length > 0

  return (
    <Modal
      open={open}
      onClose={confirming ? () => {} : onClose}
      title={title}
      icon="📋"
      size="md"
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
            {confirming ? (isReceiveOnly ? 'Receiving…' : 'Converting…') : (isReceiveOnly ? 'Receive Stock' : 'Create Bill')}
          </button>
        </>
      }
    >
      {source && (
        <AlertBar type="blue" icon="ℹ">
          {isReceiveOnly ? (
            <>Receiving stock for <strong>{source.number}</strong></>
          ) : (
            <>Creating bill from <strong>{source.number}</strong></>
          )}
          {source.vendorName ? <> for <strong>{source.vendorName}</strong></> : null}
          {typeof source.total === 'number' ? <> · Total: <strong>{fmt(source.total)}</strong></> : null}
          {isReceiveOnly && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              No bill yet — create one later from the GRN tab via <strong>To Bill</strong>.
            </div>
          )}
        </AlertBar>
      )}

      {showStockSection && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>
            Batch capture
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, marginBottom: 10 }}>
            Enter lot # and dates for batch-tracked items, or skip to auto-generate the lot #.
            Expiry is required for FEFO (expiry-tracked) items.
          </div>
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--bg-raised)',
            overflow: 'hidden',
          }}>
            {lines.map((line, idx) => {
              const { tracked, expiryTracked } = resolveFlags(line)
              const b = (line.item_id && batchByItem[line.item_id]) || {}
              // FEFO line with no expiry yet → flag the field red + block submit.
              const expiryMissing = tracked && expiryTracked && !b.expiryDate
              return (
                <div key={`${line.item_id || 'noid'}-${idx}`} style={{
                  padding: '10px 12px',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: tracked ? 10 : 0 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {line.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                        {line.qty} {line.qty === 1 ? 'unit' : 'units'}
                      </div>
                    </div>
                    {!tracked && (
                      <span style={mutedPillStyle}>Not batch-tracked</span>
                    )}
                    {tracked && (
                      <span style={mutedPillStyle}>{expiryTracked ? 'FEFO lot' : 'FIFO lot'}</span>
                    )}
                  </div>
                  {tracked && (
                    <div style={{ display: 'flex', gap: 10 }}>
                      {/* Lot # — widest; optional (auto-generated if blank). */}
                      <label style={{ flex: 1.6, minWidth: 0, ...fieldWrapStyle }}>
                        <span style={fieldLabelStyle}>Lot # (optional)</span>
                        <input className="form-input" type="text"
                          placeholder="Auto-generated if blank"
                          value={b.batchNumber || ''}
                          onChange={(e) => updateBatch(line.item_id, 'batchNumber', e.target.value)}
                          style={{ fontSize: 12, padding: '6px 8px' }} />
                      </label>
                      {/* Mfg date — always optional. */}
                      <label style={{ flex: 1, minWidth: 0, ...fieldWrapStyle }}>
                        <span style={fieldLabelStyle}>Mfg date</span>
                        <DatePicker
                          value={b.mfgDate || ''}
                          onChange={(v) => updateBatch(line.item_id, 'mfgDate', v)}
                          style={{ fontSize: 12, padding: '6px 8px' }} />
                      </label>
                      {/* Expiry date — required for FEFO (expiry-tracked) lines. */}
                      <label style={{ flex: 1, minWidth: 0, ...fieldWrapStyle }}>
                        <span style={fieldLabelStyle}>
                          Expiry date{expiryTracked && (
                            <span style={{ color: 'var(--red)' }}> * (required)</span>
                          )}
                        </span>
                        <DatePicker
                          value={b.expiryDate || ''}
                          onChange={(v) => updateBatch(line.item_id, 'expiryDate', v)}
                          style={{
                            fontSize: 12, padding: '6px 8px',
                            ...(expiryMissing ? { borderColor: 'var(--red)' } : {}),
                          }} />
                      </label>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {hasMissingExpiry && (
            <div style={{ fontSize: 11.5, color: 'var(--red)', marginTop: 8 }}>
              ⚠ Enter an expiry date for every FEFO item before creating the bill.
            </div>
          )}
        </div>
      )}

      <div style={{ height: showStockSection ? 16 : 14 }} />

      {!isReceiveOnly && (
        <>
      <FormGroup label="Due Date">
        <DatePicker
          value={dueDate}
          onChange={setDueDate} />
      </FormGroup>

      <div style={{ marginTop: 10 }}>
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
            onChange={(e) => setPaymentReceived(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>Payment paid?</span>
        </label>

        {paymentReceived && (
          <div style={{ marginTop: 10 }}>
            <FormGroup label="Method" required>
              <AutocompleteDropdown
                value={paymentMethod || ''}
                onChange={(v) => setPaymentMethod(v || null)}
                options={PAYMENT_METHOD_OPTIONS}
                prependOptions={[{ id: '', label: 'Select method…', disabled: true }]}
                isSearchFieldRequired={false}
                placeholder="Select method…"
              />
            </FormGroup>
            <FormGroup label="Reference (optional)">
              <input className="form-input"
                placeholder="UTR / transaction reference"
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)} />
            </FormGroup>
          </div>
        )}

        {!paymentReceived && (
          <div style={{
            marginTop: 10, padding: '8px 10px',
            fontSize: 11.5, color: 'var(--text-muted)',
            background: 'var(--bg-raised)', borderRadius: 6,
            lineHeight: 1.5,
          }}>
            Bill will be created as <strong>pending</strong>. Record the
            payment from Purchases → Bills when you pay the vendor.
          </div>
        )}
      </div>

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
        </>
      )}

      {isReceiveOnly && (
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

// Per-field wrapper + caption label for the labeled batch-capture inputs
// (2026-05-31 redesign). The caption sits above each input so the operator
// can tell Lot # / Mfg date / Expiry date apart.
const fieldWrapStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}
const fieldLabelStyle = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: 0.3,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
}

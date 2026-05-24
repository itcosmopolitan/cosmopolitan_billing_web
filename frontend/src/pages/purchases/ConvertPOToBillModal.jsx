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
 */
import { useEffect, useState } from 'react'
import { Modal, FormGroup, AlertBar } from '@/components/ui'
import { fmt } from '@/utils/helpers'

export default function ConvertPOToBillModal({
  open,
  onClose,
  onConfirm,
  title = 'Convert to Bill',
  source,
  lines = null,
  confirming = false,
}) {
  const [paymentReceived, setPaymentReceived] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState(null)
  const [paymentRef, setPaymentRef] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  // Per-item-id batch capture state. Shape: { [item_id]: { batchNumber, mfgDate, expiryDate } }
  const [batchByItem, setBatchByItem] = useState({})

  // Reset on every open so a previous attempt doesn't bleed in.
  useEffect(() => {
    if (open) {
      setPaymentReceived(false)
      setPaymentMethod(null)
      setPaymentRef('')
      setDueDate('')
      setNotes('')
      setBatchByItem({})
    }
  }, [open])

  const updateBatch = (item_id, key, value) => {
    setBatchByItem((prev) => ({
      ...prev,
      [item_id]: { ...(prev[item_id] || {}), [key]: value },
    }))
  }

  const handleConfirm = () => {
    if (paymentReceived && !paymentMethod) {
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
      payment_received: paymentReceived,
      payment_mode: paymentReceived ? paymentMethod : null,
      payment_ref: paymentRef.trim() || null,
      notes: notes.trim() || null,
      due_date: dueDate || null,
      line_receipts: line_receipts.length ? line_receipts : null,
    })
  }

  const buttonDisabled = confirming || (paymentReceived && !paymentMethod)
  const showStockSection = Array.isArray(lines) && lines.length > 0

  return (
    <Modal
      open={open}
      onClose={confirming ? () => {} : onClose}
      title={title}
      icon="📋"
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
            {confirming ? 'Converting…' : 'Create Bill'}
          </button>
        </>
      }
    >
      {source && (
        <AlertBar type="blue" icon="ℹ">
          Creating bill from <strong>{source.number}</strong>
          {source.vendorName ? <> for <strong>{source.vendorName}</strong></> : null}
          {typeof source.total === 'number' ? <> · Total: <strong>{fmt(source.total)}</strong></> : null}
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
            Enter lot # and expiry for batch-tracked items, or skip to auto-generate the lot #.
          </div>
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--bg-raised)',
            overflow: 'hidden',
          }}>
            {lines.map((line, idx) => {
              const tracked = Boolean(line.batch_tracking)
              const expiryTracked = Boolean(line.expiry_tracking)
              const b = (line.item_id && batchByItem[line.item_id]) || {}
              return (
                <div key={`${line.item_id || 'noid'}-${idx}`} style={{
                  padding: '10px 12px',
                  borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: tracked ? 8 : 0 }}>
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
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input className="form-input" type="text"
                        placeholder="Lot # (auto if blank)"
                        value={b.batchNumber || ''}
                        onChange={(e) => updateBatch(line.item_id, 'batchNumber', e.target.value)}
                        style={{ flex: 1, fontSize: 12, padding: '6px 8px' }} />
                      <input className="form-input" type="date"
                        title="Mfg date"
                        value={b.mfgDate || ''}
                        onChange={(e) => updateBatch(line.item_id, 'mfgDate', e.target.value)}
                        style={{ width: 140, fontSize: 12, padding: '6px 8px' }} />
                      <input className="form-input" type="date"
                        title={expiryTracked ? 'Expiry date (required)' : 'Expiry date'}
                        value={b.expiryDate || ''}
                        onChange={(e) => updateBatch(line.item_id, 'expiryDate', e.target.value)}
                        style={{ width: 140, fontSize: 12, padding: '6px 8px' }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ height: showStockSection ? 16 : 14 }} />

      <FormGroup label="Due Date">
        <input className="form-input" type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)} />
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
              <select
                className="form-input"
                value={paymentMethod || ''}
                onChange={(e) => setPaymentMethod(e.target.value || null)}
              >
                <option value="" disabled>Select method…</option>
                <option value="cash">💵 Cash</option>
                <option value="card">💳 Card</option>
                <option value="upi">📱 UPI</option>
                <option value="bank_transfer">🏦 Bank Transfer</option>
              </select>
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

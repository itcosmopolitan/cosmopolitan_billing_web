/**
 * New Vendor Return modal. Mirror of sales/ReturnFormModal — same
 * two-stage flow but against a PurchaseBill instead of a SaleInvoice.
 *
 * Stage 1: operator types the bill number, clicks Load → backend
 *   resolves the bill + items.
 * Stage 2: per-line return qty inputs (capped by original qty), reason,
 *   notes. Submit posts to /purchases/returns/.
 *
 * Backend (routes/purchases.create_return) handles the stock side-effect:
 * tracked items get a NEW batch via add_batch_atomic (source_type='return'
 * if added) or aggregate adjustment via adjust_stock_atomic, and the
 * `credited_amount` is computed against the bill's paid_amount.
 *
 * Today we don't track "already-returned-per-bill-line" (vendor returns
 * don't carry bill_line_id like sales returns do). The cap is just the
 * original qty from the bill — a second return on the same line could
 * over-return. Acceptable for the MVP per user feedback; sales had this
 * tracking added in PR2 and we can mirror later if vendor returns become
 * higher-volume.
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, AlertBar, EmptyState } from '@/components/ui'
import { purchasesAPI } from '@/api'
import { fmt } from '@/utils/helpers'

const REASONS = ['Defective', 'Overstocked', 'Wrong Item', 'Quality Issue', 'Damaged', 'Other']

export default function VendorReturnFormModal({ open, onClose, onSaved }) {
  const [billNumber, setBillNumber] = useState('')
  const [bill, setBill] = useState(null)
  const [returnQtys, setReturnQtys] = useState({})    // { [bill_line_id]: number }
  const [reason, setReason] = useState('Defective')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Reset on every open.
  useEffect(() => {
    if (open) {
      setBillNumber('')
      setBill(null)
      setReturnQtys({})
      setReason('Defective')
      setNotes('')
    }
  }, [open])

  const loadBill = async () => {
    if (!billNumber.trim()) {
      toast.error('Enter a bill number')
      return
    }
    setLoading(true)
    try {
      const listRes = await purchasesAPI.list({
        search: billNumber.trim(),
        limit: 5,
      })
      const items = listRes?.items || []
      // 2026-05-24: exact-match only — parity with sales/ReturnFormModal.
      // The previous `|| items[0]` fallback would silently process a return
      // against the wrong bill if the operator typed a prefix like
      // "PUR-2026-04" and the search returned several bills. Forcing
      // exact match prevents the wrong-bill-return class of mistake.
      // Copy buttons next to bill numbers on the Bills tab (PurchasesPage)
      // let the operator grab the exact string without retyping.
      const match = items.find(
        (b) => (b.number || '').toLowerCase() === billNumber.trim().toLowerCase(),
      )
      if (!match) {
        toast.error(`No bill found matching "${billNumber}"`)
        setBill(null)
        return
      }
      const full = await purchasesAPI.get(match.id)
      setBill(full)
      // Seed return qtys to 0 per line.
      const initial = {}
      for (const li of full.items || []) initial[li.id] = 0
      setReturnQtys(initial)
    } catch (err) {
      console.error('Failed to load bill:', err)
    } finally {
      setLoading(false)
    }
  }

  const setQtyFor = (line, raw) => {
    const cap = Number(line.qty || 0)
    const v = Math.max(0, Math.min(cap, Math.floor(Number(raw) || 0)))
    setReturnQtys((cur) => ({ ...cur, [line.id]: v }))
  }

  const totals = useMemo(() => {
    if (!bill) return { subtotal: 0, tax: 0, total: 0, anyReturned: false }
    let subtotal = 0
    let tax = 0
    let anyReturned = false
    for (const li of bill.items || []) {
      const q = returnQtys[li.id] || 0
      if (q > 0) anyReturned = true
      const gross = q * Number(li.cost || 0)
      const t = gross * (Number(li.taxRate || 0) / 100)
      subtotal += gross
      tax += t
    }
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round((subtotal + tax) * 100) / 100,
      anyReturned,
    }
  }, [bill, returnQtys])

  const handleSubmit = async () => {
    if (!bill) {
      toast.error('Pick a bill first')
      return
    }
    if (!totals.anyReturned) {
      toast.error('Enter a return quantity for at least one line')
      return
    }
    const items = (bill.items || [])
      .filter((li) => (returnQtys[li.id] || 0) > 0)
      .map((li) => ({
        item_id: li.itemId || null,
        name: li.name,
        original_qty: li.qty,
        return_qty: returnQtys[li.id],
        cost: li.cost,
        tax_rate: li.taxRate || 0,
      }))
    setSubmitting(true)
    try {
      const res = await purchasesAPI.returns.create({
        bill_id: bill.id,
        vendor_id: bill.vendorId,
        reason: reason.trim() || 'Other',
        items,
        notes: notes.trim() || null,
      })
      toast.success(`Return ${res?.number || ''} processed`)
      onSaved?.(res)
      onClose()
    } catch (err) {
      console.error('Failed to create return:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="New Vendor Return"
      icon="↩"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !bill || !totals.anyReturned}
          >
            {submitting ? 'Processing…' : 'Process Return'}
          </button>
        </>
      }
    >
      {/* Stage 1: bill picker */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
        <FormGroup label="Bill Number" required>
          <input
            className="form-input"
            placeholder="PUR-2026-0412"
            value={billNumber}
            onChange={(e) => setBillNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadBill() } }}
          />
        </FormGroup>
        <button
          className="btn btn-secondary"
          onClick={loadBill}
          disabled={loading || !billNumber.trim()}
        >
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>

      {!bill && (
        <EmptyState
          icon="📋"
          title="No bill loaded"
          desc="Enter a bill number to start a return."
        />
      )}

      {bill && (
        <>
          <AlertBar type="blue" icon="ℹ">
            <strong>{bill.number}</strong> · {bill.vendorName} ·
            Total: <strong>{fmt(bill.total)}</strong> · Paid: <strong>{fmt(bill.paidAmount)}</strong>
          </AlertBar>
          <div style={{ height: 14 }} />

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 12 }}>
            <FormGroup label="Reason" required>
              <select className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </FormGroup>
          </div>

          <FormGroup label="Lines to return" required>
            <table className="data-table" style={{ marginBottom: 6 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ width: 80, textAlign: 'right' }}>Received</th>
                  <th style={{ width: 90, textAlign: 'right' }}>Return Qty</th>
                  <th style={{ width: 95, textAlign: 'right' }}>Cost</th>
                  <th style={{ width: 100, textAlign: 'right' }}>Line Total</th>
                </tr>
              </thead>
              <tbody>
                {(bill.items || []).map((li) => {
                  const cap = Number(li.qty || 0)
                  const q = returnQtys[li.id] || 0
                  const lineGross = q * Number(li.cost || 0)
                  const lineWithTax = lineGross * (1 + Number(li.taxRate || 0) / 100)
                  const disabled = cap === 0
                  return (
                    <tr key={li.id} style={disabled ? { opacity: 0.5 } : null}>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{li.name}</div>
                      </td>
                      <td className="text-right mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cap}</td>
                      <td className="text-right">
                        <input
                          className="form-input"
                          type="number"
                          min={0}
                          max={cap}
                          value={q}
                          disabled={disabled}
                          onChange={(e) => setQtyFor(li, e.target.value)}
                          style={{ width: 80, textAlign: 'right', padding: '4px 6px', fontVariantNumeric: 'tabular-nums' }}
                        />
                      </td>
                      <td className="text-right mono" style={{ fontSize: 12 }}>{fmt(li.cost)}</td>
                      <td className="text-right mono" style={{ fontSize: 12 }}>
                        {fmt(Math.round(lineWithTax * 100) / 100)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </FormGroup>

          {/* Totals strip mirrors the SO/PO modals — Subtotal / Tax / Total */}
          {totals.anyReturned && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
              <div style={{ minWidth: 240 }}>
                <div style={totalsRowStyle}>
                  <span style={totalsLabelStyle}>Subtotal</span>
                  <span className="mono" style={totalsValueStyle}>{fmt(totals.subtotal)}</span>
                </div>
                <div style={totalsRowStyle}>
                  <span style={totalsLabelStyle}>GST</span>
                  <span className="mono" style={totalsValueStyle}>{fmt(totals.tax)}</span>
                </div>
                <div style={{ ...totalsRowStyle, borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 4 }}>
                  <span style={{ ...totalsLabelStyle, fontWeight: 600, color: 'var(--text-primary)' }}>Total Credit</span>
                  <span className="mono" style={{ ...totalsValueStyle, fontSize: 16, fontWeight: 700, color: 'var(--pink)' }}>{fmt(totals.total)}</span>
                </div>
              </div>
            </div>
          )}

          <FormGroup label="Notes">
            <textarea className="form-input" style={{ height: 60 }}
              value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes…" />
          </FormGroup>
        </>
      )}
    </Modal>
  )
}

const totalsRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  padding: '3px 0',
  fontSize: 13,
}
const totalsLabelStyle = { color: 'var(--text-muted)' }
const totalsValueStyle = { color: 'var(--text-primary)' }

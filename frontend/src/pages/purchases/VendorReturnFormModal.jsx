/**
 * New Vendor Return modal. Mirror of sales/ReturnFormModal — same
 * two-stage flow but against a PurchaseBill instead of a SaleInvoice.
 *
 * Stage 1: operator types the bill number, clicks Load → backend
 *   resolves the bill + items. We ALSO fetch every existing vendor
 *   return for that bill and sum return_qty per bill_line_id, so the
 *   Returnable column reflects cumulative prior returns.
 * Stage 2: per-line return qty inputs (capped at returnable = original −
 *   already-returned), reason, notes. Submit posts to /purchases/returns/.
 *
 * 2026-05-25: added per-line cumulative cap (parity with sales returns).
 * The backend ALSO validates server-side via _already_returned_for_bill;
 * the frontend cap is just defence-in-depth + immediate UX feedback.
 * Each return line now sends `bill_line_id` so the backend matcher is
 * precise (falls back to item_id+name for legacy callers).
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, AlertBar, EmptyState } from '@/components/ui'
import { purchasesAPI, itemsAPI } from '@/api'
import { fmt } from '@/utils/helpers'

const REASONS = ['Defective', 'Overstocked', 'Wrong Item', 'Quality Issue', 'Damaged', 'Other']

export default function VendorReturnFormModal({ open, onClose, onSaved }) {
  const [billNumber, setBillNumber] = useState('')
  const [bill, setBill] = useState(null)
  // 2026-05-25: alreadyReturned tally — { [bill_line_id]: total_returned_qty }
  // populated from a list-and-sum over all existing returns for this
  // bill. Backend has the same map server-side; this is the UX mirror.
  const [alreadyReturned, setAlreadyReturned] = useState({})
  const [returnQtys, setReturnQtys] = useState({})    // { [bill_line_id]: number }
  // 2026-05-31: current remaining qty in THIS bill's own lot, per line.
  // { [bill_line_id]: number | null }. null = untracked / no bill lot found
  // → no batch cap. A vendor return can only send back what still remains
  // from this bill's batch (e.g. received 100, sold 50 → 50 returnable).
  const [billLotRemaining, setBillLotRemaining] = useState({})
  const [reason, setReason] = useState('Defective')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Reset on every open.
  useEffect(() => {
    if (open) {
      setBillNumber('')
      setBill(null)
      setAlreadyReturned({})
      setReturnQtys({})
      setBillLotRemaining({})
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
      // Exact-match only — parity with sales/ReturnFormModal. Operator-
      // typed prefixes no longer process a return against the wrong bill.
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
      // Sum prior returns per bill_line_id. There's no dedicated endpoint
      // for this; list-and-sum is the lightest implementation (same as
      // sales/ReturnFormModal). Filter client-side to this bill.
      const allReturns = (await purchasesAPI.returns.list({ limit: 500 }))?.items || []
      const tally = {}
      for (const r of allReturns) {
        if (r.billId !== full.id) continue
        if (r.voided || r.status === 'void') continue  // voided returns don't count against the cap
        for (const li of r.items || []) {
          if (!li.billLineId) continue
          tally[li.billLineId] = (tally[li.billLineId] || 0) + Number(li.returnQty || 0)
        }
      }
      setAlreadyReturned(tally)

      // 2026-05-31: how much of THIS bill's own lot still remains on hand,
      // per line. We can only return what hasn't been sold/moved since.
      // For each unique tracked item, find the batch this bill created
      // (sourceRef === bill.id) and read its current quantity.
      const lotMap = {}
      const uniqueItemIds = Array.from(
        new Set((full.items || []).map((li) => li.itemId).filter(Boolean)))
      const batchResults = await Promise.all(
        uniqueItemIds.map((id) =>
          itemsAPI.batches.list(id, { branch_id: full.branchId })
            .then((res) => [id, res])
            .catch(() => [id, null])),
      )
      const remByItem = {}
      for (const [id, res] of batchResults) {
        // The bill-lot cap only applies to BATCH-TRACKED items. Untracked
        // items have no batches — the /batches endpoint still returns
        // `res.item` (so checking `!res.item` was wrong and forced the cap
        // to 0), so we must key off `res.item.batch_tracking`. Untracked →
        // null = no cap (returnable is just received − prior returns).
        if (!res || !res.item || !res.item.batch_tracking) { remByItem[id] = null; continue }
        const lots = (res.items || []).filter((b) => b.sourceRef === full.id)
        remByItem[id] = lots.reduce((s, b) => s + Number(b.quantity || 0), 0)
      }
      for (const li of full.items || []) {
        lotMap[li.id] = li.itemId ? remByItem[li.itemId] ?? null : null
      }
      setBillLotRemaining(lotMap)
    } catch (err) {
      console.error('Failed to load bill:', err)
    } finally {
      setLoading(false)
    }
  }

  const remainingFor = (line) => {
    const prior = alreadyReturned[line.id] || 0
    const byCap = Math.max(0, Number(line.qty || 0) - prior)
    // Cap further by what's still in this bill's lot (when tracked).
    const lot = billLotRemaining[line.id]
    if (lot == null) return byCap
    return Math.min(byCap, Math.max(0, Number(lot)))
  }

  const setQtyFor = (line, raw) => {
    const remaining = remainingFor(line)
    const v = Math.max(0, Math.min(remaining, Math.floor(Number(raw) || 0)))
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
      // li.lineTotal = taxable + tax (total paid per line). Extract tax
      // component using the GST-inclusive extraction formula, which works
      // correctly for both inclusive and exclusive org pricing modes.
      const unitTotal = Number(li.lineTotal || 0) / Math.max(1, Number(li.qty || 1))
      const lineTotalAmt = q * unitTotal
      const taxFrac = Number(li.taxRate || 0) / (100 + Number(li.taxRate || 0))
      const t = Math.round(lineTotalAmt * taxFrac * 100) / 100
      subtotal += Math.round((lineTotalAmt - t) * 100) / 100
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
    if (submitting) return
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
        // bill_line_id is the precise matcher — backend uses it to
        // sum prior returns per line. Always present for fresh bills.
        bill_line_id: li.id,
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
                  <th style={{ width: 95, textAlign: 'right' }}>Returnable</th>
                  <th style={{ width: 90, textAlign: 'right' }}>Return Qty</th>
                  <th style={{ width: 95, textAlign: 'right' }}>Cost</th>
                  <th style={{ width: 100, textAlign: 'right' }}>Line Total</th>
                </tr>
              </thead>
              <tbody>
                {(bill.items || []).map((li) => {
                  const cap = Number(li.qty || 0)
                  const remaining = remainingFor(li)
                  const q = returnQtys[li.id] || 0
                  const unitTotal = Number(li.lineTotal || 0) / Math.max(1, Number(li.qty || 1))
                  const lineWithTax = Math.round(q * unitTotal * 100) / 100
                  // Disabled when nothing left to return. Distinguishes
                  // "fully returned" rows (greyed + label) from "ok to
                  // return" rows.
                  const disabled = remaining === 0
                  return (
                    <tr key={li.id} style={disabled ? { opacity: 0.5 } : null}>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{li.name}</div>
                        {disabled && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fully returned</div>
                        )}
                      </td>
                      <td className="text-right mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cap}</td>
                      <td className="text-right mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {remaining}
                      </td>
                      <td className="text-right">
                        <input
                          className="form-input"
                          type="number"
                          min={0}
                          max={remaining}
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

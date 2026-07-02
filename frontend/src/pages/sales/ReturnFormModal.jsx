/**
 * New Sales Return / Credit Note modal.
 *
 * Two-stage flow inside one modal:
 *   1. Operator picks an invoice (by number search OR from a dropdown
 *      of recent invoices fetched on open).
 *   2. After invoice resolves, lines + returnable qty caps are displayed.
 *      Operator enters per-line return_qty (capped client-side at
 *      remaining = original_qty − already_returned), picks a refund
 *      method, optionally adds reason + notes.
 *
 * Server enforces all the same constraints — this modal just gives
 * inline feedback so the operator catches mistakes before the POST.
 *
 * Refund method semantics (matches backend SalesReturnCreate):
 *   • cash       — operator gives cash from drawer (no customer credit)
 *   • credit     — bumps customer.credit_balance (customer required;
 *                  server downgrades to "cash" silently for walk-ins)
 *
 * 2026-05-24: dropped the 'adjustment' option from the UI per user
 * request — operators were confused about when to use it and it created
 * weird side-effects when the return exceeded the paid amount. Backend
 * still accepts the value (legacy data round-trips), we just don't offer
 * it on new returns. The cash + credit cases already cover the partial-
 * paid scenarios via the AlertBar hints below the table.
 *
 * See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md for the spec.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import { salesAPI } from '@/api'
import { fmt } from '@/utils/helpers'

export default function ReturnFormModal({ open, onClose, onSaved }) {
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoice, setInvoice] = useState(null)         // full invoice with items + customer info
  const [alreadyReturned, setAlreadyReturned] = useState({})  // {invoice_line_id: total_returned}
  const [returnQtys, setReturnQtys] = useState({})     // {invoice_line_id: number}
  // 2026-05-31: per-line, per-source-batch restore split.
  // { [lineId]: { [batchId]: number } }. Only populated for tracked lines
  // that carry a batchAllocation manifest from the invoice. Defaults FEFO.
  const [batchAllocByLine, setBatchAllocByLine] = useState({})
  const [refundMethod, setRefundMethod] = useState('cash')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Reset all state when modal opens — leftover from a previous attempt
  // would be confusing.
  useEffect(() => {
    if (open) {
      setInvoiceNumber('')
      setInvoice(null)
      setAlreadyReturned({})
      setReturnQtys({})
      setBatchAllocByLine({})
      setRefundMethod('cash')
      setReason('')
      setNotes('')
    }
  }, [open])

  // Source lots a given invoice line consumed (from the manifest the
  // backend now stores). Empty list = untracked or legacy line (no
  // per-batch panel; restock falls back server-side).
  const sourceBatches = (line) => {
    const a = line.batchAllocation
    if (!Array.isArray(a)) return []
    // Sort FEFO (nearest expiry first); nulls last.
    return [...a].sort((x, y) =>
      String(x.expiry_date || '9999-12-31').localeCompare(String(y.expiry_date || '9999-12-31')))
  }

  // Distribute `qty` across a line's source lots FEFO, capped per lot by
  // what the invoice took (`consumed`). Returns { [batchId]: qty }.
  const fefoDistribute = (line, qty) => {
    const out = {}
    let remaining = Math.max(0, Math.floor(Number(qty) || 0))
    for (const b of sourceBatches(line)) {
      if (remaining <= 0) break
      const cap = Math.max(0, Number(b.consumed || 0))
      const take = Math.min(cap, remaining)
      if (take > 0) { out[b.batch_id] = take; remaining -= take }
    }
    return out
  }

  const isWalkin = !invoice?.customerId

  // Force refund_method to cash for walk-ins (matches server). UI shows
  // the option as disabled rather than auto-flipping silently.
  useEffect(() => {
    if (isWalkin && refundMethod !== 'cash') setRefundMethod('cash')
  }, [isWalkin, refundMethod])

  const loadInvoice = async () => {
    if (!invoiceNumber.trim()) {
      toast.error('Enter an invoice number')
      return
    }
    setLoading(true)
    try {
      // First find the invoice by its human-readable number (operators
      // type things like "INV-2026-2014", not opaque uuids).
      const listRes = await salesAPI.list({
        search: invoiceNumber.trim(),
        limit: 5,
      })
      const items = listRes?.items || []
      // 2026-05-24: exact-match only. The previous `|| items[0]` fallback
      // accepted any "starts with" match the search endpoint returned,
      // which was misleading — operators would type "INV-2026-201" and
      // get a return started against INV-2026-2010 by mistake. Now we
      // require the operator-typed number to exactly match the canonical
      // invoice number. A small Copy button next to invoice numbers in
      // the Invoices tab (see SalesPage.jsx) helps them grab the exact
      // string without retyping.
      const match = items.find(
        (i) => (i.number || '').toLowerCase() === invoiceNumber.trim().toLowerCase(),
      )
      if (!match) {
        toast.error(`No invoice found matching "${invoiceNumber}"`)
        setInvoice(null)
        return
      }
      // Fetch the full invoice (with line items).
      const full = await salesAPI.get(match.id)
      setInvoice(full)
      // Sum prior returns per invoice_line_id so the per-line cap is
      // accurate. There's no dedicated endpoint for this; list-and-sum is
      // the lightest implementation.
      const allReturns = (await salesAPI.returns.list({ limit: 500 }))?.items || []
      const tally = {}
      for (const r of allReturns) {
        if (r.invoiceId !== full.id) continue
        if (r.status === 'void') continue  // voided returns don't count against the cap
        for (const li of r.items || []) {
          if (!li.invoiceLineId) continue
          tally[li.invoiceLineId] = (tally[li.invoiceLineId] || 0) + Number(li.returnQty || 0)
        }
      }
      setAlreadyReturned(tally)
      // Seed return qtys to 0 for every line.
      const initialQtys = {}
      for (const il of full.items || []) initialQtys[il.id] = 0
      setReturnQtys(initialQtys)
    } catch (err) {
      console.error('Failed to load invoice:', err)
      // global axios interceptor already toasted
    } finally {
      setLoading(false)
    }
  }

  const remainingFor = (line) => {
    const prior = alreadyReturned[line.id] || 0
    return Math.max(0, Number(line.qty || 0) - prior)
  }

  const setQtyFor = (line, raw) => {
    const remaining = remainingFor(line)
    const v = Math.max(0, Math.min(remaining, Math.floor(Number(raw) || 0)))
    setReturnQtys((cur) => ({ ...cur, [line.id]: v }))
    // Re-seed the per-batch split FEFO whenever the line qty changes (only
    // for tracked lines that have a source manifest).
    if (sourceBatches(line).length > 0) {
      setBatchAllocByLine((cur) => ({ ...cur, [line.id]: fefoDistribute(line, v) }))
    }
  }

  // Operator override for one source lot's restore qty (capped at consumed).
  const setBatchQtyFor = (line, batch, raw) => {
    const cap = Math.max(0, Number(batch.consumed || 0))
    const v = Math.max(0, Math.min(cap, Math.floor(Number(raw) || 0)))
    setBatchAllocByLine((cur) => ({
      ...cur,
      [line.id]: { ...(cur[line.id] || {}), [batch.batch_id]: v },
    }))
  }

  // Sum of the per-batch split for a line (for the "X of Y" validation hint).
  const batchAllocSum = (line) =>
    Object.values(batchAllocByLine[line.id] || {}).reduce((s, n) => s + Number(n || 0), 0)

  const totals = useMemo(() => {
    if (!invoice) return { subtotal: 0, tax: 0, total: 0, anyReturned: false }
    let subtotal = 0
    let tax = 0
    let anyReturned = false
    for (const il of invoice.items || []) {
      const q = returnQtys[il.id] || 0
      if (q > 0) anyReturned = true
      // il.lineTotal = taxable base (pre-tax). Multiply by (1 + rate%) to get
      // the amount the customer actually paid for those units — correct for both
      // inclusive and exclusive pricing modes.
      const unitBase = Number(il.lineTotal || 0) / Math.max(1, Number(il.qty || 1))
      const lineBase = q * unitBase
      const t = Math.round(lineBase * (Number(il.taxRate || 0) / 100) * 100) / 100
      subtotal += lineBase
      tax += t
    }
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      total: Math.round((subtotal + tax) * 100) / 100,
      anyReturned,
    }
  }, [invoice, returnQtys])

  const handleSubmit = async () => {
    if (submitting) return
    if (!invoice) {
      toast.error('Pick an invoice first')
      return
    }
    if (!totals.anyReturned) {
      toast.error('Enter a return quantity for at least one line')
      return
    }
    // For tracked lines with a source manifest, the per-batch split must
    // add up to the line's return qty.
    for (const il of invoice.items || []) {
      const q = returnQtys[il.id] || 0
      if (q > 0 && sourceBatches(il).length > 0 && batchAllocSum(il) !== q) {
        toast.error(`${il.name}: per-batch restore (${batchAllocSum(il)}) must equal return qty (${q})`)
        return
      }
    }
    const items = (invoice.items || [])
      .filter((il) => (returnQtys[il.id] || 0) > 0)
      .map((il) => {
        const line = {
          invoice_line_id: il.id,
          item_id: il.itemId || null,
          name: il.name,
          return_qty: returnQtys[il.id],
        }
        // Attach the per-batch restore split for tracked lines.
        const alloc = batchAllocByLine[il.id]
        if (sourceBatches(il).length > 0 && alloc) {
          line.batch_allocation = Object.entries(alloc)
            .filter(([, qty]) => Number(qty) > 0)
            .map(([batch_id, qty]) => ({ batch_id, qty: Number(qty) }))
        }
        return line
      })
    setSubmitting(true)
    try {
      const res = await salesAPI.returns.create({
        invoice_id: invoice.id,
        reason: reason.trim() || null,
        refund_method: refundMethod,
        items,
        notes: notes.trim() || null,
      })
      // Toast message mirrors the server's outcome — cash refund vs
      // credit bump vs adjustment-against-balance.
      const credited = Number(res?.credited_amount || 0)
      if (res?.refund_method === 'credit' && credited > 0) {
        toast.success(
          `Return ${res.number} processed. ${fmt(credited)} credited to ${invoice.customerName}`,
          { duration: 5000 },
        )
      } else if (res?.refund_method === 'cash' && credited > 0) {
        toast.success(`Return ${res.number} processed. Refund ${fmt(credited)} cash from drawer`)
      } else {
        toast.success(`Return ${res?.number || ''} processed`)
      }
      onSaved?.(res)
      onClose()
    } catch (err) {
      console.error('Failed to create return:', err)
      // Toast already fired by global axios interceptor.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={submitting}
      title="New Return / Credit Note"
      icon="↩"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !invoice || !totals.anyReturned}
          >
            {submitting ? 'Processing…' : 'Process Return'}
          </button>
        </>
      }
    >
      {/* Stage 1: invoice picker */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
        <FormGroup label="Invoice Number" required>
          <input
            className="form-input"
            placeholder="INV-2026-2014"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadInvoice() } }}
          />
        </FormGroup>
        <button
          className="btn btn-secondary"
          onClick={loadInvoice}
          disabled={loading || !invoiceNumber.trim()}
        >
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>

      {!invoice && (
        <EmptyState
          icon="🧾"
          title="No invoice loaded"
          desc="Enter an invoice number to start a return."
        />
      )}

      {invoice && (
        <>
          <AlertBar type="blue" icon="ℹ">
            <strong>{invoice.number}</strong> · {invoice.customerName || 'Walk-in'} ·
            Total: <strong>{fmt(invoice.total)}</strong> · Paid: <strong>{fmt(invoice.paidAmount)}</strong>
          </AlertBar>
          <div style={{ height: 14 }} />

          <FormGroup label="Lines to return" required>
            <table className="data-table" style={{ marginBottom: 6 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ width: 70, textAlign: 'right' }}>Sold</th>
                  <th style={{ width: 90, textAlign: 'right' }}>Returnable</th>
                  <th style={{ width: 90, textAlign: 'right' }}>Return Qty</th>
                  <th style={{ width: 90, textAlign: 'right' }}>Line Total</th>
                </tr>
              </thead>
              <tbody>
                {(invoice.items || []).map((il) => {
                  const remaining = remainingFor(il)
                  const q = returnQtys[il.id] || 0
                  const unitBase = Number(il.lineTotal || 0) / Math.max(1, Number(il.qty || 1))
                  const lineWithTax = Math.round(q * unitBase * (1 + Number(il.taxRate || 0) / 100) * 100) / 100
                  const disabled = remaining === 0
                  const batches = sourceBatches(il)
                  const showBatchPanel = batches.length > 0 && q > 0
                  const allocSum = batchAllocSum(il)
                  const allocOk = allocSum === q
                  return (
                    <Fragment key={il.id}>
                    <tr style={disabled ? { opacity: 0.5 } : null}>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{il.name}</div>
                        {disabled && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fully returned</div>
                        )}
                      </td>
                      <td className="text-right mono" style={{ fontSize: 12 }}>{il.qty}</td>
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
                          onChange={(e) => setQtyFor(il, e.target.value)}
                          style={{ width: 70, textAlign: 'right', padding: '4px 6px' }}
                        />
                      </td>
                      <td className="text-right mono" style={{ fontSize: 12 }}>
                        {fmt(Math.round(lineWithTax * 100) / 100)}
                      </td>
                    </tr>
                    {showBatchPanel && (
                      <tr>
                        <td colSpan={5} style={{ padding: '0 0 10px 0', borderTop: 'none' }}>
                          <div style={{
                            border: '1px solid var(--border-subtle)', borderRadius: 8,
                            background: 'var(--bg-raised)', padding: '10px 12px', marginLeft: 8,
                          }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                              Restore to source batches (from this invoice)
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, marginBottom: 8 }}>
                              Defaults by expiry (FEFO). Cap per batch = qty taken from that batch on this invoice.
                            </div>
                            <table className="data-table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th>Batch #</th>
                                  <th style={{ width: 110 }}>Expiry</th>
                                  <th style={{ width: 110, textAlign: 'right' }}>Taken</th>
                                  <th style={{ width: 110, textAlign: 'right' }}>Restore Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                                {batches.map((b) => (
                                  <tr key={b.batch_id}>
                                    <td className="mono" style={{ fontSize: 12, color: 'var(--accent)' }}>{b.batch_number || b.batch_id}</td>
                                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.expiry_date || '—'}</td>
                                    <td className="text-right mono" style={{ fontSize: 12 }}>{b.consumed}</td>
                                    <td className="text-right">
                                      <input
                                        className="form-input"
                                        type="number"
                                        min={0}
                                        max={b.consumed}
                                        value={(batchAllocByLine[il.id]?.[b.batch_id]) ?? 0}
                                        onChange={(e) => setBatchQtyFor(il, b, e.target.value)}
                                        style={{ width: 90, textAlign: 'right', padding: '4px 6px' }}
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div style={{ fontSize: 11, marginTop: 6, color: allocOk ? 'var(--green)' : 'var(--amber)' }}>
                              {allocOk
                                ? `Restoring ${allocSum} of ${q} — matches return qty ✓`
                                : `Allocated ${allocSum} of ${q} — adjust so they match`}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </FormGroup>

          {totals.anyReturned && (
            <div style={{
              padding: '10px 14px',
              background: 'var(--bg-raised)',
              borderRadius: 6,
              marginBottom: 14,
              display: 'flex', justifyContent: 'space-between',
              fontSize: 13, fontWeight: 600,
            }}>
              <span>Return total:</span>
              <span className="mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 14 }}>
            <FormGroup label="Refund Method" required>
              <AutocompleteDropdown
                value={refundMethod}
                onChange={setRefundMethod}
                options={[
                  { id: 'cash', label: '💵 Cash (refund from drawer)' },
                  {
                    id: 'credit',
                    label: `🏦 Customer Credit${isWalkin ? ' (walk-in — pick Cash)' : ''}`,
                    disabled: isWalkin,
                  },
                ]}
                isSearchFieldRequired={false}
              />
            </FormGroup>
            <FormGroup label="Reason">
              <input
                className="form-input"
                placeholder="Damaged / Wrong item / Customer changed mind"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FormGroup>
          </div>

          <FormGroup label="Notes">
            <textarea
              className="form-input"
              style={{ height: 60 }}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </FormGroup>

          {/* Inline hints for what each refund method does */}
          {refundMethod === 'credit' && !isWalkin && totals.total > Number(invoice.paidAmount || 0) && (
            <AlertBar type="amber" icon="ℹ">
              Return total exceeds paid amount. Only <strong>{fmt(invoice.paidAmount)}</strong> can be credited
              to the customer; the remaining <strong>{fmt(totals.total - Number(invoice.paidAmount))}</strong> will
              reduce the invoice&apos;s outstanding balance.
            </AlertBar>
          )}
          {refundMethod === 'cash' && !isWalkin && totals.total > Number(invoice.paidAmount || 0) && (
            <AlertBar type="amber" icon="ℹ">
              Return total exceeds paid amount. Only <strong>{fmt(invoice.paidAmount)}</strong> will be refunded
              in cash; the remaining <strong>{fmt(totals.total - Number(invoice.paidAmount))}</strong> reduces
              the invoice&apos;s outstanding balance.
            </AlertBar>
          )}
        </>
      )}
    </Modal>
  )
}

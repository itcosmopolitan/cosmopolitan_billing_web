/**
 * Sales > Payments > "+ New Payment" modal.
 *
 * Flow:
 *   1. Pick a customer (strict CustomerPicker — must exist).
 *   2. Modal fetches that customer's pending / partial / overdue
 *      invoices (single GET /sales/?customer_id=X with the standard
 *      filter chain — backend already supports the status set).
 *   3. Operator checks 1+ invoices. Each checked row exposes an
 *      "Apply Amount" input pre-filled to that invoice's balance.
 *   4. If any Apply Amount exceeds the row's balance, an amber inline
 *      warning shows ("Excess ₹X will be credited to customer"); the
 *      excess accumulates into Payment.credit_applied on submit.
 *   5. Pick payment method + reference + notes → submit.
 *
 * Posts to POST /sales/payments/ with:
 *   { customer_id, date, payment_mode, payment_ref, notes,
 *     allocations: [{ invoice_id, amount }] }
 *
 * Backend validates the customer owns each invoice + applies the
 * allocations atomically + handles the credit_balance bump if any
 * excess. See routes/sales.create_payment for the contract.
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, AlertBar, EmptyState } from '@/components/ui'
import { salesAPI } from '@/api'
import { fmt } from '@/utils/helpers'
import CustomerPicker from './CustomerPicker'

const ACTIVE_STATUSES = new Set(['pending', 'partial', 'overdue'])

export default function PaymentFormModal({ open, onClose, onSaved }) {
  const [customer, setCustomer] = useState(null)   // { id, name } | null
  const [invoices, setInvoices] = useState([])     // pending/partial/overdue rows for the picked customer
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Per-invoice state. checkedIds is a Set of invoice ids; applyById is
  // a map of invoice.id → string value the operator typed into Apply Amount.
  const [checkedIds, setCheckedIds] = useState(new Set())
  const [applyById, setApplyById] = useState({})
  const [paymentMode, setPaymentMode] = useState('cash')
  const [paymentRef, setPaymentRef] = useState('')
  const [notes, setNotes] = useState('')

  // Reset everything when the modal opens — leftover from a previous
  // attempt would be confusing.
  useEffect(() => {
    if (open) {
      setCustomer(null)
      setInvoices([])
      setCheckedIds(new Set())
      setApplyById({})
      setPaymentMode('cash')
      setPaymentRef('')
      setNotes('')
    }
  }, [open])

  // Load that customer's outstanding invoices when they're picked. We
  // request a comfortable page size — 200 should cover any sane vendor's
  // open balance; if someone has > 200 open invoices, time to pay some.
  useEffect(() => {
    if (!customer?.id) return
    let cancelled = false
    setLoading(true)
    salesAPI.list({
      customer_id: customer.id,
      limit: 200,
      sort_by: 'date',
      sort_order: 'asc',
    })
      .then((raw) => {
        if (cancelled) return
        // Filter client-side to active statuses. Backend supports
        // single-status filter but not a status list — list of all
        // and trim here is the cheapest path.
        const rows = (raw?.items || []).filter((inv) => {
          const st = String(inv.status || '').toLowerCase()
          return ACTIVE_STATUSES.has(st)
        })
        setInvoices(rows)
        // Seed Apply Amount inputs to each invoice's balance. Operator
        // can edit per-row. checkedIds starts empty — operator opts in.
        const seed = {}
        rows.forEach((inv) => {
          const balance = (inv.total || 0) - (inv.paidAmount || 0)
          seed[inv.id] = String(Math.max(0, balance).toFixed(2))
        })
        setApplyById(seed)
      })
      .catch(() => {
        if (!cancelled) setInvoices([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [customer])

  const toggleCheck = (id) => {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const setAllChecked = (checked) => {
    if (!checked) {
      setCheckedIds(new Set())
      return
    }
    setCheckedIds(new Set(invoices.map((i) => i.id)))
  }

  // Live totals. Iterates over the CHECKED rows only — unchecked rows
  // don't contribute to allocated total or credit.
  const totals = useMemo(() => {
    let allocated = 0
    let credit = 0
    let count = 0
    for (const inv of invoices) {
      if (!checkedIds.has(inv.id)) continue
      count += 1
      const amt = Number(applyById[inv.id]) || 0
      const balance = (inv.total || 0) - (inv.paidAmount || 0)
      allocated += amt
      credit += Math.max(0, amt - balance)
    }
    return { allocated: Math.round(allocated * 100) / 100, credit: Math.round(credit * 100) / 100, count }
  }, [invoices, checkedIds, applyById])

  const handleSubmit = async () => {
    if (!customer?.id) {
      toast.error('Pick a customer first')
      return
    }
    if (totals.count === 0) {
      toast.error('Select at least one invoice')
      return
    }
    if (!paymentMode) {
      toast.error('Pick a payment method')
      return
    }
    // Per-row validation: each checked row must have a positive amount.
    const allocations = []
    for (const inv of invoices) {
      if (!checkedIds.has(inv.id)) continue
      const amt = Number(applyById[inv.id])
      if (!amt || amt <= 0) {
        toast.error(`Enter an amount for ${inv.number}`)
        return
      }
      allocations.push({ invoice_id: inv.id, amount: amt })
    }
    setSubmitting(true)
    try {
      const res = await salesAPI.payments.create({
        customer_id: customer.id,
        payment_mode: paymentMode,
        payment_ref: paymentRef.trim() || null,
        notes: notes.trim() || null,
        allocations,
      })
      const credit = Number(res?.credit_applied || 0)
      if (credit > 0) {
        toast.success(
          `Payment ${res.number} recorded. ${fmt(credit)} credited to ${customer.name}`,
          { duration: 5000 },
        )
      } else {
        toast.success(`Payment ${res.number} recorded`)
      }
      onSaved?.(res)
      onClose()
    } catch (err) {
      console.error('Failed to record payment:', err)
      // Global axios interceptor toasted the server detail already.
    } finally {
      setSubmitting(false)
    }
  }

  const buttonDisabled = submitting || !customer || totals.count === 0 || !paymentMode

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Record Payment"
      icon="💰"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={buttonDisabled}>
            {submitting ? 'Recording…' : 'Record Payment'}
          </button>
        </>
      }
    >
      {/* Customer picker — strict typeahead. Selecting a customer
          triggers the invoice fetch above. Clearing resets everything
          back to the unpicked state (modal stays open). */}
      <FormGroup label="Customer" required>
        <CustomerPicker
          value={customer}
          onPick={(c) => setCustomer({ id: c.id, name: c.name })}
          onClear={() => {
            setCustomer(null)
            setInvoices([])
            setCheckedIds(new Set())
            setApplyById({})
          }}
        />
      </FormGroup>

      {customer && (
        <>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Loading invoices…
            </div>
          ) : invoices.length === 0 ? (
            <EmptyState
              icon="🧾"
              title="No outstanding invoices"
              desc={`${customer.name} has no pending, partial, or overdue invoices.`}
            />
          ) : (
            <>
              {(() => {
                // Outstanding summary — total balance across ALL
                // invoices (not just checked ones).
                const totalBalance = invoices.reduce((acc, inv) =>
                  acc + Math.max(0, (inv.total || 0) - (inv.paidAmount || 0)), 0)
                return (
                  <AlertBar type="blue" icon="ℹ">
                    {invoices.length} pending {invoices.length === 1 ? 'invoice' : 'invoices'} ·{' '}
                    <strong>{fmt(totalBalance)}</strong> outstanding
                  </AlertBar>
                )
              })()}
              <div style={{ height: 14 }} />

              <div style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6,
              }}>
                <span style={{
                  fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                }}>
                  Pending Invoices
                </span>
                <button
                  type="button"
                  onClick={() => setAllChecked(checkedIds.size !== invoices.length)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: 'var(--accent)', cursor: 'pointer',
                    fontSize: 12, padding: 0, fontWeight: 500,
                  }}
                >
                  {checkedIds.size === invoices.length ? 'Clear all' : 'Select all'}
                </button>
              </div>

              <table className="data-table" style={{ marginBottom: 6 }}>
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Invoice #</th>
                    <th>Date</th>
                    <th style={{ width: 110, textAlign: 'right' }}>Total</th>
                    <th style={{ width: 100, textAlign: 'right' }}>Paid</th>
                    <th style={{ width: 110, textAlign: 'right' }}>Balance</th>
                    <th style={{ width: 130, textAlign: 'right' }}>Apply Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => {
                    const checked = checkedIds.has(inv.id)
                    const balance = (inv.total || 0) - (inv.paidAmount || 0)
                    const apply = Number(applyById[inv.id]) || 0
                    const excess = checked ? Math.max(0, apply - balance) : 0
                    return (
                      <tr key={inv.id} style={!checked ? { opacity: 0.55 } : null}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCheck(inv.id)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </td>
                        <td>
                          <span className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>
                            {inv.number}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.date}</td>
                        <td className="text-right mono" style={{ fontSize: 12 }}>{fmt(inv.total)}</td>
                        <td className="text-right mono" style={{ fontSize: 12, color: 'var(--green)' }}>{fmt(inv.paidAmount || 0)}</td>
                        <td className="text-right mono" style={{ fontSize: 12, color: 'var(--red)' }}>{fmt(balance)}</td>
                        <td className="text-right">
                          <input
                            className="form-input"
                            type="number"
                            value={applyById[inv.id] || ''}
                            disabled={!checked}
                            onChange={(e) =>
                              setApplyById((prev) => ({ ...prev, [inv.id]: e.target.value }))
                            }
                            style={{
                              width: 110, padding: '4px 6px',
                              textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                            }}
                          />
                          {excess > 0 && (
                            <div style={{ fontSize: 10.5, color: 'var(--amber)', marginTop: 2 }}>
                              Excess {fmt(excess)} → credit
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* Totals strip — right-aligned summary. Matches the SO/
                  Quote modals' strip style. */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                <div style={{ minWidth: 280 }}>
                  <div style={totalsRowStyle}>
                    <span style={totalsLabelStyle}>Total Selected</span>
                    <span style={totalsValueStyle}>{totals.count} {totals.count === 1 ? 'invoice' : 'invoices'}</span>
                  </div>
                  {totals.credit > 0 && (
                    <div style={totalsRowStyle}>
                      <span style={totalsLabelStyle}>Credit Applied</span>
                      <span className="mono" style={{ ...totalsValueStyle, color: 'var(--amber)' }}>{fmt(totals.credit)}</span>
                    </div>
                  )}
                  <div style={{ ...totalsRowStyle, borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 4 }}>
                    <span style={{ ...totalsLabelStyle, fontWeight: 600, color: 'var(--text-primary)' }}>Allocated</span>
                    <span className="mono" style={{ ...totalsValueStyle, fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{fmt(totals.allocated)}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
                <FormGroup label="Method" required>
                  <select className="form-input" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                    {['cash', 'card', 'upi', 'bank_transfer'].map((m) => (
                      <option key={m} value={m}>{m.replace('_', ' ').toUpperCase()}</option>
                    ))}
                  </select>
                </FormGroup>
                <FormGroup label="Reference">
                  <input
                    className="form-input"
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    placeholder="UTR / transaction id"
                  />
                </FormGroup>
              </div>
              <FormGroup label="Notes (optional)">
                <textarea
                  className="form-input"
                  style={{ height: 60 }}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </FormGroup>
            </>
          )}
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

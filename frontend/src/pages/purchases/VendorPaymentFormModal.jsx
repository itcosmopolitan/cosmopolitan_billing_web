/**
 * Purchases > Payments > "+ New Payment" modal.
 *
 * Mirror of sales/PaymentFormModal. Differences:
 *   • Vendor picker (strict) instead of Customer picker.
 *   • Bills (PUR-...) instead of invoices (INV-...).
 *   • NO overpayment-to-credit — vendors don't have a credit_balance
 *     field yet. Allocations > bill balance get inline red warning +
 *     are clamped by the backend (which 400s if any allocation exceeds
 *     its bill's balance). UX clamps on submit for the same outcome.
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, AlertBar, EmptyState } from '@/components/ui'
import { purchasesAPI } from '@/api'
import { fmt } from '@/utils/helpers'
import VendorPicker from './VendorPicker'

const ACTIVE_STATUSES = new Set(['pending', 'partial', 'overdue'])

export default function VendorPaymentFormModal({ open, onClose, onSaved }) {
  const [vendor, setVendor] = useState(null)
  const [bills, setBills] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [checkedIds, setCheckedIds] = useState(new Set())
  const [applyById, setApplyById] = useState({})
  const [paymentMode, setPaymentMode] = useState('bank_transfer')
  const [paymentRef, setPaymentRef] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (open) {
      setVendor(null)
      setBills([])
      setCheckedIds(new Set())
      setApplyById({})
      setPaymentMode('bank_transfer')
      setPaymentRef('')
      setNotes('')
    }
  }, [open])

  useEffect(() => {
    if (!vendor?.id) return
    let cancelled = false
    setLoading(true)
    purchasesAPI.list({
      vendor_id: vendor.id,
      limit: 200,
      sort_by: 'date',
      sort_order: 'asc',
    })
      .then((raw) => {
        if (cancelled) return
        const rows = (raw?.items || []).filter((b) => {
          const st = String(b.status || '').toLowerCase()
          return ACTIVE_STATUSES.has(st)
        })
        setBills(rows)
        const seed = {}
        rows.forEach((b) => {
          const balance = (b.total || 0) - (b.paidAmount || 0)
          seed[b.id] = String(Math.max(0, balance).toFixed(2))
        })
        setApplyById(seed)
      })
      .catch(() => { if (!cancelled) setBills([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [vendor])

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
    setCheckedIds(new Set(bills.map((b) => b.id)))
  }

  const totals = useMemo(() => {
    let allocated = 0
    let overpay = 0
    let count = 0
    for (const b of bills) {
      if (!checkedIds.has(b.id)) continue
      count += 1
      const amt = Number(applyById[b.id]) || 0
      const balance = (b.total || 0) - (b.paidAmount || 0)
      allocated += amt
      overpay += Math.max(0, amt - balance)
    }
    return {
      allocated: Math.round(allocated * 100) / 100,
      overpay: Math.round(overpay * 100) / 100,
      count,
    }
  }, [bills, checkedIds, applyById])

  const handleSubmit = async () => {
    if (!vendor?.id) { toast.error('Pick a vendor first'); return }
    if (totals.count === 0) { toast.error('Select at least one bill'); return }
    if (!paymentMode) { toast.error('Pick a payment method'); return }
    // Vendor payments REJECT overpay (no credit_balance on Vendor yet).
    // Surfacing the message client-side is friendlier than waiting on
    // the backend 400.
    if (totals.overpay > 0) {
      toast.error(`Allocation exceeds bill balance by ${fmt(totals.overpay)}. Reduce or split.`)
      return
    }
    const allocations = []
    for (const b of bills) {
      if (!checkedIds.has(b.id)) continue
      const amt = Number(applyById[b.id])
      if (!amt || amt <= 0) {
        toast.error(`Enter an amount for ${b.number}`)
        return
      }
      allocations.push({ bill_id: b.id, amount: amt })
    }
    setSubmitting(true)
    try {
      const res = await purchasesAPI.payments.create({
        vendor_id: vendor.id,
        payment_mode: paymentMode,
        payment_ref: paymentRef.trim() || null,
        notes: notes.trim() || null,
        allocations,
      })
      toast.success(`Payment ${res.number} recorded`)
      onSaved?.(res)
      onClose()
    } catch (err) {
      console.error('Failed to record payment:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const buttonDisabled = submitting || !vendor || totals.count === 0 || !paymentMode || totals.overpay > 0

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Record Vendor Payment"
      icon="💸"
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
      <FormGroup label="Vendor" required>
        <VendorPicker
          value={vendor}
          onPick={(v) => setVendor({ id: v.id, name: v.name })}
          onClear={() => {
            setVendor(null)
            setBills([])
            setCheckedIds(new Set())
            setApplyById({})
          }}
        />
      </FormGroup>

      {vendor && (
        <>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Loading bills…
            </div>
          ) : bills.length === 0 ? (
            <EmptyState
              icon="📋"
              title="No outstanding bills"
              desc={`${vendor.name} has no pending, partial, or overdue bills.`}
            />
          ) : (
            <>
              {(() => {
                const totalBalance = bills.reduce((acc, b) =>
                  acc + Math.max(0, (b.total || 0) - (b.paidAmount || 0)), 0)
                return (
                  <AlertBar type="blue" icon="ℹ">
                    {bills.length} pending {bills.length === 1 ? 'bill' : 'bills'} ·{' '}
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
                  Pending Bills
                </span>
                <button
                  type="button"
                  onClick={() => setAllChecked(checkedIds.size !== bills.length)}
                  style={{
                    background: 'transparent', border: 'none',
                    color: 'var(--accent)', cursor: 'pointer',
                    fontSize: 12, padding: 0, fontWeight: 500,
                  }}
                >
                  {checkedIds.size === bills.length ? 'Clear all' : 'Select all'}
                </button>
              </div>

              <table className="data-table" style={{ marginBottom: 6 }}>
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>Bill #</th>
                    <th>Date</th>
                    <th style={{ width: 110, textAlign: 'right' }}>Total</th>
                    <th style={{ width: 100, textAlign: 'right' }}>Paid</th>
                    <th style={{ width: 110, textAlign: 'right' }}>Balance</th>
                    <th style={{ width: 130, textAlign: 'right' }}>Apply Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    const checked = checkedIds.has(b.id)
                    const balance = (b.total || 0) - (b.paidAmount || 0)
                    const apply = Number(applyById[b.id]) || 0
                    const overpay = checked ? Math.max(0, apply - balance) : 0
                    return (
                      <tr key={b.id} style={!checked ? { opacity: 0.55 } : null}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCheck(b.id)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </td>
                        <td>
                          <span className="mono" style={{ color: 'var(--purple)', fontSize: 12 }}>
                            {b.number}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.date}</td>
                        <td className="text-right mono" style={{ fontSize: 12 }}>{fmt(b.total)}</td>
                        <td className="text-right mono" style={{ fontSize: 12, color: 'var(--green)' }}>{fmt(b.paidAmount || 0)}</td>
                        <td className="text-right mono" style={{ fontSize: 12, color: 'var(--red)' }}>{fmt(balance)}</td>
                        <td className="text-right">
                          <input
                            className="form-input"
                            type="number"
                            value={applyById[b.id] || ''}
                            disabled={!checked}
                            onChange={(e) =>
                              setApplyById((prev) => ({ ...prev, [b.id]: e.target.value }))
                            }
                            style={{
                              width: 110, padding: '4px 6px',
                              textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                            }}
                          />
                          {overpay > 0 && (
                            <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 2 }}>
                              Exceeds balance by {fmt(overpay)}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                <div style={{ minWidth: 280 }}>
                  <div style={totalsRowStyle}>
                    <span style={totalsLabelStyle}>Total Selected</span>
                    <span style={totalsValueStyle}>{totals.count} {totals.count === 1 ? 'bill' : 'bills'}</span>
                  </div>
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
                    placeholder="UTR / NEFT / cheque #"
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

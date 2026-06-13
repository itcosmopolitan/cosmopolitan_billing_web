/**
 * Purchases > Payments > "+ New Payment" modal.
 *
 * Mirror of sales/PaymentFormModal. Overpayment routes to vendor.credit_balance;
 * credit mode settles bills from stored vendor advance.
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
    let credit = 0
    let count = 0
    for (const b of bills) {
      if (!checkedIds.has(b.id)) continue
      count += 1
      const amt = Number(applyById[b.id]) || 0
      const balance = (b.total || 0) - (b.paidAmount || 0)
      allocated += amt
      credit += Math.max(0, amt - balance)
    }
    return {
      allocated: Math.round(allocated * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      count,
    }
  }, [bills, checkedIds, applyById])

  const avail = Number(vendor?.credit || 0)
  const creditMode = paymentMode === 'credit'
  const creditInsufficient = creditMode && totals.allocated > avail + 0.001

  const seedApplyToBalances = () => {
    const seed = {}
    bills.forEach((b) => {
      const bal = Math.max(0, (b.total || 0) - (b.paidAmount || 0))
      seed[b.id] = String(bal.toFixed(2))
    })
    setApplyById(seed)
  }

  const handleSubmit = async () => {
    if (submitting) return
    if (!vendor?.id) { toast.error('Pick a vendor first'); return }
    if (totals.count === 0) { toast.error('Select at least one bill'); return }
    if (!paymentMode) { toast.error('Pick a payment method'); return }
    if (creditMode && creditInsufficient) {
      toast.error(`Insufficient vendor credit — ${fmt(avail)} available, ${fmt(totals.allocated)} needed`)
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
      const credit = Number(res?.credit_applied || 0)
      if (credit > 0) {
        toast.success(
          `Payment ${res.number} recorded. ${fmt(credit)} credited to ${vendor.name}`,
          { duration: 5000 },
        )
      } else {
        toast.success(`Payment ${res.number} recorded`)
      }
      onSaved?.(res)
      onClose()
    } catch (err) {
      console.error('Failed to record payment:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const buttonDisabled = submitting || !vendor || totals.count === 0 || !paymentMode || creditInsufficient

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
          onPick={(v) => setVendor({
            id: v.id,
            name: v.name,
            credit: v.credit_balance || v.creditBalance || 0,
          })}
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
                    {avail > 0 && (
                      <> · <strong>{fmt(avail)}</strong> vendor credit available</>
                    )}
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
                    const excess = checked && !creditMode ? Math.max(0, apply - balance) : 0
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
                            disabled={!checked || creditMode}
                            onChange={(e) =>
                              setApplyById((prev) => ({ ...prev, [b.id]: e.target.value }))
                            }
                            style={{
                              width: 110, padding: '4px 6px',
                              textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                            }}
                          />
                          {excess > 0 && (
                            <div style={{ fontSize: 10.5, color: 'var(--amber)', marginTop: 2 }}>
                              Excess {fmt(excess)} → vendor credit
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
                  {totals.credit > 0 && (
                    <div style={totalsRowStyle}>
                      <span style={{ ...totalsLabelStyle, color: 'var(--amber)' }}>Vendor Credit</span>
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
                  <select
                    className="form-input"
                    value={paymentMode}
                    onChange={(e) => {
                      const mode = e.target.value
                      setPaymentMode(mode)
                      if (mode === 'credit') seedApplyToBalances()
                    }}
                  >
                    {['cash', 'card', 'upi', 'bank_transfer', 'credit'].map((m) => (
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
                    disabled={creditMode}
                  />
                </FormGroup>
              </div>
              {creditMode && creditInsufficient && (
                <AlertBar type="red" icon="⚠">
                  Insufficient vendor credit — {fmt(avail)} available, {fmt(totals.allocated)} needed
                </AlertBar>
              )}
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

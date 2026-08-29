/**
 * Purchases > Payments > "+ New Payment" / edit full page.
 *
 * Mirrors PaymentFormPage UX: pick the vendor first, then the vendor's
 * outstanding bills load and the rest of the form becomes actionable.
 * Overpayment routes to vendor.credit_balance; credit mode settles bills
 * from stored vendor advance.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FormGroup, AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import DocumentFormShell from '@/components/DocumentFormShell'
import { purchasesAPI, AUTOCOMPLETE_VENDOR_URL, vendorsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { formatAmountInput, amountInputStep } from '@/utils/decimalPrecision'
import { PAYMENT_METHOD_WITH_CREDIT_OPTIONS } from '@/utils/dropdownOptions'

const ACTIVE_STATUSES = new Set(['pending', 'partial', 'overdue'])

export default function VendorPaymentFormPage() {
  const navigate = useNavigate()
  const { paymentId } = useParams()
  const isEdit = Boolean(paymentId)
  const can = useCan()
  const [vendor, setVendor] = useState(null)
  const [bills, setBills] = useState([])
  const [loading, setLoading] = useState(false)
  const [editLoading, setEditLoading] = useState(isEdit)
  const [editingNumber, setEditingNumber] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkedIds, setCheckedIds] = useState(new Set())
  const [applyById, setApplyById] = useState({})
  const [paymentMode, setPaymentMode] = useState('bank_transfer')
  const [paymentRef, setPaymentRef] = useState('')
  const [notes, setNotes] = useState('')
  const [editAllocByBill, setEditAllocByBill] = useState({})

  useEffect(() => {
    if (!can('purchases.edit')) {
      navigate('/purchases?tab=payments', { replace: true })
    }
  }, [can, navigate])

  const goBack = () => navigate('/purchases?tab=payments')

  const resetVendorState = () => {
    setBills([])
    setCheckedIds(new Set())
    setApplyById({})
  }

  useEffect(() => {
    if (!isEdit || !paymentId) return
    let cancelled = false
    ;(async () => {
      setEditLoading(true)
      try {
        const pay = await purchasesAPI.payments.get(paymentId)
        if (cancelled) return
        if (pay.voided) {
          toast.error('Cannot edit a voided payment')
          navigate('/purchases?tab=payments', { replace: true })
          return
        }
        setEditingNumber(pay.number)
        setPaymentMode(pay.paymentMode || 'bank_transfer')
        setPaymentRef(pay.paymentRef || '')
        setNotes(pay.notes || '')
        const allocMap = {}
        for (const a of pay.allocations || []) {
          allocMap[a.billId] = Number(a.amount || 0)
        }
        setEditAllocByBill(allocMap)
        setCheckedIds(new Set(Object.keys(allocMap)))
        const seed = {}
        Object.entries(allocMap).forEach(([id, amt]) => {
          seed[id] = formatAmountInput(amt)
        })
        setApplyById(seed)
        if (pay.vendorId) {
          try {
            const v = await vendorsAPI.get(pay.vendorId)
            if (!cancelled) {
              setVendor({
                id: v.id,
                name: v.name,
                credit: Number(v.credit_balance || v.creditBalance || 0),
              })
            }
          } catch {
            if (!cancelled) {
              setVendor({ id: pay.vendorId, name: pay.vendorName, credit: 0 })
            }
          }
        }
      } catch {
        if (!cancelled) {
          toast.error('Payment not found')
          navigate('/purchases?tab=payments', { replace: true })
        }
      } finally {
        if (!cancelled) setEditLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, paymentId, navigate])

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
      .then(async (raw) => {
        if (cancelled) return
        let rows = (raw?.items || []).filter((b) => {
          const st = String(b.status || '').toLowerCase()
          return ACTIVE_STATUSES.has(st) || Boolean(editAllocByBill[b.id])
        })
        // Include allocated bills that are fully paid by this payment.
        const missingIds = Object.keys(editAllocByBill).filter((id) => !rows.some((r) => r.id === id))
        if (missingIds.length) {
          const extras = await Promise.all(
            missingIds.map((id) => purchasesAPI.get(id).catch(() => null)),
          )
          rows = [...rows, ...extras.filter(Boolean)]
        }
        setBills(rows)
        if (!isEdit) {
          const seed = {}
          rows.forEach((b) => {
            const balance = (b.total || 0) - (b.paidAmount || 0)
            seed[b.id] = formatAmountInput(Math.max(0, balance))
          })
          setApplyById(seed)
        } else {
          setApplyById((prev) => {
            const next = { ...prev }
            rows.forEach((b) => {
              if (next[b.id] != null) return
              const mine = editAllocByBill[b.id] || 0
              const balance = Math.max(0, (b.total || 0) - (b.paidAmount || 0) + mine)
              next[b.id] = formatAmountInput(balance)
            })
            return next
          })
        }
      })
      .catch(() => { if (!cancelled) setBills([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [vendor, editAllocByBill, isEdit])

  const balanceFor = (b) => {
    const mine = editAllocByBill[b.id] || 0
    return Math.max(0, (b.total || 0) - (b.paidAmount || 0) + mine)
  }

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
      const balance = balanceFor(b)
      allocated += amt
      credit += Math.max(0, amt - balance)
    }
    return {
      allocated: Math.round(allocated * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      count,
    }
  }, [bills, checkedIds, applyById, editAllocByBill])

  const avail = Number(vendor?.credit || 0)
  const creditMode = paymentMode === 'credit'
  const creditInsufficient = creditMode && totals.allocated > avail + 0.001

  const seedApplyToBalances = () => {
    const seed = {}
    bills.forEach((b) => {
      seed[b.id] = formatAmountInput(balanceFor(b))
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
      const payload = {
        vendor_id: vendor.id,
        payment_mode: paymentMode,
        payment_ref: paymentRef.trim() || null,
        notes: notes.trim() || null,
        allocations,
      }
      const res = isEdit
        ? await purchasesAPI.payments.update(paymentId, payload)
        : await purchasesAPI.payments.create(payload)
      const credit = Number(res?.credit_applied || 0)
      if (credit > 0) {
        toast.success(
          `Payment ${res.number} ${isEdit ? 'updated' : 'recorded'}. ${fmt(credit)} credited to ${vendor.name}`,
          { duration: 5000 },
        )
      } else {
        toast.success(isEdit ? `Payment ${res.number} updated` : `Payment ${res.number} recorded`)
      }
      goBack()
    } catch (err) {
      console.error(isEdit ? 'Failed to update payment:' : 'Failed to record payment:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const saveDisabled = !vendor || totals.count === 0 || !paymentMode || creditInsufficient || editLoading

  if (editLoading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    )
  }

  return (
    <DocumentFormShell
      title={isEdit ? `Edit Payment — ${editingNumber || ''}` : 'Create Vendor Payment'}
      subtitle="Payments"
      icon="💸"
      onBack={goBack}
      onSave={handleSubmit}
      saveLabel={isEdit ? 'Save Changes' : 'Record Payment'}
      saving={submitting}
      saveDisabled={saveDisabled}
    >
      <div style={{ display: 'grid', gap: 18 }}>
        <FormGroup label="Vendor" required>
          {isEdit ? (
            <div style={{ fontWeight: 500, fontSize: 14 }}>{vendor?.name || '—'}</div>
          ) : (
            <AutocompleteDropdown
              value={vendor?.id || ''}
              clearable
              onClear={() => {
                setVendor(null)
                resetVendorState()
              }}
              onSelectOption={async (opt) => {
                if (!opt) {
                  setVendor(null)
                  resetVendorState()
                  return
                }
                try {
                  const v = await vendorsAPI.get(opt.id)
                  setVendor({
                    id: v.id,
                    name: v.name,
                    credit: Number(v.credit_balance || v.creditBalance || 0),
                  })
                } catch {
                  setVendor({ id: opt.id, name: opt.label, credit: 0 })
                }
              }}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              isSearchFieldRequired
              selectedLabel={vendor?.name}
              placeholder="Search vendors…"
              searchPlaceholder="Search vendors…"
              emptyLabel="No vendors found. Add via the Vendors page."
              style={{ width: '100%', maxWidth: 420 }}
            />
          )}
        </FormGroup>

        {!vendor ? (
          <EmptyState
            icon="🏷️"
            title="Choose a vendor to begin"
            desc="Pick a vendor above to load their outstanding bills and record a payment."
          />
        ) : loading ? (
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
              const totalBalance = bills.reduce((acc, b) => acc + balanceFor(b), 0)
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

            <div>
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
                    const balance = balanceFor(b)
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
                            min="0"
                            step={amountInputStep()}
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

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
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
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <FormGroup label="Method" required>
                <AutocompleteDropdown
                  value={paymentMode}
                  onChange={setPaymentMode}
                  onSelectOption={(opt) => {
                    if (opt?.id === 'credit') seedApplyToBalances()
                  }}
                  options={PAYMENT_METHOD_WITH_CREDIT_OPTIONS}
                  isSearchFieldRequired={false}
                />
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
      </div>
    </DocumentFormShell>
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

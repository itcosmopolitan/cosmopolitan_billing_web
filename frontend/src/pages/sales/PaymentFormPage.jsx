/**
 * Sales > Payments > "+ New Payment" full page.
 *
 * Mirrors VendorPaymentFormPage UX: pick the customer first, then their
 * outstanding invoices load and the rest of the form becomes actionable.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FormGroup, AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import DocumentFormShell from '@/components/DocumentFormShell'
import { salesAPI, AUTOCOMPLETE_CUSTOMER_URL, customersAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { formatAmountInput, amountInputStep } from '@/utils/decimalPrecision'
import { PAYMENT_MODE_LABEL_OPTIONS } from '@/utils/dropdownOptions'
import CashTenderFields from '@/components/CashTenderFields'
import { cashTenderError } from '@/utils/cashTender'

const ACTIVE_STATUSES = new Set(['pending', 'partial', 'overdue'])

export default function PaymentFormPage() {
  const navigate = useNavigate()
  const can = useCan()
  const [customer, setCustomer] = useState(null)
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [checkedIds, setCheckedIds] = useState(new Set())
  const [applyById, setApplyById] = useState({})
  const [paymentMode, setPaymentMode] = useState('cash')
  const [cashCollected, setCashCollected] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!can('invoices.edit')) {
      navigate('/sales?tab=payments', { replace: true })
    }
  }, [can, navigate])

  const goBack = () => navigate('/sales?tab=payments')

  const resetCustomerState = () => {
    setInvoices([])
    setCheckedIds(new Set())
    setApplyById({})
  }

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
        const rows = (raw?.items || []).filter((inv) => {
          const st = String(inv.status || '').toLowerCase()
          return ACTIVE_STATUSES.has(st)
        })
        setInvoices(rows)
        const seed = {}
        rows.forEach((inv) => {
          const balance = (inv.total || 0) - (inv.paidAmount || 0)
          seed[inv.id] = formatAmountInput(Math.max(0, balance))
        })
        setApplyById(seed)
      })
      .catch(() => { if (!cancelled) setInvoices([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
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
    return {
      allocated: Math.round(allocated * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      count,
    }
  }, [invoices, checkedIds, applyById])

  const avail = Number(customer?.credit || 0)
  const creditMode = paymentMode === 'credit'
  const creditInsufficient = creditMode && totals.allocated > avail + 0.001

  const paymentModeOptions = useMemo(() => [
    ...PAYMENT_MODE_LABEL_OPTIONS,
    {
      id: 'credit',
      label: `STORE CREDIT (${fmt(avail)} available)`,
      disabled: avail <= 0,
    },
  ], [avail])

  const seedApplyToBalances = () => {
    const seed = {}
    invoices.forEach((inv) => {
      const bal = Math.max(0, (inv.total || 0) - (inv.paidAmount || 0))
      seed[inv.id] = formatAmountInput(bal)
    })
    setApplyById(seed)
  }

  const handleSubmit = async () => {
    if (submitting) return
    if (!customer?.id) { toast.error('Pick a customer first'); return }
    if (totals.count === 0) { toast.error('Select at least one invoice'); return }
    if (!paymentMode) { toast.error('Pick a payment method'); return }
    if (paymentMode === 'cash') {
      const err = cashTenderError(cashCollected, totals.allocated)
      if (err) { toast.error(err); return }
    }
    if (creditMode && creditInsufficient) {
      toast.error(`Insufficient store credit — ${fmt(avail)} available, ${fmt(totals.allocated)} needed`)
      return
    }
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
          `Payment ${res.number} recorded. ${fmt(credit)} added to store credit for ${customer.name}`,
          { duration: 5000 },
        )
      } else {
        toast.success(`Payment ${res.number} recorded`)
      }
      goBack()
    } catch (err) {
      console.error('Failed to record payment:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const saveDisabled = !customer || totals.count === 0 || !paymentMode || creditInsufficient

  return (
    <DocumentFormShell
      title="Create Customer Payment"
      subtitle="Payments"
      icon="💰"
      onBack={goBack}
      onSave={handleSubmit}
      saveLabel="Record Payment"
      saving={submitting}
      saveDisabled={saveDisabled}
    >
      <div style={{ display: 'grid', gap: 18 }}>
        <FormGroup label="Customer" required>
          <AutocompleteDropdown
            value={customer?.id || ''}
            clearable
            onClear={() => {
              setCustomer(null)
              resetCustomerState()
            }}
            onSelectOption={async (opt) => {
              if (!opt) {
                setCustomer(null)
                resetCustomerState()
                return
              }
              try {
                const c = await customersAPI.get(opt.id)
                setCustomer({
                  id: c.id,
                  name: c.name,
                  credit: Number(c.credit_balance || 0),
                })
              } catch {
                setCustomer({ id: opt.id, name: opt.label, credit: 0 })
              }
            }}
            fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
            isSearchFieldRequired
            selectedLabel={customer?.name}
            placeholder="Search customers…"
            searchPlaceholder="Search customers…"
            emptyLabel="No customers found. Add via the Customers page."
            style={{ width: '100%', maxWidth: 420 }}
          />
        </FormGroup>

        {!customer ? (
          <EmptyState
            icon="👤"
            title="Choose a customer to begin"
            desc="Pick a customer above to load their outstanding invoices and record a payment."
          />
        ) : loading ? (
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
              const totalBalance = invoices.reduce((acc, inv) =>
                acc + Math.max(0, (inv.total || 0) - (inv.paidAmount || 0)), 0)
              return (
                <AlertBar type="blue" icon="ℹ">
                  {invoices.length} pending {invoices.length === 1 ? 'invoice' : 'invoices'} ·{' '}
                  <strong>{fmt(totalBalance)}</strong> outstanding
                  {avail > 0 && (
                    <> · <strong>{fmt(avail)}</strong> store credit available</>
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
                    const excess = checked && !creditMode ? Math.max(0, apply - balance) : 0
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
                            min="0"
                            step={amountInputStep()}
                            value={applyById[inv.id] || ''}
                            disabled={!checked || creditMode}
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
                              Excess {fmt(excess)} → store credit
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
                    <span style={totalsValueStyle}>{totals.count} {totals.count === 1 ? 'invoice' : 'invoices'}</span>
                  </div>
                  {totals.credit > 0 && (
                    <div style={totalsRowStyle}>
                      <span style={{ ...totalsLabelStyle, color: 'var(--amber)' }}>To store credit</span>
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
                  onChange={(v) => {
                    setPaymentMode(v)
                    if (v !== 'cash') setCashCollected('')
                  }}
                  onSelectOption={(opt) => {
                    if (opt?.id === 'credit') seedApplyToBalances()
                  }}
                  options={paymentModeOptions}
                  isSearchFieldRequired={false}
                />
                {creditMode && (
                  <div style={{
                    fontSize: 11, marginTop: 4,
                    color: creditInsufficient ? 'var(--amber)' : 'var(--text-muted)',
                  }}>
                    {creditInsufficient
                      ? `Allocated ${fmt(totals.allocated)} exceeds store credit ${fmt(avail)}. Reduce selection.`
                      : `Drawing ${fmt(totals.allocated)} from ${fmt(avail)} store credit.`}
                  </div>
                )}
              </FormGroup>
              <FormGroup label="Reference">
                <input
                  className="form-input"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="UTR / transaction id"
                  disabled={creditMode}
                />
              </FormGroup>
            </div>
            {paymentMode === 'cash' && (
              <CashTenderFields
                due={totals.allocated}
                value={cashCollected}
                onChange={setCashCollected}
              />
            )}
            {creditMode && creditInsufficient && (
              <AlertBar type="red" icon="⚠">
                Insufficient store credit — {fmt(avail)} available, {fmt(totals.allocated)} needed
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

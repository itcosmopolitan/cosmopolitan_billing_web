/**
 * Sales > Payments > "+ New Payment" full page.
 *
 * Mirrors VendorPaymentFormPage UX: pick the customer first, then their
 * outstanding invoices load and the rest of the form becomes actionable.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FormGroup, AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import DocumentFormShell from '@/components/DocumentFormShell'
import { salesAPI, AUTOCOMPLETE_CUSTOMER_URL, customersAPI } from '@/api'
import { useQuickCustomer } from '@/components/useQuickParty'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { formatAmountInput, amountInputStep } from '@/utils/decimalPrecision'
import { PAYMENT_MODE_LABEL_OPTIONS } from '@/utils/dropdownOptions'
import CashTenderFields from '@/components/CashTenderFields'
import { cashTenderError } from '@/utils/cashTender'
import { storeCreditApplyAmount, remainingAfterStoreCredit } from '@/utils/storeCredit'

const ACTIVE_STATUSES = new Set(['pending', 'partial', 'overdue'])

export default function PaymentFormPage() {
  const navigate = useNavigate()
  const { paymentId } = useParams()
  const isEdit = Boolean(paymentId)
  const can = useCan()
  const [customer, setCustomer] = useState(null)
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(false)
  const [editLoading, setEditLoading] = useState(isEdit)
  const [editingNumber, setEditingNumber] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkedIds, setCheckedIds] = useState(new Set())
  const [applyById, setApplyById] = useState({})
  const [paymentMode, setPaymentMode] = useState('cash')
  const [cashCollected, setCashCollected] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [notes, setNotes] = useState('')
  const [editAllocByInvoice, setEditAllocByInvoice] = useState({})
  const { footerAction: addCustomerAction, modal: addCustomerModal } = useQuickCustomer({
    enabled: !isEdit,
    onCreated: (c) => {
      setCustomer({
        id: c.id,
        name: c.name,
        credit: Number(c.credit_balance || 0),
      })
    },
  })

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
    if (!isEdit || !paymentId) return
    let cancelled = false
    ;(async () => {
      setEditLoading(true)
      try {
        const pay = await salesAPI.payments.get(paymentId)
        if (cancelled) return
        if (pay.voided) {
          toast.error('Cannot edit a voided payment')
          navigate('/sales?tab=payments', { replace: true })
          return
        }
        setEditingNumber(pay.number)
        setPaymentMode(pay.paymentMode || 'cash')
        setPaymentRef(pay.paymentRef || '')
        setNotes(pay.notes || '')
        const allocMap = {}
        for (const a of pay.allocations || []) {
          allocMap[a.invoiceId] = Number(a.amount || 0)
        }
        setEditAllocByInvoice(allocMap)
        setCheckedIds(new Set(Object.keys(allocMap)))
        const seed = {}
        Object.entries(allocMap).forEach(([id, amt]) => {
          seed[id] = formatAmountInput(amt)
        })
        setApplyById(seed)
        if (pay.customerId) {
          try {
            const c = await customersAPI.get(pay.customerId)
            if (!cancelled) {
              setCustomer({
                id: c.id,
                name: c.name,
                credit: Number(c.credit_balance || 0),
              })
            }
          } catch {
            if (!cancelled) {
              setCustomer({ id: pay.customerId, name: pay.customerName, credit: 0 })
            }
          }
        }
      } catch {
        if (!cancelled) {
          toast.error('Payment not found')
          navigate('/sales?tab=payments', { replace: true })
        }
      } finally {
        if (!cancelled) setEditLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, paymentId, navigate])

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
      .then(async (raw) => {
        if (cancelled) return
        let rows = (raw?.items || []).filter((inv) => {
          const st = String(inv.status || '').toLowerCase()
          return ACTIVE_STATUSES.has(st) || Boolean(editAllocByInvoice[inv.id])
        })
        // Include allocated invoices that are fully paid by this payment.
        const missingIds = Object.keys(editAllocByInvoice).filter((id) => !rows.some((r) => r.id === id))
        if (missingIds.length) {
          const extras = await Promise.all(
            missingIds.map((id) => salesAPI.get(id).catch(() => null)),
          )
          rows = [...rows, ...extras.filter(Boolean)]
        }
        setInvoices(rows)
        if (!isEdit) {
          const seed = {}
          rows.forEach((inv) => {
            const balance = (inv.total || 0) - (inv.paidAmount || 0)
            seed[inv.id] = formatAmountInput(Math.max(0, balance))
          })
          setApplyById(seed)
        } else {
          setApplyById((prev) => {
            const next = { ...prev }
            rows.forEach((inv) => {
              if (next[inv.id] != null) return
              const mine = editAllocByInvoice[inv.id] || 0
              const balance = Math.max(0, (inv.total || 0) - (inv.paidAmount || 0) + mine)
              next[inv.id] = formatAmountInput(balance)
            })
            return next
          })
        }
      })
      .catch(() => { if (!cancelled) setInvoices([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [customer, editAllocByInvoice, isEdit])

  const balanceFor = (inv) => {
    const mine = editAllocByInvoice[inv.id] || 0
    return Math.max(0, (inv.total || 0) - (inv.paidAmount || 0) + mine)
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
      const balance = balanceFor(inv)
      allocated += amt
      credit += Math.max(0, amt - balance)
    }
    return {
      allocated: Math.round(allocated * 100) / 100,
      credit: Math.round(credit * 100) / 100,
      count,
    }
  }, [invoices, checkedIds, applyById, editAllocByInvoice])

  const avail = Number(customer?.credit || 0)
  const creditApplied = storeCreditApplyAmount(avail, totals.allocated, true)
  const remainingTender = remainingAfterStoreCredit(totals.allocated, creditApplied)

  const paymentModeOptions = useMemo(() => PAYMENT_MODE_LABEL_OPTIONS, [])

  const seedApplyToBalances = () => {
    const seed = {}
    invoices.forEach((inv) => {
      seed[inv.id] = formatAmountInput(balanceFor(inv))
    })
    setApplyById(seed)
  }

  const handleSubmit = async () => {
    if (submitting) return
    if (!customer?.id) { toast.error('Pick a customer first'); return }
    if (totals.count === 0) { toast.error('Select at least one invoice'); return }
    if (remainingTender > 0.001 && !paymentMode) { toast.error('Pick a payment method for the remaining amount'); return }
    if (paymentMode === 'cash' && remainingTender > 0.001) {
      const err = cashTenderError(cashCollected, remainingTender)
      if (err) { toast.error(err); return }
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
      // When store credit is applied, send credit-mode payment for that
      // portion first (FIFO via payment_mode=credit legacy), then tender.
      // Backend multi-pay still uses payment_mode; for split we create
      // credit payment when covering fully with credit, else tender with
      // store_credit_amount once backend multi-pay supports it.
      // Interim: if credit covers all → payment_mode credit; else tender
      // only for remaining by reducing allocation amounts after credit FIFO.
      let payload
      if (creditApplied > 0 && remainingTender <= 0.001) {
        payload = {
          customer_id: customer.id,
          payment_mode: 'credit',
          payment_ref: paymentRef.trim() || null,
          notes: notes.trim() || null,
          allocations,
        }
      } else if (creditApplied > 0) {
        // Split allocations: credit portion FIFO, then tender for rest.
        let creditLeft = creditApplied
        const creditAllocs = []
        const tenderAllocs = []
        for (const a of allocations) {
          const take = Math.min(creditLeft, a.amount)
          if (take > 0.001) creditAllocs.push({ invoice_id: a.invoice_id, amount: round2(take) })
          const rest = round2(a.amount - take)
          if (rest > 0.001) tenderAllocs.push({ invoice_id: a.invoice_id, amount: rest })
          creditLeft = round2(creditLeft - take)
        }
        if (creditAllocs.length) {
          await salesAPI.payments.create({
            customer_id: customer.id,
            payment_mode: 'credit',
            notes: notes.trim() || 'Store credit applied',
            allocations: creditAllocs,
          })
        }
        payload = {
          customer_id: customer.id,
          payment_mode: paymentMode,
          payment_ref: paymentRef.trim() || null,
          notes: notes.trim() || null,
          allocations: tenderAllocs,
        }
        if (!tenderAllocs.length) {
          toast.success('Store credit applied')
          goBack()
          return
        }
      } else {
        payload = {
          customer_id: customer.id,
          payment_mode: paymentMode,
          payment_ref: paymentRef.trim() || null,
          notes: notes.trim() || null,
          allocations,
        }
      }
      const res = isEdit
        ? await salesAPI.payments.update(paymentId, payload)
        : await salesAPI.payments.create(payload)
      const credit = Number(res?.credit_applied || 0)
      if (credit > 0) {
        toast.success(
          `Payment ${res.number} ${isEdit ? 'updated' : 'recorded'}. ${fmt(credit)} added to store credit for ${customer.name}`,
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

  const round2 = (n) => Math.round(Number(n) * 100) / 100

  const saveDisabled = !customer || totals.count === 0 || (remainingTender > 0.001 && !paymentMode) || editLoading

  if (editLoading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    )
  }

  return (
    <>
    <DocumentFormShell
      title={isEdit ? `Edit Payment — ${editingNumber || ''}` : 'Create Customer Payment'}
      subtitle="Payments"
      icon="💰"
      onBack={goBack}
      onSave={handleSubmit}
      saveLabel={isEdit ? 'Save Changes' : 'Record Payment'}
      saving={submitting}
      saveDisabled={saveDisabled}
    >
      <div style={{ display: 'grid', gap: 18 }}>
        <FormGroup label="Customer" required>
          {isEdit ? (
            <div style={{ fontWeight: 500, fontSize: 14 }}>{customer?.name || '—'}</div>
          ) : (
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
              emptyLabel="No customers found"
              footerAction={addCustomerAction}
              style={{ width: '100%', maxWidth: 420 }}
            />
          )}
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
              const totalBalance = invoices.reduce((acc, inv) => acc + balanceFor(inv), 0)
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
                    const balance = balanceFor(inv)
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
                            min="0"
                            step={amountInputStep()}
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
                  {creditApplied > 0 && (
                    <div style={totalsRowStyle}>
                      <span style={{ ...totalsLabelStyle, color: 'var(--accent)' }}>Account credit</span>
                      <span className="mono" style={{ ...totalsValueStyle, color: 'var(--accent)' }}>-{fmt(creditApplied)}</span>
                    </div>
                  )}
                  {totals.credit > 0 && (
                    <div style={totalsRowStyle}>
                      <span style={{ ...totalsLabelStyle, color: 'var(--amber)' }}>To account credit</span>
                      <span className="mono" style={{ ...totalsValueStyle, color: 'var(--amber)' }}>{fmt(totals.credit)}</span>
                    </div>
                  )}
                  <div style={{ ...totalsRowStyle, borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 4 }}>
                    <span style={{ ...totalsLabelStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {creditApplied > 0 ? 'Remaining to collect' : 'Allocated'}
                    </span>
                    <span className="mono" style={{ ...totalsValueStyle, fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>
                      {fmt(creditApplied > 0 ? remainingTender : totals.allocated)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {avail > 0 && (
              <AlertBar type="green" icon="✓">
                Account credit <strong>{fmt(avail)}</strong> will be applied automatically
                {remainingTender > 0.001
                  ? <> — collect <strong>{fmt(remainingTender)}</strong> remaining</>
                  : <> — fully covers this payment</>}
              </AlertBar>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <FormGroup label="Method" required={remainingTender > 0.001}>
                <AutocompleteDropdown
                  value={paymentMode}
                  onChange={(v) => {
                    setPaymentMode(v)
                    if (v !== 'cash') setCashCollected('')
                  }}
                  options={paymentModeOptions}
                  isSearchFieldRequired={false}
                  disabled={remainingTender <= 0.001}
                />
              </FormGroup>
              <FormGroup label="Reference">
                <input
                  className="form-input"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  placeholder="UTR / transaction id"
                  disabled={remainingTender <= 0.001}
                />
              </FormGroup>
            </div>
            {paymentMode === 'cash' && remainingTender > 0.001 && (
              <CashTenderFields
                due={remainingTender}
                value={cashCollected}
                onChange={setCashCollected}
              />
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
    {addCustomerModal}
    </>
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

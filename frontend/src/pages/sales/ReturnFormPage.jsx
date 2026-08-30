/**
 * Sales > Returns > "+ New Return" full page (Credit Note).
 *
 * Mirrors VendorReturnFormPage UX: pick the customer first, then choose an
 * invoice from their records and load returnable lines.
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FormGroup, AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import DocumentFormShell from '@/components/DocumentFormShell'
import { salesAPI, AUTOCOMPLETE_CUSTOMER_URL, customersAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, fmtQty } from '@/utils/helpers'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { lineTaxAmount } from '@/utils/taxCalc'

export default function ReturnFormPage() {
  const navigate = useNavigate()
  const { returnId } = useParams()
  const isEdit = Boolean(returnId)
  const [searchParams] = useSearchParams()
  const prefillInvoiceId = searchParams.get('invoiceId')
  const refundMode = searchParams.get('mode')
  const can = useCan()
  const [customer, setCustomer] = useState(null)
  const [customerInvoices, setCustomerInvoices] = useState([])
  const [invoicesLoading, setInvoicesLoading] = useState(false)
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(prefillInvoiceId || '')
  const [invoice, setInvoice] = useState(null)
  const [alreadyReturned, setAlreadyReturned] = useState({})
  const [returnQtys, setReturnQtys] = useState({})
  const [batchAllocByLine, setBatchAllocByLine] = useState({})
  const [refundMethod, setRefundMethod] = useState(refundMode === 'credit' ? 'credit' : 'cash')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [invoiceLoading, setInvoiceLoading] = useState(Boolean(prefillInvoiceId) || isEdit)
  const [editLoading, setEditLoading] = useState(isEdit)
  const [editingNumber, setEditingNumber] = useState(null)
  const [editSeedQtys, setEditSeedQtys] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [prefilled, setPrefilled] = useState(Boolean(prefillInvoiceId) || isEdit)
  const [customerOutstanding, setCustomerOutstanding] = useState(0)

  useEffect(() => {
    if (!can('invoices.create')) {
      navigate('/sales?tab=returns', { replace: true })
    }
  }, [can, navigate])

  const goBack = () => navigate('/sales?tab=returns')

  useEffect(() => {
    if (!isEdit || !returnId) return
    let cancelled = false
    ;(async () => {
      setEditLoading(true)
      try {
        const ret = await salesAPI.returns.get(returnId)
        if (cancelled) return
        if (String(ret.status || '').toLowerCase() === 'void') {
          toast.error('Cannot edit a voided credit note')
          navigate('/sales?tab=returns', { replace: true })
          return
        }
        setEditingNumber(ret.number)
        setReason(ret.reason || '')
        setNotes(ret.notes || '')
        setRefundMethod(ret.refundMethod === 'credit' ? 'adjustment' : (ret.refundMethod || 'cash'))
        setSelectedInvoiceId(ret.invoiceId)
        if (ret.customerId) {
          setCustomer({ id: ret.customerId, name: ret.customerName || 'Customer' })
        } else {
          setCustomer({ id: '', name: 'Walk-in' })
        }
        // Seed qtys from return lines after invoice loads — stash on window-free state
        const qtys = {}
        for (const li of ret.items || []) {
          if (li.invoiceLineId) qtys[li.invoiceLineId] = Number(li.returnQty || 0)
        }
        setEditSeedQtys(qtys)
        setReturnQtys(qtys)
      } catch {
        if (!cancelled) {
          toast.error('Credit note not found')
          navigate('/sales?tab=returns', { replace: true })
        }
      } finally {
        if (!cancelled) setEditLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, returnId, navigate])

  const resetInvoiceState = () => {
    setSelectedInvoiceId('')
    setInvoice(null)
    setAlreadyReturned({})
    setReturnQtys({})
    setBatchAllocByLine({})
    setRefundMethod('cash')
    setReason('')
    setNotes('')
  }

  const resetCustomerState = () => {
    setCustomerInvoices([])
    resetInvoiceState()
  }

  useEffect(() => {
    if (!customer?.id) return
    let cancelled = false
    setInvoicesLoading(true)
    salesAPI.list({
      customer_id: customer.id,
      limit: 200,
      sort_by: 'date',
      sort_order: 'desc',
    })
      .then((raw) => {
        if (cancelled) return
        const rows = (raw?.items || []).filter((inv) => {
          const st = String(inv.status || '').toLowerCase()
          return st !== 'cancelled' && st !== 'void'
        })
        setCustomerInvoices(rows)
      })
      .catch(() => { if (!cancelled) setCustomerInvoices([]) })
      .finally(() => { if (!cancelled) setInvoicesLoading(false) })
    return () => { cancelled = true }
  }, [customer])

  const sourceBatches = (line) => {
    const a = line.batchAllocation
    if (!Array.isArray(a)) return []
    return [...a].sort((x, y) =>
      String(x.expiry_date || '9999-12-31').localeCompare(String(y.expiry_date || '9999-12-31')))
  }

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
  const invoiceBalance = Math.max(
    0,
    Number(invoice?.total || 0)
      - Number(invoice?.paidAmount || 0)
      - Number(invoice?.creditedAmount || 0),
  )
  // Net outstanding can be negative (account credit). Positive AR for messaging:
  const arOutstanding = Math.max(0, customerOutstanding)

  useEffect(() => {
    if (isWalkin && refundMethod !== 'cash') setRefundMethod('cash')
  }, [isWalkin, refundMethod])

  useEffect(() => {
    if (!customer?.id) {
      setCustomerOutstanding(0)
      return
    }
    let cancelled = false
    customersAPI.get(customer.id)
      .then((c) => {
        if (!cancelled) setCustomerOutstanding(Number(c?.outstanding || 0))
      })
      .catch(() => { if (!cancelled) setCustomerOutstanding(0) })
    return () => { cancelled = true }
  }, [customer?.id])

  const loadInvoice = async (invoiceId) => {
    if (!invoiceId) return
    setInvoiceLoading(true)
    try {
      const full = await salesAPI.get(invoiceId)
      setInvoice(full)
      if (full.customerId) {
        setCustomer((cur) => (cur?.id ? cur : { id: full.customerId, name: full.customerName || 'Customer' }))
      } else {
        setCustomer((cur) => cur || { id: '', name: 'Walk-in' })
      }

      const allReturns = (await salesAPI.returns.list({ limit: 500 }))?.items || []
      const tally = {}
      for (const r of allReturns) {
        if (r.invoiceId !== full.id) continue
        if (r.status === 'void') continue
        if (isEdit && r.id === returnId) continue
        for (const li of r.items || []) {
          if (!li.invoiceLineId) continue
          tally[li.invoiceLineId] = (tally[li.invoiceLineId] || 0) + Number(li.returnQty || 0)
        }
      }
      setAlreadyReturned(tally)

      const fillRemaining = !isEdit && invoiceId === prefillInvoiceId
      const initialQtys = {}
      const initialAlloc = {}
      for (const il of full.items || []) {
        const remaining = Math.max(0, Number(il.qty || 0) - (tally[il.id] || 0))
        const seeded = editSeedQtys?.[il.id]
        const q = isEdit
          ? Math.min(Number(seeded || 0), remaining)
          : (fillRemaining ? remaining : 0)
        initialQtys[il.id] = q
        if (q > 0 && sourceBatches(il).length > 0) {
          initialAlloc[il.id] = fefoDistribute(il, q)
        }
      }
      setReturnQtys(initialQtys)
      setBatchAllocByLine(initialAlloc)
    } catch (err) {
      console.error('Failed to load invoice:', err)
      setInvoice(null)
    } finally {
      setInvoiceLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedInvoiceId) {
      setInvoice(null)
      setAlreadyReturned({})
      setReturnQtys({})
      setBatchAllocByLine({})
      return
    }
    loadInvoice(selectedInvoiceId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInvoiceId])

  useEffect(() => {
    if (!prefillInvoiceId) return
    setSelectedInvoiceId(prefillInvoiceId)
    setPrefilled(true)
    if (refundMode === 'credit') setRefundMethod('credit')
    else if (refundMode === 'refund') setRefundMethod('cash')
  }, [prefillInvoiceId, refundMode])

  const remainingFor = (line) => {
    const prior = alreadyReturned[line.id] || 0
    return Math.max(0, Number(line.qty || 0) - prior)
  }

  const setQtyFor = (line, raw) => {
    const remaining = remainingFor(line)
    const v = Math.max(0, Math.min(remaining, Math.floor(Number(raw) || 0)))
    setReturnQtys((cur) => ({ ...cur, [line.id]: v }))
    if (sourceBatches(line).length > 0) {
      setBatchAllocByLine((cur) => ({ ...cur, [line.id]: fefoDistribute(line, v) }))
    }
  }

  const setBatchQtyFor = (line, batch, raw) => {
    const cap = Math.max(0, Number(batch.consumed || 0))
    const v = Math.max(0, Math.min(cap, Math.floor(Number(raw) || 0)))
    setBatchAllocByLine((cur) => ({
      ...cur,
      [line.id]: { ...(cur[line.id] || {}), [batch.batch_id]: v },
    }))
  }

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
      // Sale prices are tax-inclusive — extract tax, do not add it on top.
      const lineGross = Math.round(q * Number(il.price || 0) * 100) / 100
      const t = lineTaxAmount(lineGross, il.taxRate || 0)
      subtotal += Math.round((lineGross - t) * 100) / 100
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
      const payload = {
        invoice_id: invoice.id,
        reason: reason.trim() || null,
        refund_method: refundMethod,
        items,
        notes: notes.trim() || null,
      }
      const res = isEdit
        ? await salesAPI.returns.update(returnId, payload)
        : await salesAPI.returns.create(payload)
      const credited = Number(res?.credited_amount || 0)
      if (res?.refund_method === 'adjustment') {
        toast.success(
          isEdit
            ? `Credit note ${res.number} updated — applied to outstanding`
            : `Return ${res.number} processed — applied to outstanding`
            + (credited > 0 ? ` (${fmt(credited)} account credit)` : ''),
          { duration: 5000 },
        )
      } else if (res?.refund_method === 'cash' && credited > 0) {
        toast.success(
          isEdit
            ? `Credit note ${res.number} updated. Refund ${fmt(credited)} cash`
            : `Return ${res.number} processed. Refund ${fmt(credited)} cash from drawer`,
        )
      } else {
        toast.success(isEdit ? `Credit note ${res?.number || ''} updated` : `Return ${res?.number || ''} processed`)
      }
      goBack()
    } catch (err) {
      console.error(isEdit ? 'Failed to update return:' : 'Failed to create return:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const invoiceOptions = customerInvoices.map((inv) => ({
    id: inv.id,
    label: `${inv.number} · ${inv.date} · ${fmt(inv.total)}`,
  }))

  const saveDisabled = !invoice || !totals.anyReturned || editLoading

  if (editLoading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    )
  }

  return (
    <DocumentFormShell
      title={isEdit ? `Edit Credit Note — ${editingNumber || ''}` : 'Create Credit Note'}
      subtitle="Returns"
      icon="↩"
      onBack={goBack}
      onSave={handleSubmit}
      saveLabel={isEdit ? 'Save Changes' : 'Process Return'}
      saving={submitting}
      saveDisabled={saveDisabled}
    >
      <div style={{ display: 'grid', gap: 18 }}>
        <FormGroup label="Customer" required>
          <AutocompleteDropdown
              value={customer?.id || ''}
              clearable={!prefilled}
              onClear={() => {
                if (prefilled) return
                setCustomer(null)
                resetCustomerState()
              }}
              onSelectOption={async (opt) => {
                if (prefilled) return
                if (!opt) {
                  setCustomer(null)
                  resetCustomerState()
                  return
                }
                try {
                  const c = await customersAPI.get(opt.id)
                  setCustomer({ id: c.id, name: c.name })
                } catch {
                  setCustomer({ id: opt.id, name: opt.label })
                }
                resetInvoiceState()
              }}
              fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
              isSearchFieldRequired
              selectedLabel={customer?.name}
              placeholder="Search customers…"
              searchPlaceholder="Search customers…"
              emptyLabel="No customers found. Add via the Customers page."
              style={{ width: '100%', maxWidth: 420 }}
              disabled={prefilled}
            />
        </FormGroup>

        {!customer && !prefillInvoiceId ? (
          <EmptyState
            icon="👤"
            title="Choose a customer to begin"
            desc="Pick a customer above to load their invoices and start a credit note."
          />
        ) : invoicesLoading && !prefilled ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading invoices…
          </div>
        ) : !prefilled && customerInvoices.length === 0 ? (
          <EmptyState
            icon="🧾"
            title="No invoices found"
            desc={`${customer?.name || 'This customer'} has no invoices available for return.`}
          />
        ) : (
          <>
            <FormGroup label="Invoice" required>
              <AutocompleteDropdown
                value={selectedInvoiceId}
                onChange={setSelectedInvoiceId}
                options={invoiceOptions}
                isSearchFieldRequired
                placeholder="Select an invoice…"
                searchPlaceholder="Search invoice #…"
                emptyLabel="No matching invoices"
                style={{ width: '100%', maxWidth: 420 }}
                disabled={invoiceLoading || prefilled}
              />
            </FormGroup>

            {!selectedInvoiceId ? (
              <EmptyState
                icon="🧾"
                title="Select an invoice"
                desc="Choose an invoice above to load returnable line items."
              />
            ) : invoiceLoading ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Loading invoice details…
              </div>
            ) : invoice ? (
              <>
                <AlertBar type="blue" icon="ℹ">
                  <strong>{invoice.number}</strong> · {invoice.customerName || 'Walk-in'} ·
                  Total: <strong>{fmt(invoice.total)}</strong> · Paid: <strong>{fmt(invoice.paidAmount)}</strong>
                </AlertBar>

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
                        const lineWithTax = Math.round(q * Number(il.price || 0) * 100) / 100
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
                              <td className="text-right mono" style={{ fontSize: 12 }}>{fmtQty(il.qty)}</td>
                              <td className="text-right mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                {fmtQty(remaining)}
                              </td>
                              <td className="text-right">
                                <input
                                  className="form-input"
                                  type="number"
                                  min={0}
                                  max={remaining}
                                  step={qtyInputStep()}
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
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: 13, fontWeight: 600,
                  }}>
                    <span>Return total:</span>
                    <span className="mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <FormGroup label="Refund Method" required>
                    <AutocompleteDropdown
                      value={refundMethod}
                      onChange={setRefundMethod}
                      options={[
                        { id: 'cash', label: '💵 Cash (refund from drawer)' },
                        ...(!isWalkin
                          ? [{
                              id: 'adjustment',
                              label: arOutstanding > 0.001
                                ? `📋 Apply to outstanding (${fmt(arOutstanding)})`
                                : '📋 Apply to outstanding (creates account credit)',
                            }]
                          : []),
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

                {refundMethod === 'cash' && !isWalkin && totals.total > Number(invoice.paidAmount || 0) && (
                  <AlertBar type="amber" icon="ℹ">
                    Return total exceeds paid amount. Only <strong>{fmt(invoice.paidAmount)}</strong> will be refunded
                    in cash; the remaining <strong>{fmt(totals.total - Number(invoice.paidAmount))}</strong> reduces
                    the invoice&apos;s outstanding balance.
                  </AlertBar>
                )}
                {refundMethod === 'adjustment' && !isWalkin && (
                  <AlertBar type="amber" icon="ℹ">
                    Return value reduces what this customer owes (this invoice, then other open bills).
                    {arOutstanding <= 0.001 || totals.total > arOutstanding + 0.001
                      ? <> Any leftover becomes account credit (negative outstanding) and auto-applies on their next sale.</>
                      : null}
                    {' '}No cash is paid out.
                  </AlertBar>
                )}
              </>
            ) : null}
          </>
        )}
      </div>
    </DocumentFormShell>
  )
}

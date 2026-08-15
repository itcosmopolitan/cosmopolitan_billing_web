/**
 * Purchases > Returns > "+ New Return" full page.
 *
 * Mirrors VendorPaymentFormPage UX: pick the vendor first, then choose a
 * bill from that vendor's records and load returnable lines. Overpayment
 * credit logic is server-side; frontend caps return qty per line.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FormGroup, AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import DocumentFormShell from '@/components/DocumentFormShell'
import { purchasesAPI, AUTOCOMPLETE_VENDOR_URL, vendorsAPI, itemsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, fmtQty } from '@/utils/helpers'
import { qtyInputStep } from '@/utils/decimalPrecision'

const REASONS = ['Defective', 'Overstocked', 'Wrong Item', 'Quality Issue', 'Damaged', 'Other']

export default function VendorReturnFormPage() {
  const navigate = useNavigate()
  const can = useCan()
  const [vendor, setVendor] = useState(null)
  const [vendorBills, setVendorBills] = useState([])
  const [billsLoading, setBillsLoading] = useState(false)
  const [selectedBillId, setSelectedBillId] = useState('')
  const [bill, setBill] = useState(null)
  const [alreadyReturned, setAlreadyReturned] = useState({})
  const [returnQtys, setReturnQtys] = useState({})
  const [billLotRemaining, setBillLotRemaining] = useState({})
  const [reason, setReason] = useState('Defective')
  const [notes, setNotes] = useState('')
  const [billLoading, setBillLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!can('purchases.create')) {
      navigate('/purchases?tab=returns', { replace: true })
    }
  }, [can, navigate])

  const goBack = () => navigate('/purchases?tab=returns')

  const resetBillState = () => {
    setSelectedBillId('')
    setBill(null)
    setAlreadyReturned({})
    setReturnQtys({})
    setBillLotRemaining({})
    setReason('Defective')
    setNotes('')
  }

  const resetVendorState = () => {
    setVendorBills([])
    resetBillState()
  }

  useEffect(() => {
    if (!vendor?.id) return
    let cancelled = false
    setBillsLoading(true)
    purchasesAPI.list({
      vendor_id: vendor.id,
      limit: 200,
      sort_by: 'date',
      sort_order: 'desc',
    })
      .then((raw) => {
        if (cancelled) return
        const rows = (raw?.items || []).filter((b) => {
          const st = String(b.status || '').toLowerCase()
          return st !== 'cancelled'
        })
        setVendorBills(rows)
      })
      .catch(() => { if (!cancelled) setVendorBills([]) })
      .finally(() => { if (!cancelled) setBillsLoading(false) })
    return () => { cancelled = true }
  }, [vendor])

  const loadBill = async (billId) => {
    if (!billId) return
    setBillLoading(true)
    try {
      const full = await purchasesAPI.get(billId)
      setBill(full)
      const initial = {}
      for (const li of full.items || []) initial[li.id] = 0
      setReturnQtys(initial)

      const allReturns = (await purchasesAPI.returns.list({ limit: 500 }))?.items || []
      const tally = {}
      for (const r of allReturns) {
        if (r.billId !== full.id) continue
        if (r.voided || r.status === 'void') continue
        for (const li of r.items || []) {
          if (!li.billLineId) continue
          tally[li.billLineId] = (tally[li.billLineId] || 0) + Number(li.returnQty || 0)
        }
      }
      setAlreadyReturned(tally)

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
      setBill(null)
    } finally {
      setBillLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedBillId) {
      setBill(null)
      setAlreadyReturned({})
      setReturnQtys({})
      setBillLotRemaining({})
      return
    }
    loadBill(selectedBillId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBillId])

  const remainingFor = (line) => {
    const prior = alreadyReturned[line.id] || 0
    const byCap = Math.max(0, Number(line.qty || 0) - prior)
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
    if (!bill) return { subtotal: 0, tax: 0, total: 0, anyReturned: false, lineCount: 0 }
    let subtotal = 0
    let tax = 0
    let anyReturned = false
    let lineCount = 0
    for (const li of bill.items || []) {
      const q = returnQtys[li.id] || 0
      if (q > 0) {
        anyReturned = true
        lineCount += 1
      }
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
      lineCount,
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
      goBack()
    } catch (err) {
      console.error('Failed to create return:', err)
    } finally {
      setSubmitting(false)
    }
  }

  const billOptions = vendorBills.map((b) => ({
    id: b.id,
    label: `${b.number} · ${b.date} · ${fmt(b.total)}`,
  }))

  const saveDisabled = !bill || !totals.anyReturned

  return (
    <DocumentFormShell
      title="Create Vendor Return"
      subtitle="Returns"
      icon="↩"
      onBack={goBack}
      onSave={handleSubmit}
      saveLabel="Process Return"
      saving={submitting}
      saveDisabled={saveDisabled}
    >
      <div style={{ display: 'grid', gap: 18 }}>
        <FormGroup label="Vendor" required>
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
                setVendor({ id: v.id, name: v.name })
              } catch {
                setVendor({ id: opt.id, name: opt.label })
              }
              resetBillState()
            }}
            fetchUrl={AUTOCOMPLETE_VENDOR_URL}
            isSearchFieldRequired
            selectedLabel={vendor?.name}
            placeholder="Search vendors…"
            searchPlaceholder="Search vendors…"
            emptyLabel="No vendors found. Add via the Vendors page."
            style={{ width: '100%', maxWidth: 420 }}
          />
        </FormGroup>

        {!vendor ? (
          <EmptyState
            icon="🏷️"
            title="Choose a vendor to begin"
            desc="Pick a vendor above to load their bills and start a return."
          />
        ) : billsLoading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading bills…
          </div>
        ) : vendorBills.length === 0 ? (
          <EmptyState
            icon="📋"
            title="No bills found"
            desc={`${vendor.name} has no bills available for return.`}
          />
        ) : (
          <>
            <FormGroup label="Bill" required>
              <AutocompleteDropdown
                value={selectedBillId}
                onChange={setSelectedBillId}
                options={billOptions}
                isSearchFieldRequired
                placeholder="Select a bill…"
                searchPlaceholder="Search bill #…"
                emptyLabel="No matching bills"
                style={{ width: '100%', maxWidth: 420 }}
                disabled={billLoading}
              />
            </FormGroup>

            {!selectedBillId ? (
              <EmptyState
                icon="📋"
                title="Select a bill"
                desc="Choose a bill above to load returnable line items."
              />
            ) : billLoading ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Loading bill details…
              </div>
            ) : bill ? (
              <>
                <AlertBar type="blue" icon="ℹ">
                  <strong>{bill.number}</strong> · {bill.vendorName} ·
                  Total: <strong>{fmt(bill.total)}</strong> · Paid: <strong>{fmt(bill.paidAmount)}</strong>
                </AlertBar>

                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
                  <FormGroup label="Reason" required>
                    <AutocompleteDropdown
                      value={reason}
                      onChange={setReason}
                      options={REASONS.map((r) => ({ id: r, label: r }))}
                      isSearchFieldRequired={false}
                    />
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
                        const disabled = remaining === 0
                        return (
                          <tr key={li.id} style={disabled ? { opacity: 0.5 } : null}>
                            <td>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{li.name}</div>
                              {disabled && (
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Fully returned</div>
                              )}
                            </td>
                            <td className="text-right mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtQty(cap)}</td>
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

                {totals.anyReturned && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
                  <textarea
                    className="form-input"
                    style={{ height: 60 }}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any additional notes…"
                  />
                </FormGroup>
              </>
            ) : null}
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

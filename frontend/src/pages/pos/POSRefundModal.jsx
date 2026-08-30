/**
 * POS refund flow — lookup a sale by receipt # (or open a specific bill)
 * and create a credit note (cash, store credit, or apply to outstanding).
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { salesAPI, customersAPI } from '@/api'
import { Modal, FormGroup, AlertBar, AutocompleteDropdown } from '@/components/ui'
import { fmt, fmtQty } from '@/utils/helpers'
import { qtyInputStep } from '@/utils/decimalPrecision'

export default function POSRefundModal({ open, onClose, branchId, initialInvoiceId, onSuccess }) {
  const [searchNum, setSearchNum] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [invoice, setInvoice] = useState(null)
  const [returnQty, setReturnQty] = useState({})
  const [refundMethod, setRefundMethod] = useState('cash')
  const [reason, setReason] = useState('Customer return')
  const [customerOutstanding, setCustomerOutstanding] = useState(0)

  const isWalkin = !invoice?.customerId
  const lockedToInvoice = Boolean(initialInvoiceId)
  const invoiceBalance = Math.max(
    0,
    Number(invoice?.total || 0)
      - Number(invoice?.paidAmount || 0)
      - Number(invoice?.creditedAmount || 0),
  )
  const arOutstanding = Math.max(0, customerOutstanding)

  const returnTotal = useMemo(() => {
    if (!invoice?.items) return 0
    return (invoice.items || []).reduce((sum, line) => {
      const q = Math.min(line.qty, Math.max(0, Number(returnQty[line.id] || 0)))
      if (q <= 0) return sum
      const unit = line.qty > 0 ? Number(line.lineTotal || 0) / line.qty : Number(line.price || 0)
      return sum + unit * q
    }, 0)
  }, [invoice, returnQty])

  const reset = () => {
    setSearchNum('')
    setInvoice(null)
    setReturnQty({})
    setRefundMethod('cash')
    setReason('Customer return')
    setCustomerOutstanding(0)
  }

  const applyInvoice = (detail) => {
    setInvoice(detail)
    const qtyMap = {}
    for (const line of detail.items || []) {
      qtyMap[line.id] = line.qty
    }
    setReturnQty(qtyMap)
    setRefundMethod('cash')
    setSearchNum(detail.number || '')
    setCustomerOutstanding(0)
    if (detail.customerId) {
      customersAPI.get(detail.customerId)
        .then((c) => setCustomerOutstanding(Number(c?.outstanding || 0)))
        .catch(() => setCustomerOutstanding(0))
    }
  }

  useEffect(() => {
    if (!open) return
    reset()
    if (!initialInvoiceId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const detail = await salesAPI.get(initialInvoiceId)
        if (cancelled) return
        if (detail.status === 'cancelled') {
          toast.error('Cannot refund a cancelled invoice')
          return
        }
        if (String(detail.returnStatus || 'none').toLowerCase() === 'full') {
          toast.error('This bill is already fully returned')
          return
        }
        applyInvoice(detail)
      } catch {
        if (!cancelled) toast.error('Could not load POS bill')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, initialInvoiceId])

  useEffect(() => {
    if (isWalkin && refundMethod !== 'cash') setRefundMethod('cash')
  }, [isWalkin, refundMethod])

  const handleClose = () => {
    if (submitting) return
    reset()
    onClose()
  }

  const lookup = async () => {
    const q = searchNum.trim()
    if (!q) return
    setLoading(true)
    setInvoice(null)
    try {
      const raw = await salesAPI.list({ search: q, branch_id: branchId, limit: 10 })
      const items = raw?.items || []
      const match = items.find(
        (i) => (i.number || '').toLowerCase() === q.toLowerCase(),
      ) || items[0]
      if (!match?.id) {
        toast.error('No invoice found for that number')
        return
      }
      const detail = await salesAPI.get(match.id)
      if (detail.status === 'cancelled') {
        toast.error('Cannot refund a cancelled invoice')
        return
      }
      applyInvoice(detail)
    } catch (err) {
      console.error('Invoice lookup failed:', err)
      toast.error('Could not load invoice')
    } finally {
      setLoading(false)
    }
  }

  const submit = async () => {
    if (!invoice?.id) return
    const items = (invoice.items || [])
      .map((line) => ({
        invoice_line_id: line.id,
        item_id: line.itemId,
        name: line.name,
        return_qty: Math.min(line.qty, Math.max(0, Number(returnQty[line.id] || 0))),
      }))
      .filter((r) => r.return_qty > 0)
    if (items.length === 0) {
      toast.error('Pick at least one line to return')
      return
    }
    setSubmitting(true)
    try {
      const res = await salesAPI.returns.create({
        invoice_id: invoice.id,
        reason: reason.trim() || 'POS refund',
        refund_method: isWalkin ? 'cash' : refundMethod,
        items,
      })
      const credited = Number(res?.credited_amount || 0)
      if (refundMethod === 'adjustment' && !isWalkin) {
        toast.success(
          `Return ${res.number} — applied to outstanding`
          + (credited > 0 ? ` (${fmt(credited)} account credit)` : ''),
        )
      } else {
        toast.success(
          credited > 0
            ? `Return ${res.number} — refund ${fmt(credited)} from drawer`
            : `Return ${res.number} processed`,
        )
      }
      onSuccess?.()
      handleClose()
    } catch (err) {
      console.error('POS refund failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="POS Return / Refund"
      icon="↩"
      size="lg"
      busy={submitting || loading}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || !invoice || returnTotal <= 0}
          >
            {submitting ? 'Processing…' : 'Process return'}
          </button>
        </>
      )}
    >
      <AlertBar type="blue" icon="ℹ">
        {lockedToInvoice
          ? 'Adjust return quantities, then choose cash, store credit, or apply to outstanding.'
          : 'Look up the receipt, select lines, then choose cash, store credit, or apply to outstanding.'}
      </AlertBar>
      <div style={{ height: 14 }} />

      {!lockedToInvoice && (
        <FormGroup label="Receipt / invoice #">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input"
              value={searchNum}
              onChange={(e) => setSearchNum(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup() } }}
              placeholder="INV-…"
              autoFocus
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-secondary" onClick={lookup} disabled={loading || !searchNum.trim()}>
              {loading ? '…' : 'Lookup'}
            </button>
          </div>
        </FormGroup>
      )}

      {loading && lockedToInvoice && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Loading bill…
        </div>
      )}

      {invoice && (
        <>
          <div style={{ marginBottom: 12, fontSize: 13 }}>
            <strong>{invoice.number}</strong>
            {' · '}
            {invoice.customerName || 'Walk-in'}
            {' · '}
            {fmt(invoice.total)}
            {invoice.returnStatus && invoice.returnStatus !== 'none' && (
              <span style={{ color: 'var(--amber)', marginLeft: 6 }}>
                ({invoice.returnStatus} return)
              </span>
            )}
          </div>

          <FormGroup label="Refund method" required>
            <AutocompleteDropdown
              value={refundMethod}
              onChange={setRefundMethod}
              options={[
                { id: 'cash', label: '💵 Cash (refund from drawer)' },
                ...(!isWalkin
                  ? [{
                      id: 'adjustment',
                      label: arOutstanding > 0.001
                        ? `Apply to outstanding (${fmt(arOutstanding)})`
                        : 'Apply to outstanding (creates account credit)',
                    }]
                  : []),
              ]}
              isSearchFieldRequired={false}
            />
          </FormGroup>

          <FormGroup label="Reason">
            <input
              className="form-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Customer return"
            />
          </FormGroup>

          <div style={{ marginTop: 8, marginBottom: 6, fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Return quantities
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-muted)', fontSize: 11, textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px' }}>Item</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Sold</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', width: 110 }}>Return</th>
                </tr>
              </thead>
              <tbody>
                {(invoice.items || []).map((line) => (
                  <tr key={line.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px', fontSize: 13 }}>{line.name}</td>
                    <td className="text-right mono" style={{ padding: '8px 10px', fontSize: 12 }}>{fmtQty(line.qty)}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <input
                        className="form-input"
                        type="number"
                        min={0}
                        max={line.qty}
                        step={qtyInputStep()}
                        value={returnQty[line.id] ?? 0}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(line.qty, Math.floor(Number(e.target.value) || 0)))
                          setReturnQty((cur) => ({ ...cur, [line.id]: v }))
                        }}
                        style={{ textAlign: 'right', width: '100%' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {returnTotal > 0 && (
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <span style={{ color: 'var(--text-muted)' }}>Return total</span>
              <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{fmt(returnTotal)}</span>
            </div>
          )}
          {refundMethod === 'adjustment' && !isWalkin && (
            <AlertBar type="amber" icon="ℹ" style={{ marginTop: 10 }}>
              Reduces what they owe. Leftover becomes account credit (negative outstanding)
              and auto-applies on their next sale. No cash paid out.
            </AlertBar>
          )}
        </>
      )}
    </Modal>
  )
}

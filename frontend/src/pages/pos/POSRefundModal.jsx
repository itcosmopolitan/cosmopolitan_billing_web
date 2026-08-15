/**
 * POS refund flow — lookup a sale by receipt # and create a credit note
 * (cash from drawer or store credit on the customer account).
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { salesAPI } from '@/api'
import { Modal, FormGroup, AlertBar, AutocompleteDropdown } from '@/components/ui'
import { fmt, fmtQty } from '@/utils/helpers'
import { qtyInputStep } from '@/utils/decimalPrecision'

export default function POSRefundModal({ open, onClose, branchId, onSuccess }) {
  const [searchNum, setSearchNum] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [invoice, setInvoice] = useState(null)
  const [returnQty, setReturnQty] = useState({})
  const [refundMethod, setRefundMethod] = useState('cash')
  const [reason, setReason] = useState('Customer return')

  const isWalkin = !invoice?.customerId

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
  }

  useEffect(() => {
    if (open) reset()
  }, [open])

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
      setInvoice(detail)
      const qtyMap = {}
      for (const line of detail.items || []) {
        qtyMap[line.id] = line.qty
      }
      setReturnQty(qtyMap)
      setRefundMethod(detail.customerId ? 'cash' : 'cash')
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
      const credited = res?.credited_amount ?? res?.creditedAmount ?? 0
      if (refundMethod === 'credit' && !isWalkin) {
        toast.success(
          credited > 0
            ? `Return ${res.number} — ${fmt(credited)} added to store credit`
            : `Return ${res.number} processed`,
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
      console.error('Refund failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Refund Sale"
      icon="↩️"
      size="md"
      footer={
        <>
          <button className="btn btn-secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={submitting || !invoice}
          >
            {submitting ? 'Processing…' : 'Issue Refund'}
          </button>
        </>
      }
    >
      <AlertBar type="blue" icon="ℹ">
        Look up the receipt number, select lines to return, and pick cash (drawer)
        or store credit (registered customers only).
      </AlertBar>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <input
          className="form-input"
          placeholder="Receipt # (POS-2026-1001 or INV-…)"
          value={searchNum}
          onChange={(e) => setSearchNum(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') lookup() }}
        />
        <button className="btn btn-secondary" onClick={lookup} disabled={loading}>
          {loading ? '…' : 'Find'}
        </button>
      </div>

      {invoice && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, marginBottom: 10 }}>
            <strong>{invoice.number}</strong>
            {' · '}{invoice.customerName || 'Walk-in'}
            {' · '}{fmt(invoice.total)}
            {invoice.returnStatus && invoice.returnStatus !== 'none' && (
              <span style={{ marginLeft: 8, color: 'var(--amber)' }}>
                ({invoice.returnStatus} return)
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 14 }}>
            <FormGroup label="Refund Method" required>
              <AutocompleteDropdown
                value={refundMethod}
                onChange={setRefundMethod}
                options={[
                  { id: 'cash', label: '💵 Cash (refund from drawer)' },
                  {
                    id: 'credit',
                    label: `🏦 Store Credit${isWalkin ? ' (walk-in — pick Cash)' : ''}`,
                    disabled: isWalkin,
                  },
                ]}
                isSearchFieldRequired={false}
                placeholder="Refund method…"
                style={{ width: '100%' }}
              />
            </FormGroup>
            <FormGroup label="Reason">
              <input
                className="form-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FormGroup>
          </div>
          <table className="data-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ width: 70, textAlign: 'right' }}>Sold</th>
                <th style={{ width: 90, textAlign: 'right' }}>Return</th>
              </tr>
            </thead>
            <tbody>
              {(invoice.items || []).map((line) => (
                <tr key={line.id}>
                  <td style={{ fontSize: 13 }}>{line.name}</td>
                  <td className="text-right mono">{fmtQty(line.qty)}</td>
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      max={line.qty}
                      step={qtyInputStep()}
                      value={returnQty[line.id] ?? 0}
                      onChange={(e) => setReturnQty((prev) => ({
                        ...prev,
                        [line.id]: Math.min(line.qty, Math.max(0, Number(e.target.value) || 0)),
                      }))}
                      style={{ width: 72, textAlign: 'right', padding: '4px 6px' }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {returnTotal > 0 && (
            <div style={{
              marginTop: 12,
              padding: '8px 12px',
              background: 'var(--bg-raised)',
              borderRadius: 6,
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              fontWeight: 600,
            }}>
              <span>Return total:</span>
              <span className="mono" style={{ color: 'var(--accent)' }}>{fmt(returnTotal)}</span>
            </div>
          )}
          {refundMethod === 'credit' && !isWalkin && returnTotal > Number(invoice.paidAmount || 0) && (
            <AlertBar type="amber" icon="ℹ" style={{ marginTop: 10 }}>
              Return total exceeds paid amount. Only <strong>{fmt(invoice.paidAmount)}</strong> can be
              credited; the rest reduces outstanding balance.
            </AlertBar>
          )}
        </div>
      )}
    </Modal>
  )
}

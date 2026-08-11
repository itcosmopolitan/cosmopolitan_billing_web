import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { purchasesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { Chip, ReturnStatusChip } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'

function displayPaymentMode(raw) {
  if (!raw) return '—'
  return String(raw).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const META = {
  bill: { icon: '📋', label: 'Purchase bill', fetch: (id) => purchasesAPI.get(id) },
  order: { icon: '📦', label: 'Purchase order', fetch: (id) => purchasesAPI.orders.get(id) },
  grn: { icon: '📥', label: 'GRN', fetch: (id) => purchasesAPI.grns.get(id) },
  return: { icon: '↩️', label: 'Vendor return', fetch: (id) => purchasesAPI.returns.get(id) },
}

/**
 * Unified purchase document detail drawer (bill / PO / GRN / vendor return).
 */
export default function PurchaseTxnDetailPanel({
  open,
  kind = 'bill',
  document: doc,
  onClose,
  onRecordPayment,
  onVoidReturn,
  onBillFromGrn,
}) {
  const can = useCan()
  const navigate = useNavigate()
  const meta = META[kind] || META.bill
  const [detail, setDetail] = useState(doc)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    if (!open || !doc?.id) return
    setTab('overview')
    setDetail(doc)
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const full = await meta.fetch(doc.id)
        if (!cancelled) setDetail({ ...doc, ...full })
      } catch {
        /* list payload may already include lines */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, doc?.id, kind])

  const lineCount = detail?.items?.length || 0
  const balDue = kind === 'bill'
    ? Math.round(((detail?.total || 0) - (detail?.paidAmount || 0)) * 100) / 100
    : 0

  const summary = kind === 'bill' ? [
    { label: 'Total', value: fmt(detail?.total) },
    { label: 'Paid', value: fmt(detail?.paidAmount || 0), tone: 'var(--green)' },
    { label: 'Balance', value: balDue > 0.01 ? fmt(balDue) : '—', tone: balDue > 0.01 ? 'var(--red)' : undefined },
    { label: 'Status', value: <Chip status={detail?.status} /> },
  ] : kind === 'return' ? [
    { label: 'Credit total', value: fmt(detail?.total) },
    { label: 'Against bill', value: detail?.billNumber || '—' },
    { label: 'Reason', value: detail?.reason || '—' },
    { label: 'Status', value: <Chip status={detail?.status} /> },
  ] : kind === 'grn' ? [
    { label: 'Total', value: fmt(detail?.total) },
    { label: 'PO', value: detail?.poNumber || '—' },
    { label: 'Lines', value: lineCount },
    { label: 'Status', value: <Chip status={detail?.status} /> },
  ] : [
    { label: 'Total', value: fmt(detail?.total) },
    { label: 'Lines', value: lineCount },
    { label: 'Expected', value: detail?.expectedDate || '—' },
    { label: 'Status', value: <Chip status={detail?.status} /> },
  ]

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>

      {kind === 'bill' && (
        <>
          {detail?.status !== 'paid' && detail?.status !== 'cancelled' && (
            <button type="button" className="btn btn-primary" onClick={() => { onRecordPayment?.(detail); onClose?.() }}>
              Record payment
            </button>
          )}
          {can('purchases.edit') && !['cancelled', 'paid'].includes(detail?.status) && (
            <button type="button" className="btn btn-secondary" onClick={() => { onClose?.(); navigate(`/purchases/bills/${detail.id}/edit`) }}>
              Edit
            </button>
          )}
        </>
      )}

      {kind === 'order' && (
        <>
          {((detail?.status === 'draft' && can('purchases.create', 'purchases.edit'))
            || (['confirmed', 'partially_received', 'approved'].includes(detail?.status) && can('purchases.edit'))) && (
            <button type="button" className="btn btn-secondary" onClick={() => { onClose?.(); navigate(`/purchases/orders/${detail.id}/edit`) }}>
              Edit
            </button>
          )}
          {['confirmed', 'approved', 'partially_received'].includes(detail?.status) && can('purchases.create') && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => { onClose?.(); navigate(`/purchases/grns/new?fromPo=${detail.id}`) }}>
                Receive stock
              </button>
              <button type="button" className="btn btn-primary" onClick={() => { onClose?.(); navigate(`/purchases/bills/new?fromPo=${detail.id}`) }}>
                Convert to bill
              </button>
            </>
          )}
        </>
      )}

      {kind === 'grn' && detail?.status === 'received' && !detail?.convertedBillId && can('purchases.create') && (
        <button type="button" className="btn btn-primary" onClick={() => { onBillFromGrn?.(detail); onClose?.() }}>
          Create bill
        </button>
      )}

      {kind === 'return' && can('purchases.edit') && detail?.status !== 'void' && !detail?.voided && (
        <button type="button" className="btn btn-danger" onClick={() => onVoidReturn?.(detail)}>
          Void return
        </button>
      )}
    </>
  )

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon={meta.icon}
      title={detail?.number || meta.label}
      subtitle={[detail?.vendorName, detail?.date].filter(Boolean).join(' · ')}
      size="xl"
      summary={summary}
      tabs={[
        { id: 'overview', label: `${meta.label} details` },
        { id: 'lines', label: `Line items (${lineCount})` },
        { id: 'totals', label: 'Totals' },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      footer={footer}
    >
      {loading && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Loading details…</div>}

      {tab === 'overview' && (
        <>
          <DetailSection title={`${meta.label} info`}>
            <DetailFields fields={[
              { label: 'Vendor', value: detail?.vendorName || '—' },
              { label: 'Branch', value: detail?.branchName || detail?.branchId || '—' },
              { label: 'Date', value: detail?.date || '—' },
              ...(kind === 'bill' ? [
                { label: 'Due date', value: detail?.dueDate || '—' },
                { label: 'Payment mode', value: displayPaymentMode(detail?.paymentMode) },
                { label: 'Return status', value: <ReturnStatusChip status={detail?.returnStatus} /> },
                { label: 'Credited (returns)', value: (detail?.creditedAmount || 0) > 0 ? fmt(detail.creditedAmount) : '—' },
              ] : []),
              ...(kind === 'order' ? [
                { label: 'Expected date', value: detail?.expectedDate || '—' },
                { label: 'Created by', value: detail?.createdBy || '—' },
                { label: 'Converted bill', value: detail?.convertedBillId || '—' },
              ] : []),
              ...(kind === 'grn' ? [
                { label: 'PO #', value: detail?.poNumber || '—' },
                { label: 'Converted bill', value: detail?.convertedBillId || '—' },
              ] : []),
              ...(kind === 'return' ? [
                { label: 'Against bill', value: detail?.billNumber || '—' },
                { label: 'Reason', value: detail?.reason || '—' },
              ] : []),
              { label: 'Status', value: <Chip status={detail?.status} /> },
            ]}
            />
          </DetailSection>
          {detail?.notes ? (
            <DetailSection title="Notes">
              <div style={{ fontSize: 13 }}>{detail.notes}</div>
            </DetailSection>
          ) : null}
        </>
      )}

      {tab === 'lines' && (
        <DetailSection title="Items">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                {kind === 'return' ? (
                  <>
                    <th className="text-right">Return qty</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Total</th>
                  </>
                ) : kind === 'grn' ? (
                  <>
                    <th className="text-right">Ordered</th>
                    <th className="text-right">Received</th>
                    <th className="text-right">Cost</th>
                    <th>Batch</th>
                    <th className="text-right">Total</th>
                  </>
                ) : (
                  <>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Discount %</th>
                    <th className="text-right">Total</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {(detail?.items || []).map((item, i) => (
                <tr key={item.id || i}>
                  <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                  {kind === 'return' ? (
                    <>
                      <td className="text-right mono">{item.returnQty}</td>
                      <td className="text-right mono">{fmt(item.cost)}</td>
                      <td className="text-right mono">{fmt(item.lineTotal || item.returnQty * item.cost)}</td>
                    </>
                  ) : kind === 'grn' ? (
                    <>
                      <td className="text-right mono">{item.orderedQty ?? '—'}</td>
                      <td className="text-right mono">{item.receivedQty ?? item.qty ?? '—'}</td>
                      <td className="text-right mono">{fmt(item.cost)}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{item.batchNumber || '—'}</td>
                      <td className="text-right mono">{fmt(item.lineTotal || (item.receivedQty || item.qty || 0) * (item.cost || 0))}</td>
                    </>
                  ) : (
                    <>
                      <td className="text-right mono">{item.qty}</td>
                      <td className="text-right mono">{fmt(item.cost)}</td>
                      <td className="text-right mono">{item.discount || 0}%</td>
                      <td className="text-right mono">{fmt(item.lineTotal || item.qty * item.cost)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      )}

      {tab === 'totals' && (
        <DetailSection title="Amounts">
          <DetailFields
            columns={1}
            fields={[
              { label: 'Subtotal', value: fmt(detail?.subtotal || 0) },
              { label: 'GST', value: fmt(detail?.taxTotal || 0) },
              { label: 'Discount', value: (detail?.discount || 0) > 0 ? `-${fmt(detail.discount)}` : '—' },
              {
                label: kind === 'return' ? 'Credit total' : 'Total',
                value: <strong style={{ color: 'var(--accent)' }}>{fmt(detail?.total || 0)}</strong>,
              },
              ...(kind === 'bill' ? [
                { label: 'Paid', value: <span style={{ color: 'var(--green)' }}>{fmt(detail?.paidAmount || 0)}</span> },
                { label: 'Balance', value: balDue > 0.01 ? <span style={{ color: 'var(--red)' }}>{fmt(balDue)}</span> : '—' },
              ] : []),
            ]}
          />
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}

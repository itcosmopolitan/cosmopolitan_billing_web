import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { salesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { Chip, ReturnStatusChip, Tag } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'

function displayPaymentMode(raw) {
  if (!raw) return '—'
  return String(raw).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const META = {
  invoice: { icon: '🧾', label: 'Invoice', fetch: (id) => salesAPI.get(id) },
  quote: { icon: '📄', label: 'Quotation', fetch: (id) => salesAPI.quotations.get(id) },
  order: { icon: '📦', label: 'Sales order', fetch: (id) => salesAPI.orders.get(id) },
  return: { icon: '↩️', label: 'Credit note', fetch: (id) => salesAPI.returns.get(id) },
}

/**
 * Unified sales document detail drawer (invoice / quotation / sales order / credit note).
 * Row-click opens this; Edit still navigates to the full form when needed.
 */
export default function SalesTxnDetailPanel({
  open,
  kind = 'invoice',
  document: doc,
  onClose,
  onPrint,
  onCancelInvoice,
  onRecordPayment,
  onVoidReturn,
  branchLookup,
}) {
  const can = useCan()
  const navigate = useNavigate()
  const meta = META[kind] || META.invoice
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
        /* list row may already include lines */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, doc?.id, kind])

  const lineCount = detail?.items?.length || 0
  const balDue = kind === 'invoice'
    ? Math.round(((detail?.total || 0) - (detail?.paidAmount || 0) - (detail?.creditedAmount || 0)) * 100) / 100
    : 0

  const customerAddressLines = [
    detail?.customerStreet1 || detail?.customer_street1,
    detail?.customerStreet2 || detail?.customer_street2,
    detail?.customerStreet3 || detail?.customer_street3,
    detail?.customerCity || detail?.customer_city || detail?.city,
    detail?.customerStateProvince || detail?.customer_state_province,
    detail?.customerCountry || detail?.customer_country || detail?.country,
    detail?.customerPostalCode || detail?.customer_postal_code || detail?.postal_code,
  ].filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim())

  const summary = kind === 'invoice' ? [
    { label: 'Total', value: fmt(detail?.total) },
    { label: 'Paid', value: fmt(detail?.paidAmount || 0), tone: 'var(--green)' },
    { label: 'Balance due', value: balDue > 0.01 ? fmt(balDue) : '—', tone: balDue > 0.01 ? 'var(--red)' : undefined },
    { label: 'Status', value: <Chip status={detail?.status} /> },
  ] : kind === 'return' ? [
    { label: 'Credit total', value: fmt(detail?.total), tone: 'var(--red)' },
    { label: 'Credited', value: (detail?.creditedAmount || 0) > 0 ? fmt(detail.creditedAmount) : '—' },
    { label: 'Refund', value: detail?.refundMethod || '—' },
    { label: 'Status', value: <Chip status={detail?.status === 'processed' ? 'paid' : detail?.status} label={(detail?.status || '').charAt(0).toUpperCase() + (detail?.status || '').slice(1)} /> },
  ] : [
    { label: 'Total', value: fmt(detail?.total) },
    { label: 'Lines', value: lineCount },
    { label: kind === 'quote' ? 'Valid until' : 'Expected', value: detail?.validUntil || detail?.expectedDate || '—' },
    { label: 'Status', value: <Chip status={detail?.status} label={String(detail?.status || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} /> },
  ]

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>

      {kind === 'invoice' && (
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              onPrint?.(detail, branchLookup?.(detail) || null)
              onClose?.()
            }}
          >
            Print invoice
          </button>
          {detail?.status !== 'cancelled' && !(detail?.paidAmount > 0) && can('invoices.cancel') && (
            <button type="button" className="btn btn-danger" onClick={() => { onCancelInvoice?.(detail); onClose?.() }}>
              Cancel invoice
            </button>
          )}
          {['pending', 'partial', 'overdue'].includes(detail?.status) && (
            <button type="button" className="btn btn-primary" onClick={() => { onRecordPayment?.(detail); onClose?.() }}>
              Record payment
            </button>
          )}
          {can('invoices.edit') && !['cancelled', 'paid'].includes(detail?.status) && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { onClose?.(); navigate(`/sales/invoices/${detail.id}/edit`) }}
            >
              Edit
            </button>
          )}
        </>
      )}

      {kind === 'quote' && (
        <>
          {!['converted', 'accepted', 'rejected'].includes(detail?.status) && can('invoices.edit') && (
            <button type="button" className="btn btn-secondary" onClick={() => { onClose?.(); navigate(`/sales/quotations/${detail.id}/edit`) }}>
              Edit
            </button>
          )}
          {!['converted', 'rejected'].includes(detail?.status) && can('invoices.create') && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => { onClose?.(); navigate(`/sales/orders/new?fromQuote=${detail.id}`) }}>
                Convert to order
              </button>
              <button type="button" className="btn btn-primary" onClick={() => { onClose?.(); navigate(`/sales/invoices/new?fromQuote=${detail.id}`) }}>
                Convert to invoice
              </button>
            </>
          )}
        </>
      )}

      {kind === 'order' && (
        <>
          {((detail?.status === 'draft' && can('invoices.create', 'invoices.edit'))
            || (detail?.status === 'confirmed' && can('invoices.edit'))) && (
            <button type="button" className="btn btn-secondary" onClick={() => { onClose?.(); navigate(`/sales/orders/${detail.id}/edit`) }}>
              Edit
            </button>
          )}
          {['confirmed', 'partially_invoiced'].includes(detail?.status) && can('invoices.create') && (
            <button type="button" className="btn btn-primary" onClick={() => { onClose?.(); navigate(`/sales/invoices/new?fromOrder=${detail.id}`) }}>
              Convert to invoice
            </button>
          )}
        </>
      )}

      {kind === 'return' && can('invoices.edit') && detail?.status !== 'void' && (
        <button type="button" className="btn btn-danger" onClick={() => onVoidReturn?.(detail)}>
          Void credit note
        </button>
      )}
    </>
  )

  const overviewTitle = kind === 'return' ? 'Credit note info' : kind === 'quote' ? 'Quotation info' : kind === 'order' ? 'Order info' : 'Bill to'

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon={meta.icon}
      title={detail?.number || meta.label}
      subtitle={[detail?.customerName || 'Walk-in', detail?.date].filter(Boolean).join(' · ')}
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
          <DetailSection title={overviewTitle}>
            <DetailFields fields={[
              {
                label: 'Customer',
                value: (
                  <div>
                    <div>{detail?.customerName || 'Walk-in'}</div>
                    {customerAddressLines.length > 0 && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 4 }}>
                        {customerAddressLines.map((line) => <div key={line}>{line}</div>)}
                      </div>
                    )}
                  </div>
                ),
              },
              { label: 'Branch', value: detail?.branchName || detail?.branchId || '—' },
              ...(kind === 'invoice' ? [
                { label: 'Cashier', value: detail?.cashier || 'N/A' },
                { label: 'Payment mode', value: displayPaymentMode(detail?.paymentMode) },
                { label: 'Return status', value: <ReturnStatusChip status={detail?.returnStatus} /> },
                { label: 'Credited (returns)', value: (detail?.creditedAmount || 0) > 0 ? fmt(detail.creditedAmount) : '—' },
                { label: 'Sales order', value: detail?.salesOrderNumber || '—' },
              ] : []),
              ...(kind === 'quote' ? [
                { label: 'Valid until', value: detail?.validUntil || '—' },
                { label: 'Created by', value: detail?.createdBy || '—' },
                { label: 'Linked SO', value: detail?.convertedOrderId ? <Tag color="var(--accent)">Linked</Tag> : '—' },
                { label: 'Linked invoice', value: detail?.convertedInvoiceId ? <Tag color="var(--green)">Invoiced</Tag> : '—' },
              ] : []),
              ...(kind === 'order' ? [
                { label: 'Expected date', value: detail?.expectedDate || '—' },
                { label: 'Created by', value: detail?.createdBy || '—' },
                { label: 'Converted invoice', value: detail?.convertedInvoiceId || '—' },
              ] : []),
              ...(kind === 'return' ? [
                { label: 'Against invoice', value: detail?.invoiceNumber || '—' },
                { label: 'Reason', value: detail?.reason || '—' },
                {
                  label: 'Refund method',
                  value: (
                    <Tag color={detail?.refundMethod === 'credit' ? 'var(--accent)' : detail?.refundMethod === 'adjustment' ? 'var(--amber)' : undefined}>
                      {detail?.refundMethod === 'credit' ? 'Credit' : detail?.refundMethod === 'adjustment' ? 'Adjustment' : 'Cash'}
                    </Tag>
                  ),
                },
                { label: 'Created by', value: detail?.createdBy || '—' },
              ] : []),
              { label: 'Date', value: detail?.date || '—' },
              { label: 'Status', value: <Chip status={detail?.status} label={String(detail?.status || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} /> },
            ]}
            />
          </DetailSection>
          {(detail?.remarks || detail?.notes) ? (
            <DetailSection title={kind === 'invoice' ? 'Remarks' : 'Notes'}>
              <div style={{ fontSize: 13 }}>{detail.remarks || detail.notes}</div>
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
                    <th className="text-right">Original qty</th>
                    <th className="text-right">Return qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">GST</th>
                    <th className="text-right">Total</th>
                  </>
                ) : (
                  <>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Disc %</th>
                    <th className="text-right">GST</th>
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
                      <td className="text-right mono">{item.originalQty ?? '—'}</td>
                      <td className="text-right mono">{item.returnQty}</td>
                      <td className="text-right mono">{fmt(item.price)}</td>
                      <td className="text-right mono">{item.taxRate || 0}%</td>
                      <td className="text-right mono">{fmt(item.lineTotal || (item.returnQty * item.price))}</td>
                    </>
                  ) : (
                    <>
                      <td className="text-right mono">{item.qty}</td>
                      <td className="text-right mono">{fmt(item.price)}</td>
                      <td className="text-right mono">{item.discount || 0}%</td>
                      <td className="text-right mono">{item.taxRate || 0}%</td>
                      <td className="text-right mono">{fmt(item.lineTotal || (item.qty * item.price))}</td>
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
              { label: 'Subtotal', value: fmt(detail?.subtotal || ((detail?.total || 0) - (detail?.taxTotal || 0))) },
              { label: 'GST', value: fmt(detail?.taxTotal || 0) },
              { label: 'Discount', value: (detail?.discount || 0) > 0 ? `-${fmt(detail.discount)}` : '—' },
              {
                label: kind === 'return' ? 'Credit total' : 'Total',
                value: <strong style={{ color: kind === 'return' ? 'var(--red)' : 'var(--accent)' }}>{fmt(detail?.total)}</strong>,
              },
              ...(kind === 'invoice' ? [
                { label: 'Paid', value: <span style={{ color: 'var(--green)' }}>{fmt(detail?.paidAmount || 0)}</span> },
                { label: 'Balance due', value: balDue > 0.01 ? <span style={{ color: 'var(--red)' }}>{fmt(balDue)}</span> : '—' },
              ] : []),
              ...(kind === 'return' ? [
                { label: 'Credited to customer', value: (detail?.creditedAmount || 0) > 0 ? fmt(detail.creditedAmount) : '—' },
              ] : []),
            ]}
          />
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}

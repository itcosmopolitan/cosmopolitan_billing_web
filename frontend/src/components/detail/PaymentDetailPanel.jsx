import { useState } from 'react'
import { fmt } from '@/utils/helpers'
import { Chip, CopyableId, AlertBar } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'

/**
 * Shared payment detail drawer for sales & purchase payments.
 * partyLabel: "Customer" | "Vendor"
 */
export default function PaymentDetailPanel({
  open,
  payment,
  onClose,
  partyLabel = 'Customer',
  partyName,
  accentColor = 'var(--accent)',
  canVoid = false,
  onVoid,
}) {
  const [tab, setTab] = useState('overview')
  const detail = payment
  const allocCount = detail?.allocations?.length || 0

  const summary = [
    { label: 'Amount', value: fmt(detail?.totalAmount), tone: 'var(--green)' },
    {
      label: 'Credit applied',
      value: (detail?.creditApplied || 0) > 0 ? fmt(detail.creditApplied) : '—',
      tone: (detail?.creditApplied || 0) > 0 ? 'var(--amber)' : undefined,
    },
    { label: 'Method', value: detail?.paymentMode ? String(detail.paymentMode).replace(/_/g, ' ').toUpperCase() : '—' },
    { label: 'Date', value: detail?.date || '—' },
  ]

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon="💸"
      title={detail?.number || 'Payment'}
      subtitle={[partyName || '—', detail?.date].filter(Boolean).join(' · ')}
      size="lg"
      summary={summary}
      tabs={[
        { id: 'overview', label: 'Payment details' },
        { id: 'allocations', label: `Allocations (${allocCount})` },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          {canVoid && !detail?.voided && (
            <button type="button" className="btn btn-danger" onClick={() => onVoid?.(detail)}>Void payment</button>
          )}
        </>
      )}
    >
      {detail?.voided && (
        <AlertBar type="amber" icon="⚠️">This payment has been voided.</AlertBar>
      )}

      {tab === 'overview' && (
        <>
          <DetailSection title="Payment info">
            <DetailFields fields={[
              { label: partyLabel, value: partyName || '—' },
              { label: 'Date', value: detail?.date || '—' },
              {
                label: 'Method',
                value: detail?.paymentMode
                  ? <Chip status={detail.paymentMode} label={String(detail.paymentMode).replace('_', ' ').toUpperCase()} />
                  : '—',
              },
              { label: 'Reference', value: detail?.paymentRef || '—' },
              {
                label: 'Total amount',
                value: <span className="mono" style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(detail?.totalAmount)}</span>,
              },
              ...(partyLabel === 'Customer' ? [{
                label: 'Credit applied',
                value: (detail?.creditApplied || 0) > 0
                  ? <span className="mono" style={{ color: 'var(--amber)' }}>{fmt(detail.creditApplied)}</span>
                  : '—',
              }] : []),
              { label: 'Created by', value: detail?.createdBy || '—' },
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

      {tab === 'allocations' && (
        <DetailSection title="Applied to">
          <table className="data-table">
            <thead>
              <tr>
                <th>{partyLabel === 'Vendor' ? 'Bill #' : 'Invoice #'}</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(detail?.allocations || []).map((a) => (
                <tr key={a.id}>
                  <td>
                    <CopyableId
                      value={a.billNumber || a.invoiceNumber}
                      label={a.billNumber || a.invoiceNumber}
                      style={{ color: accentColor, fontSize: 12 }}
                    />
                  </td>
                  <td className="text-right mono">{fmt(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}

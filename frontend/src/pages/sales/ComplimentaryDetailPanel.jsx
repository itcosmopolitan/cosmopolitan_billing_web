import { useState } from 'react'
import { useCan } from '@/auth/permissions'
import { fmt, fmtDateTime, formatLabel } from '@/utils/helpers'
import { Chip } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'
import { NOT_SET } from '@/utils/emptyValue'

function PersonWhen({ name, at }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{name || NOT_SET}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
        {fmtDateTime(at || null)}
      </div>
    </div>
  )
}

export default function ComplimentaryDetailPanel({
  open,
  onClose,
  entry,
  onPrint,
  onExport,
  onSubmit,
  onApprove,
  onReject,
  onDelete,
  actionBusy = null,
  actionKind = null,
}) {
  const can = useCan()
  const [tab, setTab] = useState('overview')
  const lines = entry?.items || []
  const status = entry?.status || 'approved'
  const entryId = entry?.id
  const busy = !!actionBusy

  const isBusy = (kind) => actionKind === kind && actionBusy === entryId
  const canSubmit = status === 'draft' && can('invoices.create')
  const canApprove = status === 'pending' && can('complimentary.approve')
  const canDelete = can('invoices.delete')
  const showApprovalActions = canSubmit || canApprove

  const summary = [
    { label: 'Amount (cost) (MVR)', value: fmt(entry?.cost_value) },
    { label: 'Lines', value: lines.length },
    { label: 'Reason', value: entry?.reason || NOT_SET },
    {
      label: 'Status',
      value: (
        <Chip
          status={status === 'approved' ? 'active' : status === 'pending' ? 'pending' : 'draft'}
          label={formatLabel(status)}
        />
      ),
    },
    { label: 'Taxable amount (MVR)', value: fmt(0) },
  ]

  const nextAction = status === 'draft'
    ? { description: 'Submit this draft to an approver. Stock moves only after approval.', label: isBusy('submit') ? 'Submitting…' : 'Submit for approval', onClick: () => onSubmit?.(entry), disabled: busy || !canSubmit }
    : status === 'pending'
      ? { description: 'Review the entry and approve it to deduct stock.', label: isBusy('approve') ? 'Approving…' : 'Approve', onClick: () => onApprove?.(entry), disabled: busy || !canApprove }
      : null

  const footer = (
    <>
      {canDelete && (status === 'draft' || status === 'pending') && (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginRight: 'auto', color: 'var(--red)' }}
          disabled={busy}
          onClick={() => onDelete?.(entry)}
        >
          Delete
        </button>
      )}
      {canSubmit && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onSubmit?.(entry)}>
          {isBusy('submit') ? 'Submitting…' : 'Submit for approval'}
        </button>
      )}
      {canApprove && (
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onReject?.(entry)}>
            {isBusy('reject') ? 'Rejecting…' : 'Reject'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onApprove?.(entry)}>
            {isBusy('approve') ? 'Approving…' : 'Approve'}
          </button>
        </>
      )}
      <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={!entry}
        onClick={() => {
          onPrint?.(entry)
          onClose?.()
        }}
      >
        Print
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={!entry}
        onClick={() => {
          onExport?.(entry)
          onClose?.()
        }}
      >
        Export PDF
      </button>
    </>
  )

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon="🎁"
      title={entry?.number || 'Complimentary'}
      subtitle={[entry?.customer_name || 'Walk-in', entry?.date].filter(Boolean).join(' · ')}
      size="xl"
      summary={summary}
      nextAction={showApprovalActions ? nextAction : null}
      footer={footer}
      busy={busy}
      tabs={[
        { id: 'overview', label: 'Complimentary details' },
        { id: 'lines', label: `Line items (${lines.length})` },
        { id: 'audit', label: 'Approval trail' },
      ]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'overview' && (
        <>
          <DetailSection title="Basic info">
            <DetailFields fields={[
              { label: 'Customer', value: entry?.customer_name || 'Walk-in' },
              { label: 'Branch', value: entry?.branch_name || NOT_SET },
              { label: 'Reason', value: entry?.reason || NOT_SET },
              { label: 'Date', value: entry?.date || NOT_SET },
              { label: 'Cashier', value: entry?.created_by || NOT_SET },
            ]}
            />
          </DetailSection>
          {entry?.notes ? (
            <DetailSection title="Remarks">
              <div style={{ fontSize: 13 }}>{entry.notes}</div>
            </DetailSection>
          ) : null}
        </>
      )}

      {tab === 'audit' && (
        <>
          <DetailSection title="Workflow">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ padding: '12px 14px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  Requested
                </div>
                <PersonWhen name={entry?.requested_by || entry?.created_by} at={entry?.created_at} />
              </div>
              <div style={{ padding: '12px 14px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  {status === 'rejected' ? 'Rejected' : status === 'approved' ? 'Approved' : 'Resolution'}
                </div>
                {status === 'draft' || status === 'pending' ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {status === 'draft' ? 'Not yet submitted' : 'Awaiting approval'}
                  </span>
                ) : (
                  <PersonWhen
                    name={entry?.approved_by || entry?.rejected_by}
                    at={entry?.resolved_at}
                  />
                )}
              </div>
            </div>
          </DetailSection>
          {entry?.rejection_notes ? (
            <DetailSection title="Rejection notes">
              <div style={{ fontSize: 13, color: 'var(--red)' }}>{entry.rejection_notes}</div>
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
                <th>Packaging</th>
                <th>UOM</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Rate (Cost) (MVR)</th>
                <th className="text-right">Total (Cost) (MVR)</th>
                <th>Lots</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={`${line.name}-${idx}`}>
                  <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{line.name}</td>
                  <td>{line.packaging || ''}</td>
                  <td>{line.unit || ''}</td>
                  <td className="text-right">{line.qty}</td>
                  <td className="text-right">{fmt(line.cost_price)}</td>
                  <td className="text-right">{fmt(line.cost_total)}</td>
                  <td>
                    {line.lots?.length
                      ? line.lots.map((lot, i) => (
                          <div key={`${lot.batch_id}-${i}`} style={{ fontSize: 12 }}>
                            {lot.qty} from batch {lot.batch_id}
                          </div>
                        ))
                      : NOT_SET}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}

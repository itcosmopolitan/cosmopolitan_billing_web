import { useState } from 'react'
import { useCan } from '@/auth/permissions'
import { fmtDateTime, formatLabel } from '@/utils/helpers'
import { Chip } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'

function PersonWhen({ name, at }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{name || '—'}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
        {fmtDateTime(at || null)}
      </div>
    </div>
  )
}

export default function AdjustmentDetailPanel({
  open,
  adjustment,
  onClose,
  onApprove,
  onReject,
  onDelete,
  actionBusy = false,
  deleteBusy = false,
  actionKind = null,
}) {
  const can = useCan()
  const canDelete = can('adjustments.delete')
  const [tab, setTab] = useState('overview')
  const detail = adjustment
  const busy = !!actionBusy || deleteBusy

  const deltaTone = Number(detail?.delta) > 0 ? 'var(--green)' : Number(detail?.delta) < 0 ? 'var(--red)' : undefined

  const summary = [
    {
      label: 'Quantity change',
      value: `${detail?.before_qty ?? '—'} → ${detail?.new_qty ?? '—'}`,
    },
    {
      label: 'Delta',
      value: `${Number(detail?.delta) >= 0 ? '+' : ''}${detail?.delta ?? 0}`,
      tone: deltaTone,
    },
    {
      label: 'Status',
      value: (
        <Chip
          status={detail?.status === 'approved' ? 'active' : detail?.status === 'pending' ? 'pending' : 'draft'}
          label={detail?.status ? formatLabel(detail.status) : '—'}
        />
      ),
    },
    { label: 'Reason', value: detail?.reason || '—' },
  ]

  const footer = detail?.status === 'pending' && (can('adjustments.approve') || canDelete) ? (
    <>
      {canDelete && (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginRight: 'auto', color: 'var(--red)' }}
          disabled={busy}
          onClick={() => onDelete?.(detail)}
        >
          Delete
        </button>
      )}
      {can('adjustments.approve') && (
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onReject?.(detail)}>
            {actionKind === 'reject' && actionBusy === detail.id ? 'Rejecting…' : 'Reject'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onApprove?.(detail)}>
            {actionKind === 'approve' && actionBusy === detail.id ? 'Approving…' : 'Approve'}
          </button>
        </>
      )}
    </>
  ) : null

  return (
    <RecordDetailDrawer
      open={open}
      onClose={() => !busy && onClose?.()}
      icon="⚖"
      title={detail?.ref_number || 'Adjustment'}
      subtitle={[detail?.item_name, detail?.branch_name].filter(Boolean).join(' · ')}
      size="lg"
      summary={summary}
      tabs={[
        { id: 'overview', label: 'Adjustment details' },
        { id: 'audit', label: 'Approval trail' },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      footer={footer}
      busy={busy}
    >
      {tab === 'overview' && (
        <>
          <DetailSection title="Stock change">
            <DetailFields fields={[
              { label: 'Adjustment #', value: <span className="mono">{detail?.ref_number}</span> },
              { label: 'Branch', value: detail?.branch_name || '—' },
              { label: 'Item', value: detail?.item_name || '—' },
              { label: 'Before qty', value: detail?.before_qty ?? '—' },
              { label: 'New qty', value: detail?.new_qty ?? '—' },
              {
                label: 'Delta',
                value: (
                  <span style={{ color: deltaTone, fontWeight: 600 }}>
                    {Number(detail?.delta) >= 0 ? '+' : ''}{detail?.delta ?? 0}
                  </span>
                ),
              },
              { label: 'Reason', value: detail?.reason || '—' },
              { label: 'Batch target', value: detail?.batch_id ? <span className="mono">{detail.batch_id}</span> : 'Aggregate / auto' },
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

      {tab === 'audit' && (
        <>
          <DetailSection title="Workflow">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ padding: '12px 14px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  Requested
                </div>
                <PersonWhen name={detail?.requested_by} at={detail?.requested_at || detail?.created_at} />
              </div>
              <div style={{ padding: '12px 14px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  {detail?.status === 'approved' ? 'Approved' : detail?.status === 'rejected' ? 'Rejected' : 'Resolution'}
                </div>
                {detail?.status === 'pending' ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Awaiting manager approval</span>
                ) : (
                  <PersonWhen
                    name={detail?.resolved_by || detail?.approved_by || detail?.rejected_by}
                    at={detail?.resolved_at}
                  />
                )}
              </div>
            </div>
          </DetailSection>
          {detail?.rejection_notes ? (
            <DetailSection title="Rejection notes">
              <div style={{ fontSize: 13, color: 'var(--red)' }}>{detail.rejection_notes}</div>
            </DetailSection>
          ) : null}
        </>
      )}
    </RecordDetailDrawer>
  )
}

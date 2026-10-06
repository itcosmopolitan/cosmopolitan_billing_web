import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { transfersAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmtDate, fmtQty } from '@/utils/helpers'
import { openStockTransferPrintWindow } from '@/utils/printInvoice'
import { exportStockTransferPdf } from '@/utils/exportStockTransferPdf'
import { Chip } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'

function transferStatusChip(status) {
  if (status === 'received') return { status: 'received', label: 'Received' }
  if (status === 'transit') return { status: 'transit', label: 'In Transit' }
  if (status === 'pending') return { status: 'pending', label: 'Pending' }
  if (status === 'rejected') return { status: 'draft', label: 'Rejected' }
  if (status === 'draft') return { status: 'draft', label: 'Draft' }
  return { status: 'draft', label: status || '—' }
}

export default function TransferDetailPanel({
  open,
  transfer,
  activeBranchId = '',
  activeBranch = {},
  onClose,
  onApprove,
  onReject,
  onReceive,
  onDelete,
  actionBusy = false,
  deleteBusy = false,
  actionKind = null,
}) {
  const can = useCan()
  const navigate = useNavigate()
  const canCreate = can('transfers.create')
  const canDelete = can('transfers.delete')
  const [detail, setDetail] = useState(transfer)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('overview')
  const [documentBusy, setDocumentBusy] = useState(false)
  const [documentAction, setDocumentAction] = useState('')
  const canApproveHere = (
    detail?.status === 'pending'
    && can('transfers.approve')
    && !!activeBranchId
    && detail?.from_branch_id === activeBranchId
  )
  const canReceiveHere = (
    detail?.status === 'transit'
    && can('transfers.receive')
    && !!activeBranchId
    && detail?.to_branch_id === activeBranchId
  )

  useEffect(() => {
    if (!open || !transfer?.id) return
    setTab('overview')
    setDetail(transfer)
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const full = await transfersAPI.get(transfer.id)
        if (!cancelled) setDetail({ ...transfer, ...full })
      } catch {
        /* list row may already include lines */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, transfer?.id])

  const chip = transferStatusChip(detail?.status)
  const lineCount = detail?.items?.length || 0
  const totalQty = (detail?.items || []).reduce((s, it) => s + Number(it.qty || 0), 0)

  const summary = [
    { label: 'Status', value: <Chip status={chip.status} label={chip.label} /> },
    { label: 'Lines', value: lineCount },
    { label: 'Total qty', value: totalQty },
    { label: 'Requested by', value: detail?.requested_by || '—' },
  ]

  const busy = !!actionBusy || deleteBusy || documentBusy

  const printTransfer = async () => {
    setDocumentBusy(true)
    setDocumentAction('print')
    try {
      await openStockTransferPrintWindow(detail, activeBranch)
    } catch (error) {
      console.error('Failed to print stock transfer:', error)
      toast.error(error.message || 'Failed to print stock transfer')
    } finally {
      setDocumentBusy(false)
      setDocumentAction('')
    }
  }

  const exportTransfer = async () => {
    setDocumentBusy(true)
    setDocumentAction('export')
    try {
      await exportStockTransferPdf(detail, activeBranch)
      toast.success('Stock transfer exported')
    } catch (error) {
      console.error('Failed to export stock transfer:', error)
      toast.error(error.message || 'Failed to export stock transfer')
    } finally {
      setDocumentBusy(false)
      setDocumentAction('')
    }
  }
  const nextAction = canApproveHere
    ? {
      description: 'Review the transfer request and approve it to dispatch the stock.',
      label: actionKind === 'approve' && actionBusy === detail.id ? 'Approving…' : 'Approve & dispatch',
      onClick: () => onApprove?.(detail),
      disabled: busy,
    }
    : detail?.status === 'pending' && canCreate
    ? {
      description: 'Update the pending transfer request.',
      label: 'Edit transfer',
      onClick: () => {
        onClose?.()
        navigate(`/transfers/${detail.id}/edit`)
      },
      disabled: busy,
    }
    : canReceiveHere
      ? {
        description: 'Confirm receipt to complete this stock transfer.',
        label: actionKind === 'receive' && actionBusy === detail.id ? 'Receiving…' : 'Receive',
        onClick: () => onReceive?.(detail),
        disabled: busy,
      }
      : {
        description: detail?.status === 'pending'
          ? (activeBranchId && detail?.from_branch_id !== activeBranchId
            ? 'Switch to the source branch to approve and dispatch this transfer.'
            : 'This transfer is awaiting approval.')
          : detail?.status === 'transit'
            ? (activeBranchId && detail?.to_branch_id !== activeBranchId
              ? 'Switch to the destination branch to receive this transfer.'
              : 'This transfer is in transit and awaiting receipt.')
            : 'No further action is needed for this transfer.',
      }

  let footer = null
  if (detail?.status === 'pending' && (canApproveHere || canDelete || canCreate)) {
    footer = (
      <>
        {canCreate && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginRight: canDelete ? 0 : 'auto' }}
            disabled={busy}
            onClick={() => {
              onClose?.()
              navigate(`/transfers/${detail.id}/edit`)
            }}
          >
            Edit
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginRight: 'auto', color: 'var(--red)', marginLeft: canCreate ? 8 : 0 }}
            disabled={busy}
            onClick={() => onDelete?.(detail)}
          >
            Delete
          </button>
        )}
        {canApproveHere && (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onReject?.(detail)}>
              {actionKind === 'reject' && actionBusy === detail.id ? 'Rejecting…' : 'Reject'}
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onApprove?.(detail)}>
              {actionKind === 'approve' && actionBusy === detail.id ? 'Approving…' : 'Approve & dispatch'}
            </button>
          </>
        )}
      </>
    )
  } else if (canReceiveHere) {
    footer = (
      <>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onReceive?.(detail)}>
          {actionKind === 'receive' && actionBusy === detail.id ? 'Receiving…' : 'Receive'}
        </button>
      </>
    )
  }

  footer = (
    <>
      {footer}
      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginLeft: 'auto' }}
        disabled={busy || !detail?.id}
        onClick={exportTransfer}
      >
        {documentAction === 'export' ? 'Exporting…' : 'Export Stock Transfer'}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !detail?.id}
        onClick={printTransfer}
      >
        {documentAction === 'print' ? 'Opening…' : 'Print Stock Transfer'}
      </button>
    </>
  )

  return (
    <RecordDetailDrawer
      open={open}
      onClose={() => !busy && onClose?.()}
      icon="↔"
      title={detail?.ref_number || 'Transfer'}
      subtitle={`${detail?.from_branch_name || detail?.from_branch_id || '—'} → ${detail?.to_branch_name || detail?.to_branch_id || '—'}`}
      size="lg"
      summary={summary}
      tabs={[
        { id: 'overview', label: 'Transfer details' },
        { id: 'items', label: `Items (${lineCount})` },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      nextAction={nextAction}
      footer={footer}
      busy={busy}
    >
      {loading && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Loading details…</div>}

      {tab === 'overview' && (
        <>
          <DetailSection title="Route">
            <DetailFields fields={[
              { label: 'Transfer #', value: <span className="mono">{detail?.ref_number}</span> },
              { label: 'From', value: detail?.from_branch_name || detail?.from_branch_id },
              { label: 'To', value: detail?.to_branch_name || detail?.to_branch_id },
              { label: 'Status', value: <Chip status={chip.status} label={chip.label} /> },
              { label: 'Requested by', value: detail?.requested_by || '—' },
              { label: 'Created', value: detail?.created_at ? fmtDate(detail.created_at) : '—' },
            ]}
            />
          </DetailSection>
          {detail?.notes ? (
            <DetailSection title="Notes">
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{detail.notes}</div>
            </DetailSection>
          ) : null}
        </>
      )}

      {tab === 'items' && (
        <DetailSection title="Line items & batch allocation">
          {!detail?.items?.length ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No items on this transfer</div>
          ) : (
            <>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Qty</th>
                    <th>Source batches drained</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((item, idx) => {
                    const drained = item.batches || []
                    const requested = item.requested_allocation || []
                    const showRequested = drained.length === 0 && requested.length > 0
                    const lots = showRequested
                      ? requested.map((r) => ({
                        batch_id: r.batch_id,
                        batch_number: r.batch_id?.slice(-8),
                        consumed: r.qty,
                      }))
                      : drained
                    return (
                      <tr key={idx} style={{ verticalAlign: 'top' }}>
                        <td>
                          <div style={{ fontSize: 13 }}>{item.name || 'Unknown'}</div>
                          {item.preferred_batch_id && requested.length === 0 && (
                            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                              Operator pick: <span className="mono">{item.preferred_batch_id.slice(-8)}</span>
                            </div>
                          )}
                        </td>
                        <td className="text-right mono">{fmtQty(item.qty)}</td>
                        <td>
                          {lots.length === 0 ? (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {detail.status === 'pending' ? '— auto-allocate on approval' : 'untracked / no allocation'}
                            </span>
                          ) : (
                            <>
                              {showRequested && (
                                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: 0.4, marginBottom: 4 }}>
                                  PLANNED SPLIT
                                </div>
                              )}
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {lots.map((b, bi) => (
                                  <div key={bi} style={{ fontSize: 11, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                                    <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                                      {b.batch_number || b.batch_id?.slice(-8)}
                                    </span>
                                    <span style={{ color: 'var(--text-muted)' }}>×{fmtQty(b.consumed)}</span>
                                    {b.expiry_date && (
                                      <span style={{ color: 'var(--amber)' }}>exp {fmtDate(b.expiry_date)}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {detail.status === 'received' && detail.items.some((it) => it.batches?.length) && (
                <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg-raised)', borderRadius: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Each batch above was recreated at <strong>{detail.to_branch_name || detail.to_branch_id}</strong> with the original
                  lot number, mfg / expiry date and cost — so FIFO/FEFO ordering carries across the transfer.
                </div>
              )}
            </>
          )}
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}

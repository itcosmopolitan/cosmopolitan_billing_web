import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { transfersAPI, summariesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import ActivityDrawer from '@/components/activity/ActivityDrawer'
import { SectionHeader, Card, Tabs, Chip, Modal, EmptyState, AlertBar, PaginationBar, SortableHeader, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions, CustomizeColumnsModal, ColumnPrefsTrigger, ColumnPrefsSpacer } from '@/components/ui'
import { DEFAULT_PAGE_SIZE, unwrapPaged } from '@/utils/pagination'
import { tabsWithCounts } from '@/utils/moduleSummary'
import { tableRowClickProps } from '@/utils/tableRowClick'
import { formatLabel } from '@/utils/helpers'
import useColumnPrefs from '@/hooks/useColumnPrefs'
import RowActionsMenu from './RowActionsMenu'
import TransferDetailPanel from './TransferDetailPanel'

// In-flight request cache to avoid duplicate identical fetches across
// remounts (helps reduce dev StrictMode double-calls showing in Network).
const inFlightTransfersRequests = new Map()

const TAB_DEFS = [
  { id: 'all',      label: 'All Transfers' },
  { id: 'draft',    label: 'Draft' },
  { id: 'pending',  label: 'Pending Approval' },
  { id: 'transit',  label: 'In Transit' },
  { id: 'received', label: 'Received' },
  { id: 'rejected', label: 'Rejected' },
]

const TAB_IDS = new Set(TAB_DEFS.map((t) => t.id))

/** Read the active section from ?status= (defaults to all). */
function tabFromSearchParams(searchParams) {
  const raw = searchParams.get('status')
  if (!raw || raw === 'all') return 'all'
  return TAB_IDS.has(raw) ? raw : 'all'
}

function transferStatusChip(status) {
  if (status === 'received') return { status: 'received', label: 'Received' }
  if (status === 'transit') return { status: 'transit', label: 'In Transit' }
  if (status === 'pending') return { status: 'pending', label: 'Pending' }
  if (status === 'rejected') return { status: 'draft', label: 'Rejected' }
  return { status: 'draft', label: formatLabel(status) }
}

export default function TransfersPage() {
  const can = useCan()
  const columnPrefs = useColumnPrefs('transfers.list')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const user = useAppStore((s) => s.user)
  const tab = tabFromSearchParams(searchParams)
  const [showDetail, setShowDetail] = useState(null)
  const [activityTarget, setActivityTarget] = useState(null)
  const [transfers, setTransfers] = useState([])
  const [listTotal, setListTotal] = useState(0)
  const [summary, setSummary] = useState(null)
  const [listVersion, setListVersion] = useState(0)
  const [trSkip, setTrSkip] = useState(0)
  const [trLimit, setTrLimit] = useState(DEFAULT_PAGE_SIZE)
  const [trSortBy, setTrSortBy] = useState('created_at')
  const [trSortOrder, setTrSortOrder] = useState('desc')
  const [listLoading, setListLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionKind, setActionKind] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleteTargets, setDeleteTargets] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const selectAllRef = useRef(null)
  const lastFetchKeyRef = useRef(null)
  const canDelete = can('transfers.delete')
  const canCreate = can('transfers.create')
  const canActivity = can('history.view', 'comments.view')

  const bumpList = useCallback(() => setListVersion((v) => v + 1), [])

  useEffect(() => {
    const unsub = subscribeToBranchChanged(() => {
      setTrSkip(0)
      setSelectedIds(new Set())
      bumpList()
    })
    return () => unsub()
  }, [bumpList])

  const onTabChange = useCallback((next) => {
    setTrSkip(0)
    const params = new URLSearchParams(searchParams)
    if (next === 'all') params.delete('status')
    else params.set('status', next)
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
      const key = `${activeBranch?.id || ''}|${tab}|${trSkip}|${trLimit}|${trSortBy}|${trSortOrder}|${listVersion}`
      let cancelled = false
      const run = async () => {
        try {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('TransfersPage fetch', {
              activeBranchId: activeBranch?.id,
              tab,
              trSkip,
              trLimit,
              trSortBy,
              trSortOrder,
              listVersion,
            })
          }
          setListLoading(true)
          let promise = inFlightTransfersRequests.get(key)
          if (!promise) {
            promise = Promise.all([
              transfersAPI.list({
                branch_id: activeBranch?.id,
                skip: trSkip,
                limit: trLimit,
                sort_by: trSortBy,
                sort_order: trSortOrder,
                status: tab === 'all' ? undefined : tab,
              }),
              summariesAPI.get('transfers', { branch_id: activeBranch?.id }),
            ])
            inFlightTransfersRequests.set(key, promise)
          }
          const [raw, summaryData] = await promise
          const { items, total } = unwrapPaged(raw)
          if (!cancelled) {
            setTransfers(items || [])
            setListTotal(total)
            setSummary(summaryData)
          }
        } catch (err) {
          console.error('Failed to fetch transfers:', err)
          if (!cancelled) {
            setTransfers([])
            setListTotal(0)
            setSummary(null)
            toast.error('Failed to load transfers')
          }
        } finally {
          if (!cancelled) setListLoading(false)
          inFlightTransfersRequests.delete(key)
        }
      }
      run()
      return () => { cancelled = true }
  }, [activeBranch?.id, tab, trSkip, trLimit, trSortBy, trSortOrder, listVersion])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [tab, trSkip, trLimit])

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const pendingIds = new Set(
        transfers.filter((t) => t.status === 'pending').map((t) => t.id),
      )
      const next = new Set([...prev].filter((id) => pendingIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [transfers])

  const onSort = (key) => {
    setTrSkip(0)
    if (trSortBy === key) {
      setTrSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setTrSortBy(key)
    setTrSortOrder(key === 'created_at' ? 'desc' : 'asc')
  }

  const pendingOnPage = transfers.filter((t) => t.status === 'pending')
  const selectablePending = canDelete ? pendingOnPage : []
  const selectedPending = selectablePending.filter((t) => selectedIds.has(t.id))
  const selectedCount = selectedPending.length
  const allPendingSelected = selectablePending.length > 0
    && selectablePending.every((t) => selectedIds.has(t.id))
  const somePendingSelected = selectablePending.some((t) => selectedIds.has(t.id))

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePendingSelected && !allPendingSelected
    }
  }, [somePendingSelected, allPendingSelected])

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllPending = () => {
    setSelectedIds((prev) => {
      if (allPendingSelected) {
        const next = new Set(prev)
        selectablePending.forEach((t) => next.delete(t.id))
        return next
      }
      const next = new Set(prev)
      selectablePending.forEach((t) => next.add(t.id))
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const deselectRow = (id) => {
    setSelectedIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const openDeleteConfirm = (rows) => {
    const list = (Array.isArray(rows) ? rows : [rows]).filter((t) => t.status === 'pending')
    if (list.length === 0) return
    setDeleteTargets(list)
  }

  const closeDeleteConfirm = () => {
    if (!deleteBusy) setDeleteTargets(null)
  }

  const confirmDelete = async () => {
    if (!deleteTargets?.length || deleteBusy) return
    setDeleteBusy(true)
    setActionKind('delete')
    let ok = 0
    let fail = 0
    let lastError = null
    for (const row of deleteTargets) {
      try {
        await transfersAPI.delete(row.id, { ref_number: row.ref_number })
        ok += 1
      } catch (err) {
        fail += 1
        lastError = err
        console.error(err)
      }
    }
    if (ok > 0) toast.success(`${ok} transfer${ok > 1 ? 's' : ''} deleted`)
    if (fail > 0) {
      toast.error(lastError?.response?.data?.detail || `${fail} transfer${fail > 1 ? 's' : ''} could not be deleted`)
    }
    setDeleteTargets(null)
    setSelectedIds(new Set())
    setShowDetail(null)
    bumpList()
    setDeleteBusy(false)
    setActionKind(null)
  }

  const isRowBusy = (id) => actionBusy === id || (deleteBusy && deleteTargets?.some((r) => r.id === id))

  const approve = async (row) => {
    if (actionBusy) return
    setActionBusy(row.id)
    setActionKind('approve')
    try {
      const res = await transfersAPI.approve(row.id, {
        approved_by: user?.name || 'Manager',
        ref_number: row.ref_number,
      })
      if (res.already_processed) {
        toast.success(`${row.ref_number} was already dispatched`)
      } else {
        toast.success(`${row.ref_number} approved & dispatched`)
      }
      bumpList()
      deselectRow(row.id)
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error(err.response?.data?.detail || 'Failed to approve transfer')
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }

  const submit = async (row) => {
    if (actionBusy) return
    setActionBusy(row.id)
    setActionKind('submit')
    try {
      await transfersAPI.submit(row.id, { ref_number: row.ref_number })
      toast.success(`${row.ref_number} submitted for approval`)
      bumpList()
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error(err.response?.data?.detail || 'Failed to submit transfer')
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }

  const reject = async (row) => {
    if (actionBusy) return
    setActionBusy(row.id)
    setActionKind('reject')
    try {
      const res = await transfersAPI.reject(row.id, {
        rejected_by: user?.name || 'Manager',
        rejection_notes: 'Rejected by manager',
        ref_number: row.ref_number,
      })
      if (res.already_processed) {
        toast.success(`${row.ref_number} was already rejected`)
      } else {
        toast.success(`${row.ref_number} rejected`)
      }
      bumpList()
      deselectRow(row.id)
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error(err.response?.data?.detail || 'Failed to reject transfer')
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }

  const receive = async (row) => {
    if (actionBusy) return
    setActionBusy(row.id)
    setActionKind('receive')
    try {
      const res = await transfersAPI.receive(row.id, {
        received_by: user?.name || 'Staff',
        ref_number: row.ref_number,
      })
      if (res.already_processed) {
        toast.success(`${row.ref_number} was already received`)
      } else {
        toast.success(`${row.ref_number} received — inventory updated`)
      }
      bumpList()
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error(err.response?.data?.detail || 'Failed to receive transfer')
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }

  const deleteRequest = (row) => openDeleteConfirm(row)

  const deleteSelected = () => openDeleteConfirm(selectedPending)

  const tabs = useMemo(() => tabsWithCounts(TAB_DEFS, summary), [summary])

  return (
    <div className="page-container">
      <SectionHeader title="Stock Transfers" subtitle="Move stock between branches with approval workflow">
        {canCreate && (
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/transfers/new')}>+ New Transfer</button>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          hideExport: true,
          onRefresh: () => {
            setListVersion((v) => v + 1)
            toast.success('List refreshed')
          },
        })} />
      </SectionHeader>


      <div style={{ alignItems: 'start' }}>
        <div>
          <Tabs tabs={tabs} active={tab} onChange={onTabChange} />
          {canDelete && selectedCount > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              marginBottom: 10,
              background: 'var(--bg-raised)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {selectedCount} pending transfer{selectedCount > 1 ? 's' : ''} selected
              </span>
              <button
                className="btn btn-danger btn-sm"
                onClick={deleteSelected}
                disabled={deleteBusy || !!actionBusy}
              >
                Delete selected
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={clearSelection}
                disabled={deleteBusy || !!actionBusy}
              >
                Clear selection
              </button>
            </div>
          )}
          <Card bodyPadding={false}>
            {listLoading ? (
              <TableLoadingPanel label="Loading transfers…" />
            ) : transfers.length === 0 ? (
              <EmptyState icon="↔" title="No transfers" desc="No transfers match this filter" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <ColumnPrefsTrigger onClick={columnPrefs.openCustomize} />
                    {canDelete && (
                      <th style={{ width: 36 }}>
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label="Select all pending transfers on this page"
                          checked={allPendingSelected}
                          disabled={selectablePending.length === 0 || deleteBusy || !!actionBusy}
                          onChange={toggleSelectAllPending}
                        />
                      </th>
                    )}
                    {columnPrefs.visibleIds.map((id) => {
                      if (id === 'ref_number') {
                        return <SortableHeader key={id} label="Transfer #" sortKey="ref_number" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                      }
                      if (id === 'route') {
                        return <SortableHeader key={id} label="From → To" sortKey="from_branch_id" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                      }
                      if (id === 'items') return <th key={id}>Items</th>
                      if (id === 'status') {
                        return <SortableHeader key={id} label="Status" sortKey="status" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                      }
                      if (id === 'date') {
                        return <SortableHeader key={id} label="Date" sortKey="created_at" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                      }
                      return null
                    })}
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => {
                    const chip = transferStatusChip(t.status)
                    return (
                    <tr key={t.id} {...tableRowClickProps(() => setShowDetail(t))}>
                      <ColumnPrefsSpacer />
                      {canDelete && (
                        <td data-no-row-click>
                          {t.status === 'pending' ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${t.ref_number}`}
                              checked={selectedIds.has(t.id)}
                              disabled={deleteBusy || !!actionBusy}
                              onChange={() => toggleSelect(t.id)}
                            />
                          ) : null}
                        </td>
                      )}
                      {columnPrefs.visibleIds.map((id) => {
                        if (id === 'ref_number') {
                          return <td key={id}><span className="mono" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>{t.ref_number}</span></td>
                        }
                        if (id === 'route') {
                          return (
                            <td key={id}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t.from_branch_name || t.from_branch_id}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>→ {t.to_branch_name || t.to_branch_id}</div>
                            </td>
                          )
                        }
                        if (id === 'items') {
                          return (
                            <td key={id}>
                              <div style={{ fontSize: 13 }}>{t.items?.length || 0} item{t.items?.length !== 1 ? 's' : ''}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.items?.map((i) => i.name?.split(' ')[0]).join(', ')}</div>
                            </td>
                          )
                        }
                        if (id === 'status') {
                          return (
                            <td key={id}>
                              <Chip status={chip.status} label={chip.label} />
                            </td>
                          )
                        }
                        if (id === 'date') {
                          return <td key={id} style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.date || 'N/A'}</td>
                        }
                        return null
                      })}
                      <td className="text-right">
                        <RowActionsMenu
                          busy={!!actionBusy || deleteBusy}
                          ariaLabel={`Actions for ${t.ref_number}`}
                          actions={[
                            {
                              label: 'View details',
                              disabled: isRowBusy(t.id),
                              onClick: () => setShowDetail(t),
                            },
                            {
                              label: 'Activity',
                              hidden: !canActivity,
                              disabled: isRowBusy(t.id),
                              onClick: () => setActivityTarget({ recordType: 'stock_transfer', recordId: t.id, title: `Transfer ${t.ref_number || t.id}` }),
                            },
                            {
                              label: 'Edit',
                              hidden: !['draft', 'pending'].includes(t.status) || !canCreate,
                              disabled: isRowBusy(t.id),
                              onClick: () => navigate(`/transfers/${t.id}/edit`),
                            },
                            {
                              label: actionKind === 'submit' && isRowBusy(t.id) ? 'Submitting…' : 'Submit for approval',
                              hidden: t.status !== 'draft' || !canCreate,
                              disabled: isRowBusy(t.id),
                              onClick: () => submit(t),
                            },
                            {
                              label: actionKind === 'approve' && isRowBusy(t.id) ? 'Approving…' : 'Approve & dispatch',
                              hidden: t.status !== 'pending' || !can('transfers.approve'),
                              disabled: isRowBusy(t.id),
                              onClick: () => approve(t),
                            },
                            {
                              label: actionKind === 'reject' && isRowBusy(t.id) ? 'Rejecting…' : 'Reject',
                              danger: true,
                              hidden: t.status !== 'pending' || !can('transfers.approve'),
                              disabled: isRowBusy(t.id),
                              onClick: () => reject(t),
                            },
                            {
                              label: actionKind === 'receive' && isRowBusy(t.id) ? 'Receiving…' : 'Receive',
                              hidden: t.status !== 'transit' || !can('transfers.receive'),
                              disabled: isRowBusy(t.id),
                              onClick: () => receive(t),
                            },
                            {
                              label: actionKind === 'delete' && isRowBusy(t.id) ? 'Deleting…' : 'Delete',
                              danger: true,
                              hidden: !['draft', 'pending'].includes(t.status) || !canDelete,
                              disabled: isRowBusy(t.id) || deleteBusy || !!actionBusy,
                              onClick: () => deleteRequest(t),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={listTotal}
              skip={trSkip}
              limit={trLimit}
              onSkipChange={setTrSkip}
              onLimitChange={setTrLimit}
              disabled={listLoading}
            />
          </Card>
        </div>
      </div>

      <CustomizeColumnsModal
        open={columnPrefs.customizeOpen}
        onClose={columnPrefs.closeCustomize}
        defs={columnPrefs.defs}
        value={columnPrefs.prefs}
        onSave={columnPrefs.savePrefs}
      />

      <TransferDetailPanel
        open={!!showDetail}
        transfer={showDetail}
        onClose={() => !actionBusy && !deleteBusy && setShowDetail(null)}
        onApprove={approve}
        onReject={reject}
        onReceive={receive}
        onDelete={deleteRequest}
        actionBusy={actionBusy}
        deleteBusy={deleteBusy}
        actionKind={actionKind}
      />

      <ActivityDrawer
        open={!!activityTarget}
        onClose={() => setActivityTarget(null)}
        recordType={activityTarget?.recordType}
        recordId={activityTarget?.recordId}
        title={activityTarget?.title}
      />

      <Modal
        open={!!deleteTargets?.length}
        onClose={closeDeleteConfirm}
        title="Delete transfers"
        icon="⚠️"
        size="sm"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={closeDeleteConfirm} disabled={deleteBusy}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy
                ? `Deleting${deleteTargets?.length > 1 ? ` (${deleteTargets.length})…` : '…'}`
                : `Delete${deleteTargets?.length > 1 ? ` (${deleteTargets.length})` : ''}`}
            </button>
          </>
        )}
      >
        {deleteTargets && (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 12 }}>
              {deleteTargets.length === 1
                ? 'This will permanently remove the following pending transfer:'
                : `This will permanently remove ${deleteTargets.length} pending transfers:`}
            </p>
            <div style={{
              maxHeight: 220,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 8,
              marginBottom: 12,
            }}>
              <table className="data-table" style={{ marginBottom: 0 }}>
                <thead>
                  <tr>
                    <th>Transfer #</th>
                    <th>Route</th>
                    <th>Items</th>
                  </tr>
                </thead>
                <tbody>
                  {deleteTargets.map((t) => (
                    <tr key={t.id}>
                      <td className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                        {t.ref_number}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {t.from_branch_name || t.from_branch_id} → {t.to_branch_name || t.to_branch_id}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.items?.length || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AlertBar type="amber" icon="⚠️">
              This action cannot be undone. In-transit and received transfers cannot be deleted.
            </AlertBar>
          </>
        )}
      </Modal>
    </div>
  )
}

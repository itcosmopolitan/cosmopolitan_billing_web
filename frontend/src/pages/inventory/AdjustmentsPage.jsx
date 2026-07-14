import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import toast from 'react-hot-toast'
import { adjustmentsAPI, itemsAPI, summariesAPI, AUTOCOMPLETE_ITEM_URL, AUTOCOMPLETE_BRANCH_URL } from '@/api'
import { useCan } from '@/auth/permissions'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import ActivityDrawer from '@/components/activity/ActivityDrawer'
import {
  SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow,
  EmptyState, AlertBar, PaginationBar, SortableHeader, AutocompleteDropdown,
  PageActionsMenu, buildListPageMenuActions,
} from '@/components/ui'
import { DEFAULT_PAGE_SIZE, unwrapPaged } from '@/utils/pagination'
import { tabsWithCounts } from '@/utils/moduleSummary'
import { fmtDate, fmtDateTime } from '@/utils/helpers'
import RowActionsMenu from './RowActionsMenu'

// In-flight request cache to avoid duplicate identical fetches across
// remounts (helps reduce dev StrictMode double-calls showing in Network).
const inFlightAdjustmentsRequests = new Map()

const TAB_DEFS = [
  { id: 'all',      label: 'All' },
  { id: 'pending',  label: 'Pending Approval' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
]

const REASONS = [
  'Physical count',
  'Damaged / Spoilage',
  'Theft / Shrinkage',
  'Data correction',
  'Expiry removal',
  'Other',
]

function trackingLabel(item) {
  if (!item?.batch_tracking) return 'Untracked'
  return item.expiry_tracking ? 'FEFO' : 'FIFO'
}

function resolvedColumnLabel(tab) {
  if (tab === 'approved') return 'Approved'
  if (tab === 'rejected') return 'Rejected'
  if (tab === 'pending') return 'Resolution'
  return 'Approved / Rejected'
}

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

export default function AdjustmentsPage() {
  const can = useCan()
  const user = useAppStore((s) => s.user)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const [activityTarget, setActivityTarget] = useState(null)
  const [tab, setTab] = useState('all')
  const [requests, setRequests] = useState([])
  const [listTotal, setListTotal] = useState(0)
  const [summary, setSummary] = useState(null)
  const [listVersion, setListVersion] = useState(0)
  const [pickedItem, setPickedItem] = useState(null)
  const [listLoading, setListLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [showDetail, setShowDetail] = useState(null)
  const [skip, setSkip] = useState(0)
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE)
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [newForm, setNewForm] = useState({
    branch_id: activeBranch?.id || 'br-001',
    item_id: '',
    new_qty: '',
    reason: 'Physical count',
    notes: '',
    batch_id: '',
  })
  const [adjBatches, setAdjBatches] = useState([])
  const [adjLoading, setAdjLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionKind, setActionKind] = useState(null)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleteTargets, setDeleteTargets] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const selectAllRef = useRef(null)

  const canDelete = can('adjustments.delete')
  const canActivity = can('history.view', 'comments.view')

  const bumpList = useCallback(() => setListVersion((v) => v + 1), [])

  useEffect(() => {
    const key = `${tab}|${activeBranch?.id || ''}|${skip}|${limit}|${sortBy}|${sortOrder}|${listVersion}`
    let cancelled = false
    const run = async () => {
      try {
        setListLoading(true)
        let promise = inFlightAdjustmentsRequests.get(key)
        if (!promise) {
          promise = Promise.all([
            adjustmentsAPI.list({
              skip,
              limit,
              sort_by: sortBy,
              sort_order: sortOrder,
              status: tab === 'all' ? undefined : tab,
            }),
            summariesAPI.get('adjustments'),
          ])
          inFlightAdjustmentsRequests.set(key, promise)
        }
        const [raw, summaryData] = await promise
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setRequests(items || [])
          setListTotal(total)
          setSummary(summaryData)
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          setRequests([])
          setListTotal(0)
          setSummary(null)
          toast.error('Failed to load adjustment requests')
        }
      } finally {
        if (!cancelled) setListLoading(false)
        inFlightAdjustmentsRequests.delete(key)
      }
    }
    run()
    return () => { cancelled = true }
  }, [tab, activeBranch?.id, skip, limit, sortBy, sortOrder, listVersion])

  // Re-fetch list when active branch changes; also update newForm.branch_id
  useEffect(() => {
    const unsub = subscribeToBranchChanged((newBranch) => {
      setNewForm((f) => ({ ...f, branch_id: newBranch?.id || 'br-001' }))
      setSelectedIds(new Set())
      setSkip(0)
      setListVersion((v) => v + 1)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    setSelectedIds(new Set())
  }, [tab, skip, limit])

  const pendingOnPage = requests.filter((r) => r.status === 'pending')
  const selectablePending = canDelete ? pendingOnPage : []
  const selectedPending = selectablePending.filter((r) => selectedIds.has(r.id))
  const selectedCount = selectedPending.length
  const allPendingSelected = selectablePending.length > 0
    && selectablePending.every((r) => selectedIds.has(r.id))
  const somePendingSelected = selectablePending.some((r) => selectedIds.has(r.id))

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const pendingIds = new Set(
        requests.filter((r) => r.status === 'pending').map((r) => r.id),
      )
      const next = new Set([...prev].filter((id) => pendingIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [requests])

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
        selectablePending.forEach((r) => next.delete(r.id))
        return next
      }
      const next = new Set(prev)
      selectablePending.forEach((r) => next.add(r.id))
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
    const list = (Array.isArray(rows) ? rows : [rows]).filter((r) => r.status === 'pending')
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
        await adjustmentsAPI.delete(row.id, { ref_number: row.ref_number })
        ok += 1
      } catch (err) {
        fail += 1
        lastError = err
        console.error(err)
      }
    }
    if (ok > 0) {
      toast.success(`${ok} adjustment${ok > 1 ? 's' : ''} deleted`)
    }
    if (fail > 0) {
      toast.error(lastError?.response?.data?.detail || `${fail} adjustment${fail > 1 ? 's' : ''} could not be deleted`)
    }
    setDeleteTargets(null)
    setSelectedIds(new Set())
    setShowDetail(null)
    bumpList()
    setDeleteBusy(false)
    setActionKind(null)
  }

  const picked = pickedItem?.id === newForm.item_id ? pickedItem : null

  const loadBatches = async (itemId, branchId) => {
    if (!itemId) return
    setAdjLoading(true)
    try {
      const data = await itemsAPI.batches.list(itemId, { branch_id: branchId })
      setAdjBatches(data?.items || [])
    } catch {
      setAdjBatches([])
    } finally {
      setAdjLoading(false)
    }
  }

  useEffect(() => {
    if (!showNew || !newForm.item_id || !picked?.batch_tracking) {
      setAdjBatches([])
      return
    }
    loadBatches(newForm.item_id, newForm.branch_id)
  }, [showNew, newForm.item_id, newForm.branch_id, picked?.batch_tracking])

  const onSort = (key) => {
    setSkip(0)
    if (sortBy === key) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(key); setSortOrder('desc') }
  }

  const tabs = useMemo(() => tabsWithCounts(TAB_DEFS, summary), [summary])

  const submitNew = async () => {
    if (submitting) return
    if (!newForm.item_id) { toast.error('Select an item'); return }
    if (newForm.new_qty === '' || newForm.new_qty === null) { toast.error('Enter new quantity'); return }
    const item = pickedItem
    if (!item) return
    setSubmitting(true)
    try {
      const res = await adjustmentsAPI.create({
        branch_id: newForm.branch_id,
        item_id: newForm.item_id,
        item_name: item.name,
        new_qty: Number(newForm.new_qty),
        reason: newForm.reason,
        notes: newForm.notes || undefined,
        batch_id: newForm.batch_id || undefined,
        requested_by: user?.name || 'Staff',
      })
      toast.success(
        res.status === 'approved'
          ? `Adjustment ${res.ref_number} applied`
          : `Adjustment ${res.ref_number} submitted for approval`,
      )
      setShowNew(false)
      setPickedItem(null)
      setNewForm({
        branch_id: activeBranch?.id || 'br-001',
        item_id: '',
        new_qty: '',
        reason: 'Physical count',
        notes: '',
        batch_id: '',
      })
      bumpList()
    } catch (err) {
      console.error(err)
      toast.error(err?.response?.data?.detail || 'Failed to submit request')
    } finally {
      setSubmitting(false)
    }
  }

  const approve = async (row) => {
    if (actionBusy) return
    setActionBusy(row.id)
    setActionKind('approve')
    try {
      const res = await adjustmentsAPI.approve(row.id, {
        approved_by: user?.name || 'Manager',
        ref_number: row.ref_number,
      })
      if (res.already_processed) {
        toast.success(`${row.ref_number} was already approved`)
      } else {
        toast.success(`${row.ref_number} approved — stock updated`)
      }
      bumpList()
      deselectRow(row.id)
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error(err.response?.data?.detail || 'Failed to approve')
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
      const res = await adjustmentsAPI.reject(row.id, {
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
      toast.error(err.response?.data?.detail || 'Failed to reject')
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }

  const deleteRequest = (row) => openDeleteConfirm(row)

  const deleteSelected = () => {
    openDeleteConfirm(selectedPending)
  }

  const isRowBusy = (id) => actionBusy === id || (deleteBusy && deleteTargets?.some((r) => r.id === id))

  return (
    <div className="page-container">
      <SectionHeader
        title="Stock Adjustments"
        subtitle="Correct branch stock with manager approval — same control as transfers"
      >
        {can('adjustments.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ Request Adjustment</button>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          hideExport: true,
          onRefresh: () => {
            setListVersion((v) => v + 1)
            toast.success('List refreshed')
          },
        })} />
      </SectionHeader>


      <div className="" style={{ alignItems: 'start' }}>
        <div>
          <Tabs tabs={tabs} active={tab} onChange={(t) => { setTab(t); setSkip(0) }} />
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
                {selectedCount} pending adjustment{selectedCount > 1 ? 's' : ''} selected
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
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Loading adjustments…
              </div>
            ) : requests.length === 0 ? (
              <EmptyState icon="⚖" title="No requests" desc="No adjustment requests match this filter" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    {canDelete && (
                      <th style={{ width: 36 }}>
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label="Select all pending adjustments on this page"
                          checked={allPendingSelected}
                          disabled={selectablePending.length === 0 || deleteBusy || !!actionBusy}
                          onChange={toggleSelectAllPending}
                        />
                      </th>
                    )}
                    <SortableHeader label="Adjustment #" sortKey="ref_number" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                    <SortableHeader label="Branch" sortKey="branch_name" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                    <th>Item</th>
                    <th>Qty change</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                    <SortableHeader label="Requested" sortKey="created_at" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                    <th>{resolvedColumnLabel(tab)}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      {canDelete && (
                        <td>
                          {r.status === 'pending' ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.ref_number}`}
                              checked={selectedIds.has(r.id)}
                              disabled={deleteBusy || !!actionBusy}
                              onChange={() => toggleSelect(r.id)}
                            />
                          ) : null}
                        </td>
                      )}
                      <td><span className="mono" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>{r.ref_number}</span></td>
                      <td style={{ fontSize: 13 }}>{r.branch_name || r.branch_id}</td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{r.item_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.reason}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.before_qty} → <strong>{r.new_qty}</strong>
                        <span style={{ color: (r.delta || 0) >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 6 }}>
                          ({(r.delta || 0) >= 0 ? '+' : ''}{r.delta ?? (r.new_qty - r.before_qty)})
                        </span>
                      </td>
                      <td>
                        <Chip
                          status={r.status === 'approved' ? 'active' : r.status === 'pending' ? 'pending' : 'draft'}
                          label={r.status?.charAt(0).toUpperCase() + r.status?.slice(1)}
                        />
                      </td>
                      <td>
                        <PersonWhen name={r.requested_by} at={r.requested_at || r.created_at} />
                      </td>
                      <td>
                        {r.status === 'pending' ? (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                        ) : (
                          <PersonWhen
                            name={r.resolved_by || r.approved_by || r.rejected_by}
                            at={r.resolved_at}
                          />
                        )}
                      </td>
                      <td className="text-right">
                        <RowActionsMenu
                          busy={!!actionBusy || deleteBusy}
                          ariaLabel={`Actions for ${r.ref_number}`}
                          actions={[
                            {
                              label: 'View details',
                              disabled: isRowBusy(r.id),
                              onClick: () => setShowDetail(r),
                            },
                            {
                              label: 'Activity',
                              hidden: !canActivity,
                              disabled: isRowBusy(r.id),
                              onClick: () => setActivityTarget({ recordType: 'stock_adjustment', recordId: r.id, title: `Adjustment ${r.ref_number || r.id}` }),
                            },
                            {
                              label: actionKind === 'approve' && isRowBusy(r.id) ? 'Approving…' : 'Approve',
                              hidden: r.status !== 'pending' || !can('adjustments.approve'),
                              disabled: isRowBusy(r.id),
                              onClick: () => approve(r),
                            },
                            {
                              label: actionKind === 'reject' && isRowBusy(r.id) ? 'Rejecting…' : 'Reject',
                              danger: true,
                              hidden: r.status !== 'pending' || !can('adjustments.approve'),
                              disabled: isRowBusy(r.id),
                              onClick: () => reject(r),
                            },
                            {
                              label: actionKind === 'delete' && isRowBusy(r.id) ? 'Deleting…' : 'Delete',
                              danger: true,
                              hidden: r.status !== 'pending' || !canDelete,
                              disabled: isRowBusy(r.id) || deleteBusy || !!actionBusy,
                              onClick: () => deleteRequest(r),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={listTotal}
              skip={skip}
              limit={limit}
              onSkipChange={setSkip}
              onLimitChange={(n) => { setLimit(n); setSkip(0) }}
              disabled={listLoading}
            />
          </Card>
        </div>
      </div>

      <Modal open={showNew} onClose={() => { if (!submitting) { setShowNew(false); setPickedItem(null) } }} title="New Stock Adjustment Request" icon="⚖" size="md" busy={submitting}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowNew(false)} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={submitNew} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </>}>
        <FormRow>
          <FormGroup label="Branch">
            <AutocompleteDropdown
              value={newForm.branch_id}
              onChange={(v) => {
                setPickedItem(null)
                setNewForm((f) => ({
                  ...f,
                  branch_id: v,
                  item_id: '',
                  batch_id: '',
                  new_qty: '',
                }))
              }}
              fetchUrl={AUTOCOMPLETE_BRANCH_URL}
              fetchParams={{ retail_only: true }}
              isSearchFieldRequired={false}
            />
          </FormGroup>
          <FormGroup label="Item" required>
            <AutocompleteDropdown
              value={newForm.item_id}
              fetchUrl={AUTOCOMPLETE_ITEM_URL}
              fetchParams={{ branch_id: newForm.branch_id, listed_only: true }}
              isSearchFieldRequired
              placeholder="Select item…"
              searchPlaceholder="Search by name, SKU, or barcode…"
              emptyLabel="No items at this branch"
              selectedLabel={picked?.name ? `${picked.name} — stock ${picked.available_stock ?? 0}` : undefined}
              onSelectOption={(opt) => {
                const raw = opt?.raw
                setPickedItem(raw ? {
                  id: raw.id,
                  name: raw.name,
                  available_stock: raw.available_stock ?? 0,
                  batch_tracking: raw.batch_tracking,
                  expiry_tracking: raw.expiry_tracking,
                } : null)
                setNewForm((f) => ({
                  ...f,
                  item_id: opt?.id || '',
                  batch_id: '',
                  new_qty: raw ? String(raw.available_stock ?? 0) : '',
                }))
              }}
              disabled={submitting || !newForm.branch_id}
            />
          </FormGroup>
        </FormRow>

        {picked?.batch_tracking && (
          <div style={{ marginBottom: 12 }}>
            <div className="form-label" style={{ marginBottom: 6 }}>Target batch (optional)</div>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 200, overflowY: 'auto' }}>
              <table className="data-table" style={{ marginBottom: 0 }}>
                <tbody>
                  <tr
                    style={{ cursor: 'pointer', background: !newForm.batch_id ? 'rgba(79,142,247,.08)' : undefined }}
                    onClick={() => setNewForm((f) => ({ ...f, batch_id: '', new_qty: String(picked.available_stock ?? 0) }))}
                  >
                    <td style={{ width: 30 }}><input type="radio" readOnly checked={!newForm.batch_id} /></td>
                    <td colSpan={2} style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>Aggregate ({trackingLabel(picked)})</td>
                    <td className="text-right mono">{picked.available_stock ?? 0}</td>
                  </tr>
                  {adjLoading ? (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: 12 }}>Loading batches…</td></tr>
                  ) : adjBatches.map((b) => (
                    <tr
                      key={b.id}
                      style={{ cursor: 'pointer', background: newForm.batch_id === b.id ? 'rgba(79,142,247,.08)' : undefined }}
                      onClick={() => setNewForm((f) => ({ ...f, batch_id: b.id, new_qty: String(b.quantity) }))}
                    >
                      <td><input type="radio" readOnly checked={newForm.batch_id === b.id} /></td>
                      <td className="mono" style={{ fontSize: 12 }}>{b.batchNumber}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.expiryDate ? fmtDate(b.expiryDate) : '—'}</td>
                      <td className="text-right mono">{b.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <FormGroup label="New quantity (physical count)" required>
          <input
            className="form-input"
            type="number"
            min={0}
            value={newForm.new_qty}
            onChange={(e) => setNewForm((f) => ({ ...f, new_qty: e.target.value }))}
          />
        </FormGroup>
        <FormGroup label="Reason">
          <AutocompleteDropdown
            value={newForm.reason}
            onChange={(v) => setNewForm((f) => ({ ...f, reason: v }))}
            options={REASONS.map((r) => ({ id: r, label: r }))}
            isSearchFieldRequired={false}
          />
        </FormGroup>
        <FormGroup label="Notes">
          <textarea
            className="form-input"
            style={{ height: 60 }}
            value={newForm.notes}
            onChange={(e) => setNewForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Optional context for the approver"
          />
        </FormGroup>
      </Modal>

      <Modal
        open={!!showDetail}
        onClose={() => !actionBusy && !deleteBusy && setShowDetail(null)}
        title={showDetail ? `Adjustment — ${showDetail.ref_number}` : 'Adjustment Request'}
        icon="⚖"
        size="md"
        footer={showDetail?.status === 'pending' && (can('adjustments.approve') || canDelete) ? (
          <>
            {canDelete && (
              <button
                className="btn btn-secondary"
                style={{ marginRight: 'auto', color: 'var(--red)' }}
                onClick={() => deleteRequest(showDetail)}
                disabled={!!actionBusy || deleteBusy}
              >
                Delete
              </button>
            )}
            {can('adjustments.approve') && (
              <>
                <button
                  className="btn btn-secondary"
                  onClick={() => reject(showDetail)}
                  disabled={!!actionBusy}
                >
                  {actionKind === 'reject' && actionBusy === showDetail.id ? 'Rejecting…' : 'Reject'}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => approve(showDetail)}
                  disabled={!!actionBusy}
                >
                  {actionKind === 'approve' && actionBusy === showDetail.id ? 'Approving…' : 'Approve'}
                </button>
              </>
            )}
          </>
        ) : (
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
        )}>
        {showDetail && (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>
              <div style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Adjustment #
                </span>
                <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)', marginTop: 2 }}>
                  {showDetail.ref_number}
                </div>
              </div>
              <div><strong>Branch:</strong> {showDetail.branch_name}</div>
              <div><strong>Item:</strong> {showDetail.item_name}</div>
              <div><strong>Quantity:</strong> {showDetail.before_qty} → {showDetail.new_qty} ({showDetail.delta >= 0 ? '+' : ''}{showDetail.delta})</div>
              <div><strong>Reason:</strong> {showDetail.reason}</div>
              {showDetail.notes && <div><strong>Notes:</strong> {showDetail.notes}</div>}
              {showDetail.batch_id && <div><strong>Batch target:</strong> <span className="mono">{showDetail.batch_id}</span></div>}
              <div style={{ marginTop: 8 }}>
                <strong>Status:</strong>{' '}
                <Chip
                  status={showDetail.status === 'approved' ? 'active' : showDetail.status === 'pending' ? 'pending' : 'draft'}
                  label={showDetail.status?.charAt(0).toUpperCase() + showDetail.status?.slice(1)}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ padding: '12px 14px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  Requested
                </div>
                <PersonWhen name={showDetail.requested_by} at={showDetail.requested_at || showDetail.created_at} />
              </div>
              <div style={{ padding: '12px 14px', background: 'var(--bg-raised)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                  {showDetail.status === 'approved' ? 'Approved' : showDetail.status === 'rejected' ? 'Rejected' : 'Resolution'}
                </div>
                {showDetail.status === 'pending' ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Awaiting manager approval</span>
                ) : (
                  <PersonWhen
                    name={showDetail.resolved_by || showDetail.approved_by || showDetail.rejected_by}
                    at={showDetail.resolved_at}
                  />
                )}
              </div>
            </div>
            {showDetail.rejection_notes && (
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <strong>Rejection notes:</strong> {showDetail.rejection_notes}
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={!!deleteTargets?.length}
        onClose={closeDeleteConfirm}
        title="Delete adjustments"
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
                ? 'This will permanently remove the following pending adjustment:'
                : `This will permanently remove ${deleteTargets.length} pending adjustments:`}
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
                    <th>Adjustment #</th>
                    <th>Item</th>
                    <th>Branch</th>
                  </tr>
                </thead>
                <tbody>
                  {deleteTargets.map((r) => (
                    <tr key={r.id}>
                      <td className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                        {r.ref_number}
                      </td>
                      <td style={{ fontSize: 13 }}>{r.item_name}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.branch_name || r.branch_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AlertBar type="amber" icon="⚠️">
              This action cannot be undone. Approved and rejected adjustments are not affected.
            </AlertBar>
          </>
        )}
      </Modal>
      <ActivityDrawer
        open={!!activityTarget}
        onClose={() => setActivityTarget(null)}
        recordType={activityTarget?.recordType}
        recordId={activityTarget?.recordId}
        title={activityTarget?.title}
      />
    </div>
  )
}

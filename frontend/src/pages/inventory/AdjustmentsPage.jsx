import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import toast from 'react-hot-toast'
import { adjustmentsAPI, itemsAPI, summariesAPI, AUTOCOMPLETE_BRANCH_URL } from '@/api'
import { useCan } from '@/auth/permissions'
import { useAppStore, usePOSStore, subscribeToBranchChanged } from '@/store'
import ActivityDrawer from '@/components/activity/ActivityDrawer'
import {
  SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow,
  EmptyState, AlertBar, PaginationBar, SortableHeader, TableLoadingPanel, AutocompleteDropdown,
  PageActionsMenu, buildListPageMenuActions,
  CustomizeColumnsModal, ColumnPrefsTrigger, ColumnPrefsSpacer,
} from '@/components/ui'
import { DEFAULT_PAGE_SIZE, fetchAllList, unwrapPaged } from '@/utils/pagination'
import { EXPORT_PAGE_SIZE_SAFE } from '@/utils/listExport'
import { downloadListPdf } from '@/utils/documentPdf'
import { tabsWithCounts } from '@/utils/moduleSummary'
import { exportToExcel, fmtDate, fmtDateTime, fmtQty, formatLabel } from '@/utils/helpers'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { tableRowClickProps } from '@/utils/tableRowClick'
import useColumnPrefs from '@/hooks/useColumnPrefs'
import ListFilters, { EMPTY_LIST_FILTERS } from '@/pages/sales/ListFilters'
import { getChildCounterBranch, getConfiguredChildCounters } from '@/utils/childCounters'
import RowActionsMenu from './RowActionsMenu'
import AdjustmentDetailPanel from './AdjustmentDetailPanel'
import { NOT_SET, NOT_APPLICABLE } from '@/utils/emptyValue'
import InventoryItemPicker from '@/pages/sales/InventoryItemPicker'

// In-flight request cache to avoid duplicate identical fetches across
// remounts (helps reduce dev StrictMode double-calls showing in Network).
const inFlightAdjustmentsRequests = new Map()

const TAB_DEFS = [
  { id: 'all',      label: 'All' },
  { id: 'draft',    label: 'Draft' },
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
const STATUS_FILTER_OPTIONS = TAB_DEFS
  .filter((tab) => tab.id !== 'all')
  .map(({ id, label }) => ({ id, label }))
const REASON_FILTER_OPTIONS = REASONS.map((reason) => ({ id: reason, label: reason }))

function resolvedColumnLabel(tab) {
  if (tab === 'approved') return 'Approved'
  if (tab === 'rejected') return 'Rejected'
  if (tab === 'pending') return 'Resolution'
  return 'Approved / Rejected'
}

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

export default function AdjustmentsPage() {
  const can = useCan()
  const columnPrefs = useColumnPrefs('adjustments.list')
  const user = useAppStore((s) => s.user)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const branches = useAppStore((s) => s.branches)
  const selectedChildCounter = usePOSStore((s) => s.selectedChildCounter)
  const adjustmentLineId = useRef(0)
  const emptyAdjustmentLine = () => ({
    key: ++adjustmentLineId.current,
    item: null,
    batch_id: '',
    new_qty: '',
    batches: [],
    batch_loading: false,
  })
  const [activityTarget, setActivityTarget] = useState(null)
  const [tab, setTab] = useState('all')
  const [requests, setRequests] = useState([])
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [reasonFilter, setReasonFilter] = useState('')
  const [listTotal, setListTotal] = useState(0)
  const [summary, setSummary] = useState(null)
  const [listVersion, setListVersion] = useState(0)
  const [listLoading, setListLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [showDetail, setShowDetail] = useState(null)
  const [skip, setSkip] = useState(0)
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE)
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const childCounterId = usePOSStore((s) => s.selectedChildCounter)
  const [newForm, setNewForm] = useState({
    branch_id: activeBranch?.id || 'br-001',
    child_counter_id: '',
    child_counter_name: '',
    items: [emptyAdjustmentLine()],
    reason: 'Physical count',
    notes: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionKind, setActionKind] = useState(null)
  const [pdfExportBusy, setPdfExportBusy] = useState(false)
  const [excelExportBusy, setExcelExportBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleteTargets, setDeleteTargets] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const selectAllRef = useRef(null)

  const canDelete = can('adjustments.delete')
  const canActivity = can('history.view', 'comments.view')

  const bumpList = useCallback(() => setListVersion((v) => v + 1), [])

  useEffect(() => {
    const key = `${tab}|${activeBranch?.id || ''}|${childCounterId}|${search}|${dateFrom}|${dateTo}|${reasonFilter}|${skip}|${limit}|${sortBy}|${sortOrder}|${listVersion}`
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
              branch_id: activeBranch?.id || undefined,
              child_counter_id: childCounterId || undefined,
              search: search.trim() || undefined,
              date_from: dateFrom || undefined,
              date_to: dateTo || undefined,
              reason: reasonFilter || undefined,
            }),
            summariesAPI.get('adjustments', {
              branch_id: activeBranch?.id || undefined,
              child_counter_id: childCounterId || undefined,
            }),
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
  }, [tab, activeBranch?.id, childCounterId, search, dateFrom, dateTo, reasonFilter, skip, limit, sortBy, sortOrder, listVersion])

  // Re-fetch list when active branch changes; also update newForm.branch_id
  useEffect(() => {
    const unsub = subscribeToBranchChanged((newBranch) => {
      setNewForm((f) => ({
        ...f,
        branch_id: newBranch?.id || 'br-001',
        child_counter_id: '',
        child_counter_name: '',
      }))
      setSelectedIds(new Set())
      setSkip(0)
      setListVersion((v) => v + 1)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    setSkip(0)
    setSelectedIds(new Set())
  }, [childCounterId])

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
    for (const row of deleteTargets) {
      try {
        await adjustmentsAPI.delete(row.id, { ref_number: row.ref_number })
        ok += 1
      } catch (err) {
        fail += 1
        console.error(err)
      }
    }
    if (ok > 0) {
      toast.success(`${ok} adjustment${ok > 1 ? 's' : ''} deleted`)
    }
    if (fail > 1) toast.error(`${fail} adjustments could not be deleted`)
    setDeleteTargets(null)
    setSelectedIds(new Set())
    setShowDetail(null)
    bumpList()
    setDeleteBusy(false)
    setActionKind(null)
  }

  const updateAdjustmentLine = (lineKey, update) => setNewForm((form) => ({
    ...form,
    items: form.items.map((line) => line.key === lineKey ? update(line) : line),
  }))

  const loadBatches = async (lineKey, itemId, branchId) => {
    updateAdjustmentLine(lineKey, (line) => ({ ...line, batch_loading: true }))
    try {
      const data = await itemsAPI.batches.list(itemId, { branch_id: branchId })
      updateAdjustmentLine(lineKey, (line) => line.item?.id === itemId
        ? { ...line, batches: data?.items || [], batch_loading: false }
        : line)
    } catch (err) {
      console.error('Failed to load adjustment item batches:', err)
      updateAdjustmentLine(lineKey, (line) => line.item?.id === itemId
        ? { ...line, batches: [], batch_loading: false }
        : line)
      toast.error('Failed to load item batches')
    }
  }

  const onSort = (key) => {
    setSkip(0)
    if (sortBy === key) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    else { setSortBy(key); setSortOrder('desc') }
  }

  const tabs = useMemo(() => tabsWithCounts(TAB_DEFS, summary), [summary])

  const submitNew = async () => {
    if (submitting) return
    const lines = newForm.items.filter((line) => line.item)
    if (lines.length === 0) { toast.error('Add at least one item'); return }
    const duplicateItem = lines.find((line, index) => (
      lines.findIndex((other) => other.item.id === line.item.id) !== index
    ))
    if (duplicateItem) { toast.error(`${duplicateItem.item.name} is selected more than once`); return }
    for (const line of lines) {
      if (line.new_qty === '' || line.new_qty === null) {
        toast.error(`Enter the new quantity for ${line.item.name}`)
        return
      }
      if (!Number.isFinite(Number(line.new_qty)) || Number(line.new_qty) < 0) {
        toast.error(`Enter a valid new quantity for ${line.item.name}`)
        return
      }
      if (line.batch_loading) {
        toast.error(`Wait for batches to load for ${line.item.name}`)
        return
      }
    }
    const selectedBranch = getChildCounterBranch(branches, newForm.branch_id, activeBranch)
    const selectedCounter = getConfiguredChildCounters(selectedBranch).find(
      (counter) => String(counter.id) === String(selectedChildCounter),
    )
    if (getConfiguredChildCounters(selectedBranch).length > 0 && !selectedCounter) {
      toast.error('Select a counter from the top toolbar before creating an adjustment')
      return
    }
    setSubmitting(true)
    try {
      const res = await adjustmentsAPI.createBulk({
        branch_id: newForm.branch_id,
        child_counter_id: selectedCounter?.id || null,
        child_counter_name: selectedCounter?.name || null,
        items: lines.map((line) => ({
          item_id: line.item.id,
          item_name: line.item.name,
          new_qty: Number(line.new_qty),
          batch_id: line.batch_id || undefined,
        })),
        reason: newForm.reason,
        notes: newForm.notes || undefined,
        requested_by: user?.name || 'Staff',
      })
      const approved = res.items.every((item) => item.status === 'approved')
      toast.success(approved
        ? `${res.items.length} adjustment${res.items.length === 1 ? '' : 's'} applied`
        : `${res.items.length} adjustment${res.items.length === 1 ? '' : 's'} submitted for approval`)
      setShowNew(false)
      setNewForm({
        branch_id: activeBranch?.id || 'br-001',
        child_counter_id: '',
        child_counter_name: '',
        items: [emptyAdjustmentLine()],
        reason: 'Physical count',
        notes: '',
      })
      bumpList()
    } catch (err) {
      console.error(err)
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
      await adjustmentsAPI.submit(row.id, { ref_number: row.ref_number })
      toast.success(`${row.ref_number} submitted for approval`)
      bumpList()
      setShowDetail(null)
    } catch (err) {
      console.error(err)
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

  const exportAdjustmentsExcel = async () => {
    if (pdfExportBusy || excelExportBusy) return
    setExcelExportBusy(true)
    try {
      const rows = await fetchAllList((params) => adjustmentsAPI.list({
        ...params,
        branch_id: activeBranch?.id || undefined,
        child_counter_id: childCounterId || undefined,
        status: tab === 'all' ? undefined : tab,
        search: search.trim() || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        reason: reasonFilter || undefined,
        sort_by: sortBy,
        sort_order: sortOrder,
      }), {}, EXPORT_PAGE_SIZE_SAFE)
      if (!rows.length) {
        toast.error('No adjustments found for the selected status')
        return
      }
      const columns = [
        'Adjustment #', 'Branch', 'Counter', 'Item', 'Reason', 'Before quantity',
        'New quantity', 'Change', 'Status', 'Requested by', 'Requested date',
        'Resolved by', 'Resolved date', 'Notes',
      ]
      const exportRows = rows.map((request) => ({
        'Adjustment #': request.ref_number || '',
        Branch: request.branch_name || request.branch_id || '',
        Counter: request.child_counter_name || NOT_SET,
        Item: request.item_name || '',
        Reason: request.reason || '',
        'Before quantity': Number(request.before_qty ?? 0),
        'New quantity': Number(request.new_qty ?? 0),
        Change: Number(request.delta ?? (Number(request.new_qty || 0) - Number(request.before_qty || 0))),
        Status: formatLabel(request.status),
        'Requested by': request.requested_by || '',
        'Requested date': request.requested_at || request.created_at || '',
        'Resolved by': request.resolved_by || request.approved_by || request.rejected_by || '',
        'Resolved date': request.resolved_at || '',
        Notes: request.notes || request.rejection_notes || '',
      }))
      exportToExcel(
        exportRows,
        `Stock_Adjustments_${new Date().toISOString().split('T')[0]}.xlsx`,
        columns,
      )
      toast.success(`Exported ${rows.length} adjustment${rows.length === 1 ? '' : 's'}`)
    } catch (error) {
      console.error('Failed to export adjustments Excel:', error)
      toast.error(error?.response?.data?.detail || error?.message || 'Excel export failed')
    } finally {
      setExcelExportBusy(false)
    }
  }

  const exportAdjustmentsPdf = async () => {
    if (pdfExportBusy || excelExportBusy) return
    setPdfExportBusy(true)
    try {
      const rows = await fetchAllList((params) => adjustmentsAPI.list({
        ...params,
        branch_id: activeBranch?.id || undefined,
        child_counter_id: childCounterId || undefined,
        status: tab === 'all' ? undefined : tab,
        search: search.trim() || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        reason: reasonFilter || undefined,
        sort_by: sortBy,
        sort_order: sortOrder,
      }), {}, EXPORT_PAGE_SIZE_SAFE)
      if (!rows.length) {
        toast.error('No adjustments found for the selected status')
        return
      }
      const columns = ['Adjustment #', 'Branch', 'Item', 'Reason', 'Before quantity', 'New quantity', 'Change', 'Status', 'Requested by', 'Date']
      const pdfRows = rows.map((request) => [
        request.ref_number || '',
        request.branch_name || request.branch_id || '',
        request.item_name || '',
        request.reason || '',
        fmtQty(request.before_qty),
        fmtQty(request.new_qty),
        fmtQty(request.delta ?? (Number(request.new_qty || 0) - Number(request.before_qty || 0))),
        formatLabel(request.status),
        request.requested_by || '',
        request.created_at || '',
      ])
      await downloadListPdf('Stock Adjustments', columns, pdfRows, activeBranch)
    } catch (error) {
      console.error('Failed to export adjustments PDF:', error)
      toast.error(error?.response?.data?.detail || error?.message || 'PDF export failed')
    } finally {
      setPdfExportBusy(false)
    }
  }

  return (
    <div className="page-container">
      <SectionHeader
        title="Stock Adjustments"
        subtitle="Correct branch stock with manager approval — same control as transfers"
      >
        {can('adjustments.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ Request Adjustment</button>
        )}
      </SectionHeader>

      <ListFilters
        search={search}
        onSearchChange={(value) => {
          setSearch(value)
          setSkip(0)
        }}
        searchPlaceholder="Search adjustment number, item, branch, or requester…"
        toolbarActions={<PageActionsMenu actions={buildListPageMenuActions({
          onExport: exportAdjustmentsExcel,
          exportLabel: excelExportBusy ? 'Preparing Excel…' : 'Export Excel',
          exportDisabled: excelExportBusy || pdfExportBusy,
          onExportPdf: exportAdjustmentsPdf,
          exportPdfLabel: pdfExportBusy ? 'Generating PDF…' : 'Export PDF',
          exportPdfDisabled: pdfExportBusy || excelExportBusy,
        })} />}
        fields={['status', 'date', 'reason']}
        statusOptions={STATUS_FILTER_OPTIONS}
        reasonOptions={REASON_FILTER_OPTIONS}
        filters={{
          ...EMPTY_LIST_FILTERS,
          status: tab === 'all' ? '' : tab,
          dateFrom,
          dateTo,
          reason: reasonFilter,
        }}
        onApply={(next) => {
          setTab(next.status || 'all')
          setDateFrom(next.dateFrom || '')
          setDateTo(next.dateTo || '')
          setReasonFilter(next.reason || '')
          setSkip(0)
        }}
        onClear={() => {
          setTab('all')
          setDateFrom('')
          setDateTo('')
          setReasonFilter('')
          setSkip(0)
        }}
        onRemoveChip={(key) => {
          if (key === 'status') setTab('all')
          if (key === 'date') {
            setDateFrom('')
            setDateTo('')
          }
          if (key === 'reason') setReasonFilter('')
          setSkip(0)
        }}
      />

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
              <TableLoadingPanel label="Loading adjustments…" />
            ) : requests.length === 0 ? (
              <EmptyState icon="⚖" title="No requests" desc="No adjustment requests match this filter" />
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
                          aria-label="Select all pending adjustments on this page"
                          checked={allPendingSelected}
                          disabled={selectablePending.length === 0 || deleteBusy || !!actionBusy}
                          onChange={toggleSelectAllPending}
                        />
                      </th>
                    )}
                    {columnPrefs.visibleIds.map((id) => {
                      if (id === 'ref_number') {
                        return <SortableHeader key={id} label="Adjustment #" sortKey="ref_number" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                      }
                      if (id === 'branch') {
                        return <SortableHeader key={id} label="Branch" sortKey="branch_name" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                      }
                      if (id === 'counter') return <th key={id}>Counter</th>
                      if (id === 'item') return <th key={id}>Item</th>
                      if (id === 'qty_change') return <th key={id}>Qty change</th>
                      if (id === 'status') {
                        return <SortableHeader key={id} label="Status" sortKey="status" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                      }
                      if (id === 'requested') {
                        return <SortableHeader key={id} label="Requested" sortKey="created_at" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
                      }
                      if (id === 'resolved') return <th key={id}>{resolvedColumnLabel(tab)}</th>
                      return null
                    })}
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} {...tableRowClickProps(() => setShowDetail(r))}>
                      <ColumnPrefsSpacer />
                      {canDelete && (
                        <td data-no-row-click>
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
                      {columnPrefs.visibleIds.map((id) => {
                        if (id === 'ref_number') {
                          return <td key={id}><span className="mono" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 600 }}>{r.ref_number}</span></td>
                        }
                        if (id === 'branch') {
                          return <td key={id} style={{ fontSize: 13 }}>{r.branch_name || r.branch_id}</td>
                        }
                        if (id === 'counter') return <td key={id}>{r.child_counter_name || NOT_SET}</td>
                        if (id === 'item') {
                          return (
                            <td key={id}>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{r.item_name}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.reason}</div>
                            </td>
                          )
                        }
                        if (id === 'qty_change') {
                          return (
                            <td key={id} className="mono" style={{ fontSize: 12 }}>
                              {fmtQty(r.before_qty)} → <strong>{fmtQty(r.new_qty)}</strong>
                              <span style={{ color: (r.delta || 0) >= 0 ? 'var(--green)' : 'var(--red)', marginLeft: 6 }}>
                                ({(r.delta || 0) >= 0 ? '+' : ''}{fmtQty(r.delta ?? (r.new_qty - r.before_qty))})
                              </span>
                            </td>
                          )
                        }
                        if (id === 'status') {
                          return (
                            <td key={id}>
                              <Chip
                                status={r.status === 'approved' ? 'active' : r.status === 'pending' ? 'pending' : 'draft'}
                                label={formatLabel(r.status)}
                              />
                            </td>
                          )
                        }
                        if (id === 'requested') {
                          return (
                            <td key={id}>
                              <PersonWhen name={r.requested_by} at={r.requested_at || r.created_at} />
                            </td>
                          )
                        }
                        if (id === 'resolved') {
                          return (
                            <td key={id}>
                              {r.status === 'pending' ? (
                                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{NOT_APPLICABLE}</span>
                              ) : (
                                <PersonWhen
                                  name={r.resolved_by || r.approved_by || r.rejected_by}
                                  at={r.resolved_at}
                                />
                              )}
                            </td>
                          )
                        }
                        return null
                      })}
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
                              label: actionKind === 'submit' && isRowBusy(r.id) ? 'Submitting…' : 'Submit for approval',
                              hidden: r.status !== 'draft' || !can('adjustments.create'),
                              disabled: isRowBusy(r.id),
                              onClick: () => submit(r),
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
                              hidden: !['draft', 'pending'].includes(r.status) || !canDelete,
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

      <CustomizeColumnsModal
        open={columnPrefs.customizeOpen}
        onClose={columnPrefs.closeCustomize}
        defs={columnPrefs.defs}
        value={columnPrefs.prefs}
        onSave={columnPrefs.savePrefs}
      />

      <Modal open={showNew} onClose={() => { if (!submitting) setShowNew(false) }} title="New Stock Adjustment Request" icon="⚖" size="xl" busy={submitting}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowNew(false)} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={submitNew} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit Request'}
          </button>
        </>}>
        <FormRow>
          <FormGroup label="Branch">
            <AutocompleteDropdown
              value={newForm.branch_id}
              onChange={(v) => {
                setNewForm((f) => ({
                  ...f,
                  branch_id: v,
                  child_counter_id: '',
                  child_counter_name: '',
                  items: [emptyAdjustmentLine()],
                }))
              }}
              fetchUrl={AUTOCOMPLETE_BRANCH_URL}
              fetchParams={{ retail_only: true }}
              isSearchFieldRequired={false}
            />
          </FormGroup>
        </FormRow>
        <div style={{ margin: '4px 0 16px' }}>
          <div className="form-label" style={{ marginBottom: 8 }}>Items to adjust</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: 720, marginBottom: 8 }}>
              <thead>
                <tr>
                  <th style={{ width: 42 }}>#</th>
                  <th>Item</th>
                  <th style={{ width: 150 }}>New physical quantity</th>
                  <th style={{ width: 260 }}>Target batch</th>
                  <th style={{ width: 44 }} />
                </tr>
              </thead>
              <tbody>
                {newForm.items.map((line, index) => {
                  const excludeIds = newForm.items
                    .filter((other) => other.key !== line.key && other.item)
                    .map((other) => other.item.id)
                  return (
                    <tr key={line.key} style={{ verticalAlign: 'top' }}>
                      <td className="mono">{String(index + 1).padStart(2, '0')}</td>
                      <td style={{ minWidth: 250 }}>
                        <InventoryItemPicker
                          branchId={newForm.branch_id}
                          value={line.item ? { id: line.item.id, name: line.item.name } : null}
                          onPick={(item) => {
                            updateAdjustmentLine(line.key, (current) => ({
                              ...current,
                              item,
                              batch_id: '',
                              new_qty: String(Math.max(0, item.available_stock ?? 0)),
                              batches: [],
                            }))
                            if (item.batch_tracking) loadBatches(line.key, item.id, newForm.branch_id)
                          }}
                          onClear={() => updateAdjustmentLine(line.key, (current) => ({
                            ...current,
                            item: null,
                            batch_id: '',
                            new_qty: '',
                            batches: [],
                            batch_loading: false,
                          }))}
                          excludeIds={excludeIds}
                          disabled={submitting || !newForm.branch_id}
                          portalDropdown
                        />
                      </td>
                      <td>
                        <input
                          className="form-input"
                          type="number"
                          min={0}
                          step={qtyInputStep()}
                          value={line.new_qty}
                          onChange={(event) => updateAdjustmentLine(line.key, (current) => ({
                            ...current,
                            new_qty: event.target.value,
                          }))}
                          disabled={submitting || !line.item}
                          aria-label={`New physical quantity for ${line.item?.name || `item ${index + 1}`}`}
                        />
                      </td>
                      <td>
                        {!line.item?.batch_tracking ? (
                          <span style={{ color: 'var(--text-muted)' }}>Aggregate stock</span>
                        ) : (
                          <select
                            className="form-input"
                            value={line.batch_id}
                            disabled={submitting || line.batch_loading}
                            onChange={(event) => {
                              const batch = line.batches.find((entry) => entry.id === event.target.value)
                              updateAdjustmentLine(line.key, (current) => ({
                                ...current,
                                batch_id: event.target.value,
                                new_qty: batch ? String(Math.max(0, batch.quantity)) : String(Math.max(0, current.item.available_stock ?? 0)),
                              }))
                            }}
                          >
                            <option value="">
                              {line.batch_loading
                                ? 'Loading batches…'
                                : `Aggregate stock (${fmtQty(line.item.available_stock ?? 0)})`}
                            </option>
                            {line.batches.map((batch) => (
                              <option key={batch.id} value={batch.id}>
                                {batch.batchNumber} — {fmtQty(batch.quantity)}
                                {batch.expiryDate ? ` — ${fmtDate(batch.expiryDate)}` : ''}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => setNewForm((form) => ({
                            ...form,
                            items: form.items.length === 1
                              ? [emptyAdjustmentLine()]
                              : form.items.filter((entry) => entry.key !== line.key),
                          }))}
                          disabled={submitting}
                          aria-label={`Remove adjustment item ${index + 1}`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setNewForm((form) => ({ ...form, items: [...form.items, emptyAdjustmentLine()] }))}
            disabled={submitting || newForm.items.length >= 100}
          >
            + Add item
          </button>
        </div>
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

      <AdjustmentDetailPanel
        open={!!showDetail}
        adjustment={showDetail}
        onClose={() => !actionBusy && !deleteBusy && setShowDetail(null)}
        onApprove={approve}
        onReject={reject}
        onDelete={deleteRequest}
        actionBusy={actionBusy}
        deleteBusy={deleteBusy}
        actionKind={actionKind}
      />

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

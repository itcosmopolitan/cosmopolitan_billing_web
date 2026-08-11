import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { itemsAPI, adjustmentsAPI, AUTOCOMPLETE_BRANCH_URL, AUTOCOMPLETE_CATEGORY_URL } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, fmtDate, stockStatus, exportToCSV } from '@/utils/helpers'
import { batchExpiryStatus } from '@/utils/batchExpiry'
import {
  SectionHeader, Card, Tabs, SearchBar, Chip, Modal,
  FormGroup, KPICard, EmptyState, Tag, PaginationBar,
  SortableHeader, AlertBar, ConfirmDialog, AutocompleteDropdown,
  TableLoadingPanel, PageActionsMenu, buildListPageMenuActions,
} from '@/components/ui'
import { DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import { tableRowClickProps } from '@/utils/tableRowClick'
import BatchesModal from './BatchesModal'
import RowActionsMenu from './RowActionsMenu'
import ActivityDrawer from '@/components/activity/ActivityDrawer'

const BRANCH_TABS = [
  { id: 'all',      label: 'All Items' },
  { id: 'low',      label: 'Low Stock' },
  { id: 'expiry',   label: 'Near Expiry' },
  { id: 'inactive', label: 'Inactive' },
]

const MASTER_TABS = [
  { id: 'all',      label: 'All Items' },
  { id: 'pending',  label: 'Pending Approval' },
  { id: 'rejected', label: 'Rejected Items' },
  { id: 'inactive', label: 'Inactive' },
]

// Strategy label / hint used in the stock-adjust modal so the operator
// understands which batches will be touched when they reduce stock without
// picking a specific batch.
const trackingLabel = (item) => {
  if (!item?.batch_tracking) return 'Untracked'
  return item.expiry_tracking ? 'FEFO (nearest expiry first)' : 'FIFO (oldest received first)'
}

export default function ItemsPage({ mode = 'branch' }) {
  const isMaster = mode === 'master'
  const navigate = useNavigate()
  const can = useCan()
  const canActivity = can('history.view', 'comments.view')
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const user = useAppStore((s) => s.user)
  const branchId = activeBranch?.id
  const [tab, setTab]           = useState('all')
  const [search, setSearch]     = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [showAdj, setShowAdj]   = useState(null)
  const [showAdjSelect, setShowAdjSelect] = useState(false)
  const [adjSelectSearch, setAdjSelectSearch] = useState('')
  const [adjQty, setAdjQty]     = useState('')
  const [adjReason, setAdjReason] = useState('Physical count')
  const [adjNotes, setAdjNotes] = useState('')
  const [adjBatches, setAdjBatches] = useState([])      // batch list when adjusting a tracked item
  const [adjBatchId, setAdjBatchId] = useState('')      // selected single-batch id (or '' = aggregate)
  const [adjLoading, setAdjLoading] = useState(false)
  // activity drawer used only in master mode
  const [activityTarget, setActivityTarget] = useState(null)
  const [adjSubmitting, setAdjSubmitting] = useState(false)
  const [batchesModal, setBatchesModal] = useState(null) // item whose batches we're viewing
  const [nearExpiry, setNearExpiry]     = useState([])   // batches expiring within horizon
  const [nearExpiryDays, setNearExpiryDays] = useState(30)
  const [nearExpiryLoading, setNearExpiryLoading] = useState(false)
  const [items, setItems]       = useState([])
  const [itemSkip, setItemSkip] = useState(0)
  const [itemLimit, setItemLimit] = useState(DEFAULT_PAGE_SIZE)
  const [itemSortBy, setItemSortBy] = useState('name')
  const [itemSortOrder, setItemSortOrder] = useState('asc')
  const [loading, setLoading]   = useState(true)
  const [listVersion, setListVersion] = useState(0)
  const [categories, setCategories] = useState([])
  const [confirmAction, setConfirmAction] = useState(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')

  // Client-side sort because the page fetches all items at once via
  // fetchAllList and paginates locally. If/when this switches to true
  // server-side pagination, send sort_by/sort_order in the API call instead
  // (the backend already accepts them — see backend/src/routes/items.py).
  const onSort = (key) => {
    setItemSkip(0)
    if (itemSortBy === key) {
      setItemSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setItemSortBy(key)
    setItemSortOrder('asc')
  }

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true)
      const tabStatus = isMaster
        ? (tab === 'pending' ? 'pending' : tab === 'rejected' ? 'rejected' : tab === 'inactive' ? 'inactive' : undefined)
        : undefined
      const params = isMaster
        ? {
            master_mode: true,
            branch_id: null,
            include_inactive: tab === 'inactive',
            ...(tabStatus ? { status: tabStatus } : {}),
          }
        : { branch_id: branchId, listed_only: tab === 'inactive' ? false : true, include_inactive: tab === 'inactive' }

      const data = await fetchAllList(itemsAPI.list, params)
      setItems(data || [])
    } catch (err) {
      console.error('Failed to fetch items:', err)
      toast.error('Failed to load items')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [branchId, isMaster, tab, listVersion])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  useEffect(() => {
    setItemSkip(0)
  }, [search, catFilter, tab, branchId, isMaster])

  // Refresh the near-expiry roll-up when the relevant filters change. We
  // keep it on a separate effect so toggling tabs doesn't re-fetch the full
  // items list (which is already in memory) just to look at expiries.
  const loadNearExpiry = useCallback(async () => {
    try {
      setNearExpiryLoading(true)
      const data = await itemsAPI.batches.nearExpiry({
        branch_id: branchId,
        within_days: nearExpiryDays,
      })
      setNearExpiry(data?.items || [])
    } catch (err) {
      console.error('Failed to fetch near-expiry batches:', err)
      setNearExpiry([])
    } finally {
      setNearExpiryLoading(false)
    }
  }, [branchId, nearExpiryDays])

  useEffect(() => {
    if (!isMaster) {
      loadNearExpiry()
    }
  }, [loadNearExpiry, isMaster])

  const filtered = useMemo(() => {  // eslint-disable-line react-hooks/exhaustive-deps
    let list = [...items]
    if (search)     list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || (p.sku && p.sku.toLowerCase().includes(search.toLowerCase())) || (p.barcode && p.barcode.includes(search)))
    if (catFilter)  list = list.filter((p) => p.categoryId === catFilter)
    if (tab === 'low' && !isMaster)      list = list.filter((p) => p.available_stock > 0 && p.available_stock <= p.reorder_level)
    if (tab === 'expiry' && !isMaster) {
      // Items that own at least one batch in the near-expiry rollup. The
      // `Near Expiry` table below shows the actual lot rows; this filter
      // just narrows the item table to items the operator should look at.
      const ids = new Set(nearExpiry.map((b) => b.itemId))
      list = list.filter((p) => ids.has(p.id))
    }
    if (tab === 'inactive') list = list.filter((p) => p.active === false)
    if (tab === 'rejected') list = list.filter((p) => (p.status || p.approval_status || 'approved') === 'rejected')
    // Sort: numeric columns sort numerically, everything else string-compare.
    // 'category_id' uses the resolved categoryName for a UX that matches what
    // the user sees in the column.
    const sortKey = itemSortBy
    const dir = itemSortOrder === 'desc' ? -1 : 1
    const numericKeys = new Set(['cost_price', 'selling_price', 'tax_rate', 'reorder_level', 'available_stock'])
    const valueOf = (row) => {
      if (sortKey === 'category_id') return row.categoryName || ''
      const v = row[sortKey]
      if (v == null) return numericKeys.has(sortKey) ? 0 : ''
      return v
    }
    list.sort((a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (numericKeys.has(sortKey)) return (Number(av) - Number(bv)) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
    return list
  }, [items, search, catFilter, tab, itemSortBy, itemSortOrder, nearExpiry, isMaster])

  const pageRows = useMemo(() => {
    return filtered.slice(itemSkip, itemSkip + itemLimit)
  }, [filtered, itemSkip, itemLimit])

  const totals = useMemo(() => {
    if (isMaster) {
      const listed = items.reduce((sum, p) => sum + (p.available_branch_count || 0), 0)
      const approvedCount = items.filter((p) => (p.status || p.approval_status || 'approved') === 'approved').length
      return {
        items: approvedCount,
        rejected: items.filter((p) => (p.status || p.approval_status || 'approved') === 'rejected').length,
        tracked: items.filter((p) => p.batch_tracking).length,
        avgBranches: items.length ? Math.round(listed / items.length) : 0,
      }
    }
    return {
      items:    items.length,
      low:      items.filter((p) => p.available_stock > 0 && p.available_stock <= p.reorder_level).length,
      outStock: items.filter((p) => p.available_stock === 0).length,
      stockVal: items.reduce((sum, p) => sum + (p.available_stock || 0) * (p.cost_price || 0), 0),
      tracked:  items.filter((p) => p.batch_tracking).length,
      expiring: nearExpiry.length,
    }
  }, [items, nearExpiry, isMaster])

  const openEdit = (item) => {
    navigate(`/item-master/${item.id}/edit`)
  }

  const [itemActionBusy, setItemActionBusy] = useState(null)
  const [showDetail, setShowDetail] = useState(null)
  const [actionKind, setActionKind] = useState(null)

  const approveItem = async (item) => {
    if (itemActionBusy) return
    setItemActionBusy(item.id)
    try {
      await itemsAPI.approve(item.id)
      toast.success(`${item.name} approved`)
      await fetchItems()
    } catch (err) {
      console.error(err)
      toast.error('Failed to approve item')
    } finally {
      setItemActionBusy(null)
    }
  }

  const rejectItem = async (item) => {
    if (itemActionBusy) return
    setItemActionBusy(item.id)
    try {
      await itemsAPI.reject(item.id, { reason: rejectReason.trim() })
      toast.success(`${item.name} rejected`)
      setRejectTarget(null)
      setRejectReason('')
      await fetchItems()
    } catch (err) {
      console.error(err)
      toast.error('Failed to reject item')
    } finally {
      setItemActionBusy(null)
    }
  }

  const approveFromDetail = async () => {
    if (!showDetail) return
    setActionKind('approve')
    await approveItem(showDetail)
    setActionKind(null)
    setShowDetail(null)
  }

  const openRejectFromDetail = () => {
    if (!showDetail) return
    setRejectTarget(showDetail)
    setRejectReason('')
  }

  // Open the stock adjustment modal. For batch-tracked items we lazily fetch
  // the live batch list so the operator can pick a specific lot — defaulting
  // to "aggregate" which routes through FIFO/FEFO on the backend.
  const openAdj = async (item) => {
    setShowAdj(item)
    setAdjQty(item.available_stock || 0)
    setAdjReason('Physical count')
    setAdjNotes('')
    setAdjBatchId('')
    setAdjBatches([])
    if (item.batch_tracking) {
      try {
        setAdjLoading(true)
        const data = await itemsAPI.batches.list(item.id, { branch_id: branchId })
        setAdjBatches(data?.items || [])
      } catch (err) {
        console.error('Failed to fetch batches:', err)
        toast.error('Could not load batches for this item')
      } finally {
        setAdjLoading(false)
      }
    }
  }

  const saveAdj = async () => {
    if (adjSubmitting) return
    if (adjQty === '' || adjQty === null) { toast.error('Enter adjusted quantity'); return }
    if (!can('adjustments.create')) {
      toast.error('You do not have permission to request stock adjustments')
      return
    }
    setAdjSubmitting(true)
    try {
      const res = await adjustmentsAPI.create({
        branch_id: branchId,
        item_id: showAdj.id,
        item_name: showAdj.name,
        new_qty: Number(adjQty),
        reason: adjReason,
        notes: adjNotes || undefined,
        batch_id: adjBatchId || undefined,
        requested_by: user?.name || 'Staff',
      })
      toast.success(
        res.status === 'approved'
          ? `Adjustment ${res.ref_number} applied for ${showAdj.name}`
          : `Adjustment ${res.ref_number} submitted for approval`,
      )
      await fetchItems()
      setShowAdj(null)
    } catch (err) {
      console.error('Failed to submit adjustment request:', err)
      toast.error('Failed to submit adjustment request')
    } finally {
      setAdjSubmitting(false)
    }
  }

  const handleConfirmAction = async () => {
    if (!confirmAction) return
    setActionBusy(true)
    try {
      const { type, item } = confirmAction
      if (type === 'delete') {
        // Master page must perform a global delete (no branch_id param).
        // Branch-mode (Items & Stock) should pass branch_id to delete only that branch data.
        if (isMaster) {
          await itemsAPI.delete(item.id)
        } else {
          await itemsAPI.delete(item.id, { branch_id: branchId })
          // Notify any open Item Master edit page to remove this branch row
          try {
            window.dispatchEvent(new CustomEvent('item-branch-removed', {
              detail: { item_id: item.id, branch_id: branchId },
            }))
          } catch (e) {
            // ignore in environments where window/custom events are unavailable
          }
        }
        toast.success(`Deleted ${item.name}`)
      } else {
        // Pass current branch in body for branch-specific deactivate/reactivate check
        await itemsAPI.patch(item.id, { 
          active: type === 'reactivate',
          branch_id: branchId,
        })
        toast.success(`${item.name} ${type === 'reactivate' ? 'reactivated' : 'deactivated'}`)
      }
      setConfirmAction(null)
      await fetchItems()
    } catch (err) {
      console.error('Failed action:', err)
        // Global axios interceptor already shows HTTP error toasts. Show a
        // local toast only for non-HTTP errors (network, JS exceptions)
        if (!err?.response) {
          toast.error(err?.message || 'Action failed')
        }
    } finally {
      setActionBusy(false)
    }
  }

  const handleExport = () => {
    exportToCSV(filtered.map((item) => ({
      'Item Name': item.name,
      SKU: item.sku || '—',
      Barcode: item.barcode || '—',
      Category: item.categoryName || '—',
      Brand: item.brand || '—',
      Unit: item.unit,
      'Cost Price (MVR)': isMaster ? (item.default_cost_price ?? item.cost_price) : item.cost_price,
      'Selling Price (MVR)': isMaster ? (item.default_selling_price ?? item.selling_price) : item.selling_price,
      'GST (%)': item.tax_rate,
      ...(isMaster
        ? { 'Active Branches': item.available_branch_count ?? 0 }
        : {
          Stock: item.available_stock,
          'Reorder Level': item.reorder_level,
          'Stock Value (MVR)': (item.available_stock || 0) * (item.cost_price || 0),
        }),
    })), `${isMaster ? 'ItemMaster' : 'ItemsStock'}_${new Date().toISOString().split('T')[0]}.csv`)
    toast.success('Items exported')
  }

  const handleRefresh = () => {
    setListVersion((v) => v + 1)
    if (!isMaster) loadNearExpiry()
    toast.success('List refreshed')
  }

  return (
    <div className="page-container">
      <SectionHeader
        title={isMaster ? 'Item Master' : 'Items & Stock'}
        subtitle={isMaster
          ? 'Central product catalog — create items, defaults, and branch listing'
          : 'Branch inventory — request stock corrections (manager approval required)'}
      >
        {!isMaster && can('adjustments.create') && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAdjSelect(true)}>⚖ Request Adjustment</button>
        )}
        {isMaster && can('item_master.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/item-master/new')}>+ Add Item</button>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          onExport: handleExport,
          onRefresh: handleRefresh,
        })} />
      </SectionHeader>

      {/* KPIs */}
      
      <Tabs tabs={isMaster ? MASTER_TABS : BRANCH_TABS} active={tab} onChange={setTab} />

      {/* Filters */}
      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search name, SKU, barcode…" />
        <AutocompleteDropdown
          value={catFilter}
          onChange={setCatFilter}
          onSelectOption={(opt) => setCatFilter(opt?.id || '')}
          fetchUrl={AUTOCOMPLETE_CATEGORY_URL}
          prependOptions={[{ id: '', label: 'All Categories' }]}
          isSearchFieldRequired
          placeholder="All Categories"
          searchPlaceholder="Search categories…"
          emptyLabel="No categories"
          style={{ width: 180 }}
        />
      </div>

      {!isMaster && tab === 'expiry' && (
        <>
        <div style={{ marginBottom: 12 }}>
          <AlertBar type="blue" icon="ℹ️">
            This list shows batches expiring within your chosen calendar window.
            The <strong>Status</strong> column compares remaining days to each batch&apos;s
            own shelf life (mfg or received → expiry): <strong>Use soon</strong> means
            ≤25% shelf life left — so milk with 2 days on a 7-day shelf reads differently
            than biscuits with 2 days on a 6-month shelf.
          </AlertBar>
        </div>
        <Card
          title="Batches Near Expiry"
          titleRight={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Within</span>
              <AutocompleteDropdown
                value={nearExpiryDays}
                onChange={(v) => setNearExpiryDays(Number(v))}
                options={[7, 15, 30, 60, 90, 180].map((d) => ({ id: d, label: `${d} days` }))}
                isSearchFieldRequired={false}
                style={{ width: 90, fontSize: 12 }}
              />
            </div>
          }
          bodyPadding={false}
          style={{ marginBottom: 18 }}
        >
          {nearExpiryLoading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading batches…</div>
          ) : nearExpiry.length === 0 ? (
            <EmptyState icon="✅" title={`Nothing expiring in ${nearExpiryDays} days`} desc="No batches in this calendar window" />
          ) : (
            <table className="data-table" style={{ marginBottom: 0 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Batch #</th>
                  <th>Mfg</th>
                  <th>Expiry</th>
                  <th className="text-right">Remaining</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {nearExpiry.map((b) => {
                  const expInfo = batchExpiryStatus(b)
                  return (
                  <tr key={b.id}>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{b.itemEmoji} {b.itemName}</div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{b.itemSku}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{b.batchNumber}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.mfgDate ? fmtDate(b.mfgDate) : '—'}</td>
                    <td style={{ fontSize: 12, fontWeight: 600, color: expInfo.dateColor }} title={expInfo.title}>
                      {b.expiryDate ? fmtDate(b.expiryDate) : '—'}
                    </td>
                    <td className="text-right mono" style={{ fontWeight: 600 }}>{b.quantity}</td>
                    <td title={expInfo.title}>
                      {expInfo.status
                        ? <Chip status={expInfo.status} label={expInfo.statusLabel} />
                        : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{expInfo.statusLabel}</span>}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-xs" onClick={() => {
                        const it = items.find((i) => i.id === b.itemId)
                        if (it) setBatchesModal(it)
                      }}>View</button>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
        </>
      )}

      <Card bodyPadding={false}>
        {loading ? (
          <TableLoadingPanel label="Loading items…" />
        ) : filtered.length === 0 ? (
          <EmptyState icon="📦" title="No items found" desc="Try a different search or filter" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader label="Item" sortKey="name" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} />
                  <th>SKU / Barcode</th>
                  <SortableHeader label="Category" sortKey="category_id" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} />
                  <SortableHeader label={isMaster ? 'Default Cost' : 'Cost'} sortKey="cost_price" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} className="text-right" align="right" />
                  <SortableHeader label={isMaster ? 'Default Price' : 'Price'} sortKey="selling_price" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} className="text-right" align="right" />
                  {isMaster && <th>{tab === 'pending' ? 'Raised By' : tab === 'rejected' ? 'Rejected By' : 'Branches'}</th>}
                  <th>GST</th>
                  {!isMaster && (
                    <SortableHeader label="Stock" sortKey="available_stock" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} className="text-right" align="right" />
                  )}
                  {!isMaster && <th>Status</th>}
                  <th style={{ width: 48 }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p) => {
                  const branchStock = p.available_stock || 0
                  // `cls` is destructured but unused — kept named so the
                  // shape of stockStatus() stays self-documenting.
                  const { label } = stockStatus(branchStock, p.reorder_level)
                  return (
                    <tr key={p.id} {...tableRowClickProps(() => setShowDetail(p))}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <span style={{ fontSize: 20 }}>{p.emoji}</span>
                          <div>
                            <div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                              {p.name}
                              {p.batch_tracking && (
                                <span title={p.expiry_tracking ? 'FEFO tracked' : 'FIFO tracked'} style={{
                                  fontSize: 9.5, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                                  background: p.expiry_tracking ? 'rgba(245,72,92,.12)' : 'rgba(79,142,247,.12)',
                                  color: p.expiry_tracking ? 'var(--red)' : 'var(--accent)',
                                }}>{p.expiry_tracking ? 'FEFO' : 'FIFO'}</span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {p.brand}
                              {!p.active && (
                                <span style={{ marginLeft: 6, fontSize: 11.5, color: 'var(--red)' }}>Inactive</span>
                              )}
                              {!isMaster && p.batch_tracking && p.batches_count > 0 && (
                                <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>
                                  · {p.batches_count} batch{p.batches_count === 1 ? '' : 'es'}
                                  {p.nearest_expiry ? ` · exp ${fmtDate(p.nearest_expiry)}` : ''}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{p.sku}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{p.barcode}</div>
                      </td>
                      <td><Tag>{p.categoryName}</Tag></td>
                      <td className="text-right mono">
                        {fmt(isMaster ? (p.default_cost_price ?? p.cost_price) : p.cost_price)}
                        {!isMaster && p.branch_cost_override != null && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>branch override</div>
                        )}
                      </td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {fmt(isMaster ? (p.default_selling_price ?? p.selling_price) : p.selling_price)}
                        {!isMaster && p.branch_price_override != null && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>branch override</div>
                        )}
                      </td>
                      {isMaster && (
                        <td>
                          {tab === 'pending' ? (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              <div>{p.created_by || '—'}</div>
                              {p.created_at ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(p.created_at)}</div> : null}
                            </div>
                          ) : tab === 'rejected' ? (
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              <div>{p.rejected_by || '—'}</div>
                              {p.rejected_at ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(p.rejected_at)}</div> : null}
                              {p.rejection_reason ? <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{p.rejection_reason}</div> : null}
                            </div>
                          ) : (
                            <Tag>{p.available_branch_count ?? 0} active</Tag>
                          )}
                        </td>
                      )}
                      <td><Tag>{p.tax_rate}%</Tag></td>
                      {!isMaster && (
                        <td className="text-right">
                          <div style={{ fontWeight: 500, fontSize: 13, color: branchStock === 0 ? 'var(--red)' : branchStock <= p.reorder_level ? 'var(--amber)' : 'var(--text-primary)' }}>{branchStock}</div>
                        </td>
                      )}
                      {!isMaster && <td><Chip status={label === 'In Stock' ? 'active' : label === 'Low Stock' ? 'low' : 'out'} label={label} /></td>}
                      <td className="text-right">
                        {isMaster && tab === 'pending' ? (
                            <RowActionsMenu
                              busy={!!itemActionBusy}
                              ariaLabel={`Actions for ${p.name}`}
                              actions={[
                                {
                                  label: 'View details',
                                  disabled: itemActionBusy === p.id,
                                  onClick: () => setShowDetail(p),
                                },
                                {
                                  label: 'Activity',
                                  hidden: !canActivity,
                                  disabled: itemActionBusy === p.id,
                                  onClick: () => setActivityTarget({ recordType: 'item', recordId: p.id, title: `Item ${p.name || p.id}` }),
                                },
                                {
                                  label: 'Edit item',
                                  hidden: !can('item_master.edit'),
                                  disabled: itemActionBusy === p.id,
                                  onClick: () => navigate(`/item-master/${p.id}/edit`),
                                },
                                {
                                  label: itemActionBusy === p.id && actionKind === 'approve' ? 'Approving…' : 'Approve',
                                  hidden: !can('item_master.approve'),
                                  disabled: itemActionBusy === p.id,
                                  onClick: () => { setActionKind('approve'); approveItem(p) },
                                },
                                {
                                  label: itemActionBusy === p.id && actionKind === 'reject' ? 'Rejecting…' : 'Reject',
                                  danger: true,
                                  hidden: !can('item_master.approve'),
                                  disabled: itemActionBusy === p.id,
                                  onClick: () => { setRejectTarget(p); setRejectReason('') },
                                },
                                {
                                  label: itemActionBusy === p.id && actionKind === 'delete' ? 'Deleting…' : 'Delete',
                                  danger: true,
                                  hidden: !can('item_master.delete'),
                                  disabled: itemActionBusy === p.id,
                                  onClick: () => setConfirmAction({ type: 'delete', item: p }),
                                },
                              ]}
                            />
                          ) : (
                          <RowActionsMenu
                            busy={!!itemActionBusy}
                            ariaLabel={`Actions for ${p.name}`}
                            actions={isMaster ? [
                              {
                                label: 'View details',
                                onClick: () => setShowDetail(p),
                              },
                              {
                                label: 'Activity',
                                hidden: !canActivity,
                                disabled: itemActionBusy === p.id,
                                onClick: () => setActivityTarget({ recordType: 'item', recordId: p.id, title: `Item ${p.name || p.id}` }),
                              },
                              {
                                label: 'Edit item',
                                hidden: tab === 'pending' || !can('item_master.edit'),
                                onClick: () => openEdit(p),
                              },
                              {
                                label: p.active ? 'Deactivate item' : 'Reactivate item',
                                hidden: !can('item_master.edit', 'items.edit'),
                                onClick: () => setConfirmAction({ type: p.active ? 'deactivate' : 'reactivate', item: p }),
                              },
                              {
                                label: 'Delete item',
                                hidden: !can('item_master.delete'),
                                danger: true,
                                onClick: () => setConfirmAction({ type: 'delete', item: p }),
                              },
                            ] : [
                              {
                                label: 'View details',
                                onClick: () => setShowDetail(p),
                              },
                              {
                                label: 'Request adjustment',
                                hidden: !can('adjustments.create'),
                                onClick: () => openAdj(p),
                              },
                              {
                                label: 'View batches',
                                hidden: !p.batch_tracking || !can('items.view'),
                                onClick: () => setBatchesModal(p),
                              },
                              {
                                label: p.active ? 'Deactivate item' : 'Reactivate item',
                                hidden: !can('item_master.edit', 'items.edit'),
                                onClick: () => setConfirmAction({ type: p.active ? 'deactivate' : 'reactivate', item: p }),
                              },
                              {
                                label: 'Delete item',
                                hidden: !can('item_master.delete'),
                                danger: true,
                                onClick: () => setConfirmAction({ type: 'delete', item: p }),
                              },
                            ]}
                          />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar
          total={filtered.length}
          skip={itemSkip}
          limit={itemLimit}
          onSkipChange={setItemSkip}
          onLimitChange={setItemLimit}
          disabled={loading}
        />
      </Card>

      <ConfirmDialog
        open={!!confirmAction}
        onClose={() => !actionBusy && setConfirmAction(null)}
        onConfirm={handleConfirmAction}
        title={confirmAction ? (confirmAction.type === 'delete' ? 'Delete item?' : confirmAction.type === 'deactivate' ? 'Deactivate item?' : 'Reactivate item?') : ''}
        message={confirmAction ? (
          confirmAction.type === 'delete'
            ? `Delete ${confirmAction.item.name}? This cannot be undone.`
            : confirmAction.type === 'deactivate'
              ? `Deactivate ${confirmAction.item.name}? This will prevent it from being sold or listed.`
              : `Reactivate ${confirmAction.item.name}? This will restore it to active catalog listings.`
        ) : ''}
        confirmLabel={confirmAction?.type === 'delete' ? 'Delete' : 'Yes'}
        danger={confirmAction?.type === 'delete'}
      />

      <Modal
        open={!!rejectTarget}
        onClose={() => !itemActionBusy && setRejectTarget(null)}
        title="Reject item"
        icon="✖"
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setRejectTarget(null)} disabled={itemActionBusy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => rejectItem(rejectTarget)} disabled={itemActionBusy || !rejectReason.trim()}>
              {itemActionBusy ? 'Rejecting…' : 'Reject item'}
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Provide a reason for rejecting <strong>{rejectTarget?.name}</strong>.
          </div>
          <textarea
            className="form-input"
            rows={4}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection"
          />
        </div>
      </Modal>

      <Modal
        open={!!showDetail}
        onClose={() => !itemActionBusy && setShowDetail(null)}
        title={showDetail ? `Item — ${showDetail.name}` : 'Item'}
        icon="📦"
        size="md"
        footer={showDetail?.status === 'pending' && (can('item_master.approve') || can('item_master.delete') || can('item_master.create')) ? (
          <>
            {can('item_master.create') && (
              <button className="btn btn-secondary" style={{ marginRight: can('item_master.delete') ? 0 : 'auto' }} onClick={() => {
                const id = showDetail.id
                setShowDetail(null)
                navigate(`/item-master/${id}/edit`)
              }} disabled={!!itemActionBusy}>
                Edit
              </button>
            )}
            {can('item_master.delete') && (
              <button className="btn btn-secondary" style={{ marginRight: 'auto', color: 'var(--red)', marginLeft: can('item_master.create') ? 8 : 0 }} onClick={() => setConfirmAction({ type: 'delete', item: showDetail })} disabled={!!itemActionBusy}>
                Delete
              </button>
            )}
            {can('item_master.approve') && (
              <>
                <button className="btn btn-secondary" onClick={openRejectFromDetail} disabled={!!itemActionBusy}>
                  {itemActionBusy && actionKind === 'reject' ? 'Rejecting…' : 'Reject'}
                </button>
                <button className="btn btn-primary" onClick={approveFromDetail} disabled={!!itemActionBusy}>
                  {itemActionBusy && actionKind === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              </>
            )}
          </>
        ) : (
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
        )}
      >
        {showDetail && (
          <>
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Item</span>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)', marginTop: 6 }}>{showDetail.name}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'SKU', value: showDetail.sku || '—' },
                { label: 'Category', value: showDetail.categoryName || '—' },
                { label: 'Status', value: (() => { const s = (showDetail.status || showDetail.approval_status || 'approved'); return <Chip status={s === 'approved' ? 'active' : s === 'pending' ? 'pending' : s === 'rejected' ? 'draft' : 'draft'} label={s.charAt(0).toUpperCase() + s.slice(1)} /> })() },
                { label: 'Requested by', value: showDetail.created_by || '—' },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Retail price</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(showDetail.default_selling_price ?? showDetail.selling_price)}</div>
              </div>
              <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Cost</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(showDetail.default_cost_price ?? showDetail.cost_price)}</div>
              </div>
              <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Wholesale discount</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{Number(showDetail.wholesale_discount_pct || 0)}%</div>
              </div>
              <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Staff discount</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{Number(showDetail.staff_discount_pct || 0)}%</div>
              </div>
            </div>
            {showDetail.rejection_reason && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8, color: 'var(--red)' }}>
                <div style={{ fontWeight: 700 }}>Rejection reason</div>
                <div style={{ marginTop: 6 }}>{showDetail.rejection_reason}</div>
              </div>
            )}
          </>
        )}
      </Modal>

      {!isMaster && (
        <>
      {/* Stock Adjustment Modal — batch-aware */}
      <Modal open={!!showAdj} onClose={() => !adjSubmitting && setShowAdj(null)} title="Request Stock Adjustment" icon="⚖" size={showAdj?.batch_tracking ? 'md' : 'sm'}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdj(null)} disabled={adjSubmitting}>Cancel</button>
          <button className="btn btn-primary" onClick={saveAdj} disabled={adjSubmitting}>
            {adjSubmitting ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </>}>
        {showAdj && (
          <>
            <div style={{ padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{showAdj.emoji} {showAdj.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                Current stock: <strong>{showAdj.available_stock || 0}</strong> units
                <span style={{ marginLeft: 10 }}>· Strategy: <strong>{trackingLabel(showAdj)}</strong></span>
              </div>
            </div>

            {showAdj.batch_tracking && (
              <>
                <div className="form-label" style={{ marginBottom: 6 }}>
                  Target {adjBatchId ? '— editing one batch' : '— aggregate (auto-pick via ' + (showAdj.expiry_tracking ? 'FEFO' : 'FIFO') + ')'}
                </div>
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 12,
                  maxHeight: 260, overflowY: 'auto',
                }}>
                  <table className="data-table" style={{ marginBottom: 0 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 30 }}></th>
                        <th>Batch #</th>
                        <th>Mfg</th>
                        <th>Expiry</th>
                        <th className="text-right">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ cursor: 'pointer', background: adjBatchId === '' ? 'rgba(79,142,247,.08)' : undefined }} onClick={() => { setAdjBatchId(''); setAdjQty(showAdj.available_stock || 0) }}>
                        <td><input type="radio" checked={adjBatchId === ''} readOnly /></td>
                        <td colSpan={3} style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>Aggregate (across all batches)</td>
                        <td className="text-right mono">{showAdj.available_stock || 0}</td>
                      </tr>
                      {adjLoading ? (
                        <tr><td colSpan={5} style={{ textAlign: 'center', padding: 14, color: 'var(--text-muted)' }}>Loading batches…</td></tr>
                      ) : adjBatches.length === 0 ? (
                        <tr><td colSpan={5} style={{ textAlign: 'center', padding: 14, color: 'var(--text-muted)' }}>No batches at this branch yet.</td></tr>
                      ) : adjBatches.map((b) => (
                        <tr key={b.id} style={{ cursor: 'pointer', background: adjBatchId === b.id ? 'rgba(79,142,247,.08)' : undefined }} onClick={() => { setAdjBatchId(b.id); setAdjQty(b.quantity) }}>
                          <td><input type="radio" checked={adjBatchId === b.id} readOnly /></td>
                          <td className="mono" style={{ fontSize: 12 }}>{b.batchNumber}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.mfgDate ? fmtDate(b.mfgDate) : '—'}</td>
                          <td style={{ fontSize: 12, color: b.expiryDate && new Date(b.expiryDate) < new Date() ? 'var(--red)' : 'var(--text-muted)' }}>{b.expiryDate ? fmtDate(b.expiryDate) : '—'}</td>
                          <td className="text-right mono">{b.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <FormGroup label={adjBatchId ? 'New Batch Quantity' : 'New Aggregate Quantity (Physical Count)'} required>
              <input className="form-input" type="number" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} autoFocus />
            </FormGroup>
            <FormGroup label="Reason">
              <AutocompleteDropdown
                value={adjReason}
                onChange={setAdjReason}
                options={['Physical count', 'Damaged / Spoilage', 'Theft / Shrinkage', 'Data correction', 'Expiry removal', 'Other'].map((r) => ({ id: r, label: r }))}
                isSearchFieldRequired={false}
              />
            </FormGroup>
            <FormGroup label="Notes">
              <textarea className="form-input" placeholder="Optional notes for the approver" style={{ height: 60 }} value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} />
            </FormGroup>
            <AlertBar type="blue" icon="ℹ">
              Stock is not changed until a manager approves this request in Stock Adjustments.
            </AlertBar>
            {showAdj.batch_tracking && !adjBatchId && Number(adjQty) > (showAdj.available_stock || 0) && (
              <AlertBar type="blue" icon="ℹ">
                Aggregate increase will be recorded as a new &quot;Adjustment&quot; batch (no expiry).
                Pick a specific batch above if you&apos;re correcting a known lot&apos;s count.
              </AlertBar>
            )}
            {showAdj.batch_tracking && !adjBatchId && Number(adjQty) < (showAdj.available_stock || 0) && (
              <AlertBar type="amber" icon="⚠">
                Aggregate decrease of {(showAdj.available_stock || 0) - Number(adjQty || 0)} units will be drawn from {showAdj.expiry_tracking ? 'nearest-expiry' : 'oldest'} batches first.
              </AlertBar>
            )}
          </>
        )}
      </Modal>

      {/* Stock Adjustment - Item Selection Modal */}
      <Modal open={showAdjSelect} onClose={() => setShowAdjSelect(false)} title="Select Item to Adjust" icon="⚖" size="md"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdjSelect(false)}>Close</button>
        </>}>
        <SearchBar
          value={adjSelectSearch}
          onChange={setAdjSelectSearch}
          placeholder="Search by name, SKU, or barcode…"
          style={{ opacity: loading ? 0.6 : 1, pointerEvents: loading ? 'none' : 'auto' }}
        />
        <div style={{ marginTop: 12, maxHeight: 400, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)', fontSize: 13 }}>
              Loading items…
            </div>
          ) : (
            <>
          {items.filter(item =>
            adjSelectSearch === '' ||
            item.name.toLowerCase().includes(adjSelectSearch.toLowerCase()) ||
            (item.sku && item.sku.toLowerCase().includes(adjSelectSearch.toLowerCase())) ||
            (item.barcode && item.barcode.includes(adjSelectSearch))
          ).map((item) => (
            <div key={item.id} onClick={() => {
              setShowAdjSelect(false)
              openAdj(item)
            }} style={{
              padding: '12px 14px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              marginBottom: 8,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              transition: 'all 0.2s',
            }} onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-input)'}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{item.emoji} {item.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  SKU: {item.sku} | {item.categoryName}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: item.available_stock === 0 ? 'var(--red)' : item.available_stock <= item.reorder_level ? 'var(--amber)' : 'var(--text-primary)' }}>
                  {item.available_stock || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current stock</div>
              </div>
            </div>
          ))}
          {items.filter(item =>
            adjSelectSearch === '' ||
            item.name.toLowerCase().includes(adjSelectSearch.toLowerCase()) ||
            (item.sku && item.sku.toLowerCase().includes(adjSelectSearch.toLowerCase())) ||
            (item.barcode && item.barcode.includes(adjSelectSearch))
          ).length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
              No items found
            </div>
          )}
          </>
          )}
        </div>
      </Modal>

      {/* Per-item batch viewer / quick-add */}
      <BatchesModal
        item={batchesModal}
        branchId={branchId}
        onClose={() => setBatchesModal(null)}
        onChanged={async () => {
          await fetchItems()
          await loadNearExpiry()
        }}
        canAdd={can('items.adjust')}
      />
      </>
      )}
      {isMaster && (
        <ActivityDrawer
          open={!!activityTarget}
          onClose={() => setActivityTarget(null)}
          recordType={activityTarget?.recordType}
          recordId={activityTarget?.recordId}
          title={activityTarget?.title}
        />
      )}
    </div>
  )
}

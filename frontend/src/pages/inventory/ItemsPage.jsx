import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { itemsAPI, taxRatesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, fmtDate, stockStatus, exportToCSV } from '@/utils/helpers'
import { batchExpiryStatus } from '@/utils/batchExpiry'
import { validateBatchDates } from '@/utils/batchDates'
import {
  SectionHeader, Card, Tabs, SearchBar, Chip, Modal,
  FormGroup, KPICard, EmptyState, Tag, PaginationBar,
  SortableHeader, AlertBar,
} from '@/components/ui'
import { DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import ItemFormModal from './ItemFormModal'
import BatchesModal from './BatchesModal'

const TABS = [
  { id: 'all',      label: 'All Items' },
  { id: 'low',      label: 'Low Stock' },
  { id: 'expiry',   label: 'Near Expiry' },
  { id: 'inactive', label: 'Inactive' },
]

const EMPTY_ITEM = {
  name: '', sku: '', barcode: '', categoryId: '', brand: '',
  unit: 'Pcs', cost_price: '', selling_price: '', tax_rate: '8',
  hsn_code: '', reorder_level: '10', opening_stock: '0', active: true,
  batch_tracking: false, expiry_tracking: false, emoji: '📦',
  opening_batch_number: '', opening_mfg_date: '', opening_expiry_date: '',
}

// Strategy label / hint used in the stock-adjust modal so the operator
// understands which batches will be touched when they reduce stock without
// picking a specific batch.
const trackingLabel = (item) => {
  if (!item?.batch_tracking) return 'Untracked'
  return item.expiry_tracking ? 'FEFO (nearest expiry first)' : 'FIFO (oldest received first)'
}

export default function ItemsPage() {
  const can = useCan()
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const [tab, setTab]           = useState('all')
  const [search, setSearch]     = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState(() => activeBranch?.id || 'br-001')
  const [showAdd, setShowAdd]   = useState(false)
  const [editItem, setEditItem] = useState(null)
  // Snapshot of batch_tracking when edit opens — used to confirm destructive toggles.
  const [editWasTracked, setEditWasTracked] = useState(false)
  const [showAdj, setShowAdj]   = useState(null)
  const [showAdjSelect, setShowAdjSelect] = useState(false)
  const [adjSelectSearch, setAdjSelectSearch] = useState('')
  const [form, setForm]         = useState(EMPTY_ITEM)
  const [adjQty, setAdjQty]     = useState('')
  const [adjReason, setAdjReason] = useState('Physical count')
  const [adjBatches, setAdjBatches] = useState([])      // batch list when adjusting a tracked item
  const [adjBatchId, setAdjBatchId] = useState('')      // selected single-batch id (or '' = aggregate)
  const [adjLoading, setAdjLoading] = useState(false)
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
  const [categories, setCategories] = useState([])
  const [taxRates, setTaxRates] = useState([])

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
      const data = await fetchAllList(itemsAPI.list, { branch_id: branchFilter })
      setItems(data || [])
      if (data && data.length > 0) {
        const uniqueCats = [...new Set(data.map((item) => item.categoryId))]
        const cats = uniqueCats.map((catId) => ({
          id: catId,
          name: data.find((item) => item.categoryId === catId)?.categoryName || catId,
        }))
        setCategories(cats)
      } else {
        setCategories([])
      }
    } catch (err) {
      console.error('Failed to fetch items:', err)
      toast.error('Failed to load items')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [branchFilter])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  useEffect(() => {
    taxRatesAPI.list()
      .then((data) => setTaxRates(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load tax rates:', err))
  }, [])

  useEffect(() => {
    setItemSkip(0)
  }, [search, catFilter, tab, branchFilter])

  // Refresh the near-expiry roll-up when the relevant filters change. We
  // keep it on a separate effect so toggling tabs doesn't re-fetch the full
  // items list (which is already in memory) just to look at expiries.
  const loadNearExpiry = useCallback(async () => {
    try {
      setNearExpiryLoading(true)
      const data = await itemsAPI.batches.nearExpiry({
        branch_id: branchFilter,
        within_days: nearExpiryDays,
      })
      setNearExpiry(data?.items || [])
    } catch (err) {
      console.error('Failed to fetch near-expiry batches:', err)
      setNearExpiry([])
    } finally {
      setNearExpiryLoading(false)
    }
  }, [branchFilter, nearExpiryDays])

  useEffect(() => {
    loadNearExpiry()
  }, [loadNearExpiry])

  const patchForm = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const filtered = useMemo(() => {  // eslint-disable-line react-hooks/exhaustive-deps
    let list = [...items]
    if (search)     list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || (p.sku && p.sku.toLowerCase().includes(search.toLowerCase())) || (p.barcode && p.barcode.includes(search)))
    if (catFilter)  list = list.filter((p) => p.categoryId === catFilter)
    if (tab === 'low')      list = list.filter((p) => p.available_stock > 0 && p.available_stock <= p.reorder_level)
    if (tab === 'expiry') {
      // Items that own at least one batch in the near-expiry rollup. The
      // `Near Expiry` table below shows the actual lot rows; this filter
      // just narrows the item table to items the operator should look at.
      const ids = new Set(nearExpiry.map((b) => b.itemId))
      list = list.filter((p) => ids.has(p.id))
    }
    if (tab === 'inactive') list = list.filter((p) => p.active === false)
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
  }, [items, search, catFilter, tab, itemSortBy, itemSortOrder, nearExpiry])

  const pageRows = useMemo(() => {
    return filtered.slice(itemSkip, itemSkip + itemLimit)
  }, [filtered, itemSkip, itemLimit])

  const totals = useMemo(() => ({
    items:    items.length,
    low:      items.filter((p) => p.available_stock > 0 && p.available_stock <= p.reorder_level).length,
    outStock: items.filter((p) => p.available_stock === 0).length,
    stockVal: items.reduce((sum, p) => sum + (p.available_stock || 0) * (p.cost_price || 0), 0),
    tracked:  items.filter((p) => p.batch_tracking).length,
    // "Near expiry" comes from the per-batch rollup, not the items list —
    // an item can have multiple lots at different expiries so the count is
    // by batch (a single tracked item may contribute several rows).
    expiring: nearExpiry.length,
  }), [items, nearExpiry])

  const openAdd  = () => {
    setForm(EMPTY_ITEM)
    setEditItem(null)
    setEditWasTracked(false)
    setShowAdd(true)
  }
  const openEdit = (item) => {
    setForm({
      name: item.name,
      sku: item.sku,
      barcode: item.barcode,
      categoryId: item.categoryId,
      brand: item.brand,
      unit: item.unit,
      cost_price: item.cost_price,
      selling_price: item.selling_price,
      tax_rate: item.tax_rate,
      hsn_code: item.hsn_code,
      reorder_level: item.reorder_level,
      opening_stock: item.available_stock,
      emoji: item.emoji,
      batch_tracking: item.batch_tracking || false,
      expiry_tracking: item.expiry_tracking || false,
      opening_batch_number: '',
      opening_mfg_date: '',
      opening_expiry_date: '',
    })
    setEditWasTracked(Boolean(item.batch_tracking))
    setEditItem(item.id)
    setShowAdd(true)
  }

  // Open the stock adjustment modal. For batch-tracked items we lazily fetch
  // the live batch list so the operator can pick a specific lot — defaulting
  // to "aggregate" which routes through FIFO/FEFO on the backend.
  const openAdj = async (item) => {
    setShowAdj(item)
    setAdjQty(item.available_stock || 0)
    setAdjReason('Physical count')
    setAdjBatchId('')
    setAdjBatches([])
    if (item.batch_tracking) {
      try {
        setAdjLoading(true)
        const data = await itemsAPI.batches.list(item.id, { branch_id: branchFilter })
        setAdjBatches(data?.items || [])
      } catch (err) {
        console.error('Failed to fetch batches:', err)
        toast.error('Could not load batches for this item')
      } finally {
        setAdjLoading(false)
      }
    }
  }

  const saveItem = async () => {
    if (!form.name) { toast.error('Item name is required'); return }
    if (!form.selling_price) { toast.error('Selling price is required'); return }
    if (!editItem && form.batch_tracking && Number(form.opening_stock) > 0) {
      const { ok, errors } = validateBatchDates(
        { mfgDate: form.opening_mfg_date, expiryDate: form.opening_expiry_date },
        { requireExpiry: Boolean(form.expiry_tracking) },
      )
      if (!ok) {
        toast.error(errors[0])
        return
      }
    }
    try {
      const payload = {
        name: form.name,
        sku: form.sku,
        barcode: form.barcode,
        category_id: form.categoryId,
        brand: form.brand,
        unit: form.unit,
        cost_price: Number(form.cost_price),
        selling_price: Number(form.selling_price),
        tax_rate: Number(form.tax_rate),
        hsn_code: form.hsn_code,
        reorder_level: Number(form.reorder_level),
        emoji: form.emoji || '📦',
        batch_tracking: form.batch_tracking,
        expiry_tracking: form.expiry_tracking,
        opening_stock: editItem ? 0 : Number(form.opening_stock),
        branch_id: branchFilter,
        // Opening-batch metadata is read by the backend only when
        // batch_tracking is on AND opening_stock > 0; safe to always send.
        opening_batch_number: form.opening_batch_number || undefined,
        opening_mfg_date:     form.opening_mfg_date || undefined,
        opening_expiry_date:  form.opening_expiry_date || undefined,
      }

      if (editItem) {
        const res = await itemsAPI.update(editItem, payload)
        const ch = res?.data?.batch_tracking_change
        if (ch?.action === 'disabled') {
          toast.success(`Item updated — ${ch.batches_deleted ?? 0} batch(es) removed`)
        } else if (ch?.action === 'enabled') {
          toast.success(`Item updated — ${ch.batches_seeded ?? 0} opening batch(es) created`)
        } else {
          toast.success('Item updated')
        }
      } else {
        await itemsAPI.create(payload)
        toast.success('Item added')
      }
      await fetchItems()
      await loadNearExpiry()
      setShowAdd(false)
    } catch (err) {
      console.error('Failed to save item:', err)
      toast.error('Failed to save item')
    }
  }

  const saveAdj = async () => {
    if (adjQty === '' || adjQty === null) { toast.error('Enter adjusted quantity'); return }
    try {
      await itemsAPI.adjust({
        item_id: showAdj.id,
        branch_id: branchFilter,
        new_qty: Number(adjQty),
        reason: adjReason,
        // batch_id only sent when the operator picks a specific lot in the
        // adjustment table; '' means "aggregate" and the backend will draw
        // from oldest batches first using the item's tracking strategy.
        batch_id: adjBatchId || undefined,
      })
      toast.success(`Stock adjusted for ${showAdj.name}`)
      await fetchItems()
      await loadNearExpiry()
      setShowAdj(null)
    } catch (err) {
      console.error('Failed to adjust stock:', err)
      toast.error('Failed to adjust stock')
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading items...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Items & Inventory" subtitle="Manage item master, stock levels, and adjustments">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = filtered.map(item => ({
            'Item Name': item.name,
            'SKU': item.sku || '—',
            'Barcode': item.barcode || '—',
            'Category': item.categoryName || '—',
            'Brand': item.brand || '—',
            'Unit': item.unit,
            'Cost Price (₹)': item.cost_price,
            'Selling Price (₹)': item.selling_price,
            'GST (%)': item.tax_rate,
            'Stock': item.available_stock,
            'Reorder Level': item.reorder_level,
            'Stock Value (₹)': (item.available_stock || 0) * (item.cost_price || 0),
          }))
          exportToCSV(exportData, `Items_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Items exported')
        }}>↓ Export</button>
        {can('items.adjust') && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAdjSelect(true)}>⚖ Adjust Stock</button>
        )}
        {can('items.create') && (
          <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Item</button>
        )}
      </SectionHeader>

      {/* KPIs */}
      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Items"         value={totals.items}     color="var(--accent)" sub={`${totals.tracked} tracked (FIFO/FEFO)`} />
        <KPICard label="Low Stock Items"     value={totals.low}       color="var(--amber)"   />
        <KPICard label="Near Expiry"         value={totals.expiring}  color="var(--red)" sub={`within ${nearExpiryDays} days`} onClick={() => setTab('expiry')} />
        <KPICard label="Stock Value"         value={fmt(totals.stockVal)} color="var(--green)" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* Filters */}
      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search name, SKU, barcode…" />
        <select className="form-input" style={{ width: 180 }} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">All Categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="form-input" style={{ width: 150 }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {tab === 'expiry' && (
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
              <select className="form-input" style={{ width: 90, padding: '4px 8px', fontSize: 12 }} value={nearExpiryDays} onChange={(e) => setNearExpiryDays(Number(e.target.value))}>
                {[7, 15, 30, 60, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
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
        {filtered.length === 0 ? <EmptyState icon="📦" title="No items found" desc="Try a different search or filter" /> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader label="Item" sortKey="name" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} />
                  <th>SKU / Barcode</th>
                  <SortableHeader label="Category" sortKey="category_id" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} />
                  <SortableHeader label="Cost" sortKey="cost_price" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} className="text-right" align="right" />
                  <SortableHeader label="Price" sortKey="selling_price" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} className="text-right" align="right" />
                  <th>GST</th>
                  <SortableHeader label="Stock" sortKey="available_stock" sortBy={itemSortBy} sortOrder={itemSortOrder} onSort={onSort} className="text-right" align="right" />
                  <th>Status</th>
                  <th style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p) => {
                  const branchStock = p.available_stock || 0
                  // `cls` is destructured but unused — kept named so the
                  // shape of stockStatus() stays self-documenting.
                  const { label } = stockStatus(branchStock, p.reorder_level)
                  return (
                    <tr key={p.id}>
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
                              {p.batch_tracking && p.batches_count > 0 && (
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
                      <td className="text-right mono">{fmt(p.cost_price)}</td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(p.selling_price)}</td>
                      <td><Tag>{p.tax_rate}%</Tag></td>
                      <td className="text-right">
                        <div style={{ fontWeight: 500, fontSize: 13, color: branchStock === 0 ? 'var(--red)' : branchStock <= p.reorder_level ? 'var(--amber)' : 'var(--text-primary)' }}>{branchStock}</div>
                      </td>
                      <td><Chip status={label === 'In Stock' ? 'active' : label === 'Low Stock' ? 'low' : 'out'} label={label} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {p.batch_tracking && (
                            <button className="btn btn-ghost btn-xs" onClick={() => setBatchesModal(p)} title="View batches">Batches</button>
                          )}
                          {can('items.edit') && (
                            <button className="btn btn-ghost btn-xs" onClick={() => openEdit(p)}>Edit</button>
                          )}
                          {can('items.adjust') && (
                            <button className="btn btn-ghost btn-xs" onClick={() => openAdj(p)}>Adj</button>
                          )}
                        </div>
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

      <ItemFormModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        editing={!!editItem}
        editWasTracked={editWasTracked}
        form={form}
        patchForm={patchForm}
        onSave={saveItem}
        categories={categories}
        taxRates={taxRates}
      />

      {/* Stock Adjustment Modal — batch-aware. For tracked items we show the
          batch table and let the operator EITHER pick a specific lot (per-
          batch absolute set) OR leave 'Aggregate' selected to let the backend
          add/consume via FIFO/FEFO. The currently-selected target's stock
          drives the New Quantity field. */}
      <Modal open={!!showAdj} onClose={() => setShowAdj(null)} title="Stock Adjustment" icon="⚖" size={showAdj?.batch_tracking ? 'md' : 'sm'}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdj(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveAdj}>Save Adjustment</button>
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
              <select className="form-input" value={adjReason} onChange={(e) => setAdjReason(e.target.value)}>
                {['Physical count', 'Damaged / Spoilage', 'Theft / Shrinkage', 'Data correction', 'Expiry removal', 'Other'].map((r) => <option key={r}>{r}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Notes">
              <textarea className="form-input" placeholder="Optional notes about this adjustment" style={{ height: 60 }} />
            </FormGroup>
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
      <Modal open={showAdjSelect} onClose={() => setShowAdjSelect(false)} title="Select Item to Adjust Stock" icon="⚖" size="md"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdjSelect(false)}>Close</button>
        </>}>
        <SearchBar value={adjSelectSearch} onChange={setAdjSelectSearch} placeholder="Search by name, SKU, or barcode…" />
        <div style={{ marginTop: 12, maxHeight: 400, overflowY: 'auto' }}>
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
        </div>
      </Modal>

      {/* Per-item batch viewer / quick-add */}
      <BatchesModal
        item={batchesModal}
        branchId={branchFilter}
        onClose={() => setBatchesModal(null)}
        onChanged={async () => {
          await fetchItems()
          await loadNearExpiry()
        }}
        canAdd={can('items.adjust')}
      />
    </div>
  )
}

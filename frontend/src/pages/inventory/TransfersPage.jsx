import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { transfersAPI, branchesAPI, itemsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow, KPICard, EmptyState, AlertBar, PaginationBar, SortableHeader } from '@/components/ui'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import { DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import { fmtDate } from '@/utils/helpers'
import {
  allocatableBatches,
  computeAutoAllocation,
  isAllocationValid,
  allocationSum,
  toApiPayload,
  formatAllocationSummary,
} from '@/utils/batchAllocation'

const TABS = [
  { id: 'all',      label: 'All Transfers' },
  { id: 'pending',  label: 'Pending Approval' },
  { id: 'transit',  label: 'In Transit' },
  { id: 'received', label: 'Received' },
]

const STEPS = [
  { n: 1, title: 'Create Request', desc: 'Source branch initiates transfer request with items and quantities' },
  { n: 2, title: 'Manager Approval', desc: 'Branch manager or super admin reviews and approves/rejects' },
  { n: 3, title: 'Issue & Dispatch', desc: 'Source branch picks items, updates stock, marks dispatched' },
  { n: 4, title: 'Receive & Confirm', desc: 'Destination branch receives, counts, confirms — stock auto-updated' },
]

export default function TransfersPage() {
  const can = useCan()
  const [tab, setTab]           = useState('all')
  const [showNew, setShowNew]   = useState(false)
  const [showDetail, setShowDetail] = useState(null)
  const [transfers, setTransfers] = useState([])
  const [trSkip, setTrSkip] = useState(0)
  const [trLimit, setTrLimit] = useState(DEFAULT_PAGE_SIZE)
  const [trSortBy, setTrSortBy] = useState('created_at')
  const [trSortOrder, setTrSortOrder] = useState('desc')
  const [branches, setBranches] = useState([])
  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [newForm, setNewForm]   = useState({
    from_branch_id: 'br-001', to_branch_id: 'br-002', priority: 'Normal', notes: '',
    items: [{ item_id: '', qty: '', batchAllocation: [], batchAllocationCustom: false }],
  })
  // Cache of `${itemId}|${branchId}` → batch list, populated lazily when the
  // operator picks a tracked item in the New Transfer form. Avoids hitting
  // /items/{id}/batches on every render.
  const [batchOptions, setBatchOptions] = useState({})
  // Active allocation editor target — `{ index }` when open. Mirrors the
  // POS pattern: a single shared modal driven by a row pointer.
  const [allocEditor, setAllocEditor] = useState(null)

  const fetchData = useCallback(async (branchForItems = 'br-001') => {
    try {
      setLoading(true)
      const [transfersData, branchesData, itemsData] = await Promise.all([
        fetchAllList(transfersAPI.list),
        fetchAllList(branchesAPI.list).catch(() => []),
        fetchAllList(itemsAPI.list, { branch_id: branchForItems }).catch(() => []),
      ])
      setTransfers(transfersData || [])
      setBranches(branchesData || [])
      setItems(itemsData || [])
    } catch (err) {
      console.error('Failed to fetch transfers:', err)
      setTransfers([])
      toast.error('Failed to load transfers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Refresh the item list whenever the operator changes the source branch in
  // the New Transfer form — stock counts and batch availability are per-branch.
  useEffect(() => {
    if (!showNew) return
    fetchAllList(itemsAPI.list, { branch_id: newForm.from_branch_id })
      .then((rows) => setItems(rows || []))
      .catch(() => { /* keep existing items on failure */ })
    // Branch changed → every cached batch list AND every per-row
    // `batchAllocation` is now stale (the batch IDs refer to lots at the
    // PREVIOUS source branch). We must blow both away. Without clearing
    // the allocation, the auto-allocation effect would short-circuit
    // (its `batches.length === 0` guard fires while the new-branch cache
    // is still empty) and the stale batch IDs would survive submit. On
    // approve, the backend would detect the branch mismatch and — in its
    // legacy error path — zero out ALL stock for that item at the actual
    // source branch. Destructive data loss; see backend safety net in
    // transfers.approve_transfer.
    setBatchOptions({})
    setNewForm((f) => ({
      ...f,
      items: f.items.map((row) => (
        row.item_id
          ? { ...row, batchAllocation: [], batchAllocationCustom: false }
          : row
      )),
    }))
  }, [showNew, newForm.from_branch_id])

  const loadBatchesForRow = useCallback(async (itemId) => {
    if (!itemId) return null
    const key = `${itemId}|${newForm.from_branch_id}`
    if (batchOptions[key]) return batchOptions[key]
    try {
      const data = await itemsAPI.batches.list(itemId, { branch_id: newForm.from_branch_id })
      const rows = allocatableBatches(data?.items || [])
      setBatchOptions((prev) => ({ ...prev, [key]: rows }))
      return rows
    } catch {
      setBatchOptions((prev) => ({ ...prev, [key]: [] }))
      return []
    }
  }, [batchOptions, newForm.from_branch_id])

  // Auto-allocate FIFO/FEFO whenever a row's batch list or qty changes and the
  // operator hasn't locked the split via the modal. Mirrors CartRow's effect.
  //
  // Also kicks off a lazy fetch for any row whose (item, branch) batches
  // aren't cached yet — covers the case where the operator changed the
  // source branch AFTER selecting items, in which case loadBatchesForRow
  // never fires from the row's item-select onChange. Without this fetch,
  // the new-branch cache stays empty, the short-circuit below skips the
  // row, and the row's allocation stays empty → submit is blocked (which
  // is correct) but the user has no way out other than reselecting items.
  useEffect(() => {
    if (!showNew) return
    let mutated = false
    const next = newForm.items.map((row) => {
      if (!row.item_id || row.batchAllocationCustom) return row
      const picked = items.find((x) => x.id === row.item_id)
      if (!picked?.batch_tracking) return row
      const key = `${row.item_id}|${newForm.from_branch_id}`
      const batches = batchOptions[key]
      if (batches === undefined) {
        // Not in cache yet — trigger a fetch and let this effect re-run
        // when batchOptions updates.
        loadBatchesForRow(row.item_id)
        return row
      }
      if (batches.length === 0) return row
      const auto = computeAutoAllocation(batches, Number(row.qty) || 0)
      const same = JSON.stringify(auto) === JSON.stringify(row.batchAllocation || [])
      if (same) return row
      mutated = true
      return { ...row, batchAllocation: auto }
    })
    if (mutated) setNewForm((f) => ({ ...f, items: next }))
  }, [showNew, newForm.items, newForm.from_branch_id, batchOptions, items, loadBatchesForRow])

  useEffect(() => {
    setTrSkip(0)
  }, [tab])

  const patchForm = (k, v) => setNewForm((f) => ({ ...f, [k]: v }))

  const filtered = useMemo(() => {
    const base = tab === 'all' ? transfers : transfers.filter((t) => t.status === tab)
    // Client-side sort (same reasoning as ItemsPage — page uses fetchAllList).
    const dir = trSortOrder === 'desc' ? -1 : 1
    const valueOf = (row) => row[trSortBy] ?? ''
    return [...base].sort((a, b) => {
      const av = valueOf(a)
      const bv = valueOf(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [transfers, tab, trSortBy, trSortOrder])

  const onSort = (key) => {
    setTrSkip(0)
    if (trSortBy === key) {
      setTrSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setTrSortBy(key)
    setTrSortOrder(key === 'created_at' ? 'desc' : 'asc')
  }

  const pageRows = useMemo(
    () => filtered.slice(trSkip, trSkip + trLimit),
    [filtered, trSkip, trLimit]
  )

  const approve = async (id) => {
    try {
      await transfersAPI.approve(id)
      await fetchData()
      toast.success('Transfer approved & dispatched')
    } catch (err) {
      console.error('Failed to approve transfer:', err)
      toast.error('Failed to approve transfer')
    }
  }

  const receive = async (id) => {
    try {
      await transfersAPI.receive(id)
      await fetchData()
      toast.success('Stock received & inventory updated')
    } catch (err) {
      console.error('Failed to receive transfer:', err)
      toast.error('Failed to receive transfer')
    }
  }

  const submitNew = async () => {
    if (newForm.from_branch_id === newForm.to_branch_id) { toast.error('From and To branches must differ'); return }
    // Validate every tracked row's allocation matches its qty before posting.
    for (const row of newForm.items) {
      if (!row.item_id) continue
      const picked = items.find((x) => x.id === row.item_id)
      if (!picked?.batch_tracking) continue
      const need = Number(row.qty) || 0
      if (!isAllocationValid(row.batchAllocation || [], need)) {
        toast.error(`Fix batch split for ${picked.name} — ${allocationSum(row.batchAllocation || [])}/${need} allocated`)
        return
      }
      // Defense in depth: every allocation batch_id must exist in the CURRENT
      // (new branch) cache. Catches the case where someone managed to keep a
      // stale allocation referencing the previous source branch's lots.
      // Without this, the backend would 400 (or worse — see backend safety
      // net) on approve.
      const key = `${row.item_id}|${newForm.from_branch_id}`
      const known = new Set((batchOptions[key] || []).map((b) => b.id))
      if (known.size === 0) {
        toast.error(`Loading batches for ${picked.name}, please retry in a moment`)
        return
      }
      for (const entry of row.batchAllocation || []) {
        if (!known.has(entry.id)) {
          toast.error(`Stale batch in ${picked.name} — re-select the item to refresh`)
          return
        }
      }
    }
    try {
      await transfersAPI.create({
        from_branch_id: newForm.from_branch_id,
        to_branch_id: newForm.to_branch_id,
        items: newForm.items.filter((i) => i.item_id).map(i => {
          const itm = items.find(x => x.id === i.item_id)
          return {
            item_id: i.item_id,
            item_name: itm?.name || 'Unknown',
            qty: Number(i.qty),
            // Explicit operator split — backend consumes these batches in
            // this order on approve. Untracked items send undefined and
            // fall through to the aggregate path.
            batch_allocation: toApiPayload(i.batchAllocation),
          }
        }),
        requested_by: 'Current User',
        notes: newForm.notes,
      })
      await fetchData(newForm.from_branch_id)
      setShowNew(false)
      toast.success('Transfer submitted')
    } catch (err) {
      console.error('Failed to create transfer:', err)
      toast.error('Failed to create transfer')
    }
  }

  const addItemRow = () => setNewForm((f) => ({
    ...f,
    items: [...f.items, { item_id: '', qty: '', batchAllocation: [], batchAllocationCustom: false }],
  }))
  const patchItem  = (i, k, v) => setNewForm((f) => ({
    ...f,
    items: f.items.map((it, idx) => {
      if (idx !== i) return it
      // Clear the allocation whenever the item changes — batches belong to a
      // specific item, so the previous split becomes meaningless. Same for
      // qty: reset custom so the auto-effect re-flows the split.
      if (k === 'item_id') return { ...it, item_id: v, batchAllocation: [], batchAllocationCustom: false }
      if (k === 'qty') return { ...it, qty: v, batchAllocationCustom: false }
      return { ...it, [k]: v }
    }),
  }))

  const pending  = transfers.filter((t) => t.status === 'pending').length
  const transit  = transfers.filter((t) => t.status === 'transit').length
  const received = transfers.filter((t) => t.status === 'received').length

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading transfers...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Stock Transfers" subtitle="Move stock between branches with approval workflow">
        {can('transfers.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New Transfer</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Pending Approval" value={pending}  color="var(--amber)" icon="⏳" />
        <KPICard label="In Transit"       value={transit}  color="var(--blue)"  icon="🚚" />
        <KPICard label="Received (Apr)"   value={received} color="var(--green)" icon="✅" />
        <KPICard label="Total"            value={transfers.length} color="var(--accent)" icon="↔" sub="all transfers" />
      </div>

      {pending > 0 && <AlertBar type="amber" icon="⚠️" style={{ marginBottom: 16 }}>
        {pending} transfer request{pending > 1 ? 's' : ''} awaiting your approval.
      </AlertBar>}

      <div className="grid-65" style={{ alignItems: 'start' }}>
        <div>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          <Card bodyPadding={false}>
            {filtered.length === 0 ? <EmptyState icon="↔" title="No transfers" desc="No transfers match this filter" /> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Ref #" sortKey="ref_number" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                    <SortableHeader label="From → To" sortKey="from_branch_id" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                    <th>Items</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                    <SortableHeader label="Date" sortKey="created_at" sortBy={trSortBy} sortOrder={trSortOrder} onSort={onSort} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((t) => (
                    <tr key={t.id}>
                      <td><span className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{t.number || t.ref_number}</span></td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{t.from_branch_name || t.from_branch_id}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>→ {t.to_branch_name || t.to_branch_id}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 13 }}>{t.items?.length || 0} item{t.items?.length !== 1 ? 's' : ''}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.items?.map((i) => i.name?.split(' ')[0]).join(', ')}</div>
                      </td>
                      <td>
                        <Chip status={t.status === 'received' ? 'received' : t.status === 'transit' ? 'transit' : t.status === 'pending' ? 'pending' : 'draft'} label={t.status === 'transit' ? 'In Transit' : t.status?.charAt(0).toUpperCase() + t.status?.slice(1)} />
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.date || 'N/A'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(t)}>View</button>
                          {t.status === 'pending'  && can('transfers.approve') && <button className="btn btn-primary btn-xs" onClick={() => approve(t.id)}>Approve</button>}
                          {t.status === 'transit'  && can('transfers.receive') && <button className="btn btn-success btn-xs" onClick={() => receive(t.id)}>Receive</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={filtered.length}
              skip={trSkip}
              limit={trLimit}
              onSkipChange={setTrSkip}
              onLimitChange={setTrLimit}
              disabled={loading}
            />
          </Card>
        </div>

        {/* Transfer workflow steps */}
        <Card title="Transfer Workflow">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {STEPS.map((s) => (
              <div key={s.n} style={{ display: 'flex', gap: 12, padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--accent-bg)', border: '1.5px solid var(--accent)', color: 'var(--accent)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.n}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Stock is reserved at source on approval and deducted on dispatch. Destination branch receives and confirms quantity. Discrepancies are flagged for review.
          </div>
        </Card>
      </div>

      {/* New Transfer Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Stock Transfer Request" icon="↔" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={submitNew}>Submit Request</button>
        </>}>
        <FormRow>
          <FormGroup label="From Branch">
            <select className="form-input" value={newForm.from_branch_id} onChange={(e) => patchForm('from_branch_id', e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </FormGroup>
          <FormGroup label="To Branch">
            <select className="form-input" value={newForm.to_branch_id} onChange={(e) => patchForm('to_branch_id', e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </FormGroup>
        </FormRow>

        <div style={{ marginBottom: 14 }}>
          <div className="form-label">Items to Transfer</div>
          <AlertBar type="blue" icon="🧴">
            Tracked items auto-split by <strong>FIFO/FEFO</strong>. Click the ✎ to
            override the split across multiple batches — the receiving branch
            inherits the exact lot metadata of every batch you draw from.
          </AlertBar>
          {newForm.items.map((row, i) => {
            const picked = items.find((x) => x.id === row.item_id)
            const tracked = Boolean(picked?.batch_tracking)
            const expiryTracked = Boolean(picked?.expiry_tracking)
            const strategy = expiryTracked ? 'FEFO' : 'FIFO'
            const key = row.item_id ? `${row.item_id}|${newForm.from_branch_id}` : null
            const batches = key ? (batchOptions[key] || []) : []
            const allocation = row.batchAllocation || []
            const need = Number(row.qty) || 0
            const valid = isAllocationValid(allocation, need)
            return (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px auto', gap: 8 }}>
                  <select
                    className="form-input"
                    value={row.item_id}
                    onChange={(e) => {
                      patchItem(i, 'item_id', e.target.value)
                      if (e.target.value) loadBatchesForRow(e.target.value)
                    }}
                  >
                    <option value="">Select item…</option>
                    {items.map((itm) => (
                      <option key={itm.id} value={itm.id}>
                        {itm.name}{itm.batch_tracking ? ` · ${itm.expiry_tracking ? 'FEFO' : 'FIFO'}` : ''}
                      </option>
                    ))}
                  </select>
                  <input className="form-input" type="number" placeholder="Qty" value={row.qty} onChange={(e) => patchItem(i, 'qty', e.target.value)} />
                  <button className="btn btn-ghost btn-sm" onClick={() => setNewForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }))}>✕</button>
                </div>
                {tracked && row.item_id && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, paddingLeft: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 5px', borderRadius: 3, background: expiryTracked ? 'rgba(245,158,11,0.15)' : 'var(--accent-bg)', color: expiryTracked ? 'var(--amber)' : 'var(--accent)', letterSpacing: 0.3 }}>
                      {strategy}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Source batches:</span>
                    {batches.length === 0 ? (
                      <span style={{ fontSize: 11, color: 'var(--amber)' }}>none available at source</span>
                    ) : allocation.length === 0 ? (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>enter a qty…</span>
                    ) : (
                      <span style={{ fontSize: 11, fontFamily: 'DM Mono, monospace', color: valid ? 'var(--text-secondary)' : 'var(--red)' }}>
                        {formatAllocationSummary(allocation)}
                      </span>
                    )}
                    {row.batchAllocationCustom && (
                      <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--text-secondary)', letterSpacing: 0.4 }}>CUSTOM</span>
                    )}
                    {!valid && allocation.length > 0 && (
                      <span style={{ fontSize: 10.5, color: 'var(--red)' }}>⚠ {allocationSum(allocation)} / {need}</span>
                    )}
                    {batches.length > 0 && need > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        title="Edit batch split"
                        onClick={async () => {
                          const rows = await loadBatchesForRow(row.item_id)
                          setAllocEditor({
                            index: i,
                            batches: rows || batches,
                            itemName: picked?.name || 'Item',
                            expiryTracking: expiryTracked,
                          })
                        }}
                        style={{ fontSize: 10.5, padding: '2px 6px' }}
                      >
                        ✎ Edit split
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <button className="btn btn-ghost btn-sm" onClick={addItemRow}>+ Add item</button>
        </div>

        <FormRow>
          <FormGroup label="Priority">
            <select className="form-input" value={newForm.priority} onChange={(e) => patchForm('priority', e.target.value)}>
              {['Normal', 'Urgent', 'Planned'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </FormGroup>
          <FormGroup label="Expected Dispatch Date">
            <input className="form-input" type="date" />
          </FormGroup>
        </FormRow>
        <FormGroup label="Notes">
          <textarea className="form-input" placeholder="Reason for transfer, special instructions…" value={newForm.notes} onChange={(e) => patchForm('notes', e.target.value)} style={{ height: 72 }} />
        </FormGroup>
      </Modal>

      {/* Per-line batch allocation editor for the New Transfer form. Saving
          flips `batchAllocationCustom` so the auto-FIFO/FEFO effect leaves
          this row alone until qty/item changes. */}
      <BatchAllocationModal
        open={!!allocEditor}
        onClose={() => setAllocEditor(null)}
        item={allocEditor ? { name: allocEditor.itemName, emoji: '🧴', expiry_tracking: allocEditor.expiryTracking } : null}
        qty={allocEditor ? Number(newForm.items[allocEditor.index]?.qty || 0) : 0}
        batches={allocEditor?.batches || []}
        allocation={allocEditor ? (newForm.items[allocEditor.index]?.batchAllocation || []) : []}
        strategyLabel={allocEditor?.expiryTracking ? 'FEFO' : 'FIFO'}
        onSave={(next) => {
          if (!allocEditor) return
          setNewForm((f) => ({
            ...f,
            items: f.items.map((it, idx) => idx === allocEditor.index
              ? { ...it, batchAllocation: next, batchAllocationCustom: true }
              : it),
          }))
          setAllocEditor(null)
          toast.success('Batch split saved')
        }}
      />

      {/* Detail Drawer */}
      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title={`Transfer — ${showDetail?.number || showDetail?.ref_number}`} icon="↔" size="md"
        footer={<button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>}>
        {showDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'From', value: showDetail.from_branch_name || showDetail.from_branch_id },
                { label: 'To', value: showDetail.to_branch_name || showDetail.to_branch_id },
                { label: 'Status', value: <Chip status={showDetail.status === 'received' ? 'received' : showDetail.status === 'transit' ? 'transit' : 'pending'} label={showDetail.status?.charAt(0).toUpperCase() + showDetail.status?.slice(1)} /> },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            {showDetail.items?.length > 0 && (
              <>
                <div className="form-label" style={{ marginBottom: 8 }}>Items</div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="text-right">Qty</th>
                      <th>Source batches drained</th>
                    </tr>
                  </thead>
                  <tbody>
                    {showDetail.items.map((item, idx) => {
                      // Approved/received: actual lots drained at source.
                      // Pending: operator-pre-allocated split (if any).
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
                          <td className="text-right mono">{item.qty}</td>
                          <td>
                            {lots.length === 0 ? (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {showDetail.status === 'pending' ? '— auto-allocate on approval' : 'untracked / no allocation'}
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
                                      <span style={{ color: 'var(--text-muted)' }}>×{b.consumed}</span>
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
                {showDetail.status === 'received' && showDetail.items.some((it) => it.batches?.length) && (
                  <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg-raised)', borderRadius: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    ℹ Each batch above was recreated at <strong>{showDetail.to_branch_name || showDetail.to_branch_id}</strong> with the original
                    lot number, mfg / expiry date and cost — so FIFO/FEFO ordering carries across the transfer.
                  </div>
                )}
              </>
            )}
            {showDetail.notes && <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>{showDetail.notes}</div>}
          </>
        )}
      </Modal>
    </div>
  )
}

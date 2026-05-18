import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { transfersAPI, branchesAPI, itemsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow, KPICard, EmptyState, AlertBar, PaginationBar, SortableHeader } from '@/components/ui'
import { DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'

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
  const [newForm, setNewForm]   = useState({ from_branch_id: 'br-001', to_branch_id: 'br-002', priority: 'Normal', notes: '', items: [{ item_id: '', qty: '' }] })

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [transfersData, branchesData, itemsData] = await Promise.all([
        fetchAllList(transfersAPI.list),
        fetchAllList(branchesAPI.list).catch(() => []),
        fetchAllList(itemsAPI.list, { branch_id: 'br-001' }).catch(() => []),
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
    try {
      await transfersAPI.create({
        from_branch_id: newForm.from_branch_id,
        to_branch_id: newForm.to_branch_id,
        items: newForm.items.filter((i) => i.item_id).map(i => {
          const itm = items.find(x => x.id === i.item_id)
          return {
            item_id: i.item_id,
            item_name: itm?.name || 'Unknown',
            qty: Number(i.qty)
          }
        }),
        requested_by: 'Current User',
        notes: newForm.notes,
      })
      await fetchData()
      setShowNew(false)
      toast.success('Transfer submitted')
    } catch (err) {
      console.error('Failed to create transfer:', err)
      toast.error('Failed to create transfer')
    }
  }

  const addItemRow = () => setNewForm((f) => ({ ...f, items: [...f.items, { item_id: '', qty: '' }] }))
  const patchItem  = (i, k, v) => setNewForm((f) => ({ ...f, items: f.items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) }))

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
          {newForm.items.map((item, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 100px auto', gap: 8, marginBottom: 6 }}>
              <select className="form-input" value={item.item_id} onChange={(e) => patchItem(i, 'item_id', e.target.value)}>
                <option value="">Select item…</option>
                {items.map((itm) => (
                  <option key={itm.id} value={itm.id}>{itm.name}</option>
                ))}
              </select>
              <input className="form-input" type="number" placeholder="Qty" value={item.qty} onChange={(e) => patchItem(i, 'qty', e.target.value)} />
              <button className="btn btn-ghost btn-sm" onClick={() => setNewForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }))}>✕</button>
            </div>
          ))}
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
                  <thead><tr><th>Item</th><th className="text-right">Qty</th></tr></thead>
                  <tbody>
                    {showDetail.items.map((item, idx) => (
                      <tr key={idx}><td>{item.name || 'Unknown'}</td><td className="text-right mono">{item.qty}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {showDetail.notes && <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>{showDetail.notes}</div>}
          </>
        )}
      </Modal>
    </div>
  )
}

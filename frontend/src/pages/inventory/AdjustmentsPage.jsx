import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { adjustmentsAPI, branchesAPI, itemsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { useAppStore } from '@/store'
import {
  SectionHeader, Card, Tabs, Chip, Modal, FormGroup, FormRow,
  KPICard, EmptyState, AlertBar, PaginationBar, SortableHeader,
} from '@/components/ui'
import { DEFAULT_PAGE_SIZE, fetchAllList, unwrapPaged } from '@/utils/pagination'
import { fmtDate, fmtDateTime } from '@/utils/helpers'
import RowActionsMenu from './RowActionsMenu'

const TABS = [
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
  const [tab, setTab] = useState('all')
  const [requests, setRequests] = useState([])
  const [listTotal, setListTotal] = useState(0)
  const [summary, setSummary] = useState(null)
  const [listVersion, setListVersion] = useState(0)
  const [branches, setBranches] = useState([])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
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

  const bumpList = useCallback(() => setListVersion((v) => v + 1), [])

  useEffect(() => {
    fetchAllList(branchesAPI.list)
      .then((rows) => setBranches(rows || []))
      .catch(() => setBranches([]))
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const raw = await adjustmentsAPI.list({
          skip,
          limit,
          sort_by: sortBy,
          sort_order: sortOrder,
          status: tab === 'all' ? undefined : tab,
        })
        const { items, total, summary: s } = unwrapPaged(raw)
        if (!cancelled) {
          setRequests(items || [])
          setListTotal(total)
          setSummary(s)
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
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, skip, limit, sortBy, sortOrder, listVersion])

  const loadItems = useCallback(async (branchId) => {
    try {
      const rows = await fetchAllList(itemsAPI.list, { branch_id: branchId })
      setItems(rows || [])
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => {
    if (!showNew) return
    loadItems(newForm.branch_id)
  }, [showNew, newForm.branch_id, loadItems])

  const picked = items.find((x) => x.id === newForm.item_id)

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

  const pending = summary?.pending ?? 0
  const approved = summary?.approved ?? 0
  const rejected = summary?.rejected ?? 0
  const totalAll = summary?.total ?? 0

  const submitNew = async () => {
    if (!newForm.item_id) { toast.error('Select an item'); return }
    if (newForm.new_qty === '' || newForm.new_qty === null) { toast.error('Enter new quantity'); return }
    const item = items.find((x) => x.id === newForm.item_id)
    if (!item) return
    try {
      await adjustmentsAPI.create({
        branch_id: newForm.branch_id,
        item_id: newForm.item_id,
        item_name: item.name,
        new_qty: Number(newForm.new_qty),
        reason: newForm.reason,
        notes: newForm.notes || undefined,
        batch_id: newForm.batch_id || undefined,
        requested_by: user?.name || 'Staff',
      })
      toast.success('Adjustment request submitted for approval')
      setShowNew(false)
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
      toast.error('Failed to submit request')
    }
  }

  const approve = async (id) => {
    try {
      await adjustmentsAPI.approve(id, { approved_by: user?.name || 'Manager' })
      toast.success('Adjustment approved — stock updated')
      bumpList()
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error('Failed to approve')
    }
  }

  const reject = async (id) => {
    try {
      await adjustmentsAPI.reject(id, {
        rejected_by: user?.name || 'Manager',
        rejection_notes: 'Rejected by manager',
      })
      toast.success('Request rejected')
      bumpList()
      setShowDetail(null)
    } catch (err) {
      console.error(err)
      toast.error('Failed to reject')
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{ padding: 40, textAlign: 'center' }}>Loading adjustments…</div></div>
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

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Pending Approval" value={pending} color="var(--amber)" icon="⏳" />
        <KPICard label="Approved" value={approved} color="var(--green)" icon="✅" />
        <KPICard label="Rejected" value={rejected} color="var(--text-muted)" icon="✕" />
        <KPICard label="Total" value={totalAll} color="var(--accent)" icon="⚖" sub="all requests" />
      </div>

      {pending > 0 && can('adjustments.approve') && (
        <AlertBar type="amber" icon="⚠️" style={{ marginBottom: 16 }}>
          {pending} adjustment request{pending > 1 ? 's' : ''} awaiting your approval.
        </AlertBar>
      )}

      <div className="" style={{ alignItems: 'start' }}>
        <div>
          <Tabs tabs={TABS} active={tab} onChange={(t) => { setTab(t); setSkip(0) }} />
          <Card bodyPadding={false}>
            {requests.length === 0 ? (
              <EmptyState icon="⚖" title="No requests" desc="No adjustment requests match this filter" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Ref #" sortKey="ref_number" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort} />
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
                      <td><span className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{r.ref_number}</span></td>
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
                          ariaLabel={`Actions for ${r.ref_number}`}
                          actions={[
                            {
                              label: 'View details',
                              onClick: () => setShowDetail(r),
                            },
                            {
                              label: 'Approve',
                              hidden: r.status !== 'pending' || !can('adjustments.approve'),
                              onClick: () => approve(r.id),
                            },
                            {
                              label: 'Reject',
                              danger: true,
                              hidden: r.status !== 'pending' || !can('adjustments.approve'),
                              onClick: () => reject(r.id),
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
              disabled={loading}
            />
          </Card>
        </div>
      </div>

      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Stock Adjustment Request" icon="⚖" size="md"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={submitNew}>Submit for Approval</button>
        </>}>
        <FormRow>
          <FormGroup label="Branch">
            <select
              className="form-input"
              value={newForm.branch_id}
              onChange={(e) => setNewForm((f) => ({ ...f, branch_id: e.target.value, item_id: '', batch_id: '' }))}
            >
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </FormGroup>
          <FormGroup label="Item" required>
            <select
              className="form-input"
              value={newForm.item_id}
              onChange={(e) => {
                const it = items.find((x) => x.id === e.target.value)
                setNewForm((f) => ({
                  ...f,
                  item_id: e.target.value,
                  batch_id: '',
                  new_qty: it ? String(it.available_stock ?? 0) : '',
                }))
              }}
            >
              <option value="">Select item…</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} — stock {it.available_stock ?? 0}
                </option>
              ))}
            </select>
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
          <select className="form-input" value={newForm.reason} onChange={(e) => setNewForm((f) => ({ ...f, reason: e.target.value }))}>
            {REASONS.map((r) => <option key={r}>{r}</option>)}
          </select>
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

      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title="Adjustment Request" icon="⚖" size="md"
        footer={showDetail?.status === 'pending' && can('adjustments.approve') ? (
          <>
            <button className="btn btn-secondary" onClick={() => reject(showDetail.id)}>Reject</button>
            <button className="btn btn-primary" onClick={() => approve(showDetail.id)}>Approve</button>
          </>
        ) : (
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
        )}>
        {showDetail && (
          <>
            <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 16 }}>
              <div><strong>Ref:</strong> <span className="mono">{showDetail.ref_number}</span></div>
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
    </div>
  )
}

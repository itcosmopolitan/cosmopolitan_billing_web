import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { itemsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, fmtDate, stockStatus } from '@/utils/helpers'
import { Chip, Tag, EmptyState } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'
import { unwrapPaged } from '@/utils/pagination'

const TABS = [
  { id: 'overview', label: 'Item details' },
  { id: 'branches', label: 'Branch pricing' },
  { id: 'batches', label: 'Batches' },
]

function statusChip(item) {
  const s = (item?.status || item?.approval_status || (item?.active === false ? 'inactive' : 'approved'))
  const label = String(s).charAt(0).toUpperCase() + String(s).slice(1)
  const chipStatus = s === 'approved' || s === 'active' ? 'active'
    : s === 'pending' || s === 'pending_approval' ? 'pending'
      : s === 'rejected' ? 'draft'
        : 'draft'
  return <Chip status={chipStatus} label={label} />
}

export default function ItemDetailPanel({
  item,
  open,
  onClose,
  mode = 'branch',
  onApprove,
  onReject,
  onDelete,
  actionBusy = false,
}) {
  const can = useCan()
  const navigate = useNavigate()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const isMaster = mode === 'master'
  const [tab, setTab] = useState('overview')
  const [detail, setDetail] = useState(item)
  const [branches, setBranches] = useState([])
  const [branchMeta, setBranchMeta] = useState(null)
  const [batches, setBatches] = useState([])
  const [loadingExtra, setLoadingExtra] = useState(false)

  useEffect(() => {
    if (!open || !item?.id) return
    setTab('overview')
    setDetail(item)
    let cancelled = false
    ;(async () => {
      setLoadingExtra(true)
      try {
        const [full, branchRes, batchRes] = await Promise.all([
          itemsAPI.get(item.id).catch(() => item),
          itemsAPI.getBranches(item.id).catch(() => null),
          item.batch_tracking
            ? itemsAPI.batches.list(item.id, {
              branch_id: isMaster ? undefined : activeBranch?.id,
              include_zero: true,
            }).catch(() => ({ items: [] }))
            : Promise.resolve({ items: [] }),
        ])
        if (cancelled) return
        setDetail({ ...item, ...full })
        setBranchMeta(branchRes)
        setBranches(branchRes?.branches || [])
        const batchItems = Array.isArray(batchRes) ? batchRes : (unwrapPaged(batchRes).items || batchRes?.items || [])
        setBatches(batchItems)
      } finally {
        if (!cancelled) setLoadingExtra(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, item?.id, item?.batch_tracking, isMaster, activeBranch?.id])

  const stockOnHand = useMemo(() => {
    if (!isMaster) return Number(detail?.available_stock ?? item?.available_stock ?? 0)
    return branches.reduce((sum, b) => sum + Number(b.available_stock || 0), 0)
  }, [isMaster, detail, item, branches])

  const listedBranches = branches.filter((b) => b.is_available).length
  const { label: stockLabel } = stockStatus(stockOnHand, detail?.reorder_level ?? detail?.default_reorder_level ?? 10)

  const summary = [
    { label: 'Stock on hand', value: stockOnHand },
    { label: 'Retail price', value: fmt(detail?.default_selling_price ?? detail?.selling_price) },
    { label: 'Cost', value: fmt(detail?.default_cost_price ?? detail?.cost_price) },
    {
      label: isMaster ? 'Listed branches' : 'Stock status',
      value: isMaster ? listedBranches : stockLabel,
      tone: !isMaster && stockLabel !== 'In Stock' ? 'var(--amber)' : undefined,
    },
  ]

  const headerActions = (
    <>
      {isMaster && can('item_master.edit') && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={actionBusy}
          onClick={() => {
            onClose?.()
            navigate(`/item-master/${detail?.id || item?.id}/edit`)
          }}
        >
          Edit item
        </button>
      )}
      {!isMaster && detail?.batch_tracking && can('items.view') && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setTab('batches')}
        >
          View batches
        </button>
      )}
    </>
  )

  const pending = (detail?.status || detail?.approval_status) === 'pending'
    || (detail?.status || detail?.approval_status) === 'pending_approval'

  const footer = pending && isMaster ? (
    <>
      {can('item_master.delete') && (
        <button type="button" className="btn btn-secondary" style={{ color: 'var(--red)', marginRight: 'auto' }} disabled={actionBusy} onClick={() => onDelete?.(detail)}>
          Delete
        </button>
      )}
      {can('item_master.approve') && (
        <>
          <button type="button" className="btn btn-secondary" disabled={actionBusy} onClick={() => onReject?.(detail)}>Reject</button>
          <button type="button" className="btn btn-primary" disabled={actionBusy} onClick={() => onApprove?.(detail)}>Approve</button>
        </>
      )}
    </>
  ) : null

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon={detail?.emoji || '📦'}
      title={detail?.name || 'Item'}
      subtitle={[detail?.sku, detail?.categoryName || detail?.category?.name].filter(Boolean).join(' · ') || 'Item details'}
      size="lg"
      summary={summary}
      tabs={TABS.filter((t) => t.id !== 'batches' || detail?.batch_tracking)}
      activeTab={tab}
      onTabChange={setTab}
      headerActions={headerActions}
      footer={footer}
      busy={actionBusy}
    >
      {loadingExtra && (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Loading details…</div>
      )}

      {tab === 'overview' && (
        <>
          <DetailSection title="General details">
            <DetailFields fields={[
              { label: 'Item name', value: detail?.name },
              { label: 'SKU', value: <span className="mono">{detail?.sku || '—'}</span> },
              { label: 'Barcode', value: detail?.barcode || '—' },
              { label: 'Category', value: detail?.categoryName || detail?.category?.name || '—' },
              { label: 'Brand', value: detail?.brand || '—' },
              { label: 'Unit', value: detail?.unit || '—' },
              { label: 'HSN code', value: detail?.hsn_code || '—' },
              { label: 'Country of origin', value: detail?.country_of_origin || '—' },
              { label: 'Tax rate', value: detail?.tax_rate != null ? `${detail.tax_rate}%` : '—' },
              { label: 'Status', value: statusChip(detail) },
              { label: 'Created by', value: detail?.created_by || '—' },
              { label: 'Packaging', value: detail?.is_packaging ? `Yes (${detail.packaging_quantity || '—'} per pack)` : 'No' },
            ]}
            />
          </DetailSection>

          <DetailSection title="Pricing">
            <DetailFields fields={[
              { label: 'Default cost (MVR)', value: fmt(detail?.default_cost_price ?? detail?.cost_price) },
              { label: 'Default selling — retail (MVR)', value: fmt(detail?.default_selling_price ?? detail?.selling_price) },
              { label: 'Wholesale discount %', value: `${Number(detail?.wholesale_discount_pct || 0)}%` },
              { label: 'Staff discount %', value: `${Number(detail?.staff_discount_pct || 0)}%` },
              { label: 'Default reorder level', value: detail?.default_reorder_level ?? detail?.reorder_level ?? '—' },
            ]}
            />
          </DetailSection>

          <DetailSection title="Inventory tracking">
            <DetailFields fields={[
              { label: 'Batch / lot tracking', value: detail?.batch_tracking ? 'Enabled' : 'Off' },
              { label: 'Expiry tracking (FEFO)', value: detail?.expiry_tracking ? 'Enabled' : 'Off' },
              { label: 'Strategy', value: detail?.batch_tracking ? (detail?.expiry_tracking ? 'FEFO' : 'FIFO') : 'Aggregate stock' },
            ]}
            />
          </DetailSection>

          {detail?.rejection_reason ? (
            <DetailSection title="Rejection">
              <div style={{ color: 'var(--red)', fontSize: 13 }}>{detail.rejection_reason}</div>
            </DetailSection>
          ) : null}
        </>
      )}

      {tab === 'branches' && (
        <DetailSection title="Per-branch listing & pricing">
          {branches.length === 0 ? (
            <EmptyState icon="🏪" title="No branch data" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Branch</th>
                    <th>Listed</th>
                    <th className="text-right">Stock</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Selling</th>
                    <th className="text-right">Reorder</th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b) => (
                    <tr key={b.branch_id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{b.branch_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{b.branch_code}</div>
                      </td>
                      <td>{b.is_available ? <Tag color="var(--green)">Yes</Tag> : <span style={{ color: 'var(--text-muted)' }}>No</span>}</td>
                      <td className="text-right mono">{b.available_stock ?? 0}</td>
                      <td className="text-right mono">
                        {fmt(b.effective_cost_price)}
                        {b.cost_price != null && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>override</div>}
                      </td>
                      <td className="text-right mono">
                        {fmt(b.effective_selling_price)}
                        {b.selling_price != null && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>override</div>}
                      </td>
                      <td className="text-right mono">{b.effective_reorder_level ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {branchMeta && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                  Catalog defaults — cost {fmt(branchMeta.default_cost_price)}, sell {fmt(branchMeta.default_selling_price)}, reorder {branchMeta.default_reorder_level}
                </div>
              )}
            </div>
          )}
        </DetailSection>
      )}

      {tab === 'batches' && (
        <DetailSection title={isMaster ? 'Batches (all branches)' : `Batches — ${activeBranch?.name || 'current branch'}`}>
          {!detail?.batch_tracking ? (
            <EmptyState icon="🧴" title="Batch tracking is off for this item" />
          ) : batches.length === 0 ? (
            <EmptyState icon="🧴" title="No batches found" />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Batch #</th>
                    {isMaster && <th>Branch</th>}
                    <th className="text-right">Qty</th>
                    <th>Mfg</th>
                    <th>Expiry</th>
                    <th className="text-right">Cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{b.batchNumber || b.batch_number}</td>
                      {isMaster && <td style={{ fontSize: 12 }}>{b.branchName || b.branch_name || b.branch_id || '—'}</td>}
                      <td className="text-right mono">{b.quantity ?? b.qty ?? 0}</td>
                      <td style={{ fontSize: 12 }}>{b.mfgDate || b.mfg_date ? fmtDate(b.mfgDate || b.mfg_date) : '—'}</td>
                      <td style={{ fontSize: 12 }}>{b.expiryDate || b.expiry_date ? fmtDate(b.expiryDate || b.expiry_date) : '—'}</td>
                      <td className="text-right mono">{fmt(b.costPrice ?? b.cost_price)}</td>
                      <td><Chip status={b.active === false ? 'inactive' : 'active'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}

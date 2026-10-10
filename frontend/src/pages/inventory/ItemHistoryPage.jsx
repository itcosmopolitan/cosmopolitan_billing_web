/**
 * Item Transaction History — full-page report-style view.
 *
 * Matches the Reports module UI: section-hdr, filter-toolbar-stack,
 * Card with data-table, drilldown from date-summary → individual transactions.
 *
 * Summary fetches from  /items/{id}/history/summary
 * Drilldown fetches from /items/{id}/history/transactions
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { itemsAPI } from '@/api'
import { useAppStore } from '@/store'
import { fmt, fmtDate, fmtQty } from '@/utils/helpers'
import { DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import {
  Card, DatePicker, AutocompleteDropdown, PaginationBar,
  SortableHeader, TableLoadingPanel,
  PageActionsMenu, buildListPageMenuActions,
} from '@/components/ui'
import * as Icon from '@/components/ui/Icons'

/* ── Category & transaction-type options ──────────────────────────────── */
const CATEGORY_OPTIONS = [
  { id: 'sales',         label: 'Sales' },
  { id: 'purchase',      label: 'Purchase' },
  { id: 'complimentary', label: 'Complimentary' },
  { id: 'transfer',      label: 'Transfer' },
  { id: 'adjustment',    label: 'Adjustment' },
]

const DOC_KIND_MAP = {
  sales:         [{ id: 'Invoice', label: 'Invoice' }, { id: 'Quotation', label: 'Quotation' }, { id: 'Sales Order', label: 'Sales Order' }, { id: 'Sales Return', label: 'Sales Return' }],
  purchase:      [{ id: 'Bill', label: 'Bill' }, { id: 'Purchase Order', label: 'Purchase Order' }, { id: 'GRN', label: 'GRN' }, { id: 'Vendor Return', label: 'Vendor Return' }],
  complimentary: [{ id: 'Complimentary', label: 'Complimentary' }],
  transfer:      [{ id: 'Transfer', label: 'Transfer' }],
  adjustment:    [{ id: 'Adjustment', label: 'Adjustment' }, { id: 'Opening Stock', label: 'Opening Stock' }],
}

/* Summary qty column labels per category */
const QTY_LABELS = {
  sales:         { qty: 'Sold Qty',      ordered: 'Ordered / Quoted Qty' },
  purchase:      { qty: 'Purchased Qty', ordered: 'Ordered Qty' },
  complimentary: { qty: 'Qty',           ordered: null },
  transfer:      { qty: 'Qty',           ordered: null },
  adjustment:    { qty: 'Qty',           ordered: null },
}

/* ── Column definitions ───────────────────────────────────────────────── */
const DETAIL_COLUMNS = [
  { key: 'docKind',   label: 'Type',        align: 'left' },
  { key: 'docNumber', label: 'Document',    align: 'left' },
  { key: 'party',     label: 'Party',       align: 'left' },
  { key: 'qty',       label: 'Qty',         align: 'right' },
  { key: 'amount',    label: 'Amount (MVR)', align: 'right' },
  { key: 'time',      label: 'Time',        align: 'left' },
  { key: 'createdBy', label: 'By',          align: 'left' },
]

/* ── Component ────────────────────────────────────────────────────────── */
export default function ItemHistoryPage() {
  const { itemId } = useParams()
  const navigate = useNavigate()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const isMaster = useAppStore((s) => s.user?.branch_type === 'master')
  const branchId = isMaster ? null : activeBranch?.id

  /* ── Item info ─────────────────────────────────────────────────────── */
  const [itemName, setItemName] = useState('')
  useEffect(() => {
    if (!itemId) return
    itemsAPI.get(itemId)
      .then((r) => setItemName(r?.name || r?.item?.name || ''))
      .catch(() => {})
  }, [itemId])

  /* ── Filters ───────────────────────────────────────────────────────── */
  const [category, setCategory] = useState('sales')
  const [docKind, setDocKind] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const docKindOptions = useMemo(
    () => DOC_KIND_MAP[category] || [],
    [category],
  )

  /* ── Summary state ─────────────────────────────────────────────────── */
  const [summaryRows, setSummaryRows] = useState([])
  const [summaryTotal, setSummaryTotal] = useState(0)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summarySkip, setSummarySkip] = useState(0)
  const [summaryLimit, setSummaryLimit] = useState(DEFAULT_PAGE_SIZE)
  const [sortBy, setSortBy] = useState('date')
  const [sortOrder, setSortOrder] = useState('desc')

  /* ── Drilldown state ───────────────────────────────────────────────── */
  const [drillDate, setDrillDate] = useState(null)
  const [detailRows, setDetailRows] = useState([])
  const [detailTotal, setDetailTotal] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailSkip, setDetailSkip] = useState(0)
  const [detailLimit, setDetailLimit] = useState(DEFAULT_PAGE_SIZE)

  /* ── Summary column config (depends on category) ───────────────────── */
  const qtyLabels = QTY_LABELS[category] || QTY_LABELS.sales
  const hasOrderedCol = !!qtyLabels.ordered

  const summaryColumns = useMemo(() => {
    const cols = [
      { key: 'date',        label: 'Date',         sortable: true, align: 'left' },
      { key: 'count',       label: 'Transactions',  sortable: true, align: 'right' },
      { key: 'qty',         label: qtyLabels.qty,    sortable: true, align: 'right' },
    ]
    if (hasOrderedCol) {
      cols.push({ key: 'orderedQty', label: qtyLabels.ordered, sortable: true, align: 'right' })
    }
    cols.push({ key: 'totalAmount', label: 'Amount (MVR)', sortable: true, align: 'right' })
    return cols
  }, [qtyLabels, hasOrderedCol])

  const summaryColCount = summaryColumns.length

  /* ── Fetch summary (separate API) ──────────────────────────────────── */
  const fetchSummary = useCallback(async () => {
    if (!itemId) return
    setSummaryLoading(true)
    try {
      const params = { skip: summarySkip, limit: summaryLimit, sort_by: sortBy, sort_order: sortOrder }
      if (branchId) params.branch_id = branchId
      if (category) params.category = category
      if (fromDate) params.from_date = fromDate
      if (toDate) params.to_date = toDate
      const res = await itemsAPI.historySummary(itemId, params)
      setSummaryRows(res?.items || [])
      setSummaryTotal(res?.total || 0)
    } catch (err) {
      console.error('Failed to load history summary', err)
      setSummaryRows([])
      setSummaryTotal(0)
    } finally {
      setSummaryLoading(false)
    }
  }, [itemId, branchId, category, fromDate, toDate, sortBy, sortOrder, summarySkip, summaryLimit])

  useEffect(() => { fetchSummary() }, [fetchSummary])

  /* ── Fetch drilldown transactions (separate API) ───────────────────── */
  const fetchDrilldown = useCallback(async (date, kind, skip, limit) => {
    if (!itemId || !date) return
    setDetailLoading(true)
    try {
      const params = { date, skip: skip ?? 0, limit: limit ?? DEFAULT_PAGE_SIZE }
      if (branchId) params.branch_id = branchId
      if (category) params.category = category
      if (kind) params.doc_kind = kind
      const res = await itemsAPI.historyTransactions(itemId, params)
      setDetailRows(res?.items || [])
      setDetailTotal(res?.total || 0)
    } catch (err) {
      console.error('Failed to load transactions', err)
      setDetailRows([])
      setDetailTotal(0)
    } finally {
      setDetailLoading(false)
    }
  }, [itemId, branchId, category])

  const handleDrill = useCallback((date) => {
    setDocKind('')
    setDetailSkip(0)
    setDrillDate(date)
    fetchDrilldown(date, '', 0, detailLimit)
  }, [fetchDrilldown, detailLimit])

  /* Re-fetch drilldown when doc_kind or pagination changes */
  useEffect(() => {
    if (drillDate) fetchDrilldown(drillDate, docKind, detailSkip, detailLimit)
  }, [docKind, detailSkip, detailLimit]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Reset skip when doc_kind filter changes */
  useEffect(() => { setDetailSkip(0) }, [docKind])

  /* Reset drilldown when summary filters change */
  useEffect(() => {
    setDrillDate(null); setDetailRows([]); setDocKind('')
    setSummarySkip(0)
  }, [category, fromDate, toDate])

  /* ── Sort handler ──────────────────────────────────────────────────── */
  const handleSort = (key) => {
    setSummarySkip(0)
    if (sortBy === key) setSortOrder((o) => o === 'asc' ? 'desc' : 'asc')
    else { setSortBy(key); setSortOrder('desc') }
  }

  /* ── Labels ────────────────────────────────────────────────────────── */
  const categoryLabel = CATEGORY_OPTIONS.find((o) => o.id === category)?.label || 'All'
  const pageTitle = itemName ? `${itemName} — Transaction History` : 'Transaction History'

  /* ── Render ────────────────────────────────────────────────────────── */
  return (
    <div className="page-container page-container--list">

      {/* ── Header (matches Reports section-hdr) ───────────────────── */}
      <div className="section-hdr">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          title="Back"
          style={{
            flexShrink: 0, width: 36, height: 36, padding: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 8, border: '1px solid var(--border-subtle)',
            background: 'var(--bg-raised)', color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <Icon.ChevronLeft size={20} />
        </button>
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, flex: 1, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, minWidth: 0, flex: '0 1 auto' }}>{pageTitle}</h2>
          {category && (
            <span style={{
              flexShrink: 0, fontSize: 12, fontWeight: 600,
              color: 'var(--blue)', background: 'var(--blue-bg)',
              padding: '4px 10px', borderRadius: 8, whiteSpace: 'nowrap',
            }}>
              {categoryLabel}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          <PageActionsMenu actions={buildListPageMenuActions({
            onRefresh: () => {
              if (drillDate) fetchDrilldown(drillDate, docKind, detailSkip, detailLimit)
              else fetchSummary()
              toast.success('Refreshed')
            },
          })} />
        </div>
      </div>

      {/* ── Filter toolbar ─────────────────────────────────────────── */}
      <div className="filter-toolbar-stack">
        {drillDate ? (
          /* Drilldown breadcrumb + transaction type filter */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              fontSize: 13, color: 'var(--text-secondary)',
            }}>
              <button
                type="button"
                onClick={() => setDrillDate(null)}
                style={{
                  border: 'none', background: 'transparent',
                  color: 'var(--blue)', fontWeight: 600, cursor: 'pointer', padding: 0,
                }}
              >
                {categoryLabel} Summary
              </button>
              <span aria-hidden>›</span>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '4px 10px', borderRadius: 8,
                background: 'var(--blue-bg)', color: 'var(--blue)', fontWeight: 600,
              }}>
                {fmtDate(drillDate)}
                <button
                  type="button"
                  onClick={() => setDrillDate(null)}
                  aria-label="Back to summary"
                  style={{
                    border: 'none', background: 'transparent',
                    color: 'inherit', cursor: 'pointer', fontSize: 14,
                    lineHeight: 1, padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            {docKindOptions.length > 1 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
                <div style={{ width: 180 }}>
                  <label className="form-label">Transaction Type</label>
                  <AutocompleteDropdown
                    value={docKind}
                    onChange={setDocKind}
                    options={docKindOptions}
                    placeholder="All types"
                    clearable
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Normal filter bar */
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
            <div style={{ width: 180 }}>
              <label className="form-label">Category</label>
              <AutocompleteDropdown
                value={category}
                onChange={setCategory}
                options={CATEGORY_OPTIONS}
                placeholder="Select category"
              />
            </div>
            <div style={{ width: 200 }}>
              <label className="form-label">From</label>
              <DatePicker
                value={fromDate}
                onChange={setFromDate}
                max={toDate || undefined}
                clearable
              />
            </div>
            <div style={{ width: 200 }}>
              <label className="form-label">To</label>
              <DatePicker
                value={toDate}
                onChange={setToDate}
                min={fromDate || undefined}
                clearable
              />
            </div>
            {(fromDate || toDate) && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => { setFromDate(''); setToDate('') }}
                style={{ height: 36 }}
              >
                Clear dates
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Data table ─────────────────────────────────────────────── */}
      <div className="list-page-panel">
        <Card bodyPadding={false}>
          <div className="list-page-scroll">
            {drillDate ? (
              /* ── Detail view (individual transactions for a date) ── */
              <table className="data-table" style={{ minWidth: 700 }}>
                <thead>
                  <tr>
                    {DETAIL_COLUMNS.map((col) => (
                      <th key={col.key} className={col.align === 'right' ? 'text-right' : ''}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detailLoading ? (
                    <tr>
                      <td colSpan={DETAIL_COLUMNS.length} style={{ padding: 0 }}>
                        <TableLoadingPanel label="Loading transactions…" />
                      </td>
                    </tr>
                  ) : detailRows.length === 0 ? (
                    <tr>
                      <td colSpan={DETAIL_COLUMNS.length} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                        No transactions found for {fmtDate(drillDate)}.
                      </td>
                    </tr>
                  ) : (
                    detailRows.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <span style={{
                            fontSize: 12, padding: '2px 8px', borderRadius: 4,
                            background: 'var(--bg-raised)', fontWeight: 500,
                          }}>
                            {m.docKind}
                          </span>
                        </td>
                        <td>
                          <span className="mono" style={{ color: 'var(--accent)', fontWeight: 500 }}>
                            {m.docNumber || '—'}
                          </span>
                        </td>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.party || '—'}
                        </td>
                        <td className="text-right mono" style={{ fontWeight: 500 }}>
                          {m.qty != null ? fmtQty(m.qty) : '—'}
                        </td>
                        <td className="text-right mono">{m.amount != null ? fmt(m.amount) : '—'}</td>
                        <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{m.time || '—'}</td>
                        <td style={{ color: 'var(--text-muted)', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.createdBy || '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {detailRows.length > 0 && (
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan={3} style={{ textAlign: 'right' }}>Total</td>
                      <td className="text-right mono">
                        {fmtQty(detailRows.reduce((s, m) => s + (Number(m.qty) || 0), 0))}
                      </td>
                      <td className="text-right mono">
                        {fmt(detailRows.reduce((s, m) => s + (Number(m.amount) || 0), 0))}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            ) : (
              /* ── Summary view (date-wise) ─────────────────────── */
              <table className="data-table" style={{ minWidth: 600 }}>
                <thead>
                  <tr>
                    {summaryColumns.map((col) => (
                      col.sortable ? (
                        <SortableHeader
                          key={col.key}
                          label={col.label}
                          sortKey={col.key}
                          sortBy={sortBy}
                          sortOrder={sortOrder}
                          onSort={handleSort}
                          align={col.align || 'left'}
                        />
                      ) : (
                        <th key={col.key} className={col.align === 'right' ? 'text-right' : ''}>
                          {col.label}
                        </th>
                      )
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summaryLoading ? (
                    <tr>
                      <td colSpan={summaryColCount} style={{ padding: 0 }}>
                        <TableLoadingPanel label="Loading report data…" />
                      </td>
                    </tr>
                  ) : summaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={summaryColCount} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                        No {categoryLabel.toLowerCase()} transactions found for the selected period.
                      </td>
                    </tr>
                  ) : (
                    summaryRows.map((row) => (
                      <tr
                        key={row.date}
                        onClick={() => handleDrill(row.date)}
                        style={{ cursor: 'pointer' }}
                        className="hoverable-row"
                      >
                        <td style={{ fontWeight: 500 }}>{fmtDate(row.date)}</td>
                        <td className="text-right">{row.count}</td>
                        <td className="text-right mono" style={{ fontWeight: 500 }}>{fmtQty(row.qty)}</td>
                        {hasOrderedCol && (
                          <td className="text-right mono" style={{ fontWeight: 500, color: 'var(--blue)' }}>{fmtQty(row.orderedQty)}</td>
                        )}
                        <td className="text-right mono">{fmt(row.totalAmount)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
                {summaryRows.length > 0 && (
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td>Total</td>
                      <td className="text-right">{summaryRows.reduce((s, r) => s + r.count, 0)}</td>
                      <td className="text-right mono">
                        {fmtQty(summaryRows.reduce((s, r) => s + (r.qty || 0), 0))}
                      </td>
                      {hasOrderedCol && (
                        <td className="text-right mono" style={{ color: 'var(--blue)' }}>
                          {fmtQty(summaryRows.reduce((s, r) => s + (r.orderedQty || 0), 0))}
                        </td>
                      )}
                      <td className="text-right mono">
                        {fmt(summaryRows.reduce((s, r) => s + r.totalAmount, 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>
          <PaginationBar
            total={drillDate ? detailTotal : summaryTotal}
            skip={drillDate ? detailSkip : summarySkip}
            limit={drillDate ? detailLimit : summaryLimit}
            onSkipChange={drillDate ? setDetailSkip : setSummarySkip}
            onLimitChange={drillDate
              ? (v) => { setDetailLimit(v); setDetailSkip(0) }
              : (v) => { setSummaryLimit(v); setSummarySkip(0) }
            }
            disabled={drillDate ? detailLoading : summaryLoading}
          />
        </Card>
      </div>
    </div>
  )
}

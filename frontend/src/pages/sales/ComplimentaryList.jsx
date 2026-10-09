import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { salesAPI } from '@/api'
import { usePOSStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import { tableRowClickProps } from '@/utils/tableRowClick'
import { warmDocumentPdf, printDocumentPdf, downloadDocumentPdf } from '@/utils/documentPdf'
import { prepareComplimentaryPayload } from '@/utils/printInvoice'
import { useRowActionBusy } from '@/utils/useRowActionBusy'
import useColumnPrefs from '@/hooks/useColumnPrefs'
import {
  Card,
  ConfirmDialog,
  CopyableId,
  ColumnPrefsSpacer,
  ColumnPrefsTrigger,
  CustomizeColumnsModal,
  PaginationBar,
  RowActionsMenu,
  SortableHeader,
  TablePanel,
} from '@/components/ui'
import ListFilters, { EMPTY_LIST_FILTERS } from './ListFilters'
import ComplimentaryDetailPanel from './ComplimentaryDetailPanel'
import { COMPLIMENTARY_REASONS } from './complimentaryOptions'

const FILTER_FIELDS = ['customer', 'reason', 'date']
const REASON_OPTIONS = COMPLIMENTARY_REASONS.map((r) => ({ id: r, label: r }))

export default function ComplimentaryList({ toolbarActions, refreshKey = 0, branches = [] }) {
  const can = useCan()
  const columnPrefs = useColumnPrefs('sales.complimentary')
  const { isRowBusy, runRowAction } = useRowActionBusy()
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [skip, setSkip] = useState(0)
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE)
  const [search, setSearch] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [customerLabel, setCustomerLabel] = useState('')
  const [reason, setReason] = useState('')
  const childCounterId = usePOSStore((s) => s.selectedChildCounter)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [detailId, setDetailId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    salesAPI.complimentary
      .list({
        skip,
        limit,
        search: search || undefined,
        customer_id: customerId || undefined,
        reason: reason || undefined,
        child_counter_id: childCounterId || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        sort_by: sortBy,
        sort_order: sortOrder,
      })
      .then((raw) => {
        if (cancelled) return
        const { items, total: t } = unwrapPaged(raw)
        setRows(items)
        setTotal(t)
      })
      .catch((err) => console.error('Failed to load complimentary entries', err))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [skip, limit, search, customerId, reason, childCounterId, dateFrom, dateTo, sortBy, sortOrder, reloadKey, refreshKey])

  useEffect(() => {
    setSkip(0)
  }, [childCounterId])

  useEffect(() => {
    if (!detailId) {
      setDetail(null)
      return
    }
    let cancelled = false
    salesAPI.complimentary
      .get(detailId)
      .then((data) => {
        if (!cancelled) setDetail(data)
      })
      .catch((err) => console.error('Failed to load complimentary entry', err))
    return () => {
      cancelled = true
    }
  }, [detailId])

  const toggleSort = (key, defaultOrder = 'asc') => {
    setSkip(0)
    if (sortBy === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortBy(key)
    setSortOrder(defaultOrder)
  }

  const applyFilters = (next) => {
    setSkip(0)
    setCustomerId(next.customerId || '')
    setCustomerLabel(next.customerLabel || '')
    setReason(next.reason || '')
    setDateFrom(next.dateFrom || '')
    setDateTo(next.dateTo || '')
  }

  const clearFilters = () => {
    applyFilters({})
  }

  const removeChip = (key) => {
    if (key === 'customer') {
      setCustomerId(EMPTY_LIST_FILTERS.customerId)
      setCustomerLabel(EMPTY_LIST_FILTERS.customerLabel)
    } else if (key === 'reason') setReason('')
    else if (key === 'date') {
      setDateFrom(EMPTY_LIST_FILTERS.dateFrom)
      setDateTo(EMPTY_LIST_FILTERS.dateTo)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    try {
      await salesAPI.complimentary.remove(pendingDelete.id)
      if (detailId === pendingDelete.id) setDetailId(null)
      setReloadKey((k) => k + 1)
    } catch (err) {
      console.error('Failed to delete complimentary entry', err)
    } finally {
      setPendingDelete(null)
    }
  }

  const runComplimentaryPdf = async (id, mode) => {
    try {
      const entry = await salesAPI.complimentary.get(id)
      const branch = branches.find((b) => b.id === entry.branch_id) || null
      warmDocumentPdf('Tax Invoice', branch)
      const data = await prepareComplimentaryPayload(entry, branch)
      if (mode === 'print') await printDocumentPdf('Tax Invoice', data)
      else await downloadDocumentPdf('Tax Invoice', data)
    } catch (error) {
      console.error(`Failed to ${mode} complimentary PDF:`, error)
      toast.error(mode === 'print' ? 'Could not print this entry.' : 'Could not download the PDF. Please try again.')
    }
  }

  const printComplimentary = (id) => runRowAction(id, 'print', () => runComplimentaryPdf(id, 'print'))
  const exportComplimentary = (id) => runRowAction(id, 'export', () => runComplimentaryPdf(id, 'export'))

  return (
    <>
      <ListFilters
        search={search}
        onSearchChange={(v) => {
          setSkip(0)
          setSearch(v)
        }}
        searchPlaceholder="Search complimentary #, customer…"
        toolbarActions={toolbarActions}
        fields={FILTER_FIELDS}
        reasonOptions={REASON_OPTIONS}
        filters={{
          customerId,
          customerLabel,
          reason,
          dateFrom,
          dateTo,
        }}
        onApply={applyFilters}
        onClear={clearFilters}
        onRemoveChip={removeChip}
      />

      <div className="list-page-panel">
        <Card bodyPadding={false}>
          <div className="list-page-scroll">
            <TablePanel
              loading={loading}
              isEmpty={!loading && rows.length === 0}
              emptyIcon="🎁"
              emptyTitle="No complimentary entries found"
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <ColumnPrefsTrigger onClick={columnPrefs.openCustomize} />
                    {columnPrefs.visibleIds.map((id) => {
                      if (id === 'number') return <SortableHeader key={id} label="Complimentary #" sortKey="number" sortBy={sortBy} sortOrder={sortOrder} onSort={(k) => toggleSort(k, 'desc')} />
                      if (id === 'customer') return <SortableHeader key={id} label="Customer" sortKey="customer_name" sortBy={sortBy} sortOrder={sortOrder} onSort={(k) => toggleSort(k)} />
                      if (id === 'branch') return <SortableHeader key={id} label="Branch" sortKey="branch_id" sortBy={sortBy} sortOrder={sortOrder} onSort={(k) => toggleSort(k)} />
                      if (id === 'date') return <SortableHeader key={id} label="Date" sortKey="date" sortBy={sortBy} sortOrder={sortOrder} onSort={(k) => toggleSort(k, 'desc')} />
                      if (id === 'reason') return <SortableHeader key={id} label="Reason" sortKey="reason" sortBy={sortBy} sortOrder={sortOrder} onSort={(k) => toggleSort(k)} />
                      if (id === 'counter') return <th key={id}>Counter</th>
                      if (id === 'cashier') return <SortableHeader key={id} label="Cashier" sortKey="cashier" sortBy={sortBy} sortOrder={sortOrder} onSort={(k) => toggleSort(k)} />
                      return null
                    })}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} {...tableRowClickProps(() => setDetailId(row.id))}>
                      <ColumnPrefsSpacer />
                      {columnPrefs.visibleIds.map((id) => {
                        if (id === 'number') return <td key={id}><CopyableId value={row.number} label={row.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                        if (id === 'customer') {
                          return (
                            <td key={id}>
                              <div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{row.customer_name || 'Walk-in'}</div>
                            </td>
                          )
                        }
                        if (id === 'branch') return <td key={id} style={{ fontSize: 12 }}>{row.branch_name || row.branch_id || 'N/A'}</td>
                        if (id === 'date') return <td key={id} style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.date}</td>
                        if (id === 'reason') return <td key={id} style={{ fontSize: 12 }}>{row.reason}</td>
                        if (id === 'counter') return <td key={id} style={{ fontSize: 12 }}>{row.child_counter_name || '—'}</td>
                        if (id === 'cashier') return <td key={id} style={{ fontSize: 12, color: 'var(--text-muted)' }}>{row.created_by || 'N/A'}</td>
                        return null
                      })}
                      <td className="text-right" data-no-row-click>
                        <RowActionsMenu
                          ariaLabel={`Actions for ${row.number}`}
                          busy={isRowBusy(row.id)}
                          actions={[
                            { label: 'View', onClick: () => setDetailId(row.id) },
                            { label: 'Print', onClick: () => printComplimentary(row.id) },
                            { label: 'Export PDF', onClick: () => exportComplimentary(row.id) },
                            {
                              label: 'Delete',
                              danger: true,
                              hidden: !can('invoices.delete'),
                              onClick: () => setPendingDelete(row),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TablePanel>
          </div>
          <PaginationBar
            total={total}
            skip={skip}
            limit={limit}
            onSkipChange={setSkip}
            onLimitChange={(v) => {
              setSkip(0)
              setLimit(v)
            }}
            disabled={loading}
          />
        </Card>
      </div>

      <ComplimentaryDetailPanel
        open={!!detailId}
        onClose={() => setDetailId(null)}
        entry={detail?.id === detailId ? detail : null}
        onPrint={(entry) => printComplimentary(entry.id)}
        onExport={(entry) => exportComplimentary(entry.id)}
      />

      <CustomizeColumnsModal
        open={columnPrefs.customizeOpen}
        onClose={columnPrefs.closeCustomize}
        defs={columnPrefs.defs}
        value={columnPrefs.prefs}
        onSave={columnPrefs.savePrefs}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Delete complimentary entry?"
        message={
          pendingDelete
            ? `Deleting ${pendingDelete.number} returns its stock to the branch.`
            : ''
        }
        confirmLabel="Delete"
        danger
      />
    </>
  )
}

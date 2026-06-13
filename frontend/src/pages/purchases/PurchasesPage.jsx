/**
 * Purchases — Bills + Purchase Orders + Vendor Returns.
 *
 * 2026-05-24 overhaul: same UX patterns as the Sales side.
 *   • Dropped the GRN tab (was a re-skin of Bills with no separate model).
 *   • Implemented real Purchase Orders (was placeholder + toast).
 *   • Branch is implicit — uses operator's active branch from Topbar.
 *     No inline branch picker on either form.
 *   • Bills + POs use VendorPicker + InventoryItemPicker (mirror of
 *     CustomerPicker + items picker from Sales).
 *   • Per-line discount with % / ₹ toggle (mirror of SO/Quote modals).
 *   • Bills are immutable — only Record Payment + Cancel.
 *   • PO → Bill convert uses ConvertPOToBillModal with batch capture
 *     for tracked items (operator types the actual lot # / mfg / expiry
 *     at receipt time).
 *
 * Active branch: SO/Quote use a snapshot at modal-open time to avoid
 * mid-edit branch swaps changing the picker results. Purchases mirror
 * the same pattern via openCreatePO / openCreateBill helpers.
 */
import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { purchasesAPI, vendorsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, Modal, FormGroup, AlertBar, PaginationBar, SortableHeader, CopyableId, ReturnStatusChip, RowActionsMenu, TablePanel, Tag } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import VendorReturnFormModal from './VendorReturnFormModal'
import VendorPaymentFormModal from './VendorPaymentFormModal'
import BulkDeleteConfirmModal from '@/components/BulkDeleteConfirmModal'

const VALID_TAB_IDS = new Set(['bills', 'orders', 'grns', 'returns', 'payments'])

const TABS = [
  { id: 'bills',    label: 'Purchase Bills' },
  { id: 'orders',   label: 'Purchase Orders' },
  { id: 'grns',     label: 'GRN (Receipts)' },
  { id: 'returns',  label: 'Vendor Returns' },
  { id: 'payments', label: 'Payments' },
]

// Mirror of routes/purchases.py PaymentMode + sales VALID_PAYMENT_MODES.
// Used to render the Mode column gracefully when a legacy bill has a
// non-allow-list value (renders as em-dash instead of fabricating CASH).
const VALID_PAYMENT_MODES = new Set(['cash', 'card', 'upi', 'bank_transfer'])
function displayPaymentMode(raw) {
  if (!raw) return '—'
  const v = String(raw).trim().toLowerCase()
  if (!VALID_PAYMENT_MODES.has(v)) return '—'
  return v.replace('_', ' ').toUpperCase()
}

export default function PurchasesPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab = VALID_TAB_IDS.has(tabParam) ? tabParam : 'bills'
  const can = useCan()
  const [search, setSearch]       = useState('')
  const [billStatusF, setBillStatusF]   = useState('')
  const [orderStatusF, setOrderStatusF] = useState('')
  const [grnStatusF, setGrnStatusF]     = useState('')
  const [retStatusF, setRetStatusF]     = useState('')
  const [vendorF, setVendorF]     = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')

  // Bills state
  const [bills, setBills]       = useState([])
  const [billTotal, setBillTotal] = useState(0)
  const [billSkip, setBillSkip] = useState(0)
  const [billLimit, setBillLimit] = useState(DEFAULT_PAGE_SIZE)
  const [billSortBy, setBillSortBy] = useState('created_at')
  const [billSortOrder, setBillSortOrder] = useState('desc')
  const [billLoading, setBillLoading] = useState(false)

  // POs state
  const [orders, setOrders] = useState([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [orderSkip, setOrderSkip] = useState(0)
  const [orderLimit, setOrderLimit] = useState(DEFAULT_PAGE_SIZE)
  const [orderSortBy, setOrderSortBy] = useState('created_at')
  const [orderSortOrder, setOrderSortOrder] = useState('desc')
  const [orderLoading, setOrderLoading] = useState(false)

  // GRNs state (Phase 3 — stock receipt documents)
  const [grns, setGrns] = useState([])
  const [grnTotal, setGrnTotal] = useState(0)
  const [grnSkip, setGrnSkip] = useState(0)
  const [grnLimit, setGrnLimit] = useState(DEFAULT_PAGE_SIZE)
  const [grnSortBy, setGrnSortBy] = useState('created_at')
  const [grnSortOrder, setGrnSortOrder] = useState('desc')
  const [grnLoading, setGrnLoading] = useState(false)

  // Returns state
  const [returns, setReturns]   = useState([])
  const [retTotal, setRetTotal] = useState(0)
  const [retSkip, setRetSkip] = useState(0)
  const [retLimit, setRetLimit] = useState(DEFAULT_PAGE_SIZE)
  const [retSortBy, setRetSortBy] = useState('created_at')
  const [retSortOrder, setRetSortOrder] = useState('desc')
  const [retLoading, setRetLoading] = useState(false)

  // Payments state
  const [payments, setPayments] = useState([])
  const [payTotal, setPayTotal] = useState(0)
  const [paySkip, setPaySkip] = useState(0)
  const [payLimit, setPayLimit] = useState(DEFAULT_PAGE_SIZE)
  const [paySortBy, setPaySortBy] = useState('created_at')
  const [paySortOrder, setPaySortOrder] = useState('desc')
  const [payLoading, setPayLoading] = useState(false)
  const [showPayForm, setShowPayForm] = useState(false)
  const [payDetail, setPayDetail] = useState(null)

  // Masters (only vendors — for the filter dropdown). Items + branches
  // are no longer loaded as masters; pickers do their own paginated
  // fetches on demand.
  const [vendors, setVendors]   = useState([])

  const [listVersion, setListVersion] = useState(0)

  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteOneTarget, setDeleteOneTarget] = useState(null)
  const [deleteBlocked, setDeleteBlocked] = useState([])
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setSelectedIds(new Set())
    setDeleteOneTarget(null)
    setDeleteBlocked([])
  }, [tab])

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const tabRows = () => {
    if (tab === 'bills')    return bills
    if (tab === 'orders')   return orders
    if (tab === 'grns')     return grns
    if (tab === 'returns')  return returns
    if (tab === 'payments') return payments
    return []
  }

  const toggleSelectAll = () => {
    const rows = tabRows()
    if (selectedIds.size === rows.length && rows.length > 0) setSelectedIds(new Set())
    else setSelectedIds(new Set(rows.map((r) => r.id)))
  }

  const rowToDeleteItem = (r) => ({
    id: r.id,
    number: r.number,
    vendorName: r.vendorName,
    total: r.total ?? r.totalAmount,
    status: r.status,
  })

  const deleteModalItems = () => {
    if (deleteOneTarget) return [rowToDeleteItem(deleteOneTarget)]
    return tabRows().filter((r) => selectedIds.has(r.id)).map(rowToDeleteItem)
  }

  const entityLabelForTab = () => {
    if (tab === 'bills') return 'bill'
    if (tab === 'orders') return 'purchase order'
    if (tab === 'returns') return 'return'
    if (tab === 'payments') return 'payment'
    return 'item'
  }

  const submitBulkDelete = async () => {
    const ids = deleteOneTarget ? [deleteOneTarget.id] : Array.from(selectedIds)
    if (ids.length === 0) return
    setDeleting(true)
    setDeleteBlocked([])
    try {
      let res
      if (tab === 'bills')         res = await purchasesAPI.bulkDelete.bills(ids)
      else if (tab === 'orders')   res = await purchasesAPI.bulkDelete.orders(ids)
      else if (tab === 'returns')  res = await purchasesAPI.bulkDelete.returns(ids)
      else if (tab === 'payments') res = await purchasesAPI.bulkDelete.payments(ids)
      const count = res?.data?.count || res?.count || ids.length
      const extras = []
      const stock = res?.data?.stock_removed ?? res?.stock_removed
      if (stock) extras.push(`${stock} stock units removed`)
      const extraMsg = extras.length ? ` (${extras.join(', ')})` : ''
      const label = entityLabelForTab()
      toast.success(`Deleted ${count} ${label}${count === 1 ? '' : 's'}${extraMsg}`)
      setSelectedIds(new Set())
      setDeleteOneTarget(null)
      setDeleteOpen(false)
      setListVersion((v) => v + 1)
    } catch (err) {
      const detail = err?.response?.data?.detail
      if (detail && Array.isArray(detail.blocked)) {
        setDeleteBlocked(detail.blocked)
      } else {
        console.error('Bulk delete failed:', err)
      }
    } finally {
      setDeleting(false)
    }
  }

  const reversalLinesForTab = () => {
    const n = deleteOneTarget ? 1 : selectedIds.size
    const plural = (label) => `${n} ${label}${n === 1 ? '' : 's'}`
    if (tab === 'bills') {
      return [
        `${plural('bill')} removed`,
        'Stock removed for each line; batches deleted (only if untouched)',
        'Blocked if any batch was already consumed by sales or transfers',
        'Audit log entries written',
      ]
    }
    if (tab === 'orders')   return [`${plural('purchase order')} removed`, 'No stock or money changes (POs are intent-only)', 'Audit log entries written']
    if (tab === 'returns')  return [`${plural('return')} removed`, 'Stock quantities reversed on deleted return lines', 'Audit log entries written']
    if (tab === 'payments') return [`${plural('payment')} removed`, 'Bill paid_amount + status reverted per allocation', 'Audit log entries written']
    return [`${plural('item')} removed`]
  }

  const tabCreateAction = () => {
    if (tab === 'bills' && can('purchases.create')) {
      return { label: '+ New Bill', onClick: () => navigate('/purchases/bills/new') }
    }
    if (tab === 'orders' && can('purchases.create')) {
      return { label: '+ New PO', onClick: () => navigate('/purchases/orders/new') }
    }
    if (tab === 'grns' && can('purchases.create')) {
      return { label: '+ New GRN', onClick: () => navigate('/purchases/grns/new') }
    }
    if (tab === 'returns' && can('purchases.create')) {
      return { label: '+ New Return', onClick: () => setShowNewReturn(true) }
    }
    if (tab === 'payments' && can('purchases.edit')) {
      return { label: '+ New Payment', onClick: () => setShowPayForm(true) }
    }
    return null
  }

  const createAction = tabCreateAction()

  // Modals + sub-state
  const [showDetail, setShowDetail] = useState(null)
  const [showPay, setShowPay]   = useState(null)
  const [showCancel, setShowCancel] = useState(null)
  const [showNewReturn, setShowNewReturn] = useState(false)
  const [returnDetail, setReturnDetail] = useState(null)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionKind, setActionKind] = useState(null)
  const [paySaving, setPaySaving] = useState(false)
  const [cancelSaving, setCancelSaving] = useState(false)

  const isRowBusy = useCallback((id) => actionBusy === id, [actionBusy])

  const runRowAction = useCallback(async (id, kind, fn) => {
    if (actionBusy) return
    setActionBusy(id)
    setActionKind(kind)
    try {
      await fn()
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }, [actionBusy])

  // Payment modal state — same shape as SalesPage's pay-flow.
  const [payAmt, setPayAmt]     = useState('')
  const [payMode, setPayMode]   = useState('bank_transfer')
  const [payRef, setPayRef]     = useState('')

  const loadMasters = useCallback(async () => {
    try {
      const vendorsData = await fetchAllList(vendorsAPI.list).catch(() => [])
      setVendors(vendorsData || [])
    } catch (err) {
      console.error('Failed to fetch masters:', err)
    }
  }, [])

  useEffect(() => {
    loadMasters()
  }, [loadMasters])

  useEffect(() => {
    setBillSkip(0)
    setOrderSkip(0)
    setGrnSkip(0)
    setRetSkip(0)
    setPaySkip(0)
  }, [search, billStatusF, orderStatusF, grnStatusF, retStatusF, vendorF, dateFrom, dateTo])

  // Bills list
  useEffect(() => {
    if (tab !== 'bills') return
    let cancelled = false
    ;(async () => {
      try {
        setBillLoading(true)
        const raw = await purchasesAPI.list({
          skip: billSkip,
          limit: billLimit,
          sort_by: billSortBy,
          sort_order: billSortOrder,
          search: search || undefined,
          status: billStatusF || undefined,
          vendor_id: vendorF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setBills(items || [])
          setBillTotal(total)
        }
      } catch (err) {
        console.error('Failed to fetch purchases:', err)
        if (!cancelled) {
          setBills([])
          setBillTotal(0)
        }
        toast.error('Failed to load purchases data')
      } finally {
        if (!cancelled) setBillLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, billSkip, billLimit, search, billStatusF, vendorF, dateFrom, dateTo, listVersion, billSortBy, billSortOrder])

  // Orders list — same no-branch-filter policy as bills (see above).
  useEffect(() => {
    if (tab !== 'orders') return
    let cancelled = false
    ;(async () => {
      try {
        setOrderLoading(true)
        const raw = await purchasesAPI.orders.list({
          skip: orderSkip,
          limit: orderLimit,
          sort_by: orderSortBy,
          sort_order: orderSortOrder,
          search: search || undefined,
          status: orderStatusF || undefined,
          vendor_id: vendorF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setOrders(items || [])
          setOrderTotal(total)
        }
      } catch (err) {
        console.error('Failed to fetch POs:', err)
        if (!cancelled) {
          setOrders([])
          setOrderTotal(0)
        }
      } finally {
        if (!cancelled) setOrderLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, orderSkip, orderLimit, search, orderStatusF, vendorF, dateFrom, dateTo, listVersion, orderSortBy, orderSortOrder])

  // GRNs list
  useEffect(() => {
    if (tab !== 'grns') return
    let cancelled = false
    ;(async () => {
      try {
        setGrnLoading(true)
        const raw = await purchasesAPI.grns.list({
          skip: grnSkip,
          limit: grnLimit,
          sort_by: grnSortBy,
          sort_order: grnSortOrder,
          search: search || undefined,
          status: grnStatusF || undefined,
          vendor_id: vendorF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setGrns(items || [])
          setGrnTotal(total)
        }
      } catch (err) {
        console.error('Failed to fetch GRNs:', err)
        if (!cancelled) {
          setGrns([])
          setGrnTotal(0)
        }
      } finally {
        if (!cancelled) setGrnLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, grnSkip, grnLimit, search, grnStatusF, vendorF, dateFrom, dateTo, listVersion, grnSortBy, grnSortOrder])

  // Returns list
  useEffect(() => {
    if (tab !== 'returns') return
    let cancelled = false
    ;(async () => {
      try {
        setRetLoading(true)
        const raw = await purchasesAPI.returns.list({
          skip: retSkip,
          limit: retLimit,
          sort_by: retSortBy,
          sort_order: retSortOrder,
          search: search || undefined,
          status: retStatusF || undefined,
          vendor_id: vendorF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setReturns(items || [])
          setRetTotal(total)
        }
      } catch {
        if (!cancelled) {
          setReturns([])
          setRetTotal(0)
        }
      } finally {
        if (!cancelled) setRetLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, retSkip, retLimit, listVersion, retSortBy, retSortOrder, search, retStatusF, vendorF, dateFrom, dateTo])

  // Payments list
  useEffect(() => {
    if (tab !== 'payments') return
    let cancelled = false
    ;(async () => {
      try {
        setPayLoading(true)
        const raw = await purchasesAPI.payments.list({
          skip: paySkip,
          limit: payLimit,
          sort_by: paySortBy,
          sort_order: paySortOrder,
          search: search || undefined,
          vendor_id: vendorF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setPayments(items || [])
          setPayTotal(total)
        }
      } catch {
        if (!cancelled) {
          setPayments([])
          setPayTotal(0)
        }
      } finally {
        if (!cancelled) setPayLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, paySkip, payLimit, paySortBy, paySortOrder, listVersion, search, vendorF, dateFrom, dateTo])

  // Prefill payment amount when the modal opens — same UX as
  // SalesPage's record-payment flow.
  useEffect(() => {
    if (!showPay) return
    const balance = (showPay.total || 0) - (showPay.paidAmount || 0)
    setPayAmt(String(Math.max(0, balance)))
    setPayRef('')
    setPayMode('bank_transfer')
  }, [showPay])

  const toggleSort = (currentBy, currentOrder, setBy, setOrder, setSkip, key, defaultOrder = 'asc') => {
    setSkip(0)
    if (currentBy === key) {
      setOrder(currentOrder === 'asc' ? 'desc' : 'asc')
      return
    }
    setBy(key)
    setOrder(defaultOrder)
  }

  const recordPayment = async () => {
    if (!showPay || paySaving) return
    const amount = Number(payAmt)
    if (!payAmt || amount <= 0) { toast.error('Enter a valid amount'); return }
    if (!payMode) { toast.error('Pick a payment method'); return }
    setPaySaving(true)
    try {
      await purchasesAPI.payment(showPay.id, { amount, mode: payMode, ref: payRef })
      setListVersion((v) => v + 1)
      toast.success(`Payment of ${fmt(amount)} recorded`)
      setShowPay(null)
    } catch (err) {
      console.error('Failed to record payment:', err)
    } finally {
      setPaySaving(false)
    }
  }

  const cancelBill = async () => {
    if (!showCancel || cancelSaving) return
    setCancelSaving(true)
    try {
      await purchasesAPI.cancel(showCancel.id)
      setListVersion((v) => v + 1)
      toast.success(`${showCancel.number} cancelled`)
      setShowCancel(null)
    } catch (err) {
      console.error('Failed to cancel bill:', err)
    } finally {
      setCancelSaving(false)
    }
  }

  const voidVendorPayment = async (payment) => {
    if (!payment?.id) return
    await runRowAction(payment.id, 'void-payment', async () => {
      await purchasesAPI.payments.void(payment.id)
      setListVersion((v) => v + 1)
      toast.success(`Payment ${payment.number} voided`)
      setPayDetail(null)
    })
  }

  const voidVendorReturn = async (ret) => {
    if (!ret?.id || ret.status === 'void' || ret.voided) return
    await runRowAction(ret.id, 'void-return', async () => {
      await purchasesAPI.returns.void(ret.id)
      setListVersion((v) => v + 1)
      toast.success(`Return ${ret.number} voided — bill recalculated`)
      setReturnDetail(null)
    })
  }

  const undoVoidVendorReturn = async (ret) => {
    if (!ret?.id || (!ret.voided && ret.status !== 'void')) return
    await runRowAction(ret.id, 'undo-void-return', async () => {
      await purchasesAPI.returns.undoVoid(ret.id)
      setListVersion((v) => v + 1)
      toast.success(`Return ${ret.number} restored — bill recalculated`)
      setReturnDetail(null)
    })
  }

  const cancelPO = async (po) => {
    if (!po?.id) return
    await runRowAction(po.id, 'cancel-po', async () => {
      await purchasesAPI.orders.updateStatus(po.id, 'cancelled')
      setListVersion((v) => v + 1)
      toast.success(`${po.number} cancelled`)
    })
  }

  const billFromGrn = (grn) => {
    if (!grn?.id) return
    navigate(`/purchases/bills/new?fromGrn=${grn.id}`)
  }

  const cancelGrn = async (grn) => {
    if (!grn?.id) return
    if (!window.confirm(`Cancel ${grn.number}? This reverses received stock.`)) return
    await runRowAction(grn.id, 'cancel-grn', async () => {
      await purchasesAPI.grns.cancel(grn.id)
      setListVersion((v) => v + 1)
      toast.success(`${grn.number} cancelled — stock reversed`)
    })
  }

  return (
    <div className="page-container">
      <SectionHeader title="Purchase Management" subtitle="Vendor bills, purchase orders, and payments">
        {selectedIds.size > 0 && can('purchases.delete') && tab !== 'grns' && (
          <>
            <button className="btn btn-danger btn-sm" onClick={() => setDeleteOpen(true)}>
              🗑 Delete {selectedIds.size} selected
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </button>
          </>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = bills.map(b => ({
            'Bill Number': b.number || b.id,
            'Vendor': b.vendorName || '—',
            'Bill Date': b.date || '—',
            'Due Date': b.dueDate || '—',
            'Amount (₹)': b.total || 0,
            'Paid (₹)': b.paidAmount || 0,
            'Outstanding (₹)': (b.total || 0) - (b.paidAmount || 0),
            'Status': (b.status || '—').toUpperCase(),
          }))
          exportToCSV(exportData, `Purchases_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Purchases exported')
        }}>↓ Export</button>
        {createAction && (
          <button className="btn btn-primary btn-sm" onClick={createAction.onClick}>{createAction.label}</button>
        )}
      </SectionHeader>

      <Tabs tabs={TABS} active={tab} onChange={(id) => navigate(`/purchases?tab=${id}`)} />

      {/* ── BILLS ─────────────────────────────────────────────────── */}
      {tab === 'bills' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search bill #, vendor…" />
            <select className="form-input" style={{ width: 140 }} value={billStatusF} onChange={(e) => setBillStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['paid','pending','partial','overdue','cancelled'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={billLoading} isEmpty={!billLoading && bills.length === 0} emptyIcon="📋" emptyTitle="No bills found">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < bills.length }}
                        checked={bills.length > 0 && selectedIds.size === bills.length}
                        onChange={toggleSelectAll}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    </th>
                    <SortableHeader label="Bill #" sortKey="number" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Due Date" sortKey="due_date" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Paid" sortKey="paid_amount" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Balance" sortKey="balance_due" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} className="text-right" align="right" />
                    <th>Mode</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <th>Returns</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    const balance = (b.total || 0) - (b.paidAmount || 0)
                    const canPay = b.status !== 'paid' && b.status !== 'cancelled'
                    const canEdit = b.status !== 'paid' && b.status !== 'cancelled'
                    const canCancel = b.status !== 'cancelled' && !(b.paidAmount > 0)
                    return (
                      <tr key={b.id} style={selectedIds.has(b.id) ? { background: 'var(--accent-bg)' } : null}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(b.id)}
                            onChange={() => toggleSelect(b.id)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </td>
                        <td><CopyableId value={b.number} label={b.number} style={{ color: 'var(--purple)', fontSize: 12 }} /></td>
                        <td><div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{b.vendorName || 'N/A'}</div></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.date}</td>
                        <td style={{ fontSize: 12, color: b.status === 'overdue' ? 'var(--red)' : 'var(--text-muted)' }}>{b.dueDate || '—'}</td>
                        <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(b.total || 0)}</td>
                        <td className="text-right mono" style={{ color: 'var(--green)' }}>{fmt(b.paidAmount || 0)}</td>
                        <td className="text-right mono" style={{ color: balance > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(balance)}</td>
                        <td>{displayPaymentMode(b.paymentMode) === '—'
                          ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                          : <Chip status={b.paymentMode} label={displayPaymentMode(b.paymentMode)} />}</td>
                        <td><Chip status={b.status} /></td>
                        <td><ReturnStatusChip status={b.returnStatus} /></td>
                        <td className="text-right">
                          <RowActionsMenu
                            ariaLabel={`Actions for ${b.number}`}
                            actions={[
                              { label: 'View', disabled: isRowBusy(b.id), onClick: () => setShowDetail(b) },
                              {
                                label: 'Edit',
                                hidden: !canEdit || !can('purchases.edit'),
                                disabled: isRowBusy(b.id),
                                onClick: () => navigate(`/purchases/bills/${b.id}/edit`),
                              },
                              {
                                label: 'Record payment',
                                hidden: !canPay || !can('purchases.edit'),
                                disabled: isRowBusy(b.id),
                                onClick: () => setShowPay(b),
                              },
                              {
                                label: 'Cancel bill',
                                danger: true,
                                hidden: !canCancel || !can('purchases.edit'),
                                disabled: isRowBusy(b.id),
                                onClick: () => setShowCancel(b),
                              },
                              {
                                label: 'Delete',
                                danger: true,
                                hidden: !can('purchases.delete'),
                                disabled: isRowBusy(b.id),
                                onClick: () => setDeleteOneTarget(b),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TablePanel>
            <PaginationBar
              total={billTotal}
              skip={billSkip}
              limit={billLimit}
              onSkipChange={setBillSkip}
              onLimitChange={setBillLimit}
              disabled={billLoading}
            />
          </Card>
        </>
      )}

      {/* ── ORDERS ────────────────────────────────────────────────── */}
      {tab === 'orders' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search PO #, vendor…" />
            <select className="form-input" style={{ width: 140 }} value={orderStatusF} onChange={(e) => setOrderStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['draft','confirmed','partially_received','converted','cancelled'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={orderLoading} isEmpty={!orderLoading && orders.length === 0} emptyIcon="📄" emptyTitle="No purchase orders" emptyDesc="POs you create will appear here. Convert one to a Bill to receive goods.">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < orders.length }}
                        checked={orders.length > 0 && selectedIds.size === orders.length}
                        onChange={toggleSelectAll}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    </th>
                    <SortableHeader label="PO #" sortKey="number" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} />
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} />
                    <SortableHeader label="Expected" sortKey="expected_date" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Status" sortKey="status" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const isConverted = o.status === 'converted'
                    const isCancelled = o.status === 'cancelled'
                    const isPartiallyReceived = o.status === 'partially_received'
                    const canReceiveOrConvert = !isConverted && !isCancelled && !isPartiallyReceived
                    return (
                      <tr key={o.id} style={selectedIds.has(o.id) ? { background: 'var(--accent-bg)' } : null}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(o.id)}
                            onChange={() => toggleSelect(o.id)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </td>
                        <td><CopyableId value={o.number} label={o.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                        <td><div style={{ fontWeight: 500, fontSize: 13 }}>{o.vendorName || 'N/A'}</div></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.date}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.expectedDate || '—'}</td>
                        <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(o.total || 0)}</td>
                        <td><Chip status={o.status} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <RowActionsMenu
                              ariaLabel={`Actions for ${o.number}`}
                              actions={[
                                {
                                  label: 'View',
                                  hidden: !(isConverted || isCancelled || isPartiallyReceived) || !can('purchases.edit'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/orders/${o.id}/edit?view=1`),
                                },
                                {
                                  label: 'Edit',
                                  hidden: !canReceiveOrConvert || !can('purchases.edit'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/orders/${o.id}/edit`),
                                },
                                {
                                  label: 'Receive stock',
                                  hidden: !canReceiveOrConvert || !can('purchases.create'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/grns/new?fromPo=${o.id}`),
                                },
                                {
                                  label: 'Convert to bill',
                                  hidden: !canReceiveOrConvert || !can('purchases.create'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/bills/new?fromPo=${o.id}`),
                                },
                                {
                                  label: 'View bill',
                                  hidden: !isConverted || !o.convertedBillId,
                                  disabled: isRowBusy(o.id),
                                  onClick: () => {
                                    const bill = bills.find((x) => x.id === o.convertedBillId)
                                    if (bill) setShowDetail(bill)
                                    else toast('Bill not in current page — switch to Bills tab')
                                  },
                                },
                                {
                                  label: actionKind === 'cancel-po' && isRowBusy(o.id) ? 'Cancelling…' : 'Cancel PO',
                                  danger: true,
                                  hidden: !canReceiveOrConvert || !can('purchases.edit'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => cancelPO(o),
                                },
                                {
                                  label: 'Delete',
                                  danger: true,
                                  hidden: !can('purchases.delete'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => setDeleteOneTarget(o),
                                },
                              ]}
                            />
                            {isPartiallyReceived && (
                              <Tag color="var(--amber)">Bill GRN →</Tag>
                            )}
                            {isConverted && !o.convertedBillId && (
                              <Tag color="var(--amber)">Bill removed</Tag>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TablePanel>
            <PaginationBar
              total={orderTotal}
              skip={orderSkip}
              limit={orderLimit}
              onSkipChange={setOrderSkip}
              onLimitChange={setOrderLimit}
              disabled={orderLoading}
            />
          </Card>
        </>
      )}

      {/* ── GRNs ──────────────────────────────────────────────────── */}
      {tab === 'grns' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search GRN #, vendor, PO…" />
            <select className="form-input" style={{ width: 140 }} value={grnStatusF} onChange={(e) => setGrnStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['received', 'cancelled'].map((s) => (
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={grnLoading} isEmpty={!grnLoading && grns.length === 0} emptyIcon="📦" emptyTitle="No goods receipts" emptyDesc="Receive stock with + New GRN, or create a bill / convert a PO (those also create a GRN).">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="GRN #" sortKey="number" sortBy={grnSortBy} sortOrder={grnSortOrder} onSort={(k) => toggleSort(grnSortBy, grnSortOrder, setGrnSortBy, setGrnSortOrder, setGrnSkip, k, 'desc')} />
                    <th>PO #</th>
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={grnSortBy} sortOrder={grnSortOrder} onSort={(k) => toggleSort(grnSortBy, grnSortOrder, setGrnSortBy, setGrnSortOrder, setGrnSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={grnSortBy} sortOrder={grnSortOrder} onSort={(k) => toggleSort(grnSortBy, grnSortOrder, setGrnSortBy, setGrnSortOrder, setGrnSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={grnSortBy} sortOrder={grnSortOrder} onSort={(k) => toggleSort(grnSortBy, grnSortOrder, setGrnSortBy, setGrnSortOrder, setGrnSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Status" sortKey="status" sortBy={grnSortBy} sortOrder={grnSortOrder} onSort={(k) => toggleSort(grnSortBy, grnSortOrder, setGrnSortBy, setGrnSortOrder, setGrnSkip, k)} />
                    <th>Bill</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {grns.map((g) => {
                    const hasBill = !!g.convertedBillId
                    const isReceived = g.status === 'received'
                    return (
                      <tr key={g.id}>
                        <td><CopyableId value={g.number} label={g.number} style={{ color: 'var(--green)', fontSize: 12 }} /></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{g.poNumber || '—'}</td>
                        <td style={{ fontWeight: 500, fontSize: 13 }}>{g.vendorName || 'N/A'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{g.date}</td>
                        <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(g.total || 0)}</td>
                        <td><Chip status={g.status} /></td>
                        <td style={{ fontSize: 12 }}>{hasBill ? 'Linked' : '—'}</td>
                        <td className="text-right">
                          <RowActionsMenu
                            ariaLabel={`Actions for ${g.number}`}
                            actions={[
                              {
                                label: 'Create bill',
                                hidden: !isReceived || hasBill || !can('purchases.create'),
                                disabled: isRowBusy(g.id),
                                onClick: () => billFromGrn(g),
                              },
                              {
                                label: actionKind === 'cancel-grn' && isRowBusy(g.id) ? 'Cancelling…' : 'Cancel GRN',
                                danger: true,
                                hidden: !isReceived || hasBill || !can('purchases.edit'),
                                disabled: isRowBusy(g.id),
                                onClick: () => cancelGrn(g),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TablePanel>
            <PaginationBar
              total={grnTotal}
              skip={grnSkip}
              limit={grnLimit}
              onSkipChange={setGrnSkip}
              onLimitChange={setGrnLimit}
              disabled={grnLoading}
            />
          </Card>
        </>
      )}

      {/* ── RETURNS ───────────────────────────────────────────────── */}
      {tab === 'returns' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search return #, vendor…" />
            <select className="form-input" style={{ width: 140 }} value={retStatusF} onChange={(e) => setRetStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['draft','approved','void'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={retLoading} isEmpty={!retLoading && returns.length === 0} emptyIcon="↩️" emptyTitle="No vendor returns" emptyDesc="Returns to vendors will appear here.">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < returns.length }}
                        checked={returns.length > 0 && selectedIds.size === returns.length}
                        onChange={toggleSelectAll}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    </th>
                    <SortableHeader label="Return #" sortKey="number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Bill #" sortKey="bill_number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} className="text-right" align="right" />
                    <th>Reason</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {returns.map((r) => (
                    <tr key={r.id} style={selectedIds.has(r.id) ? { background: 'var(--accent-bg)' } : null}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                          style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                        />
                      </td>
                      <td><CopyableId value={r.number} label={r.number} style={{ color: 'var(--pink)', fontSize: 12 }} /></td>
                      <td><CopyableId value={r.billNumber} label={r.billNumber} style={{ color: 'var(--purple)', fontSize: 12 }} /></td>
                      <td style={{ fontWeight: 500, fontSize: 13 }}>{r.vendorName}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.date}</td>
                      <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(r.total)}</td>
                      <td style={{ fontSize: 12 }}><Chip label={r.reason} /></td>
                      <td><Chip status={r.status} /></td>
                      <td className="text-right">
                        <RowActionsMenu
                          ariaLabel={`Actions for ${r.number}`}
                          actions={[
                            { label: 'View', disabled: isRowBusy(r.id), onClick: () => setReturnDetail(r) },
                            {
                              label: actionKind === 'void-return' && isRowBusy(r.id) ? 'Voiding…' : 'Void',
                              danger: true,
                              hidden: !can('purchases.edit') || r.status === 'void' || r.voided,
                              disabled: isRowBusy(r.id),
                              onClick: () => voidVendorReturn(r),
                            },
                            {
                              label: actionKind === 'undo-void-return' && isRowBusy(r.id) ? 'Restoring…' : 'Undo Void',
                              hidden: !can('purchases.edit') || (!r.voided && r.status !== 'void'),
                              disabled: isRowBusy(r.id),
                              onClick: () => undoVoidVendorReturn(r),
                            },
                            {
                              label: 'Delete',
                              danger: true,
                              hidden: !can('purchases.delete'),
                              disabled: isRowBusy(r.id),
                              onClick: () => setDeleteOneTarget(r),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TablePanel>
            <PaginationBar
              total={retTotal}
              skip={retSkip}
              limit={retLimit}
              onSkipChange={setRetSkip}
              onLimitChange={setRetLimit}
              disabled={retLoading}
            />
          </Card>
        </>
      )}

      {/* ── PAYMENTS ──────────────────────────────────────────────── */}
      {tab === 'payments' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search payment #, vendor…" />
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={payLoading} isEmpty={!payLoading && payments.length === 0} emptyIcon="💸" emptyTitle="No payments yet" emptyDesc="Record a vendor payment to see it here.">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < payments.length }}
                        checked={payments.length > 0 && selectedIds.size === payments.length}
                        onChange={toggleSelectAll}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    </th>
                    <SortableHeader label="Payment #" sortKey="number" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k, 'desc')} />
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k, 'desc')} />
                    <SortableHeader label="Method" sortKey="payment_mode" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k)} />
                    <th>Bills</th>
                    <SortableHeader label="Total Amount" sortKey="total_amount" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k, 'desc')} className="text-right" align="right" />
                    <th>Reference</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const allocCount = p.billCount ?? (p.allocations?.length || 0)
                    return (
                      <tr key={p.id} style={selectedIds.has(p.id) ? { background: 'var(--accent-bg)' } : null}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleSelect(p.id)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </td>
                        <td><CopyableId value={p.number} label={p.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{p.vendorName || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.date}</td>
                        <td>{p.paymentMode
                          ? <Chip status={p.paymentMode} label={String(p.paymentMode).replace('_', ' ').toUpperCase()} />
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td><span style={{ fontSize: 12 }}>{allocCount} {allocCount === 1 ? 'bill' : 'bills'}</span></td>
                        <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--green)' }}>{fmt(p.totalAmount || 0)}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.paymentRef || '—'}</td>
                        <td className="text-right">
                          <RowActionsMenu
                            ariaLabel={`Actions for payment ${p.number}`}
                            actions={[
                              { label: 'View', disabled: isRowBusy(p.id), onClick: () => setPayDetail(p) },
                              {
                                label: actionKind === 'void-payment' && isRowBusy(p.id) ? 'Voiding…' : 'Void',
                                danger: true,
                                hidden: !can('purchases.edit') || p.voided,
                                disabled: isRowBusy(p.id),
                                onClick: () => voidVendorPayment(p),
                              },
                              {
                                label: 'Delete',
                                danger: true,
                                hidden: !can('purchases.delete'),
                                disabled: isRowBusy(p.id),
                                onClick: () => setDeleteOneTarget(p),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TablePanel>
            <PaginationBar
              total={payTotal}
              skip={paySkip}
              limit={payLimit}
              onSkipChange={setPaySkip}
              onLimitChange={setPayLimit}
              disabled={payLoading}
            />
          </Card>
        </>
      )}

      {/* ── Bill Detail Modal ─────────────────────────────────────── */}
      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title={`Purchase Bill — ${showDetail?.number}`} icon="📋" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
          {showDetail?.status !== 'paid' && showDetail?.status !== 'cancelled' && (
            <button className="btn btn-primary" onClick={() => { setShowPay(showDetail); setShowDetail(null) }}>Record Payment</button>
          )}
        </>}>
        {showDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Vendor', value: showDetail.vendorName },
                { label: 'Branch', value: showDetail.branchName },
                { label: 'Bill Date', value: showDetail.date },
                { label: 'Due Date', value: showDetail.dueDate || '—' },
                { label: 'Payment Mode', value: displayPaymentMode(showDetail.paymentMode) },
                { label: 'Status', value: <Chip status={showDetail.status} /> },
                { label: 'Return Status', value: <ReturnStatusChip status={showDetail.returnStatus} /> },
                { label: 'Credited (returns)', value: (showDetail.creditedAmount || 0) > 0 ? fmt(showDetail.creditedAmount) : '—' },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Cost</th><th className="text-right">Discount %</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {(showDetail.items || []).map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                    <td className="text-right mono">{item.qty}</td>
                    <td className="text-right mono">{fmt(item.cost)}</td>
                    <td className="text-right mono">{item.discount || 0}%</td>
                    <td className="text-right mono">{fmt(item.lineTotal || item.qty * item.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>Subtotal</span><span className="mono">{fmt(showDetail.subtotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>GST</span><span className="mono">{fmt(showDetail.taxTotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 17, fontWeight: 700 }}><span>Total</span><span className="mono" style={{ color: 'var(--purple)' }}>{fmt(showDetail.total || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--green)' }}><span>Paid</span><span className="mono">{fmt(showDetail.paidAmount || 0)}</span></div>
            </div>
          </>
        )}
      </Modal>

      {/* ── Payment Modal ─────────────────────────────────────────── */}
      <Modal open={!!showPay} onClose={() => !paySaving && setShowPay(null)} title="Record Vendor Payment" icon="💳" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowPay(null)} disabled={paySaving}>Cancel</button>
          <button className="btn btn-primary" onClick={recordPayment} disabled={paySaving}>
            {paySaving ? 'Recording…' : 'Record Payment'}
          </button>
        </>}>
        {showPay && (() => {
          const balance = (showPay.total || 0) - (showPay.paidAmount || 0)
          return (
            <>
              <AlertBar type="blue" icon="ℹ">
                Balance: <strong>{fmt(balance)}</strong> for {showPay.vendorName || 'vendor'}
              </AlertBar>
              <div style={{ height: 14 }} />
              <FormGroup label="Amount Paid (₹)" required>
                <input className="form-input" type="number"
                  value={payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  autoFocus
                  style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
              </FormGroup>
              <FormGroup label="Payment Method" required>
                {/* Same 4 methods as POS — see purchases.py PaymentMode Literal. */}
                <select className="form-input" value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                  {['cash', 'card', 'upi', 'bank_transfer'].map((m) => (
                    <option key={m} value={m}>{m.replace('_', ' ').toUpperCase()}</option>
                  ))}
                </select>
              </FormGroup>
              <FormGroup label="Reference / Transaction ID">
                <input className="form-input"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="UTR / NEFT / cheque #" />
              </FormGroup>
            </>
          )
        })()}
      </Modal>

      {/* ── Cancel Bill Confirm ───────────────────────────────────── */}
      <Modal open={!!showCancel} onClose={() => !cancelSaving && setShowCancel(null)} title="Cancel Bill" icon="⚠️" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowCancel(null)} disabled={cancelSaving}>Keep Bill</button>
          <button className="btn btn-danger" onClick={cancelBill} disabled={cancelSaving}>
            {cancelSaving ? 'Cancelling…' : 'Cancel Bill'}
          </button>
        </>}>
        {showCancel && (
          <>
            <AlertBar type="amber" icon="⚠">
              Cancelling <strong>{showCancel.number}</strong> marks it ignored in payable totals.
              Void or delete any payments first. It does NOT reverse stock — goods already received
              stay in inventory. Use Vendor Returns to physically return stock.
            </AlertBar>
          </>
        )}
      </Modal>

      {/* ── Return Form ───────────────────────────────────────────── */}
      <VendorReturnFormModal
        open={showNewReturn}
        onClose={() => setShowNewReturn(false)}
        onSaved={() => setListVersion((v) => v + 1)}
      />

      {/* ── Payment Form ──────────────────────────────────────────── */}
      <VendorPaymentFormModal
        open={showPayForm}
        onClose={() => setShowPayForm(false)}
        onSaved={() => setListVersion((v) => v + 1)}
      />

      {/* ── Payment Detail (read-only) ────────────────────────────── */}
      <Modal
        open={!!payDetail}
        onClose={() => setPayDetail(null)}
        title={payDetail ? `Payment — ${payDetail.number}` : 'Payment'}
        icon="💸"
        size="md"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setPayDetail(null)}>Close</button>
          {can('purchases.edit') && !payDetail?.voided && (
            <button className="btn btn-danger" onClick={() => voidVendorPayment(payDetail)}>Void Payment</button>
          )}
        </>}
      >
        {payDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'Vendor', value: payDetail.vendorName || '—' },
                { label: 'Date', value: payDetail.date },
                { label: 'Method', value: payDetail.paymentMode
                  ? <Chip status={payDetail.paymentMode} label={String(payDetail.paymentMode).replace('_', ' ').toUpperCase()} />
                  : '—' },
                { label: 'Reference', value: payDetail.paymentRef || '—' },
                { label: 'Total Amount', value: <span className="mono" style={{ color: 'var(--green)', fontWeight: 600 }}>{fmt(payDetail.totalAmount)}</span> },
                { label: 'Created By', value: payDetail.createdBy || '—' },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
              Allocations
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Bill #</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(payDetail.allocations || []).map((a) => (
                  <tr key={a.id}>
                    <td><CopyableId value={a.billNumber} label={a.billNumber} style={{ color: 'var(--purple)', fontSize: 12 }} /></td>
                    <td className="text-right mono">{fmt(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {payDetail.notes && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Notes</div>
                <div style={{ fontSize: 13, padding: '8px 10px', background: 'var(--bg-raised)', borderRadius: 6 }}>
                  {payDetail.notes}
                </div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* ── Return Detail ─────────────────────────────────────────── */}
      <Modal open={!!returnDetail} onClose={() => setReturnDetail(null)} title={`Vendor Return — ${returnDetail?.number}`} icon="↩️" size="lg"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setReturnDetail(null)}>Close</button>
            {can('purchases.edit') && returnDetail && returnDetail.status !== 'void' && !returnDetail.voided && (
              <button className="btn btn-danger" onClick={() => voidVendorReturn(returnDetail)}>Void Return</button>
            )}
          </>
        }>
        {returnDetail && (
          <>
            <AlertBar type="blue" icon="ℹ">
              Against bill <strong>{returnDetail.billNumber}</strong> · Vendor {returnDetail.vendorName} ·
              Reason: <strong>{returnDetail.reason}</strong>
            </AlertBar>
            <div style={{ height: 14 }} />
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Item</th><th className="text-right">Return Qty</th><th className="text-right">Cost</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {(returnDetail.items || []).map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                    <td className="text-right mono">{item.returnQty}</td>
                    <td className="text-right mono">{fmt(item.cost)}</td>
                    <td className="text-right mono">{fmt(item.lineTotal || item.returnQty * item.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>Subtotal</span><span className="mono">{fmt(returnDetail.subtotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>GST</span><span className="mono">{fmt(returnDetail.taxTotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 17, fontWeight: 700 }}><span>Total Credit</span><span className="mono" style={{ color: 'var(--pink)' }}>{fmt(returnDetail.total || 0)}</span></div>
            </div>
          </>
        )}
      </Modal>

      <BulkDeleteConfirmModal
        open={deleteOpen || !!deleteOneTarget}
        onClose={() => { setDeleteOpen(false); setDeleteOneTarget(null); setDeleteBlocked([]) }}
        onConfirm={submitBulkDelete}
        entityLabel={entityLabelForTab()}
        items={deleteModalItems()}
        blocked={deleteBlocked}
        submitting={deleting}
        reversalLines={reversalLinesForTab()}
      />
    </div>
  )
}

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
 *   • Per-line discount with % / MVR toggle (mirror of SO/Quote modals).
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
import { purchasesAPI, AUTOCOMPLETE_VENDOR_URL } from '@/api'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, Modal, FormGroup, AlertBar, PaginationBar, SortableHeader, CopyableId, ReturnStatusChip, RowActionsMenu, TablePanel, Tag, AutocompleteDropdown, DatePicker, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'
import ActivityDrawer from '@/components/activity/ActivityDrawer'
import { PAYMENT_MODE_LABEL_OPTIONS, statusOptions } from '@/utils/dropdownOptions'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import { tableRowClickProps } from '@/utils/tableRowClick'
// In-flight cache to deduplicate identical purchases requests across remounts
const inFlightPurchasesRequests = new Map()
import BulkDeleteConfirmModal from '@/components/BulkDeleteConfirmModal'
import PurchaseTxnDetailPanel from './PurchaseTxnDetailPanel'
import PaymentDetailPanel from '@/components/detail/PaymentDetailPanel'

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
  const activeBranch = useAppStore((s) => s.activeBranch)
  const [search, setSearch]       = useState('')
  const [billStatusF, setBillStatusF]   = useState('')
  const [orderStatusF, setOrderStatusF] = useState('')
  const [grnStatusF, setGrnStatusF]     = useState('')
  const [retStatusF, setRetStatusF]     = useState('')
  const [vendorF, setVendorF]     = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const canActivity = can('history.view', 'comments.view')

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
  const [payDetail, setPayDetail] = useState(null)
  const [activityTarget, setActivityTarget] = useState(null)

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
      return { label: '+ New Return', onClick: () => navigate('/purchases/returns/new') }
    }
    if (tab === 'payments' && can('purchases.edit')) {
      return { label: '+ New Payment', onClick: () => navigate('/purchases/payments/new') }
    }
    return null
  }

  const createAction = tabCreateAction()

  // Modals + sub-state
  const [purchaseDoc, setPurchaseDoc] = useState(null) // { kind: 'bill'|'order'|'grn'|'return', data }
  const [showPay, setShowPay]   = useState(null)
  const [showCancel, setShowCancel] = useState(null)
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

  useEffect(() => {
    setBillSkip(0)
    setOrderSkip(0)
    setGrnSkip(0)
    setRetSkip(0)
    setPaySkip(0)
  }, [search, billStatusF, orderStatusF, grnStatusF, retStatusF, vendorF, dateFrom, dateTo])

  // Re-fetch when active branch changes
  useEffect(() => {
    const unsub = subscribeToBranchChanged(() => {
      setBillSkip(0)
      setOrderSkip(0)
      setGrnSkip(0)
      setRetSkip(0)
      setPaySkip(0)
      setSelectedIds(new Set())
      setListVersion((v) => v + 1)
    })
    return () => unsub()
  }, [])

  // Bills list
  useEffect(() => {
    if (tab !== 'bills') return
    const key = `bills|${activeBranch?.id || ''}|${billSkip}|${billLimit}|${billSortBy}|${billSortOrder}|${search}|${billStatusF}|${vendorF}|${dateFrom}|${dateTo}|${listVersion}`
    let cancelled = false
    const run = async () => {
      try {
        setBillLoading(true)
        let promise = inFlightPurchasesRequests.get(key)
        if (!promise) {
          promise = purchasesAPI.list({
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
          inFlightPurchasesRequests.set(key, promise)
        }
        const raw = await promise
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
        inFlightPurchasesRequests.delete(key)
      }
    }
    run()
    return () => { cancelled = true }
  }, [tab, activeBranch?.id, billSkip, billLimit, search, billStatusF, vendorF, dateFrom, dateTo, listVersion, billSortBy, billSortOrder])

  // Orders list — same no-branch-filter policy as bills (see above).
  useEffect(() => {
    if (tab !== 'orders') return
    const key = `orders|${activeBranch?.id || ''}|${orderSkip}|${orderLimit}|${orderSortBy}|${orderSortOrder}|${search}|${orderStatusF}|${vendorF}|${dateFrom}|${dateTo}|${listVersion}`
    let cancelled = false
    const run = async () => {
      try {
        setOrderLoading(true)
        let promise = inFlightPurchasesRequests.get(key)
        if (!promise) {
          promise = purchasesAPI.orders.list({
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
          inFlightPurchasesRequests.set(key, promise)
        }
        const raw = await promise
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
        inFlightPurchasesRequests.delete(key)
      }
    }
    run()
    return () => { cancelled = true }
  }, [tab, activeBranch?.id, orderSkip, orderLimit, search, orderStatusF, vendorF, dateFrom, dateTo, listVersion, orderSortBy, orderSortOrder])

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
  }, [tab, activeBranch?.id, grnSkip, grnLimit, search, grnStatusF, vendorF, dateFrom, dateTo, listVersion, grnSortBy, grnSortOrder])

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
  }, [tab, activeBranch?.id, retSkip, retLimit, listVersion, retSortBy, retSortOrder, search, retStatusF, vendorF, dateFrom, dateTo])

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
  }, [tab, activeBranch?.id, paySkip, payLimit, paySortBy, paySortOrder, listVersion, search, vendorF, dateFrom, dateTo])

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
      setPurchaseDoc(null)
    })
  }

  const undoVoidVendorReturn = async (ret) => {
    if (!ret?.id || (!ret.voided && ret.status !== 'void')) return
    await runRowAction(ret.id, 'undo-void-return', async () => {
      await purchasesAPI.returns.undoVoid(ret.id)
      setListVersion((v) => v + 1)
      toast.success(`Return ${ret.number} restored — bill recalculated`)
      setPurchaseDoc(null)
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

  const approvePO = async (po) => {
    if (!po?.id) return
    await runRowAction(po.id, 'approve-po', async () => {
      await purchasesAPI.orders.approve(po.id)
      setListVersion((v) => v + 1)
      toast.success(`${po.number} approved`)
    })
  }

  const submitPO = async (po) => {
    if (!po?.id) return
    await runRowAction(po.id, 'submit-po', async () => {
      await purchasesAPI.orders.submit(po.id)
      setListVersion((v) => v + 1)
      toast.success(`${po.number} submitted for approval`)
    })
  }

  const submitBill = async (bill) => {
    if (!bill?.id) return
    await runRowAction(bill.id, 'submit-bill', async () => {
      await purchasesAPI.submit(bill.id)
      setListVersion((v) => v + 1)
      toast.success(`${bill.number} submitted for approval`)
    })
  }

  const approveBill = async (bill) => {
    if (!bill?.id) return
    await runRowAction(bill.id, 'approve-bill', async () => {
      await purchasesAPI.approve(bill.id)
      setListVersion((v) => v + 1)
      toast.success(`${bill.number} approved`)
    })
  }

  const rejectBill = async (bill) => {
    if (!bill?.id) return
    await runRowAction(bill.id, 'reject-bill', async () => {
      await purchasesAPI.reject(bill.id)
      setListVersion((v) => v + 1)
      toast.success(`${bill.number} rejected`)
    })
  }

  const rejectPO = async (po) => {
    if (!po?.id) return
    await runRowAction(po.id, 'reject-po', async () => {
      await purchasesAPI.orders.reject(po.id)
      setListVersion((v) => v + 1)
      toast.success(`${po.number} rejected`)
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

  const submitGrn = async (grn) => {
    if (!grn?.id) return
    await runRowAction(grn.id, 'submit-grn', async () => {
      await purchasesAPI.grns.submit(grn.id)
      setListVersion((v) => v + 1)
      toast.success(`${grn.number} submitted for approval`)
    })
  }

  const approveGrn = async (grn) => {
    if (!grn?.id) return
    await runRowAction(grn.id, 'approve-grn', async () => {
      await purchasesAPI.grns.approve(grn.id)
      setListVersion((v) => v + 1)
      toast.success(`${grn.number} approved — stock received`)
    })
  }

  const rejectGrn = async (grn) => {
    if (!grn?.id) return
    await runRowAction(grn.id, 'reject-grn', async () => {
      await purchasesAPI.grns.reject(grn.id)
      setListVersion((v) => v + 1)
      toast.success(`${grn.number} rejected`)
    })
  }

  const refreshCurrentTab = () => {
    setListVersion((v) => v + 1)
    toast.success('List refreshed')
  }

  const exportCurrentTab = () => {
    const stamp = new Date().toISOString().split('T')[0]
    if (tab === 'bills') {
      exportToCSV(bills.map((b) => ({
        'Bill Number': b.number || b.id,
        Vendor: b.vendorName || '—',
        'Bill Date': b.date || '—',
        'Due Date': b.dueDate || '—',
        'Amount (MVR)': b.total || 0,
        'Paid (MVR)': b.paidAmount || 0,
        'Outstanding (MVR)': (b.total || 0) - (b.paidAmount || 0),
        Status: (b.status || '—').toUpperCase(),
      })), `PurchaseBills_${stamp}.csv`)
    } else if (tab === 'orders') {
      exportToCSV(orders.map((o) => ({
        'PO Number': o.number || o.id,
        Vendor: o.vendorName || '—',
        Date: o.date || '—',
        'Amount (MVR)': o.total || 0,
        Status: (o.status || '—').toUpperCase(),
      })), `PurchaseOrders_${stamp}.csv`)
    } else if (tab === 'grns') {
      exportToCSV(grns.map((g) => ({
        'GRN Number': g.number || g.id,
        Vendor: g.vendorName || '—',
        Date: g.date || '—',
        'Amount (MVR)': g.total || 0,
        Status: (g.status || '—').toUpperCase(),
      })), `GRNs_${stamp}.csv`)
    } else if (tab === 'returns') {
      exportToCSV(returns.map((r) => ({
        'Return Number': r.number || r.id,
        Vendor: r.vendorName || '—',
        Date: r.date || '—',
        'Amount (MVR)': r.total || 0,
        Status: (r.status || '—').toUpperCase(),
      })), `VendorReturns_${stamp}.csv`)
    } else if (tab === 'payments') {
      exportToCSV(payments.map((p) => ({
        'Payment Number': p.number || p.id,
        Vendor: p.vendorName || '—',
        Date: p.date || '—',
        'Amount (MVR)': p.amount || 0,
        Method: p.paymentMode || '—',
      })), `VendorPayments_${stamp}.csv`)
    }
    toast.success('List exported')
  }

  const listMenuActions = buildListPageMenuActions({
    onExport: exportCurrentTab,
    onRefresh: refreshCurrentTab,
  })

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
        {createAction && (
          <button className="btn btn-primary btn-sm" onClick={createAction.onClick}>{createAction.label}</button>
        )}
        <PageActionsMenu actions={listMenuActions} />
      </SectionHeader>

      <Tabs tabs={TABS} active={tab} onChange={(id) => navigate(`/purchases?tab=${id}`)} />

      {/* ── BILLS ─────────────────────────────────────────────────── */}
      {tab === 'bills' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search bill #, vendor…" />
            <AutocompleteDropdown
              value={billStatusF}
              onChange={setBillStatusF}
              options={statusOptions(['paid', 'pending', 'partial', 'overdue', 'cancelled', 'draft', 'pending_approval'])}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <AutocompleteDropdown
              value={vendorF}
              onChange={setVendorF}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              prependOptions={[{ id: '', label: 'All Vendors' }]}
              isSearchFieldRequired
              placeholder="All Vendors"
              searchPlaceholder="Search vendors…"
              style={{ width: 180 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
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
                    const isDraft = b.status === 'draft'
                    const isPendingApproval = b.status === 'pending_approval'
                    const canPay = !['paid', 'cancelled', 'draft', 'pending_approval'].includes(b.status)
                    const canEdit = !['paid', 'cancelled', 'pending_approval'].includes(b.status) && !(b.paidAmount > 0)
                    const canCancel = !['cancelled', 'draft', 'pending_approval'].includes(b.status) && !(b.paidAmount > 0)
                    return (
                      <tr
                        key={b.id}
                        {...tableRowClickProps(() => setPurchaseDoc({ kind: 'bill', data: b }), {
                          style: selectedIds.has(b.id) ? { background: 'var(--accent-bg)' } : undefined,
                        })}
                      >
                        <td data-no-row-click>
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
                            busy={!!actionBusy}
                            ariaLabel={`Actions for ${b.number}`}
                            actions={[
                              { label: 'View', disabled: isRowBusy(b.id), onClick: () => setPurchaseDoc({ kind: 'bill', data: b }) },
                              {
                                label: 'Activity',
                                hidden: !canActivity,
                                disabled: isRowBusy(b.id),
                                onClick: () => setActivityTarget({ recordType: 'purchase_bill', recordId: b.id, title: `Bill ${b.number || b.id}` }),
                              },
                              {
                                label: 'Edit',
                                hidden: !(
                                  canEdit
                                  && b.status !== 'pending_approval'
                                  && (
                                    (isDraft && can('purchases.create', 'purchases.edit'))
                                    || (!isDraft && can('purchases.edit'))
                                  )
                                ),
                                disabled: isRowBusy(b.id),
                                onClick: () => navigate(`/purchases/bills/${b.id}/edit`),
                              },
                              {
                                label: 'Submit for approval',
                                hidden: !isDraft || !can('purchases.create'),
                                disabled: isRowBusy(b.id),
                                onClick: () => submitBill(b),
                              },
                              {
                                label: 'Approve',
                                hidden: !(isPendingApproval || isDraft) || !can('purchases.approve'),
                                disabled: isRowBusy(b.id),
                                onClick: () => approveBill(b),
                              },
                              {
                                label: 'Reject',
                                danger: true,
                                hidden: !(isPendingApproval || isDraft) || !can('purchases.approve'),
                                disabled: isRowBusy(b.id),
                                onClick: () => rejectBill(b),
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
            <AutocompleteDropdown
              value={orderStatusF}
              onChange={setOrderStatusF}
              options={['draft', 'pending_approval', 'confirmed', 'partially_received', 'converted', 'cancelled'].map((s) => ({
                id: s,
                label: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              }))}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <AutocompleteDropdown
              value={vendorF}
              onChange={setVendorF}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              prependOptions={[{ id: '', label: 'All Vendors' }]}
              isSearchFieldRequired
              placeholder="All Vendors"
              searchPlaceholder="Search vendors…"
              style={{ width: 180 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
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
                    const isPendingApproval = o.status === 'pending_approval'
                    const isDraft = o.status === 'draft'
                    const canReceiveOrConvert = !isConverted && !isCancelled && !isPartiallyReceived && !isPendingApproval && !isDraft
                    const canCreateGrn = canReceiveOrConvert && can('purchases.create')
                    // Bill form creates a draft bill (no stock) for create-only; approvers post stock on bill approve.
                    const canConvertToBill = canReceiveOrConvert && can('purchases.create')
                    return (
                      <tr
                        key={o.id}
                        {...tableRowClickProps(() => setPurchaseDoc({ kind: 'order', data: o }), {
                          style: selectedIds.has(o.id) ? { background: 'var(--accent-bg)' } : undefined,
                        })}
                      >
                        <td data-no-row-click>
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
                              busy={!!actionBusy}
                              ariaLabel={`Actions for ${o.number}`}
                              actions={[
                                {
                                  label: 'Submit for approval',
                                  hidden: !isDraft || !can('purchases.create'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => submitPO(o),
                                },
                                {
                                  label: 'Approve',
                                  hidden: !isPendingApproval || !can('purchases.approve'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => approvePO(o),
                                },
                                {
                                  label: 'Reject',
                                  danger: true,
                                  hidden: !isPendingApproval || !can('purchases.approve'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => rejectPO(o),
                                },
                                {
                                  label: 'View',
                                  disabled: isRowBusy(o.id),
                                  onClick: () => setPurchaseDoc({ kind: 'order', data: o }),
                                },
                                {
                                  label: 'Activity',
                                  hidden: !canActivity,
                                  disabled: isRowBusy(o.id),
                                  onClick: () => setActivityTarget({ recordType: 'purchase_order', recordId: o.id, title: `PO ${o.number || o.id}` }),
                                },
                                {
                                  label: 'Edit',
                                  hidden: !(
                                    (isDraft && can('purchases.create', 'purchases.edit'))
                                    || (canReceiveOrConvert && can('purchases.edit'))
                                  ),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/orders/${o.id}/edit`),
                                },
                                {
                                  label: 'Receive stock',
                                  hidden: !canCreateGrn,
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/grns/new?fromPo=${o.id}`),
                                },
                                {
                                  label: 'Convert to bill',
                                  hidden: !canConvertToBill,
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/purchases/bills/new?fromPo=${o.id}`),
                                },
                                {
                                  label: 'View bill',
                                  hidden: !isConverted || !o.convertedBillId,
                                  disabled: isRowBusy(o.id),
                                  onClick: async () => {
                                    try {
                                      const bill = await purchasesAPI.get(o.convertedBillId)
                                      if (bill) setPurchaseDoc({ kind: 'bill', data: bill })
                                    } catch (err) {
                                      console.error(err)
                                      toast.error('Failed to load bill')
                                    }
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
            <AutocompleteDropdown
              value={grnStatusF}
              onChange={setGrnStatusF}
              options={statusOptions(['draft', 'pending_approval', 'received', 'cancelled'])}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <AutocompleteDropdown
              value={vendorF}
              onChange={setVendorF}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              prependOptions={[{ id: '', label: 'All Vendors' }]}
              isSearchFieldRequired
              placeholder="All Vendors"
              searchPlaceholder="Search vendors…"
              style={{ width: 180 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
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
                    const isDraft = g.status === 'draft'
                    const isPendingApproval = g.status === 'pending_approval'
                    const isReceived = g.status === 'received'
                    return (
                      <tr
                        key={g.id}
                        {...tableRowClickProps(() => setPurchaseDoc({ kind: 'grn', data: g }))}
                      >
                        <td><CopyableId value={g.number} label={g.number} style={{ color: 'var(--green)', fontSize: 12 }} /></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{g.poNumber || '—'}</td>
                        <td style={{ fontWeight: 500, fontSize: 13 }}>{g.vendorName || 'N/A'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{g.date}</td>
                        <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(g.total || 0)}</td>
                        <td><Chip status={g.status} /></td>
                        <td style={{ fontSize: 12 }}>{hasBill ? 'Linked' : '—'}</td>
                        <td className="text-right">
                          <RowActionsMenu
                            busy={!!actionBusy}
                            ariaLabel={`Actions for ${g.number}`}
                            actions={[
                              {
                                label: 'View',
                                disabled: isRowBusy(g.id),
                                onClick: () => setPurchaseDoc({ kind: 'grn', data: g }),
                              },
                              {
                                label: 'Activity',
                                hidden: !canActivity,
                                disabled: isRowBusy(g.id),
                                onClick: () => setActivityTarget({ recordType: 'grn', recordId: g.id, title: `GRN ${g.number || g.id}` }),
                              },
                              {
                                label: actionKind === 'submit-grn' && isRowBusy(g.id) ? 'Submitting…' : 'Submit for approval',
                                hidden: !isDraft || !can('purchases.create'),
                                disabled: isRowBusy(g.id),
                                onClick: () => submitGrn(g),
                              },
                              {
                                label: actionKind === 'approve-grn' && isRowBusy(g.id) ? 'Approving…' : 'Approve',
                                hidden: !isPendingApproval || !can('purchases.approve'),
                                disabled: isRowBusy(g.id),
                                onClick: () => approveGrn(g),
                              },
                              {
                                label: actionKind === 'reject-grn' && isRowBusy(g.id) ? 'Rejecting…' : 'Reject',
                                danger: true,
                                hidden: !isPendingApproval || !can('purchases.approve'),
                                disabled: isRowBusy(g.id),
                                onClick: () => rejectGrn(g),
                              },
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
            <AutocompleteDropdown
              value={retStatusF}
              onChange={setRetStatusF}
              options={statusOptions(['draft', 'approved', 'void'])}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <AutocompleteDropdown
              value={vendorF}
              onChange={setVendorF}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              prependOptions={[{ id: '', label: 'All Vendors' }]}
              isSearchFieldRequired
              placeholder="All Vendors"
              searchPlaceholder="Search vendors…"
              style={{ width: 180 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
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
                    <tr
                      key={r.id}
                      {...tableRowClickProps(() => setPurchaseDoc({ kind: 'return', data: r }), {
                        style: selectedIds.has(r.id) ? { background: 'var(--accent-bg)' } : undefined,
                      })}
                    >
                      <td data-no-row-click>
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
                          busy={!!actionBusy}
                          ariaLabel={`Actions for ${r.number}`}
                          actions={[
                            { label: 'View', disabled: isRowBusy(r.id), onClick: () => setPurchaseDoc({ kind: 'return', data: r }) },
                            {
                              label: 'Activity',
                              hidden: !canActivity,
                              disabled: isRowBusy(r.id),
                              onClick: () => setActivityTarget({ recordType: 'vendor_return', recordId: r.id, title: `Return ${r.number || r.id}` }),
                            },
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
            <AutocompleteDropdown
              value={vendorF}
              onChange={setVendorF}
              fetchUrl={AUTOCOMPLETE_VENDOR_URL}
              prependOptions={[{ id: '', label: 'All Vendors' }]}
              isSearchFieldRequired
              placeholder="All Vendors"
              searchPlaceholder="Search vendors…"
              style={{ width: 180 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
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
                      <tr
                        key={p.id}
                        {...tableRowClickProps(() => setPayDetail(p), {
                          style: selectedIds.has(p.id) ? { background: 'var(--accent-bg)' } : undefined,
                        })}
                      >
                        <td data-no-row-click>
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
                            busy={!!actionBusy}
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

      {/* ── Unified purchase document detail drawer ───────────────── */}
      <PurchaseTxnDetailPanel
        open={!!purchaseDoc}
        kind={purchaseDoc?.kind || 'bill'}
        document={purchaseDoc?.data}
        onClose={() => setPurchaseDoc(null)}
        onRecordPayment={(b) => setShowPay(b)}
        onVoidReturn={voidVendorReturn}
        onBillFromGrn={billFromGrn}
      />

      {/* ── Payment Modal ─────────────────────────────────────────── */}
      <Modal open={!!showPay} onClose={() => setShowPay(null)} title="Record Vendor Payment" icon="💳" size="sm" busy={paySaving}
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
              <FormGroup label="Amount Paid (MVR)" required>
                <input className="form-input" type="number"
                  value={payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  autoFocus
                  style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
              </FormGroup>
              <FormGroup label="Payment Method" required>
                {/* Same 4 methods as POS — see purchases.py PaymentMode Literal. */}
                <AutocompleteDropdown
                  value={payMode}
                  onChange={setPayMode}
                  options={PAYMENT_MODE_LABEL_OPTIONS}
                  isSearchFieldRequired={false}
                />
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
      <Modal open={!!showCancel} onClose={() => setShowCancel(null)} title="Cancel Bill" icon="⚠️" size="sm" busy={cancelSaving}
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

      {/* ── Payment Detail (read-only) ────────────────────────────── */}
      <PaymentDetailPanel
        open={!!payDetail}
        payment={payDetail}
        onClose={() => setPayDetail(null)}
        partyLabel="Vendor"
        partyName={payDetail?.vendorName || '—'}
        accentColor="var(--purple)"
        canVoid={can('purchases.edit')}
        onVoid={voidVendorPayment}
      />

      <ActivityDrawer
        open={!!activityTarget}
        onClose={() => setActivityTarget(null)}
        recordType={activityTarget?.recordType}
        recordId={activityTarget?.recordId}
        title={activityTarget?.title}
      />

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

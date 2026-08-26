import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI, customersAPI, AUTOCOMPLETE_CUSTOMER_URL, AUTOCOMPLETE_CATEGORY_URL } from '@/api'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, statusLabel, exportToCSV } from '@/utils/helpers'
import { amountInputStep } from '@/utils/decimalPrecision'
import { SectionHeader, Card, Tabs, SearchBar, Chip, Modal, FormGroup, Tag, AlertBar, PaginationBar, SortableHeader, CopyableId, ReturnStatusChip, RowActionsMenu, TablePanel, AutocompleteDropdown, DatePicker, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'
import ActivityDrawer from '@/components/activity/ActivityDrawer'
import {
  QUOTE_STATUS_FILTER_OPTIONS,
  PAYMENT_STATUS_FILTER_OPTIONS,
  PAYMENT_MODE_LABEL_OPTIONS,
  PAYMENT_METHOD_WITH_CREDIT_OPTIONS,
  statusOptions,
} from '@/utils/dropdownOptions'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import openInvoicePrintWindow, { openQuotePrintWindow } from '@/utils/printInvoice'
import { tableRowClickProps } from '@/utils/tableRowClick'
import BulkDeleteConfirmModal from '@/components/BulkDeleteConfirmModal'
import SalesTxnDetailPanel from './SalesTxnDetailPanel'
import PaymentDetailPanel from '@/components/detail/PaymentDetailPanel'

// Sales Phase 1 (2026-05-23): Credit Purchases tab dropped — same data is
// reachable via Invoices tab + payment_mode filter. Sales Orders + Returns
// still placeholder shells today; PR 2 makes them real (model + endpoints +
// CRUD). See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md.
const TABS = [
  { id: 'quotes',    label: 'Quotations' },
  { id: 'orders',    label: 'Sales Orders' },
  { id: 'invoices',  label: 'Invoices' },
  { id: 'returns',   label: 'Credit Notes / Returns' },
  // 2026-05-24: standalone Payments record — lists every payment ever
  // recorded (single-invoice via the row Pay button OR multi-invoice
  // via + New Payment). See PaymentFormPage for the create flow.
  { id: 'payments',  label: 'Payments' },
]

const VALID_TABS = new Set(TABS.map((t) => t.id))

// Source-of-truth for renderable payment-method values — mirrors the
// PaymentMode Literal in backend/src/routes/sales.py AND the POS payment
// dropdown in POSPage.jsx. Keep these aligned with PAYMENT_METHOD_OPTIONS
// in @/utils/dropdownOptions.js when payment methods change.
//
// Legacy rows in the DB may still carry "credit" / "partial" / "cheque" /
// "" / null from pre-2026-05-23 seeds; we explicitly DON'T fabricate a
// "CASH" label for them anymore (the old `|| 'cash'` fallback was a lie —
// pending invoices have no recorded method yet). Unknown / missing →
// em-dash so it's obvious nothing was captured.
const VALID_PAYMENT_MODES = new Set(['cash', 'card', 'upi', 'bank_transfer', 'credit'])
function displayPaymentMode(raw) {
  if (!raw) return '—'
  const v = String(raw).trim().toLowerCase()
  if (!VALID_PAYMENT_MODES.has(v)) return '—'
  return v.replace('_', ' ').toUpperCase()
}

export default function SalesPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const can = useCan()
  const canActivity = can('history.view', 'comments.view')
  const tabParam = searchParams.get('tab')
  const tab = VALID_TABS.has(tabParam) ? tabParam : 'quotes'
  const viewId = searchParams.get('view')
  const setTab = useCallback((id) => {
    navigate(`/sales?tab=${id}`, { replace: true })
  }, [navigate])
  const [search, setSearch]       = useState('')
  const [invStatusF, setInvStatusF]     = useState('')
  const [paymentModeF, setPaymentModeF] = useState('')
  const [customerF, setCustomerF] = useState('')
  const [categoryF, setCategoryF] = useState('')
  const [discountF, setDiscountF] = useState('')
  const [quoteStatusF, setQuoteStatusF] = useState('')
  const [orderStatusF, setOrderStatusF] = useState('')
  const [retStatusF, setRetStatusF]     = useState('')
  const [payStatusF, setPayStatusF]     = useState('')
  // Branch filter removed 2026-05-23: the Topbar's active-branch picker
  // already scopes everything the operator sees; a second filter in the
  // invoice tab was duplicative and confusing.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [salesDoc, setSalesDoc] = useState(null) // { kind: 'invoice'|'quote'|'order'|'return', data }

  useEffect(() => {
    if (!viewId) return
    const kindByTab = { invoices: 'invoice', quotes: 'quote', orders: 'order', returns: 'return' }
    const kind = kindByTab[tab]
    if (!kind) return
    setSalesDoc({ kind, data: { id: viewId } })
  }, [tab, viewId])
  const [showPayment, setShowPayment] = useState(null)
  const [payAmt, setPayAmt]     = useState('')
  const [payMode, setPayMode]   = useState('bank_transfer')
  const [payRef, setPayRef]     = useState('')
  const [activityTarget, setActivityTarget] = useState(null)
  // 2026-05-30: customer's available credit balance, fetched when the
  // Record Payment modal opens for a customer invoice. The invoice row
  // doesn't carry credit_balance, so we pull it from customersAPI.get to
  // gate + label the new "credit" payment method. null = not loaded yet.
  const [payCustCredit, setPayCustCredit] = useState(null)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const [invoices, setInvoices] = useState([])
  const [invoiceTotal, setInvoiceTotal] = useState(0)
  const [invSkip, setInvSkip] = useState(0)
  const [invLimit, setInvLimit] = useState(DEFAULT_PAGE_SIZE)
  const [invSortBy, setInvSortBy] = useState('created_at')
  const [invSortOrder, setInvSortOrder] = useState('desc')
  const [quotations, setQuotations] = useState([])
  const [quoteTotal, setQuoteTotal] = useState(0)
  const [quoteSkip, setQuoteSkip] = useState(0)
  const [quoteLimit, setQuoteLimit] = useState(DEFAULT_PAGE_SIZE)
  const [quoteSortBy, setQuoteSortBy] = useState('created_at')
  const [quoteSortOrder, setQuoteSortOrder] = useState('desc')
  const [returns, setReturns]   = useState([])
  const [retTotal, setRetTotal] = useState(0)
  const [retSkip, setRetSkip] = useState(0)
  const [retLimit, setRetLimit] = useState(DEFAULT_PAGE_SIZE)
  const [retSortBy, setRetSortBy] = useState('date')
  const [retSortOrder, setRetSortOrder] = useState('desc')
  // Sales Phase 1 PR 2 (2026-05-23): orders are real now. State mirrors
  // the invoices/quotes/returns shape (pagination + sort + listVersion
  // bump-on-mutate). See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md
  const [orders, setOrders]     = useState([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [orderSkip, setOrderSkip] = useState(0)
  const [orderLimit, setOrderLimit] = useState(DEFAULT_PAGE_SIZE)
  const [orderSortBy, setOrderSortBy] = useState('created_at')
  const [orderSortOrder, setOrderSortOrder] = useState('desc')
  const [orderListVersion, setOrderListVersion] = useState(0)
  const [retListVersion, setRetListVersion] = useState(0)
  const [payListVersion, setPayListVersion] = useState(0)

  const [invLoading, setInvLoading] = useState(false)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [orderLoading, setOrderLoading] = useState(false)
  const [retLoading, setRetLoading] = useState(false)
  const [payLoading, setPayLoading] = useState(false)
  const [branches, setBranches] = useState([])

  // 2026-05-25: bulk-delete state. One shared selection map keyed by
  // the tab name (so switching tabs doesn't bleed selections). The
  // modal opens against the CURRENT tab when "Delete N" is clicked.
  // Blocked rows from a 400 response are surfaced in the modal's
  // alert; the operator deselects + retries.
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteOneTarget, setDeleteOneTarget] = useState(null)
  const [deleteBlocked, setDeleteBlocked] = useState([])
  const [deleting, setDeleting] = useState(false)

  // Reset selection when the tab changes — different rows, different scope.
  useEffect(() => {
    setSelectedIds(new Set())
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
    if (tab === 'invoices') return invoices
    if (tab === 'orders')   return orders
    if (tab === 'quotes')   return quotations
    if (tab === 'returns')  return returns
    if (tab === 'payments') return payments
    return []
  }

  const toggleSelectAll = () => {
    const rows = tabRows()
    if (selectedIds.size === rows.length && rows.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(rows.map((r) => r.id)))
    }
  }

  // Items array passed to BulkDeleteConfirmModal — shape varies per
  // entity but the modal only reads number / customerName / total / status.
  const selectedItemsForModal = () => {
    const rows = tabRows().filter((r) => selectedIds.has(r.id))
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      customerName: r.customerName || r.vendorName,
      total: r.total ?? r.totalAmount,
      status: r.status || (r.paymentMode ? String(r.paymentMode).toUpperCase() : undefined),
    }))
  }

  // Submit handler — picks the right API per current tab. Backend
  // returns 400 with `detail.blocked` if any row's guard fires. On
  // success the list refreshes via the appropriate version bumper.
  const submitBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setDeleting(true)
    setDeleteBlocked([])
    try {
      let res
      if (tab === 'invoices') {
        res = await salesAPI.bulkDelete.invoices(ids)
        setSalesListVersion((v) => v + 1)
      } else if (tab === 'orders') {
        res = await salesAPI.bulkDelete.orders(ids)
        setOrderListVersion((v) => v + 1)
      } else if (tab === 'quotes') {
        res = await salesAPI.bulkDelete.quotations(ids)
        setQuoteListVersion((v) => v + 1)
      } else if (tab === 'returns') {
        res = await salesAPI.bulkDelete.returns(ids)
        setRetListVersion((v) => v + 1)
      } else if (tab === 'payments') {
        res = await salesAPI.bulkDelete.payments(ids)
        setPayListVersion((v) => v + 1)
      }
      const count = res?.count || ids.length
      const extras = []
      if (res?.stock_restored) extras.push(`${res.stock_restored} stock units restored`)
      if (res?.credit_refunded) extras.push(`${fmt(res.credit_refunded)} credit refunded`)
      const extraMsg = extras.length ? ` (${extras.join(', ')})` : ''
      toast.success(`Deleted ${count} ${tab === 'invoices' ? 'invoice' : tab.replace(/s$/, '')}${count === 1 ? '' : 's'}${extraMsg}`)
      setSelectedIds(new Set())
      setDeleteOpen(false)
    } catch (err) {
      // Backend's 400 carries the per-row blocked list inside detail.
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

  const requestDeleteOne = (row, entityLabel, tabKey) => {
    setDeleteOneTarget({ id: row.id, number: row.number, label: entityLabel, tabKey })
  }

  const confirmDeleteOne = async () => {
    if (!deleteOneTarget) return
    setDeleting(true)
    setDeleteBlocked([])
    try {
      const ids = [deleteOneTarget.id]
      const tabKey = deleteOneTarget.tabKey
      let res
      if (tabKey === 'invoices') {
        res = await salesAPI.bulkDelete.invoices(ids)
        setSalesListVersion((v) => v + 1)
      } else if (tabKey === 'orders') {
        res = await salesAPI.bulkDelete.orders(ids)
        setOrderListVersion((v) => v + 1)
      } else if (tabKey === 'quotes') {
        res = await salesAPI.bulkDelete.quotations(ids)
        setQuoteListVersion((v) => v + 1)
      } else if (tabKey === 'returns') {
        res = await salesAPI.bulkDelete.returns(ids)
        setRetListVersion((v) => v + 1)
      } else if (tabKey === 'payments') {
        res = await salesAPI.bulkDelete.payments(ids)
        setPayListVersion((v) => v + 1)
      }
      const count = res?.count || 1
      const extras = []
      if (res?.stock_restored) extras.push(`${res.stock_restored} stock units restored`)
      if (res?.credit_refunded) extras.push(`${fmt(res.credit_refunded)} credit refunded`)
      const extraMsg = extras.length ? ` (${extras.join(', ')})` : ''
      toast.success(`Deleted ${count} ${deleteOneTarget.label}${extraMsg}`)
      setDeleteOneTarget(null)
    } catch (err) {
      const detail = err?.response?.data?.detail
      if (detail && Array.isArray(detail.blocked)) {
        setDeleteBlocked(detail.blocked)
      } else {
        console.error('Delete failed:', err)
      }
    } finally {
      setDeleting(false)
    }
  }

  const reversalLinesForTabKey = (tabKey) => {
    const n = deleteOneTarget ? 1 : selectedIds.size
    const plural = (label) => `${n} ${label}${n === 1 ? '' : 's'}`
    if (tabKey === 'invoices') {
      return [
        `${plural('invoice')} removed`,
        'Stock restored on each invoice line (aggregate add-back)',
        'Store-credit payments refund customer store credit balance',
        'Audit log entries written per deletion',
      ]
    }
    if (tabKey === 'orders') return [`${plural('sales order')} removed`, 'No stock or credit changes (SOs are intent-only)', 'Audit log entries written']
    if (tabKey === 'quotes') return [`${plural('quotation')} removed`, 'No downstream effects', 'Audit log entries written']
    if (tabKey === 'returns') return [`${plural('return')} removed`, 'Store credit refunds revoked from customer balance (if any)', 'Audit log entries written']
    if (tabKey === 'payments') return [`${plural('payment')} removed`, 'Invoice paid_amount + status reverted per allocation', 'Store-credit payments restore store credit balance', 'Audit log entries written']
    return [`${plural('item')} removed`]
  }

  // Payments tab state.
  const [payments, setPayments] = useState([])
  const [payTotal, setPayTotal] = useState(0)
  const [paySkip, setPaySkip] = useState(0)
  const [payLimit, setPayLimit] = useState(DEFAULT_PAGE_SIZE)
  const [paySortBy, setPaySortBy] = useState('created_at')
  const [paySortOrder, setPaySortOrder] = useState('desc')
  const [payDetail, setPayDetail] = useState(null)
  const [showCancelInvoice, setShowCancelInvoice] = useState(null)

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
  const [salesListVersion, setSalesListVersion] = useState(0)
  const [quoteListVersion, setQuoteListVersion] = useState(0)
  const storeBranches = useAppStore((s) => s.branches)

  useEffect(() => {
    setBranches(storeBranches)
  }, [storeBranches])

  useEffect(() => {
    setInvSkip(0)
    setQuoteSkip(0)
    setOrderSkip(0)
    setRetSkip(0)
    setPaySkip(0)
  }, [search, invStatusF, paymentModeF, customerF, categoryF, discountF, quoteStatusF, orderStatusF, retStatusF, payStatusF, dateFrom, dateTo])

  // Re-fetch lists when active branch changes.
  useEffect(() => {
    const unsub = subscribeToBranchChanged(() => {
      setInvSkip(0)
      setQuoteSkip(0)
      setOrderSkip(0)
      setRetSkip(0)
      setPaySkip(0)
      setSelectedIds(new Set())
      setSalesListVersion((v) => v + 1)
      setQuoteListVersion((v) => v + 1)
      setOrderListVersion((v) => v + 1)
      setRetListVersion((v) => v + 1)
      setPayListVersion((v) => v + 1)
    })
    return () => unsub()
  }, [])

  // Prefill the Record-Payment amount with the invoice's outstanding
  // balance whenever the modal opens. This single source of truth
  // replaces ad-hoc setPayAmt() calls scattered across each "Pay"
  // / "Record Payment" trigger. For walk-in invoices the input is
  // disabled in the modal body (see PaymentModal), so this prefill is
  // also the FINAL value — no operator typing is possible. Without
  // this, reopening the modal after a previous payment would show the
  // stale value (or empty for first-time use from the detail panel).
  useEffect(() => {
    if (!showPayment) return
    const balance = (showPayment.total || 0) - (showPayment.paidAmount || 0)
    setPayAmt(String(Math.max(0, balance)))
    setPayRef('')
    // Reset the method on every open so a stale 'credit' selection from a
    // prior invoice can't carry over (the credit option may not even
    // render for the new invoice if it's a walk-in).
    setPayMode('bank_transfer')
  }, [showPayment])

  useEffect(() => {
    if (tab !== 'invoices') return
    let cancelled = false
    ;(async () => {
      try {
        setInvLoading(true)
        const raw = await salesAPI.list({
          skip: invSkip,
          limit: invLimit,
          sort_by: invSortBy,
          sort_order: invSortOrder,
          search: search || undefined,
          status: invStatusF || undefined,
          payment_mode: paymentModeF || undefined,
          customer_id: customerF || undefined,
          category_id: categoryF || undefined,
          discount: discountF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setInvoices(items || [])
          setInvoiceTotal(total)
        }
      } catch (err) {
        console.error('Failed to fetch sales:', err)
        if (!cancelled) {
          setInvoices([])
          setInvoiceTotal(0)
        }
        toast.error('Failed to load sales data')
      } finally {
        if (!cancelled) setInvLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, activeBranch?.id, invSkip, invLimit, search, invStatusF, paymentModeF, customerF, categoryF, discountF, dateFrom, dateTo, salesListVersion, invSortBy, invSortOrder])

  useEffect(() => {
    if (tab !== 'quotes') return
    let cancelled = false
    ;(async () => {
      try {
        setQuoteLoading(true)
        const raw = await salesAPI.quotations.list({
          skip: quoteSkip,
          limit: quoteLimit,
          sort_by: quoteSortBy,
          sort_order: quoteSortOrder,
          search: search || undefined,
          status: quoteStatusF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setQuotations(items || [])
          setQuoteTotal(total)
        }
      } catch {
        if (!cancelled) {
          setQuotations([])
          setQuoteTotal(0)
        }
      } finally {
        if (!cancelled) setQuoteLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, activeBranch?.id, quoteSkip, quoteLimit, quoteListVersion, quoteSortBy, quoteSortOrder, search, quoteStatusF, dateFrom, dateTo])

  // Credit Purchases tab was removed 2026-05-23 (Sales Phase 1). No
  // separate data-fetch effect — same invoices are available via the main
  // Invoices tab.

  // Sales Phase 1 PR 2: Sales Orders are real now. Fetch when the tab is
  // active OR a mutation bumps orderListVersion.
  useEffect(() => {
    if (tab !== 'orders') return
    let cancelled = false
    ;(async () => {
      try {
        setOrderLoading(true)
        const raw = await salesAPI.orders.list({
          skip: orderSkip,
          limit: orderLimit,
          sort_by: orderSortBy,
          sort_order: orderSortOrder,
          search: search || undefined,
          status: orderStatusF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setOrders(items || [])
          setOrderTotal(total)
        }
      } catch {
        if (!cancelled) { setOrders([]); setOrderTotal(0) }
      } finally {
        if (!cancelled) setOrderLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, activeBranch?.id, orderSkip, orderLimit, orderSortBy, orderSortOrder, orderListVersion, search, orderStatusF, dateFrom, dateTo])

  useEffect(() => {
    if (tab !== 'returns') return
    let cancelled = false
    ;(async () => {
      try {
        setRetLoading(true)
        const raw = await salesAPI.returns.list({
          skip: retSkip,
          limit: retLimit,
          sort_by: retSortBy,
          sort_order: retSortOrder,
          search: search || undefined,
          status: retStatusF || undefined,
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
  }, [tab, activeBranch?.id, retSkip, retLimit, retSortBy, retSortOrder, retListVersion, search, retStatusF, dateFrom, dateTo])

  useEffect(() => {
    if (tab !== 'payments') return
    let cancelled = false
    ;(async () => {
      try {
        setPayLoading(true)
        const raw = await salesAPI.payments.list({
          skip: paySkip,
          limit: payLimit,
          sort_by: paySortBy,
          sort_order: paySortOrder,
          search: search || undefined,
          status: payStatusF || undefined,
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
  }, [tab, activeBranch?.id, paySkip, payLimit, paySortBy, paySortOrder, payListVersion, search, payStatusF, dateFrom, dateTo])

  // Tab-aware sort handler for the four list tabs in this page. Each tab
  // owns its own sortBy/sortOrder pair; the closure picks them up.
  const toggleSort = (currentBy, currentOrder, setBy, setOrder, setSkip, key, defaultOrder = 'asc') => {
    setSkip(0)
    if (currentBy === key) {
      setOrder(currentOrder === 'asc' ? 'desc' : 'asc')
      return
    }
    setBy(key)
    setOrder(defaultOrder)
  }

  useEffect(() => {
    if (!showPayment?.customerId) { setPayCustCredit(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const c = await customersAPI.get(showPayment.customerId)
        if (!cancelled) setPayCustCredit(Number(c?.credit_balance || 0))
      } catch {
        if (!cancelled) setPayCustCredit(0)
      }
    })()
    return () => { cancelled = true }
  }, [showPayment])

  const recordPayment = async () => {
    if (paySaving) return
    const amount = Number(payAmt)
    if (!payAmt || amount <= 0) { toast.error('Enter a valid amount'); return }
    if (!payMode) { toast.error('Pick a payment method'); return }
    const balance = (showPayment.total || 0) - (showPayment.paidAmount || 0)
    const isWalkin = !showPayment.customerId
    if (isWalkin && amount > balance) {
      toast.error(`Walk-in invoice — reduce amount to ${fmt(balance)} or assign a customer first`)
      return
    }
    // 2026-05-30: credit-mode guards (mirror POS). Walk-in can't draw
    // credit; available balance must cover the amount. Backend re-checks.
    if (payMode === 'credit') {
      if (isWalkin) { toast.error('Store credit needs a customer — walk-in invoices can\'t use store credit'); return }
      const avail = Number(payCustCredit || 0)
      if (avail < amount) {
        toast.error(`Insufficient store credit — ${fmt(avail)} available, ${fmt(amount)} needed`)
        return
      }
    }
    setPaySaving(true)
    try {
      const res = await salesAPI.payment(showPayment.id, { amount, mode: payMode, ref: payRef })
      setSalesListVersion((v) => v + 1)
      setPayListVersion((v) => v + 1)
      const credit = Number(res?.credit_applied || 0)
      if (credit > 0) {
        toast.success(
          `Invoice settled. ${fmt(credit)} added to store credit for ${showPayment.customerName}`,
          { duration: 5000 },
        )
      } else {
        toast.success(`Payment of ${fmt(amount)} recorded`)
      }
      setShowPayment(null)
      setPayAmt('')
      setPayRef('')
    } catch (err) {
      console.error('Failed to record payment:', err)
      // Toast already fired by the global axios interceptor with the
      // server's detail (e.g. "Walk-in invoice — reduce amount to MVRX" or
      // "Invoice already settled"). Don't double-toast here.
    } finally {
      setPaySaving(false)
    }
  }

  const cancelInvoice = async () => {
    if (!showCancelInvoice || cancelSaving) return
    setCancelSaving(true)
    try {
      await salesAPI.cancel(showCancelInvoice.id)
      setSalesListVersion((v) => v + 1)
      toast.success(`${showCancelInvoice.number} cancelled — stock restored`)
      setShowCancelInvoice(null)
      setSalesDoc(null)
    } catch (err) {
      console.error('Failed to cancel invoice:', err)
    } finally {
      setCancelSaving(false)
    }
  }

  const submitInvoice = async (inv) => {
    await runRowAction(inv.id, 'submit-invoice', async () => {
      await salesAPI.submit(inv.id)
      setSalesListVersion((v) => v + 1)
      toast.success(`${inv.number} submitted for approval`)
    })
  }

  const approveInvoice = async (inv) => {
    await runRowAction(inv.id, 'approve-invoice', async () => {
      await salesAPI.approve(inv.id)
      setSalesListVersion((v) => v + 1)
      toast.success(`${inv.number} approved`)
    })
  }

  const rejectInvoice = async (inv) => {
    await runRowAction(inv.id, 'reject-invoice', async () => {
      await salesAPI.reject(inv.id)
      setSalesListVersion((v) => v + 1)
      toast.success(`${inv.number} rejected`)
    })
  }

  const submitSalesOrder = async (o) => {
    await runRowAction(o.id, 'submit-so', async () => {
      await salesAPI.orders.submit(o.id)
      setOrderListVersion((v) => v + 1)
      toast.success(`${o.number} submitted for approval`)
    })
  }

  const approveSalesOrder = async (o) => {
    await runRowAction(o.id, 'approve-so', async () => {
      await salesAPI.orders.approve(o.id)
      setOrderListVersion((v) => v + 1)
      toast.success(`${o.number} approved`)
    })
  }

  const rejectSalesOrder = async (o) => {
    await runRowAction(o.id, 'reject-so', async () => {
      await salesAPI.orders.reject(o.id)
      setOrderListVersion((v) => v + 1)
      toast.success(`${o.number} rejected`)
    })
  }

  const voidPayment = async (payment) => {
    if (!payment?.id) return
    await runRowAction(payment.id, 'void-payment', async () => {
      await salesAPI.payments.void(payment.id)
      setPayListVersion((v) => v + 1)
      setSalesListVersion((v) => v + 1)
      toast.success(`Payment ${payment.number} voided`)
      setPayDetail(null)
    })
  }

  const voidReturn = async (ret) => {
    if (!ret?.id || ret.status === 'void') return
    await runRowAction(ret.id, 'void-return', async () => {
      await salesAPI.returns.void(ret.id)
      setRetListVersion((v) => v + 1)
      setSalesListVersion((v) => v + 1)
      toast.success(`Credit note ${ret.number} voided — invoice recalculated`)
      setSalesDoc(null)
    })
  }

  const undoVoidReturn = async (ret) => {
    if (!ret?.id || ret.status !== 'void') return
    await runRowAction(ret.id, 'undo-void-return', async () => {
      await salesAPI.returns.undoVoid(ret.id)
      setRetListVersion((v) => v + 1)
      setSalesListVersion((v) => v + 1)
      toast.success(`Credit note ${ret.number} restored — invoice recalculated`)
    })
  }

  const updateQuoteStatus = async (quote, status) => {
    if (!quote?.id) return
    await runRowAction(quote.id, `quote-${status}`, async () => {
      await salesAPI.quotations.updateStatus(quote.id, status)
      toast.success(`Quotation marked ${status}`)
      setQuoteListVersion((v) => v + 1)
    })
  }

  const entityLabelForTab = (tabKey) => {
    if (tabKey === 'invoices') return 'invoice'
    if (tabKey === 'orders') return 'sales order'
    if (tabKey === 'quotes') return 'quotation'
    if (tabKey === 'returns') return 'return'
    if (tabKey === 'payments') return 'payment'
    return 'item'
  }

  const tabCreateAction = () => {
    if (tab === 'invoices' && can('invoices.create')) {
      return { label: '+ New Invoice', onClick: () => navigate('/sales/invoices/new') }
    }
    if (tab === 'orders' && can('invoices.create')) {
      return { label: '+ New Sales Order', onClick: () => navigate('/sales/orders/new') }
    }
    if (tab === 'quotes' && can('invoices.create')) {
      return { label: '+ Create Quotation', onClick: () => navigate('/sales/quotations/new') }
    }
    if (tab === 'returns' && can('invoices.create')) {
      return { label: '+ New Return', onClick: () => navigate('/sales/returns/new') }
    }
    if (tab === 'payments' && can('invoices.edit')) {
      return { label: '+ New Payment', onClick: () => navigate('/sales/payments/new') }
    }
    return null
  }

  const createAction = tabCreateAction()

  const refreshCurrentTab = () => {
    if (tab === 'invoices') setSalesListVersion((v) => v + 1)
    else if (tab === 'orders') setOrderListVersion((v) => v + 1)
    else if (tab === 'quotes') setQuoteListVersion((v) => v + 1)
    else if (tab === 'returns') setRetListVersion((v) => v + 1)
    else if (tab === 'payments') setPayListVersion((v) => v + 1)
    toast.success('List refreshed')
  }

  const exportCurrentTab = () => {
    const stamp = new Date().toISOString().split('T')[0]
    if (tab === 'invoices') {
      exportToCSV(invoices.map((i) => ({
        'Invoice Number': i.number || i.id,
        Customer: i.customerName || 'Walk-in',
        Date: i.date || '—',
        'Amount (MVR)': i.total || 0,
        'Paid (MVR)': i.paidAmount || 0,
        'Outstanding (MVR)': (i.total || 0) - (i.paidAmount || 0),
        Status: statusLabel(i.status),
      })), `Invoices_${stamp}.csv`)
    } else if (tab === 'orders') {
      exportToCSV(orders.map((o) => ({
        'Order Number': o.number || o.id,
        Customer: o.customerName || '—',
        Date: o.date || '—',
        'Amount (MVR)': o.total || 0,
        Status: statusLabel(o.status),
      })), `SalesOrders_${stamp}.csv`)
    } else if (tab === 'quotes') {
      exportToCSV(quotations.map((q) => ({
        'Quote Number': q.number || q.id,
        Customer: q.customerName || '—',
        Date: q.date || '—',
        'Amount (MVR)': q.total || 0,
        Status: statusLabel(q.status),
      })), `Quotations_${stamp}.csv`)
    } else if (tab === 'returns') {
      exportToCSV(returns.map((r) => ({
        'Return Number': r.number || r.id,
        Customer: r.customerName || '—',
        Date: r.date || '—',
        'Amount (MVR)': r.total || 0,
        Status: statusLabel(r.status),
      })), `Returns_${stamp}.csv`)
    } else if (tab === 'payments') {
      exportToCSV(payments.map((p) => ({
        'Payment Number': p.number || p.id,
        Customer: p.customerName || '—',
        Date: p.date || '—',
        'Amount (MVR)': p.amount || 0,
        Method: p.paymentMode || '—',
      })), `Payments_${stamp}.csv`)
    }
    toast.success('List exported')
  }

  const listMenuActions = buildListPageMenuActions({
    onExport: exportCurrentTab,
    onRefresh: refreshCurrentTab,
  })

  return (
    <div className="page-container">
      <SectionHeader title="Sales Management" subtitle="Invoices, orders, quotations, and customer payments">
        {/* 2026-05-25: Delete N selected — appears only when the operator
            has ticked rows in the active tab. Single button serves all
            5 tabs; submitBulkDelete picks the right API based on `tab`. */}
        {selectedIds.size > 0 && can('invoices.delete') && (
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

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'invoices' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search invoice #, customer…" />
            <AutocompleteDropdown
              value={invStatusF}
              onChange={setInvStatusF}
              options={statusOptions(['paid', 'pending', 'partial', 'overdue', 'draft', 'pending_approval'])}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <AutocompleteDropdown
              value={paymentModeF}
              onChange={setPaymentModeF}
              options={PAYMENT_METHOD_WITH_CREDIT_OPTIONS}
              prependOptions={[{ id: '', label: 'All Methods' }]}
              isSearchFieldRequired={false}
              placeholder="Payment Method"
              style={{ width: 140 }}
            />
            <AutocompleteDropdown
              value={customerF}
              onChange={setCustomerF}
              fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
              isSearchFieldRequired={true}
              placeholder="Customer"
              style={{ width: 220 }}
              clearable
            />
            <AutocompleteDropdown
              value={categoryF}
              onChange={setCategoryF}
              fetchUrl={AUTOCOMPLETE_CATEGORY_URL}
              isSearchFieldRequired={true}
              placeholder="Category"
              style={{ width: 180 }}
              clearable
            />
            <AutocompleteDropdown
              value={discountF}
              onChange={setDiscountF}
              options={[{ id: '', label: 'All' }, { id: 'with', label: 'With discount' }, { id: 'without', label: 'Without discount' }]}
              isSearchFieldRequired={false}
              placeholder="Discount"
              style={{ width: 140 }}
            />
            {/* Branch filter removed 2026-05-23 — Topbar active-branch
                picker scopes things globally; a second filter here was
                duplicative. */}
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} placeholder="From" />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} placeholder="To" />
          </div>

          <Card bodyPadding={false}>
            <TablePanel loading={invLoading} isEmpty={!invLoading && invoices.length === 0} emptyIcon="🧾" emptyTitle="No invoices found">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < invoices.length }}
                        checked={invoices.length > 0 && selectedIds.size === invoices.length}
                        onChange={toggleSelectAll}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    </th>
                    <SortableHeader label="Invoice #" sortKey="number" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Branch" sortKey="branch_id" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} />
                    <SortableHeader label="Cashier" sortKey="cashier" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Amount" sortKey="total" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Paid" sortKey="paid_amount" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Mode" sortKey="payment_mode" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Status" sortKey="status" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <th>Returns</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      {...tableRowClickProps(() => setSalesDoc({ kind: 'invoice', data: inv }), {
                        style: selectedIds.has(inv.id) ? { background: 'var(--accent-bg)' } : undefined,
                      })}
                    >
                      <td data-no-row-click>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(inv.id)}
                          onChange={() => toggleSelect(inv.id)}
                          style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                        />
                      </td>
                      <td><CopyableId value={inv.number} label={inv.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                      <td>
                        <div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{inv.customerName || 'Walk-in'}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{inv.branchName || inv.branchId || 'N/A'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.date}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.cashier || 'N/A'}</td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(inv.total)}</td>
                      <td className="text-right mono" style={{ color: (inv.paidAmount || 0) >= inv.total ? 'var(--green)' : 'var(--amber)' }}>{fmt(inv.paidAmount || 0)}</td>
                      <td>{displayPaymentMode(inv.paymentMode) === '—'
                        ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                        : <Tag>{displayPaymentMode(inv.paymentMode)}</Tag>}</td>
                      <td><Chip status={inv.status} /></td>
                      <td><ReturnStatusChip status={inv.returnStatus} /></td>
                      <td className="text-right">
                        <RowActionsMenu
                          busy={!!actionBusy}
                          ariaLabel={`Actions for ${inv.number}`}
                          actions={[
                            { label: 'View', disabled: isRowBusy(inv.id), onClick: () => setSalesDoc({ kind: 'invoice', data: inv }) },
                            {
                              label: 'Activity',
                              hidden: !canActivity,
                              disabled: isRowBusy(inv.id),
                              onClick: () => setActivityTarget({ recordType: 'sales_invoice', recordId: inv.id, title: `Invoice ${inv.number || inv.id}` }),
                            },
                            {
                              label: 'Edit',
                              // Drafts: create-only makers can revise before submit.
                              // Posted unpaid: needs invoices.edit (stock already applied).
                              hidden: !(
                                !(inv.paidAmount > 0)
                                && (inv.origin || 'invoice').toLowerCase() !== 'pos'
                                && inv.status !== 'cancelled'
                                && inv.status !== 'pending_approval'
                                && (
                                  (inv.status === 'draft' && can('invoices.create', 'invoices.edit'))
                                  || (['pending', 'partial', 'overdue'].includes(inv.status) && can('invoices.edit'))
                                )
                              ),
                              disabled: isRowBusy(inv.id),
                              onClick: () => navigate(`/sales/invoices/${inv.id}/edit`),
                            },
                            {
                              label: 'Submit for approval',
                              hidden: !(inv.status === 'draft' && can('invoices.create')),
                              disabled: isRowBusy(inv.id),
                              onClick: () => submitInvoice(inv),
                            },
                            {
                              label: 'Approve',
                              hidden: !(
                                ['pending_approval', 'draft'].includes(inv.status)
                                && can('invoices.approve')
                              ),
                              disabled: isRowBusy(inv.id),
                              onClick: () => approveInvoice(inv),
                            },
                            {
                              label: 'Reject',
                              danger: true,
                              hidden: !(
                                ['pending_approval', 'draft'].includes(inv.status)
                                && can('invoices.approve')
                              ),
                              disabled: isRowBusy(inv.id),
                              onClick: () => rejectInvoice(inv),
                            },
                            {
                              label: 'Record payment',
                              hidden: !(['pending', 'partial', 'overdue'].includes(inv.status) && can('invoices.edit')),
                              disabled: isRowBusy(inv.id),
                              onClick: () => setShowPayment(inv),
                            },
                            {
                              label: 'Cancel invoice',
                              danger: true,
                              hidden: inv.status === 'cancelled'
                                || ['draft', 'pending_approval'].includes(inv.status)
                                || inv.paidAmount > 0
                                || !can('invoices.cancel'),
                              disabled: isRowBusy(inv.id),
                              onClick: () => setShowCancelInvoice(inv),
                            },
                            {
                              label: 'Delete',
                              danger: true,
                              hidden: !can('invoices.delete'),
                              disabled: isRowBusy(inv.id),
                              onClick: () => requestDeleteOne(inv, 'invoice', 'invoices'),
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
              total={invoiceTotal}
              skip={invSkip}
              limit={invLimit}
              onSkipChange={setInvSkip}
              onLimitChange={setInvLimit}
              disabled={invLoading}
            />
          </Card>
        </>
      )}

      {tab === 'quotes' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search quote #, customer…" />
            <AutocompleteDropdown
              value={quoteStatusF}
              onChange={setQuoteStatusF}
              options={QUOTE_STATUS_FILTER_OPTIONS}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={quoteLoading} isEmpty={!quoteLoading && quotations.length === 0} emptyIcon="📄" emptyTitle="No quotations" emptyDesc="No quotations created yet">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < quotations.length }}
                        checked={quotations.length > 0 && selectedIds.size === quotations.length}
                        onChange={toggleSelectAll}
                        style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                      />
                    </th>
                    <SortableHeader label="Quote #" sortKey="number" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} />
                    <SortableHeader label="Valid Till" sortKey="valid_until" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} />
                    <SortableHeader label="Amount" sortKey="total" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Status" sortKey="status" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {quotations.map((q) => (
                    <tr
                      key={q.id}
                      {...tableRowClickProps(() => setSalesDoc({ kind: 'quote', data: q }), {
                        style: selectedIds.has(q.id) ? { background: 'var(--accent-bg)' } : undefined,
                      })}
                    >
                      <td data-no-row-click>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(q.id)}
                          onChange={() => toggleSelect(q.id)}
                          style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                        />
                      </td>
                      <td><CopyableId value={q.number} label={q.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                      <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{q.customerName || 'Walk-in'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.date}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.validUntil || '—'}</td>
                      <td className="text-right mono">{fmt(q.total)}</td>
                      <td><Chip status={q.status === 'sent' ? 'active' : q.status === 'accepted' ? 'success' : 'draft'} label={q.status.charAt(0).toUpperCase() + q.status.slice(1)} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <RowActionsMenu
                            busy={!!actionBusy}
                            ariaLabel={`Actions for ${q.number}`}
                            actions={[
                              {
                                label: 'Edit',
                                hidden: ['converted', 'accepted', 'rejected'].includes(q.status) || !can('invoices.edit'),
                                disabled: isRowBusy(q.id),
                                onClick: () => navigate(`/sales/quotations/${q.id}/edit`),
                              },
                              {
                                label: actionKind === 'quote-sent' && isRowBusy(q.id) ? 'Updating…' : 'Mark sent',
                                hidden: q.status !== 'draft' || !can('invoices.edit'),
                                disabled: isRowBusy(q.id),
                                onClick: () => updateQuoteStatus(q, 'sent'),
                              },
                              {
                                label: actionKind === 'quote-accepted' && isRowBusy(q.id) ? 'Updating…' : 'Accept',
                                hidden: q.status !== 'sent' || !can('invoices.edit'),
                                disabled: isRowBusy(q.id),
                                onClick: () => updateQuoteStatus(q, 'accepted'),
                              },
                              {
                                label: actionKind === 'quote-rejected' && isRowBusy(q.id) ? 'Updating…' : 'Reject',
                                danger: true,
                                hidden: q.status !== 'sent' || !can('invoices.edit'),
                                disabled: isRowBusy(q.id),
                                onClick: () => updateQuoteStatus(q, 'rejected'),
                              },
                              {
                                label: 'Convert to order',
                                hidden: ['converted', 'rejected'].includes(q.status) || !can('invoices.create'),
                                disabled: isRowBusy(q.id),
                                onClick: () => navigate(`/sales/orders/new?fromQuote=${q.id}`),
                              },
                              {
                                label: 'Convert to invoice',
                                hidden: ['converted', 'rejected'].includes(q.status) || !can('invoices.create'),
                                disabled: isRowBusy(q.id),
                                onClick: () => navigate(`/sales/invoices/new?fromQuote=${q.id}`),
                              },
                              {
                                label: 'Print quote',
                                hidden: false,
                                disabled: isRowBusy(q.id),
                                onClick: () => openQuotePrintWindow(q, branches.find((b) => b.id === q.branchId)),
                              },
                              {
                                label: 'View',
                                disabled: isRowBusy(q.id),
                                onClick: () => setSalesDoc({ kind: 'quote', data: q }),
                              },
                              {
                                label: 'Activity',
                                hidden: !canActivity,
                                disabled: isRowBusy(q.id),
                                onClick: () => setActivityTarget({ recordType: 'quotation', recordId: q.id, title: `Quotation ${q.number || q.id}` }),
                              },
                              {
                                label: 'Delete',
                                danger: true,
                                hidden: !can('invoices.delete'),
                                disabled: isRowBusy(q.id),
                                onClick: () => requestDeleteOne(q, 'quotation', 'quotes'),
                              },
                            ]}
                          />
                          {q.convertedOrderId && (
                            <Tag color="var(--accent)">SO linked</Tag>
                          )}
                          {q.convertedInvoiceId && (
                            <Tag color="var(--green)">Invoiced</Tag>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TablePanel>
            <PaginationBar
              total={quoteTotal}
              skip={quoteSkip}
              limit={quoteLimit}
              onSkipChange={setQuoteSkip}
              onLimitChange={setQuoteLimit}
              disabled={quoteLoading}
            />
          </Card>
        </>
      )}

      {/* 2026-05-25: bulk-delete confirm modal — single instance,
          re-rendered per tab. The submit handler routes to the right
          API based on the current tab. */}
      <BulkDeleteConfirmModal
        open={deleteOpen || !!deleteOneTarget}
        onClose={() => { setDeleteOpen(false); setDeleteBlocked([]); setDeleteOneTarget(null) }}
        onConfirm={deleteOneTarget ? confirmDeleteOne : submitBulkDelete}
        entityLabel={deleteOneTarget ? deleteOneTarget.label : entityLabelForTab(tab)}
        items={deleteOneTarget ? [{ id: deleteOneTarget.id, number: deleteOneTarget.number }] : selectedItemsForModal()}
        blocked={deleteBlocked}
        submitting={deleting}
        reversalLines={reversalLinesForTabKey(deleteOneTarget?.tabKey || tab)}
      />

      <ActivityDrawer
        open={!!activityTarget}
        onClose={() => setActivityTarget(null)}
        recordType={activityTarget?.recordType}
        recordId={activityTarget?.recordId}
        title={activityTarget?.title}
      />

      {/* Payment detail (read-only) — shows allocations + credit. */}
      <PaymentDetailPanel
        open={!!payDetail}
        payment={payDetail}
        onClose={() => setPayDetail(null)}
        partyLabel="Customer"
        partyName={payDetail?.customerName || 'Walk-in'}
        canVoid={can('invoices.edit')}
        onVoid={voidPayment}
      />

      {/* Credit Purchases tab removed 2026-05-23 (Sales Phase 1). */}

      {tab === 'returns' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search return #, customer…" />
            <AutocompleteDropdown
              value={retStatusF}
              onChange={setRetStatusF}
              options={statusOptions(['pending', 'processed', 'void'])}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={retLoading} isEmpty={!retLoading && returns.length === 0} emptyIcon="↩" emptyTitle="No credit notes" emptyDesc="Process a return to generate a credit note">
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
                    <SortableHeader label="Credit Note #" sortKey="number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Invoice" sortKey="invoice_number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} className="text-right" align="right" />
                    <th className="text-right">Credited</th>
                    <th>Refund</th>
                    <th>Reason</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {returns.map((r) => (
                    <tr
                      key={r.id}
                      {...tableRowClickProps(() => setSalesDoc({ kind: 'return', data: r }), {
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
                      <td><CopyableId value={r.number} label={r.number} style={{ color: 'var(--red)', fontSize: 12 }} /></td>
                      <td><CopyableId value={r.invoiceNumber} label={r.invoiceNumber} style={{ fontSize: 12 }} /></td>
                      <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{r.customerName || 'Walk-in'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.date}</td>
                      <td className="text-right mono" style={{ color: 'var(--red)' }}>-{fmt(r.total)}</td>
                      <td className="text-right mono" style={{ color: r.creditedAmount > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                        {r.creditedAmount > 0 ? fmt(r.creditedAmount) : '—'}
                      </td>
                      <td>
                        <Tag color={r.refundMethod === 'credit' ? 'var(--accent)' : r.refundMethod === 'adjustment' ? 'var(--amber)' : undefined}>
                          {r.refundMethod === 'credit' ? 'Store credit' : r.refundMethod === 'adjustment' ? 'Adjustment' : 'Cash'}
                        </Tag>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.reason || '—'}</td>
                      <td><Chip status={r.status === 'processed' ? 'paid' : r.status} label={(r.status || '').charAt(0).toUpperCase() + (r.status || '').slice(1)} /></td>
                      <td>
                        <RowActionsMenu
                          busy={!!actionBusy}
                          ariaLabel={`Actions for ${r.number}`}
                          actions={[
                            {
                              label: 'View',
                              disabled: isRowBusy(r.id),
                              onClick: () => setSalesDoc({ kind: 'return', data: r }),
                            },
                            {
                              label: 'Activity',
                              hidden: !canActivity,
                              disabled: isRowBusy(r.id),
                              onClick: () => setActivityTarget({ recordType: 'sales_return', recordId: r.id, title: `Return ${r.number || r.id}` }),
                            },
                            {
                              label: actionKind === 'void-return' && isRowBusy(r.id) ? 'Voiding…' : 'Void',
                              danger: true,
                              hidden: !can('invoices.edit') || r.status === 'void',
                              disabled: isRowBusy(r.id),
                              onClick: () => voidReturn(r),
                            },
                            {
                              label: actionKind === 'undo-void-return' && isRowBusy(r.id) ? 'Restoring…' : 'Undo Void',
                              hidden: !can('invoices.edit') || r.status !== 'void',
                              disabled: isRowBusy(r.id),
                              onClick: () => undoVoidReturn(r),
                            },
                            {
                              label: 'Delete',
                              danger: true,
                              hidden: !can('invoices.delete'),
                              disabled: isRowBusy(r.id),
                              onClick: () => requestDeleteOne(r, 'return', 'returns'),
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

      {tab === 'payments' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search payment #, customer…" />
            <AutocompleteDropdown
              value={payStatusF}
              onChange={setPayStatusF}
              options={PAYMENT_STATUS_FILTER_OPTIONS}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 140 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={payLoading} isEmpty={!payLoading && payments.length === 0} emptyIcon="💰" emptyTitle="No payments yet" emptyDesc="Record a payment to see it here.">
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
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k, 'desc')} />
                    <SortableHeader label="Method" sortKey="payment_mode" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k)} />
                    <th>Invoices</th>
                    <SortableHeader label="Total Amount" sortKey="total_amount" sortBy={paySortBy} sortOrder={paySortOrder} onSort={(k) => toggleSort(paySortBy, paySortOrder, setPaySortBy, setPaySortOrder, setPaySkip, k, 'desc')} className="text-right" align="right" />
                    <th className="text-right">Store Credit</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => {
                    const allocCount = p.invoiceCount ?? (p.allocations?.length || 0)
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
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{p.customerName || 'Walk-in'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.date}</td>
                        <td>{p.paymentMode
                          ? <Chip status={p.paymentMode} label={String(p.paymentMode).replace('_', ' ').toUpperCase()} />
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td>
                          <Tag>{allocCount} {allocCount === 1 ? 'invoice' : 'invoices'}</Tag>
                        </td>
                        <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--green)' }}>{fmt(p.totalAmount || 0)}</td>
                        <td className="text-right mono" style={{ color: (p.creditApplied || 0) > 0 ? 'var(--amber)' : 'var(--text-muted)' }}>
                          {(p.creditApplied || 0) > 0 ? fmt(p.creditApplied) : '—'}
                        </td>
                        <td>
                          {p.voided
                            ? <Chip status="cancelled" label="Voided" />
                            : <Chip status="paid" label="Recorded" />}
                        </td>
                        <td className="text-right">
                          <RowActionsMenu
                            busy={!!actionBusy}
                            ariaLabel={`Actions for payment ${p.number}`}
                            actions={[
                              { label: 'View', disabled: isRowBusy(p.id), onClick: () => setPayDetail(p) },
                              {
                                label: actionKind === 'void-payment' && isRowBusy(p.id) ? 'Voiding…' : 'Void',
                                danger: true,
                                hidden: !can('invoices.edit') || p.voided,
                                disabled: isRowBusy(p.id),
                                onClick: () => voidPayment(p),
                              },
                              {
                                label: 'Delete',
                                danger: true,
                                hidden: !can('invoices.delete'),
                                disabled: isRowBusy(p.id),
                                onClick: () => requestDeleteOne(p, 'payment', 'payments'),
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

      {tab === 'orders' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search SO #, customer…" />
            <AutocompleteDropdown
              value={orderStatusF}
              onChange={setOrderStatusF}
              options={['draft', 'pending_approval', 'confirmed', 'partially_invoiced', 'converted', 'cancelled'].map((s) => ({
                id: s,
                label: s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              }))}
              prependOptions={[{ id: '', label: 'All Status' }]}
              isSearchFieldRequired={false}
              placeholder="All Status"
              style={{ width: 160 }}
            />
            <DatePicker style={{ width: 140 }} value={dateFrom} onChange={setDateFrom} />
            <DatePicker style={{ width: 140 }} value={dateTo} onChange={setDateTo} />
          </div>
          <Card bodyPadding={false}>
            <TablePanel loading={orderLoading} isEmpty={!orderLoading && orders.length === 0} emptyIcon="📦" emptyTitle="No sales orders" emptyDesc="Create one directly or convert a quotation.">
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
                    <SortableHeader label="Order #" sortKey="number" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} />
                    <SortableHeader label="Expected" sortKey="expected_date" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k)} />
                    <SortableHeader label="Amount" sortKey="total" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Status" sortKey="status" sortBy={orderSortBy} sortOrder={orderSortOrder} onSort={(k) => toggleSort(orderSortBy, orderSortOrder, setOrderSortBy, setOrderSortOrder, setOrderSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => {
                    const isConverted = o.status === 'converted'
                    const isPartial = o.status === 'partially_invoiced'
                    const isDraft = o.status === 'draft'
                    const isPendingApproval = o.status === 'pending_approval'
                    const isConfirmed = o.status === 'confirmed'
                    return (
                      <tr
                        key={o.id}
                        {...tableRowClickProps(() => setSalesDoc({ kind: 'order', data: o }), {
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
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{o.customerName || 'Walk-in'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.date}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.expectedDate || '—'}</td>
                        <td className="text-right mono">{fmt(o.total)}</td>
                        <td><Chip status={o.status} label={(o.status || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            <RowActionsMenu
                              busy={!!actionBusy}
                              ariaLabel={`Actions for ${o.number}`}
                              actions={[
                                {
                                  label: 'Edit',
                                  hidden: !(
                                    (isDraft && can('invoices.create', 'invoices.edit'))
                                    || (isConfirmed && can('invoices.edit'))
                                  ),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/sales/orders/${o.id}/edit`),
                                },
                                {
                                  label: 'Submit for approval',
                                  hidden: !isDraft || !can('invoices.create'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => submitSalesOrder(o),
                                },
                                {
                                  label: 'Approve',
                                  hidden: !(isPendingApproval || isDraft) || !can('invoices.approve'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => approveSalesOrder(o),
                                },
                                {
                                  label: 'Reject',
                                  danger: true,
                                  hidden: !(isPendingApproval || isDraft) || !can('invoices.approve'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => rejectSalesOrder(o),
                                },
                                {
                                  label: 'Activity',
                                  hidden: !canActivity,
                                  disabled: isRowBusy(o.id),
                                  onClick: () => setActivityTarget({ recordType: 'sales_order', recordId: o.id, title: `SO ${o.number || o.id}` }),
                                },
                                {
                                  label: 'Convert to invoice',
                                  hidden: !(isConfirmed || isPartial) || !can('invoices.create'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => navigate(`/sales/invoices/new?fromOrder=${o.id}`),
                                },
                                {
                                  label: 'View',
                                  disabled: isRowBusy(o.id),
                                  onClick: () => setSalesDoc({ kind: 'order', data: o }),
                                },
                                {
                                  label: 'View invoice',
                                  hidden: !(isConverted || isPartial) || !o.convertedInvoiceId,
                                  disabled: isRowBusy(o.id),
                                  onClick: async () => {
                                    try {
                                      const inv = await salesAPI.get(o.convertedInvoiceId)
                                      if (inv) setSalesDoc({ kind: 'invoice', data: inv })
                                    } catch (err) {
                                      console.error(err)
                                      toast.error('Failed to load invoice')
                                    }
                                  },
                                },
                                {
                                  label: 'Delete',
                                  danger: true,
                                  hidden: !can('invoices.delete'),
                                  disabled: isRowBusy(o.id),
                                  onClick: () => requestDeleteOne(o, 'sales order', 'orders'),
                                },
                              ]}
                            />
                            {isConverted && !o.convertedInvoiceId && (
                              <Tag color="var(--amber)">Invoice removed</Tag>
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

      {/* Unified sales document detail drawer */}
      <SalesTxnDetailPanel
        open={!!salesDoc}
        kind={salesDoc?.kind || 'invoice'}
        document={salesDoc?.data}
        onClose={() => {
          setSalesDoc(null)
          if (searchParams.get('view')) {
            navigate(`/sales?tab=${tab}`, { replace: true })
          }
        }}
        onPrint={(inv, branch) => openInvoicePrintWindow(inv, branch)}
        onCancelInvoice={(inv) => setShowCancelInvoice(inv)}
        onRecordPayment={(inv) => setShowPayment(inv)}
        onVoidReturn={(ret) => voidReturn(ret)}
        branchLookup={(inv) => branches.find((b) => b.id === inv?.branchId)}
      />
      {/* Payment Modal */}
      <Modal open={!!showPayment} onClose={() => setShowPayment(null)} title="Record Payment" icon="💳" size="sm" busy={paySaving}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowPayment(null)} disabled={paySaving}>Cancel</button>
          <button className="btn btn-primary" onClick={recordPayment} disabled={paySaving}>
            {paySaving ? 'Recording…' : 'Record Payment'}
          </button>
        </>}>
        {showPayment && (() => {
          const balance = (showPayment.total || 0) - (showPayment.paidAmount || 0)
          const amount = Number(payAmt) || 0
          const overpay = Math.max(0, amount - balance)
          const isWalkin = !showPayment.customerId
          const creditMode = payMode === 'credit'
          // Available stored credit. null while still loading.
          const avail = payCustCredit
          const creditInsufficient = !isWalkin && avail != null && avail < balance
          return (
            <>
              <AlertBar type="blue" icon="ℹ">
                Balance due: <strong>{fmt(balance)}</strong> for {showPayment.customerName || 'Walk-in'}
              </AlertBar>
              <div style={{ height: 14 }} />
              {/* Walk-in invoices have no customer to credit, so any
                  over-/under-payment would either be rejected by the
                  server or trap money against an anonymous row. We lock
                  the input to the exact balance — operator can still
                  pick a payment method + reference. Customer invoices
                  stay editable so excess routes to credit_balance.
                  Credit mode also locks to the full balance — drawing
                  partial credit / overpaying with credit is nonsensical. */}
              <FormGroup label="Amount Received (MVR)" required>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step={amountInputStep()}
                  value={creditMode ? String(Math.max(0, balance)) : payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  disabled={isWalkin || creditMode}
                  autoFocus={!isWalkin}
                />
                {isWalkin && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Locked to balance for walk-in invoices. Assign a customer to enable partial / overpayment.
                  </div>
                )}
                {creditMode && !isWalkin && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Locked to the full balance for store credit settlement.
                  </div>
                )}
              </FormGroup>
              {/* Overpayment hint — only reachable on customer invoices
                  now that walk-in amount is locked. Suppressed in credit
                  mode (amount is locked to balance, never overpays). */}
              {overpay > 0 && !isWalkin && !creditMode && (
                <AlertBar type="amber" icon="ℹ">
                  Overpayment: <strong>{fmt(overpay)}</strong> will be added to store credit for {showPayment.customerName}
                </AlertBar>
              )}
              <FormGroup label="Payment Mode" required>
                {/* Keep this list aligned with POSPage.jsx and the
                    PaymentMode Literal in backend/src/routes/sales.py.
                    Credit (2026-05-30) draws from the customer's stored
                    credit_balance; hidden for walk-ins, disabled when the
                    balance can't cover the invoice. */}
                <AutocompleteDropdown
                  value={payMode}
                  onChange={setPayMode}
                  options={[
                    ...PAYMENT_MODE_LABEL_OPTIONS,
                    ...(!isWalkin ? [{
                      id: 'credit',
                      label: `STORE CREDIT${avail != null ? ` (${fmt(avail)} available)` : ''}${creditInsufficient ? ' — insufficient' : ''}`,
                      disabled: creditInsufficient,
                    }] : []),
                  ]}
                  isSearchFieldRequired={false}
                />
                {creditMode && creditInsufficient && (
                  <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>
                    Store credit ({fmt(avail)}) is less than the balance ({fmt(balance)}). Pick another method.
                  </div>
                )}
              </FormGroup>
              <FormGroup label="Reference / Transaction ID">
                <input className="form-input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UTR / transaction reference" />
              </FormGroup>
            </>
          )
        })()}
      </Modal>

      {/* Cancel Invoice Confirm */}
      <Modal open={!!showCancelInvoice} onClose={() => setShowCancelInvoice(null)} title="Cancel Invoice" icon="⚠️" size="sm" busy={cancelSaving}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowCancelInvoice(null)} disabled={cancelSaving}>Keep Invoice</button>
          <button className="btn btn-danger" onClick={cancelInvoice} disabled={cancelSaving}>
            {cancelSaving ? 'Cancelling…' : 'Cancel Invoice'}
          </button>
        </>}>
        {showCancelInvoice && (
          <AlertBar type="amber" icon="⚠">
            Cancelling <strong>{showCancelInvoice.number}</strong> restores stock and marks the invoice
            void. Void or delete any payments first — invoices with active payments cannot be cancelled.
          </AlertBar>
        )}
      </Modal>

      
    </div>
  )
}

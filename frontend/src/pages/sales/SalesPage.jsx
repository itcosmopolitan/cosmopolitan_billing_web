import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, statusLabel, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, KPICard, Modal, FormGroup, EmptyState, Tag, AlertBar, PaginationBar, SortableHeader, CopyableId } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import { Receipt } from '@/components/Receipt'
import QuoteFormModal from './QuoteFormModal'
import OrderFormModal from './OrderFormModal'
import ReturnFormModal from './ReturnFormModal'
import ConvertToInvoiceModal from './ConvertToInvoiceModal'

// Sales Phase 1 (2026-05-23): Credit Purchases tab dropped — same data is
// reachable via Invoices tab + payment_mode filter. Sales Orders + Returns
// still placeholder shells today; PR 2 makes them real (model + endpoints +
// CRUD). See ../cosmopolitan_billing_web_notes/SALES_PHASE_1.md.
const TABS = [
  { id: 'invoices',  label: 'Invoices' },
  { id: 'orders',    label: 'Sales Orders' },
  { id: 'quotes',    label: 'Quotations' },
  { id: 'returns',   label: 'Credit Notes / Returns' },
]

// 2026-05-24: per-line discount can be expressed as % or ₹ in the
// SO/Quote modals (via the inline toggle). Backend only stores percent
// (matches `_calc_lines` + the just-fixed `create_quotation`). This
// helper converts the form's per-line discount + type pair into the
// PERCENT value the backend expects. Clamps to [0, 100] so an over-eager
// amount entry (e.g. ₹600 on a ₹500 line) doesn't push the line total
// negative server-side.
function lineDiscountToPercent(line) {
  const qty = Number(line.qty || 0)
  const price = Number(line.price || 0)
  const gross = qty * price
  const raw = Math.max(0, Number(line.lineDiscount || 0))
  if (line.lineDiscountType === '₹') {
    if (gross <= 0) return 0
    return Math.min(100, (raw / gross) * 100)
  }
  // '%' (default; also covers legacy rows without the type flag).
  return Math.min(100, raw)
}

// Source-of-truth for renderable payment-method values — mirrors the
// PaymentMode Literal in backend/src/routes/sales.py AND the POS payment
// dropdown in POSPage.jsx. The three lists (this Set, the POS <select>,
// and the record-payment <select> below) must stay aligned — there's no
// shared constant yet, so when you change one, change all three.
//
// Legacy rows in the DB may still carry "credit" / "partial" / "cheque" /
// "" / null from pre-2026-05-23 seeds; we explicitly DON'T fabricate a
// "CASH" label for them anymore (the old `|| 'cash'` fallback was a lie —
// pending invoices have no recorded method yet). Unknown / missing →
// em-dash so it's obvious nothing was captured.
const VALID_PAYMENT_MODES = new Set(['cash', 'card', 'upi', 'bank_transfer'])
function displayPaymentMode(raw) {
  if (!raw) return '—'
  const v = String(raw).trim().toLowerCase()
  if (!VALID_PAYMENT_MODES.has(v)) return '—'
  return v.replace('_', ' ').toUpperCase()
}

export default function SalesPage() {
  const navigate = useNavigate()
  const can = useCan()
  const [tab, setTab]           = useState('invoices')
  const [search, setSearch]     = useState('')
  const [statusF, setStatusF]   = useState('')
  // Branch filter removed 2026-05-23: the Topbar's active-branch picker
  // already scopes everything the operator sees; a second filter in the
  // invoice tab was duplicative and confusing.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [showDetail, setShowDetail] = useState(null)
  const [showPayment, setShowPayment] = useState(null)
  const [showReceipt, setShowReceipt] = useState(null)
  const [payAmt, setPayAmt]     = useState('')
  const [payMode, setPayMode]   = useState('bank_transfer')
  const [payRef, setPayRef]     = useState('')
  const [invoices, setInvoices] = useState([])
  const [invoiceTotal, setInvoiceTotal] = useState(0)
  const [invSkip, setInvSkip] = useState(0)
  const [invLimit, setInvLimit] = useState(DEFAULT_PAGE_SIZE)
  const [invSortBy, setInvSortBy] = useState('created_at')
  const [invSortOrder, setInvSortOrder] = useState('desc')
  const [salesSummary, setSalesSummary] = useState(null)
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

  const [loading, setLoading]   = useState(true)
  const [branches, setBranches] = useState([])

  // 2026-05-24: SO/Quote no longer have an inline branch picker — the
  // active branch from the Topbar is the single source of truth. If the
  // operator wants to write an SO/Quote for a different branch, they
  // switch the active branch first. This eliminates the bug where the
  // form silently defaulted to 'br-001' and the InventoryItemPicker then
  // showed "Out of stock" for items that were actually in stock at the
  // operator's real branch.
  //
  // The `|| 'br-001'` fallback only triggers on the very first session
  // before the store hydrates, or in tests. Once activeBranch is set
  // (always within the first few ms post-login), it wins.
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'

  const [showQuoteForm, setShowQuoteForm] = useState(false)
  const [quoteForm, setQuoteForm] = useState({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, validUntil: '', notes: '' })
  const pqf = (k, v) => setQuoteForm(f => ({...f, [k]: v}))

  // Order form modal state. Same pattern as quoteForm — parent owns the
  // state, modal is stateless and renders against it. The same modal does
  // create / edit / view; the parent toggles `orderEditingNumber` +
  // `orderReadOnly` to flip modes. See OrderFormModal.jsx.
  const [showOrderForm, setShowOrderForm] = useState(false)
  const [orderForm, setOrderForm] = useState({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, expectedDate: '', notes: '' })
  const pof = (k, v) => setOrderForm(f => ({...f, [k]: v}))
  const [orderSaving, setOrderSaving] = useState(false)
  const [orderEditingId, setOrderEditingId] = useState(null)         // null = create
  const [orderEditingNumber, setOrderEditingNumber] = useState(null) // shown in title for edit/view
  const [orderReadOnly, setOrderReadOnly] = useState(false)

  // Quote form modal — same edit/view flag pair.
  const [quoteSaving, setQuoteSaving] = useState(false)
  const [quoteEditingId, setQuoteEditingId] = useState(null)
  const [quoteEditingNumber, setQuoteEditingNumber] = useState(null)
  const [quoteReadOnly, setQuoteReadOnly] = useState(false)

  // New Return modal — fully self-contained (manages its own state); we
  // only flip the open flag.
  const [showReturnForm, setShowReturnForm] = useState(false)

  // Reusable convert-to-invoice prompt. `convertSource` carries which SO
  // (or future intent) is being converted so the modal can show the
  // right header summary + invoke the right backend endpoint on confirm.
  const [convertSource, setConvertSource] = useState(null)  // { kind: 'order', id, number, total, customerName } | null
  const [converting, setConverting] = useState(false)
  // (Removed 2026-05-23) `setShowQuoteDetail` placeholder state — the
  // Quotation row's View button now opens QuoteFormModal in read-only
  // mode via openQuoteEdit(q, { readOnly: true }).
  const [salesListVersion, setSalesListVersion] = useState(0)
  const [quoteListVersion, setQuoteListVersion] = useState(0)

  const loadBranches = useCallback(async () => {
    try {
      const raw = await branchesAPI.list({ skip: 0, limit: 500 }).catch(() => ({}))
      const { items } = unwrapPaged(raw)
      setBranches(items || [])
    } catch {
      setBranches([])
    }
  }, [])

  const fetchData = useCallback(async () => {
    await loadBranches()
  }, [loadBranches])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    setInvSkip(0)
  }, [search, statusF, dateFrom, dateTo])

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
  }, [showPayment])

  useEffect(() => {
    if (tab !== 'invoices') {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const raw = await salesAPI.list({
          skip: invSkip,
          limit: invLimit,
          sort_by: invSortBy,
          sort_order: invSortOrder,
          search: search || undefined,
          status: statusF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total, summary } = unwrapPaged(raw)
        if (!cancelled) {
          setInvoices(items || [])
          setInvoiceTotal(total)
          setSalesSummary(summary)
        }
      } catch (err) {
        console.error('Failed to fetch sales:', err)
        if (!cancelled) {
          setInvoices([])
          setInvoiceTotal(0)
          setSalesSummary(null)
        }
        toast.error('Failed to load sales data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, invSkip, invLimit, search, statusF, dateFrom, dateTo, salesListVersion, invSortBy, invSortOrder])

  useEffect(() => {
    if (tab !== 'quotes') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await salesAPI.quotations.list({
          skip: quoteSkip,
          limit: quoteLimit,
          sort_by: quoteSortBy,
          sort_order: quoteSortOrder,
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
      }
    })()
    return () => { cancelled = true }
  }, [tab, quoteSkip, quoteLimit, quoteListVersion, quoteSortBy, quoteSortOrder])

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
        const raw = await salesAPI.orders.list({
          skip: orderSkip,
          limit: orderLimit,
          sort_by: orderSortBy,
          sort_order: orderSortOrder,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setOrders(items || [])
          setOrderTotal(total)
        }
      } catch {
        if (!cancelled) { setOrders([]); setOrderTotal(0) }
      }
    })()
    return () => { cancelled = true }
  }, [tab, orderSkip, orderLimit, orderSortBy, orderSortOrder, orderListVersion])

  useEffect(() => {
    if (tab !== 'returns') return
    let cancelled = false
    ;(async () => {
      try {
        // Sales Phase 1 PR 2: salesAPI.returns is now an object
        // ({list, get, create}) backed by the real SalesReturn table —
        // the SAMPLE_RETURNS endpoint is gone.
        const raw = await salesAPI.returns.list({
          skip: retSkip,
          limit: retLimit,
          sort_by: retSortBy,
          sort_order: retSortOrder,
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
      }
    })()
    return () => { cancelled = true }
  }, [tab, retSkip, retLimit, retSortBy, retSortOrder, retListVersion])

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

  const totals = useMemo(() => ({
    total:   salesSummary?.amountTotal ?? 0,
    paid:    salesSummary?.collectedPaid ?? 0,
    credit:  salesSummary?.creditPending ?? 0,
    overdue: salesSummary?.overdueTotal ?? 0,
  }), [salesSummary])

  // Sales Phase 1 (2026-05-23): validation aligned with the backend.
  //   • Amount must be > 0
  //   • Method must be picked (was implicitly defaulted before)
  //   • Walk-in overpayment is blocked client-side (server also rejects
  //     with 400, but inline feedback is friendlier)
  //   • Customer overpayment is allowed and shows the credited amount in
  //     the success toast using the server's echo
  const recordPayment = async () => {
    const amount = Number(payAmt)
    if (!payAmt || amount <= 0) { toast.error('Enter a valid amount'); return }
    if (!payMode) { toast.error('Pick a payment method'); return }
    const balance = (showPayment.total || 0) - (showPayment.paidAmount || 0)
    const isWalkin = !showPayment.customerId
    if (isWalkin && amount > balance) {
      toast.error(`Walk-in invoice — reduce amount to ${fmt(balance)} or assign a customer first`)
      return
    }
    try {
      const res = await salesAPI.payment(showPayment.id, { amount, mode: payMode, ref: payRef })
      setSalesListVersion((v) => v + 1)
      await loadBranches()
      const credit = Number(res?.credit_applied || 0)
      if (credit > 0) {
        toast.success(
          `Invoice settled. ${fmt(credit)} credited to ${showPayment.customerName}`,
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
      // server's detail (e.g. "Walk-in invoice — reduce amount to ₹X" or
      // "Invoice already settled"). Don't double-toast here.
    }
  }

  const saveQuotation = async () => {
    // Strict customer mode (2026-05-24): every SO/Quote must reference a
    // real Customer row. Picker is the only entry point; checking
    // customerId rather than customerName is what enforces "no walk-in
    // typed name" — see CustomerPicker docstring.
    if (!quoteForm.customerId) {
      toast.error('Pick a customer (or add one via the Customers page)')
      return
    }
    if (quoteForm.items.length === 0) {
      toast.error('Add at least one item')
      return
    }
    // Validate all items have name and qty
    if (!quoteForm.items.every(i => i.name && Number(i.qty) > 0 && Number(i.price) > 0)) {
      toast.error('Each item must have name, qty, and price')
      return
    }
    try {
      const payload = {
        customer_name: quoteForm.customerName,
        customer_id: quoteForm.customerId || null,
        branch_id: quoteForm.branchId,
        branch_name: branches.find(b => b.id === quoteForm.branchId)?.name || '',
        created_by: 'Staff',
        valid_until: quoteForm.validUntil,
        items: quoteForm.items.map(i => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: Number(i.qty),
          price: Number(i.price),
          tax_rate: Number(i.taxRate || 0),
          // Backend stores percent — convert ₹ entries here.
          line_discount: lineDiscountToPercent(i),
        })),
        discount: Number(quoteForm.discount),
        notes: quoteForm.notes
      }
      setQuoteSaving(true)
      if (quoteEditingId) {
        await salesAPI.quotations.update(quoteEditingId, payload)
        toast.success('Quotation updated')
      } else {
        await salesAPI.quotations.create(payload)
        toast.success('Quotation created successfully')
      }
      setQuoteSkip(0)
      setQuoteListVersion((v) => v + 1)
      await loadBranches()
      setShowQuoteForm(false)
      setQuoteForm({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, validUntil: '', notes: '' })
      setQuoteEditingId(null)
      setQuoteEditingNumber(null)
      setQuoteReadOnly(false)
    } catch (err) {
      console.error('Failed to save quotation:', err)
      // Global axios interceptor already toasted with server detail —
      // don't double-toast a generic message here.
    } finally {
      setQuoteSaving(false)
    }
  }

  // Open quote modal in edit / view mode. Mirrors openOrderEdit.
  // Quotes carry `line_discount` (percent) per LineItemIn from the
  // invoice schema reuse — surfaced as `lineDiscount` here.
  const openQuoteEdit = (q, { readOnly = false } = {}) => {
    setQuoteForm({
      customerName: q.customerName || '',
      customerId: q.customerId || '',
      branchId: q.branchId || activeBranchId,
      items: (q.items || []).map(it => ({
        item_id: it.itemId || null,
        name: it.name || '',
        qty: it.qty,
        price: it.price,
        taxRate: it.taxRate ?? 0,
        lineDiscount: it.discount ?? 0,
        // Backend stores percent. Operator can toggle to ₹ in the
        // modal; toggleDiscountType auto-converts the value.
        lineDiscountType: '%',
      })),
      discount: q.discount || 0,
      validUntil: q.validUntil || '',
      notes: q.notes || '',
    })
    setQuoteEditingId(q.id)
    setQuoteEditingNumber(q.number)
    setQuoteReadOnly(!!readOnly)
    setShowQuoteForm(true)
  }

  const closeQuoteForm = () => {
    setShowQuoteForm(false)
    setQuoteEditingId(null)
    setQuoteEditingNumber(null)
    setQuoteReadOnly(false)
    setQuoteForm({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, validUntil: '', notes: '' })
  }

  // The + Create Quotation button uses this to SNAPSHOT the current
  // active branch into the form at open-time. Without the snapshot, a
  // branch switch in the Topbar between page-mount and clicking + Create
  // would leave the form pointing at the stale mount-time branch (the
  // post-close / post-save resets already use activeBranchId, but those
  // never ran on a fresh page).
  const openCreateQuote = () => {
    setQuoteForm({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, validUntil: '', notes: '' })
    setQuoteEditingId(null)
    setQuoteEditingNumber(null)
    setQuoteReadOnly(false)
    setShowQuoteForm(true)
  }

  // ── PR 2: Sales Order create ──────────────────────────────────────────
  // Same validation shape as quotations; the only differences are
  // expectedDate (vs validUntil) and the convert flow that comes later.
  const saveOrder = async () => {
    // See saveQuotation for the rationale on the customerId check.
    if (!orderForm.customerId) {
      toast.error('Pick a customer (or add one via the Customers page)')
      return
    }
    if (orderForm.items.length === 0) {
      toast.error('Add at least one item')
      return
    }
    if (!orderForm.items.every(i => i.name && Number(i.qty) > 0 && Number(i.price) > 0)) {
      toast.error('Each item must have name, qty, and price')
      return
    }
    setOrderSaving(true)
    try {
      const payload = {
        customer_name: orderForm.customerName,
        customer_id: orderForm.customerId || null,
        branch_id: orderForm.branchId,
        branch_name: branches.find(b => b.id === orderForm.branchId)?.name || '',
        created_by: 'Staff',
        expected_date: orderForm.expectedDate || null,
        items: orderForm.items.map(i => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: Number(i.qty),
          price: Number(i.price),
          tax_rate: Number(i.taxRate || 0),
          // Backend stores percent — convert ₹ entries here.
          discount: lineDiscountToPercent(i),
        })),
        discount: Number(orderForm.discount),
        notes: orderForm.notes,
      }
      if (orderEditingId) {
        await salesAPI.orders.update(orderEditingId, payload)
        toast.success('Sales order updated')
      } else {
        await salesAPI.orders.create(payload)
        toast.success('Sales order created')
      }
      setOrderSkip(0)
      setOrderListVersion((v) => v + 1)
      setShowOrderForm(false)
      setOrderForm({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, expectedDate: '', notes: '' })
      setOrderEditingId(null)
      setOrderEditingNumber(null)
      setOrderReadOnly(false)
    } catch (err) {
      console.error('Failed to save order:', err)
      // Global axios interceptor already toasted with server detail
    } finally {
      setOrderSaving(false)
    }
  }

  // Open the order modal in edit mode. Pre-fills from the row object —
  // we don't refetch detail unless items are missing (list endpoint
  // returns items via _so_dict). Edit only legal when the SO isn't in a
  // terminal status; UI hides the Edit button for those, so this is a
  // defense-in-depth assertion.
  const openOrderEdit = (so, { readOnly = false } = {}) => {
    setOrderForm({
      customerName: so.customerName || '',
      customerId: so.customerId || '',
      branchId: so.branchId || activeBranchId,
      items: (so.items || []).map(it => ({
        item_id: it.itemId || null,
        name: it.name || '',
        qty: it.qty,
        price: it.price,
        taxRate: it.taxRate ?? 0,
        lineDiscount: it.discount ?? 0,
        // Backend stores percent. Operator can toggle to ₹ in the
        // modal; toggleDiscountType auto-converts the value.
        lineDiscountType: '%',
      })),
      discount: so.discount || 0,
      expectedDate: so.expectedDate || '',
      notes: so.notes || '',
    })
    setOrderEditingId(so.id)
    setOrderEditingNumber(so.number)
    setOrderReadOnly(!!readOnly)
    setShowOrderForm(true)
  }

  // Single onClose handler used by both create and edit modes.
  const closeOrderForm = () => {
    setShowOrderForm(false)
    setOrderEditingId(null)
    setOrderEditingNumber(null)
    setOrderReadOnly(false)
    setOrderForm({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, expectedDate: '', notes: '' })
  }

  // See openCreateQuote — same snapshot trick for the sales order flow.
  const openCreateOrder = () => {
    setOrderForm({ customerName: '', customerId: '', branchId: activeBranchId, items: [], discount: 0, expectedDate: '', notes: '' })
    setOrderEditingId(null)
    setOrderEditingNumber(null)
    setOrderReadOnly(false)
    setShowOrderForm(true)
  }

  // ── PR 2: Sales Order → Invoice convert ───────────────────────────────
  // The shared ConvertToInvoiceModal hands us {payment_received,
  // payment_mode, notes} from its checkbox + dropdown. Server creates
  // the SaleInvoice (paid or pending), locks the SO at status=converted,
  // returns the new invoice's id/number/total. We bump both order +
  // invoice list versions so both tabs reflect reality on next view.
  const convertOrder = async (body) => {
    if (!convertSource || convertSource.kind !== 'order') return
    setConverting(true)
    try {
      const res = await salesAPI.orders.convert(convertSource.id, body)
      toast.success(
        `Invoice ${res?.invoice_number || ''} created (${res?.status || ''})`,
      )
      setOrderListVersion((v) => v + 1)
      setSalesListVersion((v) => v + 1)
      setConvertSource(null)
    } catch (err) {
      console.error('Failed to convert order:', err)
    } finally {
      setConverting(false)
    }
  }

  // ── PR 2: Quotation → Sales Order convert ─────────────────────────────
  // No payment prompt here — the order itself doesn't carry payment
  // state. The order's own convert-to-invoice (above) is what prompts
  // for payment.
  const convertQuoteToOrder = async (quote) => {
    if (!quote?.id) return
    try {
      const res = await salesAPI.quotations.convertToOrder(quote.id)
      toast.success(`Sales order ${res?.order_number || ''} created from ${quote.number}`)
      setQuoteListVersion((v) => v + 1)
      setOrderListVersion((v) => v + 1)
    } catch (err) {
      console.error('Failed to convert quotation:', err)
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading sales...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Sales Management" subtitle="Invoices, orders, quotations, and customer payments">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = invoices.map(i => ({
            'Invoice Number': i.number || i.id,
            'Customer': i.customerName || 'Walk-in',
            'Date': i.date || '—',
            'Amount (₹)': i.total || 0,
            'Paid (₹)': i.paidAmount || 0,
            'Outstanding (₹)': (i.total || 0) - (i.paidAmount || 0),
            'Status': statusLabel(i.status),
          }))
          exportToCSV(exportData, `Sales_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Sales exported')
        }}>↓ Export</button>
        {can('invoices.create') && (
          <button className="btn btn-secondary btn-sm" onClick={() => toast('Quotation feature coming soon')}>+ Quotation</button>
        )}
        {can('pos.use', 'invoices.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/pos')}>+ New Sale</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Sales (Today)" value={fmt(totals.total)} color="var(--accent)" icon="💰" />
        <KPICard label="Collected"           value={fmt(totals.paid)}  color="var(--green)"  icon="✅" />
        <KPICard label="On Credit"           value={fmt(totals.credit)} color="var(--amber)" icon="📋" />
        <KPICard label="Overdue"             value={fmt(totals.overdue)} color="var(--red)"  icon="⚠️" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'invoices' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search invoice #, customer…" />
            <select className="form-input" style={{ width: 140 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['paid', 'pending', 'partial', 'overdue', 'draft'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            {/* Branch filter removed 2026-05-23 — Topbar active-branch
                picker scopes things globally; a second filter here was
                duplicative. */}
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From" />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo}   onChange={(e) => setDateTo(e.target.value)} placeholder="To" />
          </div>

          <Card bodyPadding={false}>
            {invoices.length === 0 ? <EmptyState icon="🧾" title="No invoices found" /> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Invoice #" sortKey="number" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Branch" sortKey="branch_id" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} />
                    <SortableHeader label="Cashier" sortKey="cashier" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Amount" sortKey="total" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Paid" sortKey="paid_amount" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Mode" sortKey="payment_mode" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Status" sortKey="status" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td><CopyableId value={inv.number} label={inv.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                      <td>
                        <div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{inv.customerName || 'Walk-in'}</div>
                        {inv.notes && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{inv.notes}</div>}
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
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(inv)}>View</button>
                          {['pending', 'partial', 'overdue'].includes(inv.status) && can('invoices.edit') &&
                            <button className="btn btn-primary btn-xs" onClick={() => setShowPayment(inv)}>Pay</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={invoiceTotal}
              skip={invSkip}
              limit={invLimit}
              onSkipChange={setInvSkip}
              onLimitChange={setInvLimit}
              disabled={loading}
            />
          </Card>
        </>
      )}

      {tab === 'quotes' && (
        <>
          {can('invoices.create') && (
            <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
              <button className="btn btn-primary btn-sm" onClick={openCreateQuote}>+ Create Quotation</button>
            </div>
          )}
          <Card bodyPadding={false}>
            {quotations.length === 0 ? (
              <EmptyState icon="📄" title="No quotations" desc="No quotations created yet" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
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
                    <tr key={q.id}>
                      <td><CopyableId value={q.number} label={q.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                      <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{q.customerName || 'Walk-in'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.date}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.validUntil || '—'}</td>
                      <td className="text-right mono">{fmt(q.total)}</td>
                      <td><Chip status={q.status === 'sent' ? 'active' : q.status === 'accepted' ? 'success' : 'draft'} label={q.status.charAt(0).toUpperCase() + q.status.slice(1)} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {/* Editable (draft / sent) → Edit + Convert.
                              Locked (accepted / converted / rejected)
                              → View only. Matches PUT
                              /sales/quotations/{id} server-side check. */}
                          {!['converted', 'accepted', 'rejected'].includes(q.status) && can('invoices.edit') && (
                            <button className="btn btn-secondary btn-xs" onClick={() => openQuoteEdit(q)}>
                              Edit
                            </button>
                          )}
                          {!['converted', 'rejected'].includes(q.status) && can('invoices.create') && (
                            <button className="btn btn-primary btn-xs" onClick={() => convertQuoteToOrder(q)}>
                              Convert to Order
                            </button>
                          )}
                          {['converted', 'accepted', 'rejected'].includes(q.status) && (
                            <button className="btn btn-ghost btn-xs" onClick={() => openQuoteEdit(q, { readOnly: true })}>
                              View
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={quoteTotal}
              skip={quoteSkip}
              limit={quoteLimit}
              onSkipChange={setQuoteSkip}
              onLimitChange={setQuoteLimit}
            />
          </Card>

          <QuoteFormModal
            open={showQuoteForm}
            onClose={closeQuoteForm}
            onSave={saveQuotation}
            quoteForm={quoteForm}
            pqf={pqf}
            branches={branches}
            saving={quoteSaving}
            editingNumber={quoteEditingNumber}
            readOnly={quoteReadOnly}
          />
        </>
      )}

      {/* PR 2 modals — rendered at the page root so they can open from any
          tab. ConvertToInvoiceModal serves the SO-convert flow today; the
          quote-convert flow is fire-and-forget (no payment prompt needed
          since the order itself doesn't carry payment state). */}
      <OrderFormModal
        open={showOrderForm}
        onClose={closeOrderForm}
        onSave={saveOrder}
        orderForm={orderForm}
        pof={pof}
        branches={branches}
        saving={orderSaving}
        editingNumber={orderEditingNumber}
        readOnly={orderReadOnly}
      />
      <ReturnFormModal
        open={showReturnForm}
        onClose={() => setShowReturnForm(false)}
        onSaved={() => { setRetListVersion((v) => v + 1); setSalesListVersion((v) => v + 1) }}
      />
      <ConvertToInvoiceModal
        open={!!convertSource}
        onClose={() => setConvertSource(null)}
        onConfirm={convertOrder}
        title={convertSource ? `Convert ${convertSource.number}` : 'Convert to Invoice'}
        source={convertSource}
        lines={convertSource?.lines || null}
        branchId={convertSource?.branchId || null}
        confirming={converting}
      />

      {/* Credit Purchases tab removed 2026-05-23 (Sales Phase 1). */}

      {tab === 'returns' && (
        <>
          {/* Sales Phase 1 PR 2: real Credit Notes / Returns. + New
              button opens the ReturnFormModal (invoice picker → line
              picker → refund method). Columns match the new API shape
              (camelCase: invoiceNumber, refundMethod, total). */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
            {can('invoices.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowReturnForm(true)}>
                + New Return
              </button>
            )}
          </div>
          <Card bodyPadding={false}>
            {returns.length === 0 ? (
              <EmptyState icon="↩" title="No credit notes" desc="Process a return to generate a credit note" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Credit Note #" sortKey="number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Invoice" sortKey="invoice_number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} className="text-right" align="right" />
                    <th className="text-right">Credited</th>
                    <th>Refund</th>
                    <th>Reason</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                  </tr>
                </thead>
                <tbody>
                  {returns.map((r) => (
                    <tr key={r.id}>
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
                          {r.refundMethod === 'credit' ? 'Credit' : r.refundMethod === 'adjustment' ? 'Adjustment' : 'Cash'}
                        </Tag>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.reason || '—'}</td>
                      <td><Chip status={r.status === 'processed' ? 'paid' : r.status} label={(r.status || '').charAt(0).toUpperCase() + (r.status || '').slice(1)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={retTotal}
              skip={retSkip}
              limit={retLimit}
              onSkipChange={setRetSkip}
              onLimitChange={setRetLimit}
            />
          </Card>
        </>
      )}

      {tab === 'orders' && (
        <>
          {/* Sales Phase 1 PR 2 (2026-05-23): real Sales Orders. + New
              opens OrderFormModal; each row gets a Convert button (when
              not already converted) that opens the shared
              ConvertToInvoiceModal. */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
            {can('invoices.create') && (
              <button className="btn btn-primary btn-sm" onClick={openCreateOrder}>
                + New Sales Order
              </button>
            )}
          </div>
          <Card bodyPadding={false}>
            {orders.length === 0 ? (
              <EmptyState
                icon="📦"
                title="No sales orders"
                desc="Create one directly or convert a quotation."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
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
                    const isCancelled = o.status === 'cancelled'
                    return (
                      <tr key={o.id}>
                        <td><CopyableId value={o.number} label={o.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{o.customerName || 'Walk-in'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.date}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.expectedDate || '—'}</td>
                        <td className="text-right mono">{fmt(o.total)}</td>
                        <td><Chip status={isConverted ? 'paid' : isCancelled ? 'inactive' : 'active'} label={(o.status || '').charAt(0).toUpperCase() + (o.status || '').slice(1)} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {/* Editable (draft / confirmed) → Edit +
                                Convert. Locked (converted / cancelled)
                                → View only. Matches the server-side
                                check in PUT /sales/orders/{id}. */}
                            {!isConverted && !isCancelled && can('invoices.edit') && (
                              <button className="btn btn-secondary btn-xs" onClick={() => openOrderEdit(o)}>
                                Edit
                              </button>
                            )}
                            {!isConverted && !isCancelled && can('invoices.create') && (
                              <button
                                className="btn btn-primary btn-xs"
                                onClick={() => setConvertSource({
                                  kind: 'order',
                                  id: o.id,
                                  number: o.number,
                                  total: o.total,
                                  customerName: o.customerName,
                                  branchId: o.branchId,
                                  // Forward the SO's line items so the
                                  // convert modal can render the stock
                                  // allocation section. Map to the
                                  // {item_id, name, qty} shape the modal
                                  // expects (snake_case item_id matches
                                  // the form's existing convention).
                                  lines: (o.items || []).map((li) => ({
                                    item_id: li.itemId,
                                    name: li.name,
                                    qty: li.qty,
                                  })),
                                })}
                              >
                                Convert
                              </button>
                            )}
                            {(isConverted || isCancelled) && (
                              <button className="btn btn-ghost btn-xs" onClick={() => openOrderEdit(o, { readOnly: true })}>
                                View
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={orderTotal}
              skip={orderSkip}
              limit={orderLimit}
              onSkipChange={setOrderSkip}
              onLimitChange={setOrderLimit}
            />
          </Card>
        </>
      )}

      {/* Invoice Detail Modal */}
      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title={`Invoice — ${showDetail?.number}`} icon="🧾" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
          <button className="btn btn-secondary" onClick={() => { setShowReceipt(showDetail); setShowDetail(null) }}>🖨 Receipt</button>
          {['pending','partial','overdue'].includes(showDetail?.status) && <button className="btn btn-primary" onClick={() => { setShowPayment(showDetail); setShowDetail(null) }}>Record Payment</button>}
        </>}>
        {showDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Customer', value: showDetail.customerName || 'Walk-in' },
                { label: 'Branch', value: showDetail.branchName || showDetail.branchId },
                { label: 'Cashier', value: showDetail.cashier || 'N/A' },
                { label: 'Date', value: showDetail.date },
                { label: 'Payment Mode', value: displayPaymentMode(showDetail.paymentMode) },
                { label: 'Status', value: <Chip status={showDetail.status} /> },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">GST</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {(showDetail.items || []).map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                    <td className="text-right mono">{item.qty}</td>
                    <td className="text-right mono">{fmt(item.price)}</td>
                    <td className="text-right mono">{item.taxRate || 0}%</td>
                    <td className="text-right mono">{fmt(item.lineTotal || (item.qty * item.price))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>Subtotal</span><span className="mono">{fmt(showDetail.subtotal || (showDetail.total - (showDetail.taxTotal || 0)))}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>GST</span><span className="mono">{fmt(showDetail.taxTotal || 0)}</span></div>
              {(showDetail.discount || 0) > 0 && <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--green)' }}><span>Discount</span><span className="mono">-{fmt(showDetail.discount)}</span></div>}
              <div style={{ display: 'flex', gap: 80, fontSize: 17, fontWeight: 700 }}><span>Total</span><span className="mono" style={{ color: 'var(--accent)' }}>{fmt(showDetail.total)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--green)' }}><span>Paid</span><span className="mono">{fmt(showDetail.paidAmount || 0)}</span></div>
              {(showDetail.total || 0) > (showDetail.paidAmount || 0) && <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--red)' }}><span>Balance Due</span><span className="mono">{fmt((showDetail.total || 0) - (showDetail.paidAmount || 0))}</span></div>}
            </div>
          </>
        )}
      </Modal>

      {/* Payment Modal */}
      <Modal open={!!showPayment} onClose={() => setShowPayment(null)} title="Record Payment" icon="💳" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowPayment(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={recordPayment}>Record Payment</button>
        </>}>
        {showPayment && (() => {
          const balance = (showPayment.total || 0) - (showPayment.paidAmount || 0)
          const amount = Number(payAmt) || 0
          const overpay = Math.max(0, amount - balance)
          const isWalkin = !showPayment.customerId
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
                  stay editable so excess routes to credit_balance. */}
              <FormGroup label="Amount Received (₹)" required>
                <input
                  className="form-input"
                  type="number"
                  value={payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  disabled={isWalkin}
                  autoFocus={!isWalkin}
                />
                {isWalkin && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Locked to balance for walk-in invoices. Assign a customer to enable partial / overpayment.
                  </div>
                )}
              </FormGroup>
              {/* Overpayment hint — only reachable on customer invoices
                  now that walk-in amount is locked. Server still echoes
                  credit_applied in the success toast. */}
              {overpay > 0 && !isWalkin && (
                <AlertBar type="amber" icon="ℹ">
                  Overpayment: <strong>{fmt(overpay)}</strong> will be credited to {showPayment.customerName}
                </AlertBar>
              )}
              <FormGroup label="Payment Mode" required>
                {/* Keep this list aligned with POSPage.jsx and the
                    PaymentMode Literal in backend/src/routes/sales.py.
                    Cheque was removed 2026-05-24 to match POS exactly. */}
                <select className="form-input" value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                  {['cash', 'card', 'upi', 'bank_transfer'].map((m) => <option key={m} value={m}>{m.replace('_', ' ').toUpperCase()}</option>)}
                </select>
              </FormGroup>
              <FormGroup label="Reference / Transaction ID">
                <input className="form-input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UTR / transaction reference" />
              </FormGroup>
            </>
          )
        })()}
      </Modal>

      {/* Receipt Modal */}
      <Modal open={!!showReceipt} onClose={() => setShowReceipt(null)} title={`Receipt — ${showReceipt?.number}`} icon="🧾" size="md">
        {showReceipt && (
          <Receipt
            sale={showReceipt}
            branch={branches.find(b => b.id === showReceipt.branchId)}
            onClose={() => setShowReceipt(null)}
          />
        )}
      </Modal>
    </div>
  )
}

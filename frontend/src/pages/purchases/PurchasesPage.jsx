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
import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { purchasesAPI, vendorsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, KPICard, Modal, FormGroup, EmptyState, AlertBar, PaginationBar, SortableHeader, CopyableId } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import BillFormModal from './BillFormModal'
import PurchaseOrderFormModal from './PurchaseOrderFormModal'
import ConvertPOToBillModal from './ConvertPOToBillModal'
import VendorReturnFormModal from './VendorReturnFormModal'
import VendorPaymentFormModal from './VendorPaymentFormModal'

const TABS = [
  { id: 'bills',    label: 'Purchase Bills' },
  { id: 'orders',   label: 'Purchase Orders' },
  // GRN tab dropped 2026-05-24 — was a re-skin of bills with no
  // separate model. The Vendor Returns tab now sits in the slot.
  { id: 'returns',  label: 'Vendor Returns' },
  // 2026-05-24: standalone Payments record — mirror of sales /payments.
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

// Convert a form's per-line discount {value, type} into the PERCENT the
// backend expects. Mirror of the same helper in SalesPage.
function lineDiscountToPercent(line) {
  const qty = Number(line.qty || 0)
  const cost = Number(line.cost || 0)
  const gross = qty * cost
  const raw = Math.max(0, Number(line.lineDiscount || 0))
  if (line.lineDiscountType === '₹') {
    if (gross <= 0) return 0
    return Math.min(100, (raw / gross) * 100)
  }
  return Math.min(100, raw)
}

export default function PurchasesPage() {
  const can = useCan()

  // Active branch from Topbar — single source of truth for which branch
  // a new bill / PO will be filed under. See SalesPage.jsx for the
  // matching pattern (activeBranchId + snapshot-at-modal-open).
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'
  const activeBranch = useAppStore((s) => s.activeBranch)

  const [tab, setTab]           = useState('bills')
  const [search, setSearch]     = useState('')
  const [statusF, setStatusF]   = useState('')
  const [vendorF, setVendorF]   = useState('')

  // Bills state
  const [bills, setBills]       = useState([])
  const [billTotal, setBillTotal] = useState(0)
  const [billSkip, setBillSkip] = useState(0)
  const [billLimit, setBillLimit] = useState(DEFAULT_PAGE_SIZE)
  const [billSortBy, setBillSortBy] = useState('created_at')
  const [billSortOrder, setBillSortOrder] = useState('desc')
  const [purchaseSummary, setPurchaseSummary] = useState(null)

  // POs state
  const [orders, setOrders] = useState([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [orderSkip, setOrderSkip] = useState(0)
  const [orderLimit, setOrderLimit] = useState(DEFAULT_PAGE_SIZE)
  const [orderSortBy, setOrderSortBy] = useState('created_at')
  const [orderSortOrder, setOrderSortOrder] = useState('desc')

  // Returns state
  const [returns, setReturns]   = useState([])
  const [retTotal, setRetTotal] = useState(0)
  const [retSkip, setRetSkip] = useState(0)
  const [retLimit, setRetLimit] = useState(DEFAULT_PAGE_SIZE)
  const [retSortBy, setRetSortBy] = useState('created_at')
  const [retSortOrder, setRetSortOrder] = useState('desc')

  // Payments state
  const [payments, setPayments] = useState([])
  const [payTotal, setPayTotal] = useState(0)
  const [paySkip, setPaySkip] = useState(0)
  const [payLimit, setPayLimit] = useState(DEFAULT_PAGE_SIZE)
  const [paySortBy, setPaySortBy] = useState('created_at')
  const [paySortOrder, setPaySortOrder] = useState('desc')
  const [showPayForm, setShowPayForm] = useState(false)
  const [payDetail, setPayDetail] = useState(null)

  // Masters (only vendors — for the filter dropdown). Items + branches
  // are no longer loaded as masters; pickers do their own paginated
  // fetches on demand.
  const [vendors, setVendors]   = useState([])

  const [loading, setLoading]   = useState(true)
  const [listVersion, setListVersion] = useState(0)

  // Modals + sub-state
  const [showDetail, setShowDetail] = useState(null)
  const [showPay, setShowPay]   = useState(null)
  const [showCancel, setShowCancel] = useState(null)
  const [showNewBill, setShowNewBill] = useState(false)
  const [showNewReturn, setShowNewReturn] = useState(false)
  const [returnDetail, setReturnDetail] = useState(null)
  const [showOrderForm, setShowOrderForm] = useState(false)
  const [orderSaving, setOrderSaving] = useState(false)
  const [orderEditingId, setOrderEditingId] = useState(null)
  const [orderEditingNumber, setOrderEditingNumber] = useState(null)
  const [orderReadOnly, setOrderReadOnly] = useState(false)
  const [billSaving, setBillSaving] = useState(false)
  const [convertSource, setConvertSource] = useState(null)
  const [converting, setConverting] = useState(false)

  // Payment modal state — same shape as SalesPage's pay-flow.
  const [payAmt, setPayAmt]     = useState('')
  const [payMode, setPayMode]   = useState('bank_transfer')
  const [payRef, setPayRef]     = useState('')

  // Bill form. paymentReceived + paymentMethod mirror the POS checkout
  // flow — settle in-line at create if checked, otherwise the bill
  // lands as pending and is settled later via Record Payment.
  const [billForm, setBillForm] = useState({
    vendorId: '', vendorName: '',
    branchId: activeBranchId,
    billDate: new Date().toISOString().split('T')[0],
    dueDate: '',
    items: [],
    paymentReceived: false,
    paymentMethod: null,
    notes: '',
  })
  const pbf = (k, v) => setBillForm((b) => ({ ...b, [k]: v }))

  // PO form. Mirror of orderForm in SalesPage.
  const [poForm, setPoForm] = useState({
    vendorId: '', vendorName: '',
    branchId: activeBranchId,
    items: [],
    expectedDate: '',
    notes: '',
  })
  const ppof = (k, v) => setPoForm((f) => ({ ...f, [k]: v }))

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
  }, [search, statusF, vendorF])

  // Bills list
  useEffect(() => {
    if (tab !== 'bills') return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        // 2026-05-25: dropped the silent `branch_id: activeBranchId`
        // filter. Sales doesn't filter its invoices by active branch
        // either — and an operator at Branch A who can't see Branch B's
        // payables is a hidden-data trap. Branch is still IMPLICIT at
        // create time (openCreateBill snapshots activeBranchId), but
        // the list now shows every branch's bills. Future: an explicit
        // Branch filter dropdown alongside Vendor/Status if anyone wants
        // per-branch scoping.
        const raw = await purchasesAPI.list({
          skip: billSkip,
          limit: billLimit,
          sort_by: billSortBy,
          sort_order: billSortOrder,
          search: search || undefined,
          status: statusF || undefined,
          vendor_id: vendorF || undefined,
        })
        const { items, total, summary } = unwrapPaged(raw)
        if (!cancelled) {
          setBills(items || [])
          setBillTotal(total)
          setPurchaseSummary(summary)
        }
      } catch (err) {
        console.error('Failed to fetch purchases:', err)
        if (!cancelled) {
          setBills([])
          setBillTotal(0)
          setPurchaseSummary(null)
        }
        toast.error('Failed to load purchases data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, billSkip, billLimit, search, statusF, vendorF, listVersion, billSortBy, billSortOrder])

  // Orders list — same no-branch-filter policy as bills (see above).
  useEffect(() => {
    if (tab !== 'orders') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await purchasesAPI.orders.list({
          skip: orderSkip,
          limit: orderLimit,
          sort_by: orderSortBy,
          sort_order: orderSortOrder,
          search: search || undefined,
          status: statusF || undefined,
          vendor_id: vendorF || undefined,
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
      }
    })()
    return () => { cancelled = true }
  }, [tab, orderSkip, orderLimit, search, statusF, vendorF, listVersion, orderSortBy, orderSortOrder])

  // Returns list
  useEffect(() => {
    if (tab !== 'returns') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await purchasesAPI.returns.list({
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
  }, [tab, retSkip, retLimit, listVersion, retSortBy, retSortOrder])

  // Payments list
  useEffect(() => {
    if (tab !== 'payments') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await purchasesAPI.payments.list({
          skip: paySkip,
          limit: payLimit,
          sort_by: paySortBy,
          sort_order: paySortOrder,
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
      }
    })()
    return () => { cancelled = true }
  }, [tab, paySkip, payLimit, paySortBy, paySortOrder, listVersion])

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

  const totals = useMemo(() => ({
    total:   purchaseSummary?.amountTotal ?? 0,
    paid:    purchaseSummary?.collectedPaid ?? 0,
    pending: purchaseSummary?.pendingBalance ?? 0,
    overdue: purchaseSummary?.overdueCount ?? 0,
  }), [purchaseSummary])

  // ── Bill flows ────────────────────────────────────────────────────
  const openCreateBill = () => {
    // Snapshot active branch at open-time. Avoids mid-fill picker swaps
    // if the operator changes branches in the Topbar after opening.
    setBillForm({
      vendorId: '', vendorName: '',
      branchId: activeBranchId,
      billDate: new Date().toISOString().split('T')[0],
      dueDate: '',
      items: [],
      paymentReceived: false,
      paymentMethod: null,
      notes: '',
    })
    setShowNewBill(true)
  }

  const saveBillForm = async () => {
    if (!billForm.vendorId) { toast.error('Pick a vendor'); return }
    if (billForm.items.length === 0) { toast.error('Add at least one item'); return }
    if (!billForm.items.every((i) => i.item_id && Number(i.qty) > 0 && Number(i.cost) >= 0)) {
      toast.error('Each line must have an item, qty > 0, and cost ≥ 0')
      return
    }
    if (billForm.paymentReceived && !billForm.paymentMethod) {
      toast.error('Pick a payment method (or uncheck Payment paid?)')
      return
    }
    setBillSaving(true)
    try {
      const payload = {
        vendor_id: billForm.vendorId,
        vendor_name: billForm.vendorName,
        branch_id: billForm.branchId,
        branch_name: activeBranch?.name || '',
        date: billForm.billDate,
        due_date: billForm.dueDate || null,
        items: billForm.items.map((i) => ({
          item_id: i.item_id,
          name: i.name,
          qty: Number(i.qty),
          cost: Number(i.cost),
          tax_rate: Number(i.taxRate || 0),
          discount: lineDiscountToPercent(i),
          batch_number: i.batchTracking ? (i.batchNumber || undefined) : undefined,
          mfg_date:     i.batchTracking ? (i.mfgDate     || undefined) : undefined,
          expiry_date:  i.batchTracking ? (i.expiryDate  || undefined) : undefined,
        })),
        discount: 0,
        payment_mode: billForm.paymentReceived ? billForm.paymentMethod : null,
        notes: billForm.notes || null,
      }
      await purchasesAPI.create(payload)
      setListVersion((v) => v + 1)
      toast.success('Purchase bill created')
      setShowNewBill(false)
    } catch (err) {
      console.error('Failed to save bill:', err)
    } finally {
      setBillSaving(false)
    }
  }

  const recordPayment = async () => {
    if (!showPay) return
    const amount = Number(payAmt)
    if (!payAmt || amount <= 0) { toast.error('Enter a valid amount'); return }
    if (!payMode) { toast.error('Pick a payment method'); return }
    try {
      await purchasesAPI.payment(showPay.id, { amount, mode: payMode, ref: payRef })
      setListVersion((v) => v + 1)
      toast.success(`Payment of ${fmt(amount)} recorded`)
      setShowPay(null)
    } catch (err) {
      console.error('Failed to record payment:', err)
    }
  }

  const cancelBill = async () => {
    if (!showCancel) return
    try {
      await purchasesAPI.cancel(showCancel.id)
      setListVersion((v) => v + 1)
      toast.success(`${showCancel.number} cancelled`)
      setShowCancel(null)
    } catch (err) {
      console.error('Failed to cancel bill:', err)
    }
  }

  // ── PO flows ──────────────────────────────────────────────────────
  const openCreatePO = () => {
    setPoForm({
      vendorId: '', vendorName: '',
      branchId: activeBranchId,
      items: [],
      expectedDate: '',
      notes: '',
    })
    setOrderEditingId(null)
    setOrderEditingNumber(null)
    setOrderReadOnly(false)
    setShowOrderForm(true)
  }

  const openEditPO = (po, { readOnly = false } = {}) => {
    setPoForm({
      vendorId: po.vendorId || '',
      vendorName: po.vendorName || '',
      branchId: po.branchId || activeBranchId,
      items: (po.items || []).map((it) => ({
        item_id: it.itemId || null,
        name: it.name || '',
        qty: it.qty,
        cost: it.cost,
        taxRate: it.taxRate ?? 0,
        lineDiscount: it.discount ?? 0,
        lineDiscountType: '%',
      })),
      expectedDate: po.expectedDate || '',
      notes: po.notes || '',
    })
    setOrderEditingId(po.id)
    setOrderEditingNumber(po.number)
    setOrderReadOnly(!!readOnly)
    setShowOrderForm(true)
  }

  const savePoForm = async () => {
    if (!poForm.vendorId) { toast.error('Pick a vendor'); return }
    if (poForm.items.length === 0) { toast.error('Add at least one item'); return }
    if (!poForm.items.every((i) => i.item_id && Number(i.qty) > 0 && Number(i.cost) >= 0)) {
      toast.error('Each line must have an item, qty > 0, and cost ≥ 0')
      return
    }
    setOrderSaving(true)
    try {
      const payload = {
        vendor_id: poForm.vendorId,
        vendor_name: poForm.vendorName,
        branch_id: poForm.branchId,
        branch_name: activeBranch?.name || '',
        created_by: 'Staff',
        expected_date: poForm.expectedDate || null,
        items: poForm.items.map((i) => ({
          item_id: i.item_id,
          name: i.name,
          qty: Number(i.qty),
          cost: Number(i.cost),
          tax_rate: Number(i.taxRate || 0),
          discount: lineDiscountToPercent(i),
        })),
        discount: 0,
        notes: poForm.notes || null,
      }
      if (orderEditingId) {
        await purchasesAPI.orders.update(orderEditingId, payload)
        toast.success('Purchase order updated')
      } else {
        await purchasesAPI.orders.create(payload)
        toast.success('Purchase order created')
      }
      setListVersion((v) => v + 1)
      setShowOrderForm(false)
      setOrderEditingId(null)
      setOrderEditingNumber(null)
    } catch (err) {
      console.error('Failed to save PO:', err)
    } finally {
      setOrderSaving(false)
    }
  }

  const convertPO = async (body) => {
    if (!convertSource || convertSource.kind !== 'order') return
    setConverting(true)
    try {
      const res = await purchasesAPI.orders.convert(convertSource.id, body)
      toast.success(`Bill ${res?.bill_number || ''} created (${res?.status || ''})`)
      setListVersion((v) => v + 1)
      setConvertSource(null)
    } catch (err) {
      console.error('Failed to convert PO:', err)
    } finally {
      setConverting(false)
    }
  }

  const cancelPO = async (po) => {
    if (!po?.id) return
    try {
      await purchasesAPI.orders.updateStatus(po.id, 'cancelled')
      setListVersion((v) => v + 1)
      toast.success(`${po.number} cancelled`)
    } catch (err) {
      console.error('Failed to cancel PO:', err)
    }
  }

  if (loading && tab === 'bills') {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading purchases...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Purchase Management" subtitle="Vendor bills, purchase orders, and payments">
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
        {can('purchases.create') && (
          <button className="btn btn-secondary btn-sm" onClick={openCreatePO}>+ New PO</button>
        )}
        {can('purchases.create') && (
          <button className="btn btn-primary btn-sm" onClick={openCreateBill}>+ New Bill</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Purchases (Apr)" value={fmt(totals.total)} color="var(--purple)" icon="📦" />
        <KPICard label="Paid"                  value={fmt(totals.paid)}  color="var(--green)"  icon="✅" />
        <KPICard label="Outstanding Payables"  value={fmt(totals.pending)} color="var(--amber)" icon="💳" />
        <KPICard label="Overdue Bills"         value={totals.overdue}    color="var(--red)"    icon="⚠️" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* ── BILLS ─────────────────────────────────────────────────── */}
      {tab === 'bills' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search bill #, vendor…" />
            <select className="form-input" style={{ width: 140 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['paid','pending','partial','overdue','cancelled'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <Card bodyPadding={false}>
            {bills.length === 0 ? <EmptyState icon="📋" title="No bills found" /> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Bill #" sortKey="number" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Due Date" sortKey="due_date" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Paid" sortKey="paid_amount" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Balance" sortKey="balance_due" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} className="text-right" align="right" />
                    <th>Mode</th>
                    <SortableHeader label="Status" sortKey="status" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    const balance = (b.total || 0) - (b.paidAmount || 0)
                    const canPay = b.status !== 'paid' && b.status !== 'cancelled'
                    const canCancel = b.status !== 'paid' && b.status !== 'cancelled'
                    return (
                      <tr key={b.id}>
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
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(b)}>View</button>
                            {canPay && can('purchases.edit') && <button className="btn btn-primary btn-xs" onClick={() => setShowPay(b)}>Pay</button>}
                            {canCancel && can('purchases.edit') && <button className="btn btn-ghost btn-xs" onClick={() => setShowCancel(b)}>Cancel</button>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={billTotal}
              skip={billSkip}
              limit={billLimit}
              onSkipChange={setBillSkip}
              onLimitChange={setBillLimit}
              disabled={loading}
            />
          </Card>
        </>
      )}

      {/* ── ORDERS ────────────────────────────────────────────────── */}
      {tab === 'orders' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search PO #, vendor…" />
            <select className="form-input" style={{ width: 140 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">All Status</option>
              {['draft','confirmed','converted','cancelled'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
            {can('purchases.create') && (
              <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={openCreatePO}>+ New PO</button>
            )}
          </div>
          <Card bodyPadding={false}>
            {orders.length === 0 ? (
              <EmptyState icon="📄" title="No purchase orders" desc="POs you create will appear here. Convert one to a Bill to receive goods." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
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
                    return (
                      <tr key={o.id}>
                        <td><CopyableId value={o.number} label={o.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                        <td><div style={{ fontWeight: 500, fontSize: 13 }}>{o.vendorName || 'N/A'}</div></td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.date}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.expectedDate || '—'}</td>
                        <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(o.total || 0)}</td>
                        <td><Chip status={o.status} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {!isConverted && !isCancelled && can('purchases.edit') && (
                              <button className="btn btn-secondary btn-xs" onClick={() => openEditPO(o)}>Edit</button>
                            )}
                            {!isConverted && !isCancelled && can('purchases.create') && (
                              <button
                                className="btn btn-primary btn-xs"
                                onClick={() => setConvertSource({
                                  kind: 'order',
                                  id: o.id,
                                  number: o.number,
                                  total: o.total,
                                  vendorName: o.vendorName,
                                  branchId: o.branchId,
                                  // Forward PO lines to the convert modal so
                                  // it can show batch-capture inputs for
                                  // tracked items. Map to {item_id, name,
                                  // qty} shape; modal lazy-fetches the
                                  // batch_tracking + expiry_tracking flags.
                                  lines: (o.items || []).map((li) => ({
                                    item_id: li.itemId,
                                    name: li.name,
                                    qty: li.qty,
                                  })),
                                })}
                              >Convert</button>
                            )}
                            {(isConverted || isCancelled) && (
                              <button className="btn btn-ghost btn-xs" onClick={() => openEditPO(o, { readOnly: true })}>View</button>
                            )}
                            {!isConverted && !isCancelled && can('purchases.edit') && (
                              <button className="btn btn-ghost btn-xs" onClick={() => cancelPO(o)}>Cancel</button>
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

      {/* ── RETURNS ───────────────────────────────────────────────── */}
      {tab === 'returns' && (
        <>
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
            {can('purchases.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowNewReturn(true)}>+ New Return</button>
            )}
          </div>
          <Card bodyPadding={false}>
            {returns.length === 0 ? (
              <EmptyState icon="↩️" title="No vendor returns" desc="Returns to vendors will appear here." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
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
                    <tr key={r.id}>
                      <td><CopyableId value={r.number} label={r.number} style={{ color: 'var(--pink)', fontSize: 12 }} /></td>
                      <td><CopyableId value={r.billNumber} label={r.billNumber} style={{ color: 'var(--purple)', fontSize: 12 }} /></td>
                      <td style={{ fontWeight: 500, fontSize: 13 }}>{r.vendorName}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.date}</td>
                      <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(r.total)}</td>
                      <td style={{ fontSize: 12 }}><Chip label={r.reason} /></td>
                      <td><Chip status={r.status} /></td>
                      <td>
                        <button className="btn btn-ghost btn-xs" onClick={() => setReturnDetail(r)}>View</button>
                      </td>
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

      {/* ── PAYMENTS ──────────────────────────────────────────────── */}
      {tab === 'payments' && (
        <>
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
            {can('purchases.edit') && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowPayForm(true)}>
                + New Payment
              </button>
            )}
          </div>
          <Card bodyPadding={false}>
            {payments.length === 0 ? (
              <EmptyState icon="💸" title="No payments yet" desc="Record a vendor payment to see it here." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
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
                      <tr key={p.id}>
                        <td><CopyableId value={p.number} label={p.number} style={{ color: 'var(--accent)', fontSize: 12 }} /></td>
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{p.vendorName || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.date}</td>
                        <td>{p.paymentMode
                          ? <Chip status={p.paymentMode} label={String(p.paymentMode).replace('_', ' ').toUpperCase()} />
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td><span style={{ fontSize: 12 }}>{allocCount} {allocCount === 1 ? 'bill' : 'bills'}</span></td>
                        <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--green)' }}>{fmt(p.totalAmount || 0)}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.paymentRef || '—'}</td>
                        <td>
                          <button className="btn btn-ghost btn-xs" onClick={() => setPayDetail(p)}>View</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={payTotal}
              skip={paySkip}
              limit={payLimit}
              onSkipChange={setPaySkip}
              onLimitChange={setPayLimit}
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
      <Modal open={!!showPay} onClose={() => setShowPay(null)} title="Record Vendor Payment" icon="💳" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowPay(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={recordPayment}>Record Payment</button>
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
      <Modal open={!!showCancel} onClose={() => setShowCancel(null)} title="Cancel Bill" icon="⚠️" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowCancel(null)}>Keep Bill</button>
          <button className="btn btn-danger" onClick={cancelBill}>Cancel Bill</button>
        </>}>
        {showCancel && (
          <>
            <AlertBar type="amber" icon="⚠">
              Cancelling <strong>{showCancel.number}</strong> marks it ignored in payable totals.
              It does NOT reverse stock — goods already received stay in inventory. Use Vendor
              Returns to physically return stock.
            </AlertBar>
          </>
        )}
      </Modal>

      {/* ── Bill Form (create) ────────────────────────────────────── */}
      <BillFormModal
        open={showNewBill}
        onClose={() => setShowNewBill(false)}
        onSave={saveBillForm}
        billForm={billForm}
        pbf={pbf}
        saving={billSaving}
      />

      {/* ── PO Form (create / edit / view) ────────────────────────── */}
      <PurchaseOrderFormModal
        open={showOrderForm}
        onClose={() => { setShowOrderForm(false); setOrderEditingId(null); setOrderEditingNumber(null); setOrderReadOnly(false) }}
        onSave={savePoForm}
        poForm={poForm}
        ppof={ppof}
        saving={orderSaving}
        editingNumber={orderEditingNumber}
        readOnly={orderReadOnly}
      />

      {/* ── PO → Bill convert ─────────────────────────────────────── */}
      <ConvertPOToBillModal
        open={!!convertSource}
        onClose={() => setConvertSource(null)}
        onConfirm={convertPO}
        title={convertSource ? `Convert ${convertSource.number}` : 'Convert to Bill'}
        source={convertSource}
        lines={convertSource?.lines || null}
        confirming={converting}
      />

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
        footer={<button className="btn btn-secondary" onClick={() => setPayDetail(null)}>Close</button>}
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
        footer={<button className="btn btn-secondary" onClick={() => setReturnDetail(null)}>Close</button>}>
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
    </div>
  )
}

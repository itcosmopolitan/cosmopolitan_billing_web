import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { usePOSStore, useAppStore } from '@/store'
import { itemsAPI, customersAPI, salesAPI, settingsAPI, stockPoolsAPI } from '@/api'
import { dashboardKeys } from '@/features/dashboard/api/queryKeys'
import { useCan } from '@/auth/permissions'
import { useNavigationBlocker } from '@/hooks/useNavigationBlocker'
import { useDisplaySocket } from '@/hooks/useDisplaySocket'
import { buildPosDisplayPayload, usePosDisplaySession } from '@/pages/display/displayShared'
import { unwrapPaged } from '@/utils/pagination'
import { fmt, fmtQty } from '@/utils/helpers'
import { calcCartTotals } from '@/utils/taxCalc'
import { amountInputStep } from '@/utils/decimalPrecision'
import { isInternalCustomer, internalGstReverseSummary } from '@/utils/pricingDiscounts'
import { posDocumentMargin, posEntityDiscountShares } from '@/utils/marginCalc'
import MarginBadge from '@/components/MarginBadge'
import { Modal, ConfirmDialog, AutocompleteDropdown, FormGroup, Spinner, MultiSelect, AlertBar } from '@/components/ui'
import { useQuickCustomer } from '@/components/useQuickParty'
import { AUTOCOMPLETE_CUSTOMER_URL } from '@/api'
import { Receipt } from '@/components/Receipt'
import CashTenderFields from '@/components/CashTenderFields'
import { cashTenderError, cashTenderSummary } from '@/utils/cashTender'
import openInvoicePrintWindow from '@/utils/printInvoice'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import { toApiPayload } from '@/utils/batchAllocation'
import CartRow from './CartRow'
import POSRefundModal from './POSRefundModal'
import PanelDragHandle from './PanelDragHandle'
import {
  invoiceHasPayment,
  invoiceHasReturn,
  invoiceLockedForEdit,
  isPosInvoice,
} from '@/pages/sales/salesFormShared'
import {
  storeCreditApplyAmount,
  remainingAfterStoreCredit,
  customerRequiresImmediatePayment,
} from '@/utils/storeCredit'
import { getConfiguredChildCounters } from '@/utils/childCounters'
import {
  POS_STORAGE_SPLIT,
  POS_STORAGE_LEADING,
  POS_DRAG_MIME,
  readStoredSplit,
  readStoredLeading,
  leadingPanelFromDrop,
} from './posDrag'

const DISCOUNT_REASON_OPTIONS = [
  'Customer goodwill',
  'Loyalty discount',
  'Seasonal offer',
  'Price match',
  'Near expiry',
  'Damaged packaging',
  'Staff discount',
  'Manager approval',
  'Other',
]

const DISCOUNT_REASON_STORAGE_PREFIX = 'pos_discount_reasons'

function discountReasonStorageKey(branchId) {
  return `${DISCOUNT_REASON_STORAGE_PREFIX}:${branchId || 'default'}`
}

function uniqueDiscountReasons(rows) {
  const seen = new Set()
  const next = []
  ;(rows || []).forEach((row) => {
    const value = typeof row === 'string' ? row.trim() : ''
    const key = value.toLowerCase()
    if (!value || seen.has(key)) return
    seen.add(key)
    next.push(value)
  })
  return next
}

function readBranchDiscountReasons(branchId) {
  if (typeof window === 'undefined') return DISCOUNT_REASON_OPTIONS
  try {
    const raw = window.localStorage.getItem(discountReasonStorageKey(branchId))
    const custom = raw ? JSON.parse(raw) : []
    return uniqueDiscountReasons([...DISCOUNT_REASON_OPTIONS, ...(Array.isArray(custom) ? custom : [])])
  } catch {
    return DISCOUNT_REASON_OPTIONS
  }
}

// Async version that fetches from API
async function fetchBranchDiscountReasons(branchId) {
  try {
    const response = await settingsAPI.getDiscountReasons(branchId)
    const reasons = response?.data?.reasons ?? response?.reasons ?? []
    // Cache in localStorage for offline access
    const defaults = new Set(DISCOUNT_REASON_OPTIONS.map((row) => row.toLowerCase()))
    const custom = reasons.filter((row) => !defaults.has(row.toLowerCase()))
    writeBranchCustomDiscountReasons(branchId, reasons)
    return reasons
  } catch (error) {
    console.error('Failed to fetch discount reasons from API:', error)
    // Fallback to localStorage
    return readBranchDiscountReasons(branchId)
  }
}

function writeBranchCustomDiscountReasons(branchId, options) {
  if (typeof window === 'undefined') return
  const defaults = new Set(DISCOUNT_REASON_OPTIONS.map((row) => row.toLowerCase()))
  const custom = uniqueDiscountReasons(options).filter((row) => !defaults.has(row.toLowerCase()))
  try {
    window.localStorage.setItem(discountReasonStorageKey(branchId), JSON.stringify(custom))
  } catch {
    /* ignore storage failures */
  }
}

function hydrateBatchAllocation(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((e) => e && (e.batch_id || e.id) && Number(e.qty) > 0)
    .map((e) => ({
      id: e.batch_id || e.id,
      batchNumber: e.batchNumber || e.batch_number || String(e.batch_id || e.id).slice(-6),
      qty: Number(e.qty),
      expiryDate: e.expiryDate || e.expiry_date || null,
    }))
}

function invoiceToCartSession(inv, customer) {
  const notes = String(inv.notes || '')
  const reasonMatch = notes.match(/Discount reason:\s*(.+)/i)
  const discountReason = reasonMatch ? reasonMatch[1].trim() : ''
  const userNotes = notes.replace(/\n?Discount reason:\s*.+/i, '').trim()
  return {
    cart: (inv.items || []).map((it) => ({
      id: it.itemId || it.item_id,
      name: it.name,
      qty: it.qty,
      price: it.price,
      taxRate: it.taxRate ?? it.tax_rate ?? 0,
      sku: it.sku,
      hsnCode: it.hsn_code || it.hsnCode || '',
      packaging: it.packaging || '',
      is_packaging: Boolean(it.is_packaging),
      packaging_quantity: it.packaging_quantity ?? null,
      costPrice: it.costPrice ?? it.cost_price ?? 0,
      batchTracking: Boolean(it.batchTracking),
      expiryTracking: Boolean(it.expiryTracking),
      batchAllocation: hydrateBatchAllocation(it.batchAllocation),
      batchAllocationCustom: Boolean(it.batchAllocation?.length),
      lineDiscountType: 'pct',
      lineDiscountValue: Number(it.discount) || 0,
    })),
    customer: customer || (inv.customerId ? { id: inv.customerId, name: inv.customerName } : null),
    discountPct: 0,
    discountAmt: Number(inv.discount) || 0,
    discountType: Number(inv.discount) > 0 ? 'flat' : 'pct',
    discountReason,
    notes: userNotes.slice(0, 100),
    paymentReceived: false,
    paymentMethod: null,
    paymentRef: '',
  }
}

export default function POSPage() {
  const can = useCan()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const editInvoiceId = searchParams.get('edit')
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activeCat, setActiveCat] = useState([])
  const [showHeld, setShowHeld] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [showCreditWarning, setShowCreditWarning] = useState(false)
  const [lastSale, setLastSale] = useState(null)
  const [products, setProducts] = useState([])
  const [productPageNo, setProductPageNo] = useState(1)
  const [productTotal, setProductTotal] = useState(null)
  const [hasMoreProducts, setHasMoreProducts] = useState(false)
  const [loadingMoreProducts, setLoadingMoreProducts] = useState(false)
  const [categories, setCategories] = useState([{ id: 'all', name: 'All', icon: '⊞' }])
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [leftPaneRatio, setLeftPaneRatio] = useState(readStoredSplit)
  const [leadingPanel, setLeadingPanel] = useState(readStoredLeading)
  const [isResizing, setIsResizing] = useState(false)
  const [dragOverSide, setDragOverSide] = useState(null)
  // Pending in-app navigation captured by the leave-confirm modal. The
  // function, when called, resumes the navigation that the operator tried to
  // perform; setting it to null cancels and keeps the user on POS.
  const [pendingNav, setPendingNav] = useState(null)
  // Per-item batch list cache populated by CartRow's lazy fetch — the
  // allocation modal needs the full list to render every available lot, not
  // just the ones currently in the allocation.
  const [batchListByItem, setBatchListByItem] = useState({})
  // Active allocation editor target. `null` => modal closed. Shape:
  //   { item, batches, allocation }
  const [allocEditor, setAllocEditor] = useState(null)
  const [allowOverselling, setAllowOverselling] = useState(true)
  const [allowPriceEditing, setAllowPriceEditing] = useState(false)
  const [showRefund, setShowRefund] = useState(false)
  const [discountReasonOptions, setDiscountReasonOptions] = useState(DISCOUNT_REASON_OPTIONS)
  const [showAddDiscountReason, setShowAddDiscountReason] = useState(false)
  const [newDiscountReason, setNewDiscountReason] = useState('')
  const [editingInvoice, setEditingInvoice] = useState(null)
  const [editLoading, setEditLoading] = useState(false)
  const [stockModeByBranch, setStockModeByBranch] = useState({})
  const [stockPool, setStockPool] = useState(null)
  const clientRequestRef = useRef(null)
  const searchRef = useRef(null)
  const splitRef = useRef(null)
  const productPaneRef = useRef(null)
  const skipSearchEffectRef = useRef(true)
  const lastProductsBranchRef = useRef(null)

  const store = usePOSStore()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const { footerAction: addCustomerAction, modal: addCustomerModal } = useQuickCustomer({
    defaultBranchId: activeBranch?.id,
    onCreated: (c) => store.setCustomer(c),
  })
  const setActiveBranch = useAppStore((s) => s.setActiveBranch)
  const branches = useAppStore((s) => s.branches)
  const cashierUser = useAppStore((s) => s.user)
  const setDecimalPrecisionPrefs = useAppStore((s) => s.setDecimalPrecisionPrefs)
  const {
    cart,
    customer,
    discountPct,
    discountAmt,
    discountType,
    discountReason,
    notes,
    heldBills,
    paymentReceived,
    paymentMethod,
    paymentRef,
    cashCollected,
    selectedChildCounter,
    setSelectedChildCounter,
  } = store
  const activeBranchData = branches.find((branch) => branch.id === activeBranch?.id) || activeBranch
  const stockMode = activeBranch?.id ? (stockModeByBranch[activeBranch.id] || 'branch') : 'branch'
  const branchHeldBills = heldBills.filter((bill) => bill.branchId === activeBranch?.id)
  const childCounters = getConfiguredChildCounters(activeBranchData)

  // Guard route changes when the cart has unsaved lines. We stash the
  // resume-callback in state so a custom Modal (rather than window.confirm)
  // can render Stay/Leave buttons. Holding a bill uses a different code path
  // (heldBills) and is unaffected.
  useNavigationBlocker(
    cart.length > 0 && !pendingNav,
    useCallback((proceed) => setPendingNav(() => proceed), []),
  )

  useEffect(() => {
    if (!editInvoiceId) {
      setEditingInvoice(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setEditLoading(true)
      try {
        const inv = await salesAPI.get(editInvoiceId)
        if (cancelled) return
        if (!isPosInvoice(inv)) {
          navigate(`/sales/invoices/${inv.id}/edit`, { replace: true })
          return
        }
        if (invoiceLockedForEdit(inv)) {
          toast.error('This POS bill cannot be edited')
          navigate('/sales?tab=invoices', { replace: true })
          return
        }
        if (invoiceHasPayment(inv)) {
          toast.error('Delete the payment first, then edit this bill.')
          navigate('/sales?tab=invoices', { replace: true })
          return
        }
        if (invoiceHasReturn(inv)) {
          toast.error('Delete the return first, then edit this bill.')
          navigate('/sales?tab=invoices', { replace: true })
          return
        }
        if (inv.branchId && activeBranch?.id && inv.branchId !== activeBranch.id) {
          const match = (branches || []).find((b) => b.id === inv.branchId)
          if (match) setActiveBranch(match)
        }
        const invoiceBranch = (branches || []).find((branch) => branch.id === inv.branchId)
        const savedCounterId = inv.childCounterId || inv.child_counter_id
        const savedCounterName = inv.childCounterName || inv.child_counter_name
        const invoiceCounter = (invoiceBranch?.child_counters || []).find((counter) => (
          counter.id === savedCounterId || counter.name === savedCounterName
        ))
        let customer = null
        if (inv.customerId) {
          try {
            customer = await customersAPI.get(inv.customerId)
          } catch {
            customer = { id: inv.customerId, name: inv.customerName }
          }
        }
        if (cancelled) return
        store.hydrateSession(invoiceToCartSession(inv, customer))
        setSelectedChildCounter(invoiceCounter?.id || savedCounterId || '')
        setEditingInvoice({ id: inv.id, number: inv.number })
      } catch {
        if (!cancelled) {
          toast.error('POS bill not found')
          navigate('/sales?tab=invoices', { replace: true })
        }
      } finally {
        if (!cancelled) setEditLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editInvoiceId])

  // Debounce product search to reduce API calls while typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    settingsAPI.getOrganisation()
      .then((res) => {
        const data = res?.data ?? res
        setAllowOverselling(data?.allowOverselling !== false)
        setAllowPriceEditing(data?.allowPriceEditing === true)
        setDecimalPrecisionPrefs(data)
      })
      .catch(() => {
        setAllowOverselling(true)
        setAllowPriceEditing(false)
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    setStockPool(null)
    if (!activeBranch?.id) return undefined
    if (!can('pos.use_pool_stock')) {
      setStockModeByBranch((current) => ({ ...current, [activeBranch.id]: 'branch' }))
      return undefined
    }
    stockPoolsAPI.forBranch(activeBranch.id)
      .then((pool) => {
        if (!cancelled) {
          setStockPool(pool || null)
          if (!pool?.allow_cross_branch_sales) {
            setStockModeByBranch((current) => ({ ...current, [activeBranch.id]: 'branch' }))
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStockPool(null)
          setStockModeByBranch((current) => ({ ...current, [activeBranch.id]: 'branch' }))
          console.error('Failed to load stock pool for POS branch:', error)
        }
      })
    return () => { cancelled = true }
  }, [activeBranch?.id, can])

  useEffect(() => {
    const branchId = activeBranch?.id || 'default'
    // Fetch discount reasons from API
    fetchBranchDiscountReasons(branchId).then((reasons) => {
      setDiscountReasonOptions(reasons)
      const currentReason = usePOSStore.getState().discountReason
      if (currentReason && !reasons.some((row) => row.toLowerCase() === currentReason.toLowerCase())) {
        usePOSStore.getState().setDiscountReason('')
      }
    })
  }, [activeBranch?.id])

  const updateCategories = (rows, reset = false) => {
    setCategories((prev) => {
      const map = new Map()
      if (!reset) {
        prev.forEach((c) => {
          if (c.id !== 'all') map.set(c.id, c.name)
        })
      }
      rows.forEach((p) => {
        if (p.categoryId) map.set(p.categoryId, p.categoryName || p.categoryId)
      })
      const merged = [...map.entries()]
        .map(([id, name]) => ({ id, name, icon: '📦' }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return [{ id: 'all', name: 'All', icon: '⊞' }, ...merged]
    })
  }

  const loadProductsPage = async ({ branchId, pageNo, reset = false, resetCategories = false }) => {
    const perPage = 100
    const raw = await itemsAPI.list({
      branch_id: branchId,
      page_no: pageNo,
      per_page: perPage,
      search: debouncedSearch || undefined,
      category_ids: activeCat.length > 0 ? activeCat.join(',') : undefined,
      sort_by: 'name',
      sort_order: 'asc',
      pos_mode: true,
      stock_mode: stockMode,
      include_total: false,
    })
    const data = unwrapPaged(raw)
    const rows = data.items || []
    updateCategories(rows, resetCategories)
    setProductTotal(typeof data.total === 'number' && data.total > 0 ? data.total : null)
    setProductPageNo(data.pageNo || pageNo)
    setHasMoreProducts(Boolean(data.hasMorePage))
    if (reset) {
      setProducts(rows)
      return
    }
    setProducts((prev) => {
      const seen = new Set(prev.map((p) => p.id))
      const next = [...prev]
      rows.forEach((r) => {
        if (!seen.has(r.id)) next.push(r)
      })
      return next
    })
  }


  const resetProducts = async (branchId, resetCategories = false) => {
    const showFullPageLoader = resetCategories
    try {
      if (showFullPageLoader) setInitialLoading(true)
      else setLoadingProducts(true)
      await loadProductsPage({ branchId, pageNo: 1, reset: true, resetCategories })
    } catch (err) {
      console.error('Failed to fetch items:', err)
      setProducts([])
      setProductTotal(0)
      setProductPageNo(1)
      setHasMoreProducts(false)
      setCategories([{ id: 'all', name: 'All', icon: '⊞' }])
      toast.error('Unable to load branch products. Please try again.')
    } finally {
      if (showFullPageLoader) setInitialLoading(false)
      else setLoadingProducts(false)
    }
  }

  const loadMoreProducts = async () => {
    if (initialLoading || loadingProducts || loadingMoreProducts || !hasMoreProducts) return
    const branchId = activeBranch?.id || 'br-001'
    try {
      setLoadingMoreProducts(true)
      await loadProductsPage({ branchId, pageNo: productPageNo + 1, reset: false })
    } catch (err) {
      console.error('Failed to fetch more items:', err)
    } finally {
      setLoadingMoreProducts(false)
    }
  }

  /** Re-fetch stock for every product page already loaded in the grid. Runs
   *  after checkout so the catalog reflects deductions without a full reload. */
  const refreshProductStock = useCallback(async () => {
    const branchId = activeBranch?.id || 'br-001'
    const perPage = 100
    const listParams = {
      branch_id: branchId,
      per_page: perPage,
      search: debouncedSearch || undefined,
      category_ids: activeCat.length > 0 ? activeCat.join(',') : undefined,
      sort_by: 'name',
      sort_order: 'asc',
      pos_mode: true,
      stock_mode: stockMode,
      include_total: false,
    }
    try {
      const stockById = new Map()
      for (let page = 1; page <= productPageNo; page += 1) {
        const raw = await itemsAPI.list({ ...listParams, page_no: page })
        const rows = unwrapPaged(raw).items || []
        rows.forEach((p) => stockById.set(p.id, p))
      }
      if (stockById.size === 0) return
      setProducts((prev) =>
        prev.map((p) => {
          const fresh = stockById.get(p.id)
          if (!fresh) return p
          return {
            ...p,
            available_stock: fresh.available_stock,
            pool_stock: fresh.pool_stock,
            batches_count: fresh.batches_count,
            nearest_expiry: fresh.nearest_expiry,
          }
        }),
      )
    } catch (err) {
      console.error('Failed to refresh stock after sale:', err)
    }
  }, [activeBranch?.id, debouncedSearch, activeCat, productPageNo, stockMode])

  useEffect(() => {
    const branchId = activeBranch?.id || 'br-001'
    if (lastProductsBranchRef.current === branchId) return
    lastProductsBranchRef.current = branchId
    setCategories([{ id: 'all', name: 'All', icon: '⊞' }])
    resetProducts(branchId, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranch?.id])

  useEffect(() => {
    if (skipSearchEffectRef.current) {
      skipSearchEffectRef.current = false
      return
    }
    const branchId = activeBranch?.id || 'br-001'
    resetProducts(branchId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, activeCat, stockMode])

  useEffect(() => {
    const lineStock = new Map(products.map((product) => [
      product.id,
      {
        availableStock: Number(
          stockMode === 'clubbed'
            ? (product.pool_stock ?? product.available_stock)
            : product.available_stock,
        ) || 0,
        branchStock: Number(product.available_stock) || 0,
        poolStock: Number(product.pool_stock) || 0,
      },
    ]))
    const currentCart = usePOSStore.getState().cart
    currentCart.forEach((line) => {
      const availability = lineStock.get(line.id)
      if (availability) {
        usePOSStore.getState().setLineStockAvailability(line.id, availability)
      }
    })
  }, [products, stockMode])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'F2') { searchRef.current?.focus(); e.preventDefault() }
      if (e.key === 'F4') { store.holdBill(activeBranch?.id); toast('Bill held'); }
      if (e.key === 'F8') handleComplete()
      if (e.key === 'Escape') searchRef.current?.blur()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
    // store + handleComplete are deliberately omitted from the dep array.
    // The shortcuts close over the latest cart/paymentMethod/customer via
    // the named deps; including the function refs would re-bind the
    // listener on every render. Properly fixing this needs useCallback
    // around handleComplete and a stable store ref — out of scope here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, paymentMethod, customer])

  const filtered = products

  const changeStockMode = (nextMode) => {
    if (nextMode === stockMode || !activeBranch?.id) return
    setStockModeByBranch((current) => ({ ...current, [activeBranch.id]: nextMode }))
    cart.forEach((line) => {
      if (line.batchTracking || line.batch_tracking) {
        store.setLineBatchAllocation(line.id, [], false)
      }
    })
  }

  const handleComplete = async (allowCreditOverLimit = false) => {
    if (cart.length === 0) { toast.error('Cart is empty'); return }
    if (completing) return
    if (childCounters.length > 0 && !selectedChildCounter) {
      toast.error('Select a child counter for this sale')
      return
    }
    const submitTotals = calcCartTotals(cart, { discountPct, discountAmt })
    const submitTotal = submitTotals.total
    const creditAppliedNow = paymentMethod === 'credit'
      ? 0
      : storeCreditApplyAmount(customer?.credit_balance, submitTotal, !!customer?.id)
    const remainingDue = remainingAfterStoreCredit(submitTotal, creditAppliedNow)
    const settling = paymentReceived || creditAppliedNow > 0
    const accountCreditRemaining = Math.max(
      0,
      Number(customer?.credit_limit || 0) - Number(customer?.outstanding || 0),
    )
    if (
      paymentMethod === 'credit'
      && !allowCreditOverLimit
      && submitTotal > accountCreditRemaining + 0.001
    ) {
      setShowCreditWarning(true)
      return
    }
    const hasBillDiscountForSubmit = Number(discountPct || 0) > 0 || Number(discountAmt || 0) > 0
    const hasLineDiscountForSubmit = cart.some((i) => Number(i.lineDiscountValue ?? i.lineDiscountPct ?? i.lineDiscountFlat ?? 0) > 0)
    const hasDiscountForSubmit = hasBillDiscountForSubmit || hasLineDiscountForSubmit
    if (hasDiscountForSubmit && !discountReason) {
      toast.error('Pick a discount reason')
      return
    }

    const poolCheckout = stockMode === 'clubbed' && !editingInvoice
    if (!paymentMethod && !poolCheckout) {
      toast.error('Pick a payment method to complete the sale')
      return
    }

    const mustPay = customerRequiresImmediatePayment(customer)
    if (mustPay && !settling && !poolCheckout) {
      toast.error(
        customer?.id
          ? 'Retail customers must pay at sale — select a payment method'
          : 'Walk-in customers must pay at sale — select a payment method',
      )
      return
    }
    if (mustPay && remainingDue > 0.001 && !paymentMethod && !poolCheckout) {
      toast.error('Pick a payment method (Cash / Card / UPI / Bank Transfer)')
      return
    }

    // When settling with a remainder, a tender method MUST be picked.
    if (
      settling
      && remainingDue > 0.001
      && !paymentMethod
      && !(poolCheckout && !paymentReceived)
    ) {
      toast.error('Pick a payment method for the remaining amount (Cash / Card / UPI / Bank Transfer)')
      return
    }

    if (settling && paymentMethod === 'cash' && remainingDue > 0.001) {
      const err = cashTenderError(cashCollected, remainingDue)
      if (err) {
        toast.error(err)
        return
      }
    }

    if (cart.some((line) => !String(line.name || '').trim())) {
      toast.error('Each item must have a name')
      return
    }

    if (!allowOverselling && stockMode !== 'clubbed' && !editingInvoice) {
      for (const line of cart) {
        const stock = Number(line.availableStock ?? line.available_stock ?? 0)
        if (line.qty > stock) {
          toast.error(`Insufficient stock for ${line.name}: need ${fmtQty(line.qty)}, available ${fmtQty(stock)}`)
          return
        }
      }
    }

    setCompleting(true)
    try {
      const totals = calcCartTotals(cart, { discountPct, discountAmt })
      const { netSubtotal: sub, taxTotal: tax, discount: disc } = totals
      const notes = [
        store.notes?.trim(),
        hasDiscountForSubmit ? `Discount reason: ${discountReason}` : '',
      ].filter(Boolean).join('\n')
      const selectedCounter = childCounters.find(
        (counter) => String(counter.id) === String(selectedChildCounter),
      )

      const salePayload = {
        customer_id: customer?.id || null,
        customer_name: customer?.name || 'Walk-in',
        branch_id: activeBranch.id,
        branch_name: activeBranch.name,
        stock_mode: poolCheckout ? 'clubbed' : 'branch',
        child_counter_id: selectedCounter?.id || null,
        child_counter_name: selectedCounter?.name || null,
        cashier: 'Staff',
        items: cart.map((i) => {
          const gross = i.qty * i.price
          const lineDiscountAmount = Math.max(0, Math.min(gross, gross - i.lineTotal))
          const effPct = gross > 0 ? Math.min(100, Math.max(0, (1 - i.lineTotal / gross) * 100)) : 0
          return {
            item_id: i.id,
            name: String(i.name || '').trim(),
            qty: i.qty,
            price: i.price,
            tax_rate: i.taxRate || 0,
            line_discount: Math.round(effPct * 10000) / 10000,
            line_discount_amount: Math.round(lineDiscountAmount * 100) / 100,
            packaging: i.packaging?.trim() || null,
            batch_allocation: toApiPayload(i.batchAllocation),
          }
        }),
        discount: disc,
        payment_mode: settling && remainingDue > 0.001 ? paymentMethod : (settling && creditAppliedNow > 0 && remainingDue <= 0.001 ? null : null),
        payment_ref: settling && ['card', 'upi', 'bank_transfer'].includes(paymentMethod)
          ? paymentRef.trim()
          : null,
        store_credit_amount: creditAppliedNow > 0 ? creditAppliedNow : undefined,
        origin: 'pos',
        notes: notes || null,
        allow_credit_over_limit: allowCreditOverLimit,
      }
      // Credit-only settlement: backend accepts store_credit_amount without tender mode.
      if (settling && remainingDue > 0.001) {
        salePayload.payment_mode = paymentMethod
      } else if (!settling) {
        salePayload.payment_mode = null
      }
      if (!editingInvoice) {
        const requestSignature = JSON.stringify(salePayload)
        if (!clientRequestRef.current || clientRequestRef.current.signature !== requestSignature) {
          clientRequestRef.current = {
            signature: requestSignature,
            id: globalThis.crypto?.randomUUID?.()
              || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
                const random = Math.floor(Math.random() * 16)
                return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16)
              }),
          }
        }
        salePayload.client_request_id = clientRequestRef.current.id
      }

      const result = editingInvoice
        ? await salesAPI.update(editingInvoice.id, salePayload)
        : await salesAPI.create(salePayload)

      const soldItemIds = cart.map((i) => i.id)

      const cashTender = settling && paymentMethod === 'cash' && remainingDue > 0.001
        ? cashTenderSummary(cashCollected, remainingDue)
        : null

      let fullSale
      try {
        fullSale = await salesAPI.get(result.id)
      } catch (fetchError) {
        console.error('Failed to refresh completed invoice:', fetchError)
        toast('Receipt loaded with limited data. Full invoice details could not be refreshed.', {
          icon: '⚠️',
          duration: 5000,
        })
        fullSale = {
          ...result,
          id: result.id,
          number: result.number,
          total: result.total,
          subtotal: sub,
          taxTotal: tax,
          discount: disc,
          storeCreditApplied: creditAppliedNow,
        }
      }

      setLastSale({
        ...fullSale,
        discountReason: hasDiscountForSubmit ? discountReason : '',
        method: settling ? (paymentMethod || (creditAppliedNow > 0 ? 'credit' : null)) : null,
        storeCreditApplied: fullSale.storeCreditApplied ?? creditAppliedNow,
        cashCollected: cashTender?.collected ?? null,
        cashChange: cashTender?.change ?? null,
      });

      if (creditAppliedNow > 0 && customer?.id) {
        const newBalance = Math.max(0, Number(customer.credit_balance || 0) - creditAppliedNow)
        store.setCustomer({ ...customer, credit_balance: newBalance })
      }
      store.clearCart()
      setEditingInvoice(null)
      clientRequestRef.current = null
      if (editInvoiceId) navigate('/pos', { replace: true })
      // Drop cached batch lists for sold lines — quantities changed server-side.
      setBatchListByItem((prev) => {
        const next = { ...prev }
        soldItemIds.forEach((id) => { delete next[id] })
        return next
      })
      await refreshProductStock()
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root })
      toast.success(editingInvoice ? `Sale ${result.number} updated` : `Sale ${result.number} completed!`)
      setShowComplete(true)
    } catch (err) {
      console.error('Failed to complete sale:', err)
      toast.error(editingInvoice ? 'Failed to update sale. Please try again.' : 'Failed to save sale. Please try again.')
    } finally {
      setCompleting(false)
    }
  }

  // Barcode / Enter-key handler: exact barcode or SKU match → add to cart + clear search.
  // USB barcode scanners act as HID keyboards: they type the barcode then press Enter.
  // Step 1: check already-loaded products (fast, no API call).
  // Step 2: if not found, do a targeted API lookup for items not yet in the current page.
  const handleBarcodeEnter = useCallback(async (term) => {
    if (!term) return
    const inMemory = products.find((p) => p.barcode === term || p.sku === term)
    if (inMemory) {
      const stock = stockMode === 'clubbed'
        ? (inMemory.pool_stock ?? inMemory.available_stock ?? 0)
        : (inMemory.available_stock ?? 0)
      const branchStock = inMemory.available_stock ?? 0
      const inCart = cart.find((i) => i.id === inMemory.id)?.qty ?? 0
      if (!allowOverselling && stock <= 0) {
        toast.error(`${inMemory.name} is out of stock`)
      } else if (!allowOverselling && inCart + 1 > stock) {
        toast.error(`Only ${stock} available for ${inMemory.name}`)
      } else {
        store.addItem({
          id: inMemory.id, name: inMemory.name, price: inMemory.selling_price,
          taxRate: inMemory.tax_rate || 0, sku: inMemory.sku, emoji: inMemory.emoji,
          costPrice: inMemory.cost_price ?? 0, hsnCode: inMemory.hsn_code || '',
          availableStock: stock, branchStock, poolStock: inMemory.pool_stock,
          batchTracking: Boolean(inMemory.batch_tracking),
          expiryTracking: Boolean(inMemory.expiry_tracking),
          packaging: inMemory.packaging || '',
          is_packaging: Boolean(inMemory.is_packaging),
          packaging_quantity: inMemory.packaging_quantity ?? null,
          wholesale_pricing_mode: inMemory.wholesale_pricing_mode || 'pct',
          wholesale_discount_pct: inMemory.wholesale_discount_pct || 0,
          wholesale_price: inMemory.wholesale_price || 0,
          staff_pricing_mode: inMemory.staff_pricing_mode || 'pct',
          staff_discount_pct: inMemory.staff_discount_pct || 0,
          staff_price: inMemory.staff_price || 0,
          brand: inMemory.brand || '',
          unit: inMemory.unit || inMemory.unitOfMeasure || inMemory.unit_of_measure || '',
        })
        toast.success(inMemory.name, { duration: 800 })
        setSearch('')
      }
      return
    }
    // Not in current page — query backend for an exact barcode/SKU match.
    try {
      const raw = await itemsAPI.list({
        branch_id: activeBranch?.id || 'br-001',
        search: term,
        per_page: 10,
        pos_mode: true,
        stock_mode: stockMode,
      })
      const rows = unwrapPaged(raw).items || []
      const exact = rows.find((p) => p.barcode === term || p.sku === term)
      const hit = exact || (rows.length === 1 ? rows[0] : null)
      if (hit) {
        const stock = stockMode === 'clubbed'
          ? (hit.pool_stock ?? hit.available_stock ?? 0)
          : (hit.available_stock ?? 0)
        const branchStock = hit.available_stock ?? 0
        const inCart = cart.find((i) => i.id === hit.id)?.qty ?? 0
        if (!allowOverselling && stock <= 0) {
          toast.error(`${hit.name} is out of stock`)
        } else if (!allowOverselling && inCart + 1 > stock) {
          toast.error(`Only ${stock} available for ${hit.name}`)
        } else {
          store.addItem({
            id: hit.id, name: hit.name, price: hit.selling_price,
            taxRate: hit.tax_rate || 0, sku: hit.sku, emoji: hit.emoji,
            costPrice: hit.cost_price ?? 0, hsnCode: hit.hsn_code || '',
            availableStock: stock, branchStock, poolStock: hit.pool_stock,
            batchTracking: Boolean(hit.batch_tracking),
            expiryTracking: Boolean(hit.expiry_tracking),
            packaging: hit.packaging || '',
            is_packaging: Boolean(hit.is_packaging),
            packaging_quantity: hit.packaging_quantity ?? null,
            wholesale_pricing_mode: hit.wholesale_pricing_mode || 'pct',
            wholesale_discount_pct: hit.wholesale_discount_pct || 0,
            wholesale_price: hit.wholesale_price || 0,
            staff_pricing_mode: hit.staff_pricing_mode || 'pct',
            staff_discount_pct: hit.staff_discount_pct || 0,
            staff_price: hit.staff_price || 0,
            brand: hit.brand || '',
            unit: hit.unit || hit.unitOfMeasure || hit.unit_of_measure || '',
          })
          toast.success(hit.name, { duration: 800 })
          setSearch('')
        }
      } else {
        toast.error(`No item found for "${term}"`)
      }
    } catch {
      toast.error('Barcode lookup failed')
    }
  }, [products, activeBranch?.id, allowOverselling, cart, store, stockMode])

  const cartTotals = calcCartTotals(cart, { discountPct, discountAmt })
  const {
    netSubtotal: subtotal,
    taxTotal: tax,
    discount,
    discountAmount,
    total,
    mode: taxMode,
  } = cartTotals
  const gstReverse = internalGstReverseSummary(cart)
  const hasLineLevelDiscount = cart.some((i) => Number(i.lineDiscountValue ?? i.lineDiscountPct ?? i.lineDiscountFlat ?? 0) > 0)
  const hasBillLevelDiscount = Number(discountPct || 0) > 0 || Number(discountAmt || 0) > 0
  const hasAnyDiscount = hasLineLevelDiscount || hasBillLevelDiscount
  // Bill-level discount is allocated across lines for per-line margin; line discounts already sit in lineTotal.
  const lineEntityShares = hasBillLevelDiscount && !hasLineLevelDiscount
    ? posEntityDiscountShares(cart, discount)
    : cart.map(() => 0)
  const cartMargin = posDocumentMargin(cart, { discountPct, discountAmt })
  const creditAvail = customer?.id ? Number(customer.credit_balance || 0) : 0
  const creditAppliedPreview = storeCreditApplyAmount(creditAvail, total, !!customer?.id)
  const remainingDuePreview = remainingAfterStoreCredit(total, creditAppliedPreview)
  const customerType = String(customer?.customer_type || customer?.customerType || customer?.type || 'retail').toLowerCase()
  const canUseCredit = Boolean(customer?.id) && ['wholesale', 'staff'].includes(customerType)
  const accountCreditRemaining = Math.max(0, Number(customer?.credit_limit || 0) - Number(customer?.outstanding || 0))
  const paymentMethodOptions = [
    { id: 'cash', label: '💵 Cash' },
    { id: 'card', label: '💳 Card' },
    // { id: 'upi', label: '📱 UPI' },
    { id: 'bank_transfer', label: '🏦 Bank Transfer' },
    ...(canUseCredit ? [{ id: 'credit', label: '💳 Credit' }] : []),
  ]

  const { displayCode, regenerate: regenerateDisplayCode } = usePosDisplaySession()
  const { sendCartUpdate, connected: displayConnected } = useDisplaySocket(displayCode, 'cashier')

  const broadcastCustomerDisplay = useCallback(() => {
    sendCartUpdate(
      buildPosDisplayPayload(cart, customer, {
        discountPct,
        discountAmt,
        branchName: activeBranch?.name,
        displayCode,
        cashierName: cashierUser?.name || '',
        cashCollected: paymentMethod === 'cash' ? cashCollected : '',
      }),
    )
  }, [cart, customer, discountPct, discountAmt, activeBranch?.name, displayCode, cashierUser?.name, paymentMethod, cashCollected, sendCartUpdate])

  const copyDisplayCode = async () => {
    try {
      await navigator.clipboard.writeText(displayCode)
      toast.success('Display code copied')
    } catch {
      toast.error('Could not copy code')
    }
  }

  const onRegenerateDisplayCode = () => {
    regenerateDisplayCode()
    toast('New display code — enter it on the customer screen', { icon: '🔑' })
  }

  const openAddDiscountReason = () => {
    setNewDiscountReason('')
    setShowAddDiscountReason(true)
  }

  const submitNewDiscountReason = async () => {
    const reason = newDiscountReason.trim()
    if (!reason) {
      toast.error('Discount reason is required')
      return
    }
    const existing = discountReasonOptions.find((row) => row.trim().toLowerCase() === reason.toLowerCase())
    const next = existing || reason
    
    if (!existing) {
      // Call API to save the new discount reason
      try {
        const branchId = activeBranch?.id || 'default'
        await settingsAPI.createDiscountReason(branchId, { reason: next })
        
        // Update local state
        setDiscountReasonOptions((prev) => {
          const updated = uniqueDiscountReasons([...prev, next])
          writeBranchCustomDiscountReasons(branchId, updated)
          return updated
        })
        toast.success('Discount reason added')
      } catch (error) {
        const msg = error?.response?.data?.detail || error?.message || 'Failed to add discount reason'
        toast.error(msg)
        return
      }
    }
    
    store.setDiscountReason(next)
    setShowAddDiscountReason(false)
  }

  useEffect(() => {
    broadcastCustomerDisplay()
  }, [broadcastCustomerDisplay])

  useEffect(() => {
    if (displayConnected) broadcastCustomerDisplay()
  }, [displayConnected, broadcastCustomerDisplay])

  useEffect(() => {
    if (!isResizing) return undefined

    const onMouseMove = (e) => {
      const container = splitRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (!rect.width) return
      const raw = ((e.clientX - rect.left) / rect.width) * 100
      const clamped = Math.max(30, Math.min(70, raw))
      setLeftPaneRatio(clamped)
      try {
        localStorage.setItem(POS_STORAGE_SPLIT, String(clamped))
      } catch {
        /* ignore */
      }
    }

    const onMouseUp = () => {
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  const onPanelDragEnd = () => setDragOverSide(null)

  const panelDropHandlers = (side) => ({
    onDragOver: (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverSide(side)
    },
    onDragLeave: (e) => {
      const rt = e.relatedTarget
      if (rt && e.currentTarget.contains(rt)) return
      setDragOverSide((prev) => (prev === side ? null : prev))
    },
    onDrop: (e) => {
      e.preventDefault()
      setDragOverSide(null)
      const dragged = e.dataTransfer.getData(POS_DRAG_MIME) || e.dataTransfer.getData('text/plain')
      if (dragged !== 'products' && dragged !== 'cart') return
      setLeadingPanel((prev) => {
        const next = leadingPanelFromDrop(side, dragged)
        if (next === prev) return prev
        try {
          localStorage.setItem(POS_STORAGE_LEADING, next)
        } catch {
          /* ignore */
        }
        return next
      })
    },
  })

  if (initialLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 56px)' }}>
        <div style={{ textAlign: 'center' }}>
          <Spinner size={40} />
          <div style={{ marginTop: 12 }}>Loading POS...</div>
        </div>
      </div>
    )
  }

  const productsDropSide = leadingPanel === 'products' ? 'left' : 'right'
  const cartDropSide = leadingPanel === 'products' ? 'right' : 'left'

  return (
    <div
      ref={splitRef}
      style={{
        display: 'grid',
        gridTemplateColumns: `${leftPaneRatio}fr 8px ${100 - leftPaneRatio}fr`,
        gridTemplateRows: 'minmax(0, 1fr)',
        height: 'calc(100vh - 56px)',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >

      {/* Product browser — grid column follows leadingPanel */}
      <div
        ref={productPaneRef}
        {...panelDropHandlers(productsDropSide)}
        onScroll={(e) => {
          const el = e.currentTarget
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) {
            loadMoreProducts()
          }
        }}
        style={{
          gridColumn: leadingPanel === 'products' ? 1 : 3,
          gridRow: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden auto',
          padding: 16,
          background: 'var(--bg-base)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: dragOverSide === productsDropSide ? 'inset 0 0 0 2px var(--accent)' : 'none',
          borderRadius: dragOverSide === productsDropSide ? 6 : 0,
          transition: 'box-shadow 0.12s ease',
        }}
      >

        {/* Search + actions bar */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              className="form-input"
              style={{ paddingLeft: 32 }}
              placeholder="Search item, SKU, barcode… (F2)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleBarcodeEnter(search.trim()) } }}
              autoFocus
            />
          </div>
          <div style={{ width: 132, flexShrink: 0 }}>
            <MultiSelect
              options={categories.filter((category) => category.id !== 'all').map((category) => ({
                id: category.id,
                label: category.name,
              }))}
              value={activeCat}
              onChange={setActiveCat}
              placeholder="All categories"
            />
          </div>
          {/* {can('pos.use') && can('invoices.create') && (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowRefund(true)}>↩ Refund</button>
          )} */}
          <PanelDragHandle
            panel="products"
            onDragEnd={onPanelDragEnd}
            title="Drag onto the other column to swap sides"
          />
        </div>

        {stockPool?.allow_cross_branch_sales && can('pos.use_pool_stock') && !editingInvoice && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-surface)' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Stock source</span>
            <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 7, overflow: 'hidden' }}>
              {[
                { id: 'branch', label: 'This branch' },
                { id: 'clubbed', label: `Pool · ${stockPool.name}` },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => changeStockMode(option.id)}
                  aria-pressed={stockMode === option.id}
                  className="btn btn-sm"
                  style={{
                    border: 0,
                    borderRadius: 0,
                    background: stockMode === option.id ? 'var(--accent-bg)' : 'transparent',
                    color: stockMode === option.id ? 'var(--accent)' : 'var(--text-secondary)',
                    fontSize: 11,
                  }}
                >{option.label}</button>
              ))}
            </div>
            {stockMode === 'clubbed' && (
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                Prices, tax and invoice remain on {activeBranch?.name || 'this branch'}.
              </span>
            )}
          </div>
        )}

        {/* Products grid */}
        <div style={{ position: 'relative', minHeight: 120 }}>
          {loadingProducts && (
            <>
              <div style={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
                background: 'var(--bg-base)',
                opacity: 0.88,
                borderRadius: 12,
              }} />
              <div style={{
                position: 'absolute',
                inset: 0,
                zIndex: 2,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}>
                <Spinner size={28} />
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading products…</div>
              </div>
            </>
          )}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
            gap: 10,
            opacity: loadingProducts ? 0.45 : 1,
            transition: 'opacity 0.15s ease',
          }}>
            {filtered.map((p) => {
            const branchStock = p.available_stock ?? 0
            const stock = stockMode === 'clubbed' ? (p.pool_stock ?? branchStock) : branchStock
            const inCart = cart.find((i) => i.id === p.id)?.qty ?? 0
            const isOut = !allowOverselling && stock <= 0
            const wouldExceed = !allowOverselling && inCart + 1 > stock
            const isLow = stock > 0 && stock <= (p.reorder_level || 10)
            return (
              <div key={p.id}
                onClick={() => {
                  if (isOut || wouldExceed) {
                    if (wouldExceed) toast.error(`Only ${stock} available for ${p.name}`)
                    return
                  }
                  store.addItem({
                      id: p.id,
                      name: p.name,
                      price: p.selling_price,
                      taxRate: p.tax_rate || 0,
                      sku: p.sku,
                      emoji: p.emoji,
                      costPrice: p.cost_price ?? 0,
                      hsnCode: p.hsn_code || '',
                      availableStock: stock,
                      branchStock,
                      poolStock: p.pool_stock,
                      packaging: p.packaging || '',
                      is_packaging: Boolean(p.is_packaging),
                      packaging_quantity: p.packaging_quantity ?? null,
                      wholesale_pricing_mode: p.wholesale_pricing_mode || 'pct',
                      wholesale_discount_pct: p.wholesale_discount_pct || 0,
                      wholesale_price: p.wholesale_price || 0,
                      staff_pricing_mode: p.staff_pricing_mode || 'pct',
                      staff_discount_pct: p.staff_discount_pct || 0,
                      staff_price: p.staff_price || 0,
                      brand: p.brand || '',
                      unit: p.unit || p.unitOfMeasure || p.unit_of_measure || '',
                      // Carry batch-tracking flags forward so CartRow knows
                      // whether to render the source batch picker.
                      batchTracking: Boolean(p.batch_tracking),
                      expiryTracking: Boolean(p.expiry_tracking),
                    })
                    toast.success(p.name, { duration: 800 })
                }}
                style={{
                  background: 'var(--bg-surface)', border: `1.5px solid ${isOut ? 'var(--border-subtle)' : 'var(--border-default)'}`,
                  borderRadius: 12, padding: 13, cursor: isOut ? 'not-allowed' : 'pointer', textAlign: 'center',
                  opacity: isOut ? 0.4 : 1, position: 'relative', transition: 'all 0.12s', userSelect: 'none',
                }}
                onMouseEnter={(e) => { if (!isOut) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-2px)' } }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = isOut ? 'var(--border-subtle)' : 'var(--border-default)'; e.currentTarget.style.transform = 'none' }}>
                {isLow && <span style={{ position: 'absolute', top: 6, right: 6, width: 7, height: 7, background: 'var(--amber)', borderRadius: '50%' }} />}
                <div style={{ fontSize: 28, lineHeight: 1.3 }}>{p.emoji || '📦'}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', marginTop: 7, lineHeight: 1.3 }}>{p.name}</div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)', marginTop: 4 }}>{fmt(p.selling_price)}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {isOut ? 'Out of stock' : stockMode === 'clubbed'
                    ? `${fmtQty(stock)} pool · ${fmtQty(branchStock)} here${inCart > 0 ? ` · ${fmtQty(inCart)} in cart` : ''}`
                    : `${fmtQty(stock)} in stock${inCart > 0 ? ` (${fmtQty(inCart)} in cart)` : ''}`}
                </div>
              </div>
            )
          })}
          </div>
        </div>

        {!loadingProducts && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🔍</div>
            <div style={{ fontSize: 14 }}>No products found</div>
          </div>
        )}

        {!loadingProducts && filtered.length > 0 && (
          <div style={{ textAlign: 'center', padding: '12px 0 6px', color: 'var(--text-muted)', fontSize: 12 }}>
            {loadingMoreProducts
              ? 'Loading more products…'
              : hasMoreProducts
                ? 'Scroll to load more'
                : productTotal
                  ? `Loaded ${filtered.length} of ${productTotal}`
                  : `Loaded ${filtered.length} items`}
          </div>
        )}

      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize columns. Drag ⋮⋮ on Products or Cart to swap sides."
        onMouseDown={() => setIsResizing(true)}
        style={{
          gridColumn: 2,
          gridRow: 1,
          cursor: 'col-resize',
          background: isResizing ? 'var(--accent-bg)' : 'var(--bg-raised)',
          borderLeft: '1px solid var(--border-subtle)',
          borderRight: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
        }}
      >
        <div
          style={{
            width: 2,
            height: 34,
            borderRadius: 2,
            background: isResizing ? 'var(--accent)' : 'var(--border-strong)',
          }}
        />
      </div>

      {/* Cart — grid column follows leadingPanel */}
      <div
        {...panelDropHandlers(cartDropSide)}
        style={{
          gridColumn: leadingPanel === 'products' ? 3 : 1,
          gridRow: 1,
          minWidth: 0,
          minHeight: 0,
          background: 'var(--bg-surface)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: dragOverSide === cartDropSide ? 'inset 0 0 0 2px var(--accent)' : 'none',
          borderRadius: dragOverSide === cartDropSide ? 6 : 0,
          transition: 'box-shadow 0.12s ease',
        }}
      >

        {/* Cart header — single compact toolbar */}
        <div
          className="pos-cart-toolbar"
          style={{
            borderBottom: '1px solid var(--border-subtle)',
            padding: '6px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            flexShrink: 0,
            height: 40,
            boxSizing: 'border-box',
          }}
        >
          <PanelDragHandle
            panel="cart"
            onDragEnd={onPanelDragEnd}
            title="Drag onto the other column to swap sides"
          />
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', minWidth: 0 }}>
            {editingInvoice ? `Editing ${editingInvoice.number}` : 'Cart'}
            <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>
              {editLoading
                ? 'Loading…'
                : cart.length === 0
                  ? 'Empty'
                  : `${cart.length} line${cart.length === 1 ? '' : 's'}${editingInvoice ? ' · save to update' : ''}`}
            </span>
          </div>
          <button
            className="btn btn-secondary btn-sm"
            title="Focus input then scan barcode"
            onClick={() => { searchRef.current?.focus(); searchRef.current?.select(); toast('Ready to scan — point your barcode scanner now', { duration: 2000 }) }}
          >📷 Scan</button>
          <button
            className="btn btn-secondary btn-sm"
            style={{ position: 'relative' }}
            onClick={() => setShowHeld(true)}
            disabled={!!editingInvoice}
            title={editingInvoice ? 'Hold is unavailable while editing a saved bill' : undefined}
          >
            ⏸ Hold
            {branchHeldBills.length > 0 && <span style={{ position: 'absolute', top: -4, right: -4, background: 'var(--amber)', color: '#000', fontSize: 9, fontWeight: 800, borderRadius: '50%', width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{branchHeldBills.length}</span>}
          </button>
          <AutocompleteDropdown
            value={customer?.id || ''}
            onChange={(id) => {
              if (!id) store.setCustomer(null)
            }}
            onSelectOption={async (opt) => {
              if (!opt?.id) {
                store.setCustomer(null)
                return
              }
              try {
                const c = await customersAPI.get(opt.id)
                store.setCustomer(c)
              } catch {
                store.setCustomer({
                  id: opt.id,
                  name: opt.label,
                  phone: opt.description || opt.raw?.phone || '',
                })
              }
            }}
            fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
            fetchParams={{ branch_id: null, limit: 2000 }}
            isSearchFieldRequired
            prependOptions={[{ id: '', label: 'Walk-in Customer' }]}
            footerAction={addCustomerAction}
            selectedLabel={customer?.name}
            placeholder="Walk-in Customer"
            size="sm"
            style={{ width: 168, maxWidth: '28vw', flexShrink: 0 }}
          />
          {customer && isInternalCustomer(customer) && (
            <span
              className="pos-cart-toolbar__chip"
              style={{
                fontSize: 10,
                padding: '0 7px',
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 6,
                background: 'rgba(46,184,92,0.12)',
                color: 'var(--green)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
              title="Internal customer — GST is subtracted from item amounts"
            >
              GST reversed
            </span>
          )}
          {customer?.id && Number(customer.credit_balance || 0) > 0 && (
            <span
              className="pos-cart-toolbar__chip"
              style={{
                fontSize: 10,
                padding: '0 7px',
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 6,
                background: 'rgba(46,184,92,0.12)',
                color: 'var(--green)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
              title="Account credit available (from returns / overpayments)"
            >
              {fmt(Number(customer.credit_balance || 0))}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 8 }} />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0,
              height: 28,
              padding: '0 4px 0 8px',
              borderLeft: '1px solid var(--border-subtle)',
            }}
            title={displayConnected ? 'Customer screen connected' : 'Customer screen'}
          >
            <span
              style={{
                fontFamily: 'DM Mono, monospace',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: displayConnected ? 'var(--green)' : 'var(--text-primary)',
                padding: '0 6px',
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 6,
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-subtle)',
                boxSizing: 'border-box',
              }}
            >
              {displayCode}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyDisplayCode} style={{ padding: '2px 6px', fontSize: 11 }} title="Copy customer screen code">
              Copy
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onRegenerateDisplayCode}
              title="Generate a new code for this terminal"
              style={{ padding: '2px 6px', fontSize: 11 }}
            >
              ↻
            </button>
            <a
              href={`/customer-view/${encodeURIComponent(displayCode)}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm"
              title="Open customer screen"
              style={{ padding: '2px 6px', fontSize: 11 }}
            >
              ↗
            </a>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              store.clearCart()
              if (editingInvoice) {
                setEditingInvoice(null)
                navigate('/sales?tab=invoices')
              }
            }}
            style={{ padding: '4px 6px', color: 'var(--text-muted)' }}
            title={editingInvoice ? 'Cancel edit' : 'Clear cart'}
          >
            ✕
          </button>
        </div>

        {/* Cart items */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {cart.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🛒</div>
              <div style={{ fontSize: 13 }}>Cart is empty</div>
              <div style={{ fontSize: 11.5, marginTop: 4 }}>Click products in the catalog to add lines</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 980, borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-raised)' }}>
                    {['Item Details', 'Packaging', 'Qty', 'Rate (Excl.)', 'Discount', 'Tax', 'Margin', 'Total (Excl.)', ''].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: h === '' ? 'center' : 'left',
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--text-muted)',
                          padding: '6px 8px',
                          borderBottom: '1px solid var(--border-subtle)',
                          position: 'sticky',
                          top: 0,
                          zIndex: 1,
                          background: 'var(--bg-raised)',
                          whiteSpace: 'nowrap',
                          ...(h === 'Item Details' ? { minWidth: 320, width: '32%' } : null),
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cart.map((item, cartIdx) => (
                    <CartRow
                      key={item.id}
                      item={item}
                      cartIndex={cartIdx}
                      branchId={activeBranch?.id}
                      stockMode={stockMode}
                      entityDiscountShare={lineEntityShares[cartIdx] || 0}
                      onQtyChange={(qty) => {
                        if (!allowOverselling && stockMode !== 'clubbed') {
                          const stock = Number(item.availableStock ?? item.available_stock ?? 0)
                          if (qty > stock) {
                            toast.error(`Only ${stock} available for ${item.name}`)
                            return
                          }
                        }
                        store.updateQty(item.id, qty)
                      }}
                      onPriceChange={(price) => store.setLinePrice(item.id, price)}
                      onNameChange={(name) => store.setLineName(item.id, name)}
                      onPackagingChange={(packaging) => store.setLinePackaging(item.id, packaging)}
                      onRemove={() => store.removeItem(item.id)}
                      onDiscChange={(value) => store.setLineDiscount(item.id, value, item.lineDiscountType)}
                      onDiscTypeChange={(type) => store.setLineDiscountType(item.id, type)}
                      onAllocationChange={(alloc, custom) => store.setLineBatchAllocation(item.id, alloc, custom)}
                      onEditAllocation={(payload) => setAllocEditor(payload)}
                      onBatchesLoaded={(itemId, rows) => setBatchListByItem((m) => ({ ...m, [itemId]: rows }))}
                      disableDiscount={hasBillLevelDiscount || !can('pos.discount')}
                      allowPriceEditing={allowPriceEditing}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Compact footer: remarks+discount | totals, then payments | Complete Sale */}
        <div style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-raised)', flexShrink: 0 }}>
          {taxMode === 'inclusive' && cart.length > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '6px 14px 0' }}>
              Prices include tax
            </div>
          )}

          {/* Row 1: remarks + discount (70%) | calculation box (30%) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 40%',
              gap: 12,
              alignItems: 'end',
              padding: '8px 14px',
              width: '100%',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="pos-remarks" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Remarks
                </label>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{notes.length}/100</span>
              </div> */}
              <textarea
                id="pos-remarks"
                className="form-input"
                rows={2}
                maxLength={100}
                value={notes}
                onChange={(e) => store.setNotes(e.target.value)}
                placeholder="Add a remark to show on the invoice"
                style={{ width: '100%', resize: 'vertical', minHeight: 32, padding: '6px 8px', fontSize: 12, flex: 1 }}
              />

              {/* Discount — gated on pos.discount; cashier role does not have it.
                  % or flat (MVR) — same toggle pattern as line discounts. */}
              {can('pos.discount') && (
                <>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      className="form-input"
                      style={{
                        width: 72,
                        flexShrink: 0,
                        padding: '6px 8px',
                        fontSize: 12,
                        opacity: hasLineLevelDiscount ? 0.6 : 1,
                      }}
                      placeholder={
                        hasLineLevelDiscount
                          ? '—'
                          : (discountType === 'flat' ? 'Amt' : '%')
                      }
                      type="number"
                      min="0"
                      max={discountType === 'flat' ? undefined : 100}
                      step={discountType === 'flat' ? amountInputStep() : 0.5}
                      value={(discountType === 'flat' ? discountAmt : discountPct) || ''}
                      onChange={(e) => {
                        const v = Number(e.target.value) || 0
                        if (discountType === 'flat') store.setDiscount(0, v)
                        else store.setDiscount(v, 0)
                      }}
                      disabled={hasLineLevelDiscount}
                      title={
                        hasLineLevelDiscount
                          ? 'Clear line discounts for bill discount'
                          : (discountType === 'flat'
                            ? 'Bill discount amount'
                            : 'Bill discount % (>10% needs approval)')
                      }
                      aria-label={discountType === 'flat' ? 'Bill discount amount' : 'Bill discount percent'}
                    />
                    <div
                      style={{
                        display: 'inline-flex',
                        border: '1px solid var(--border-default)',
                        borderRadius: 7,
                        overflow: 'hidden',
                        flexShrink: 0,
                        opacity: hasLineLevelDiscount ? 0.6 : 1,
                      }}
                    >
                      <button
                        type="button"
                        disabled={hasLineLevelDiscount}
                        onClick={() => store.setDiscountType('pct')}
                        style={{
                          border: 'none',
                          borderRight: '1px solid var(--border-default)',
                          background: discountType !== 'flat' ? 'var(--accent-bg)' : 'transparent',
                          color: discountType !== 'flat' ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: hasLineLevelDiscount ? 'not-allowed' : 'pointer',
                          fontSize: 11,
                          padding: '5px 7px',
                          fontWeight: 600,
                        }}
                      >
                        %
                      </button>
                      <button
                        type="button"
                        disabled={hasLineLevelDiscount}
                        onClick={() => store.setDiscountType('flat')}
                        style={{
                          border: 'none',
                          background: discountType === 'flat' ? 'var(--accent-bg)' : 'transparent',
                          color: discountType === 'flat' ? 'var(--accent)' : 'var(--text-muted)',
                          cursor: hasLineLevelDiscount ? 'not-allowed' : 'pointer',
                          fontSize: 11,
                          padding: '5px 7px',
                          fontWeight: 600,
                        }}
                      >
                        MVR
                      </button>
                    </div>
                    <AutocompleteDropdown
                      value={discountReason || ''}
                      onChange={(id) => store.setDiscountReason(id || '')}
                      onSelectOption={(opt) => store.setDiscountReason(opt?.id || '')}
                      options={uniqueDiscountReasons([
                        ...discountReasonOptions,
                        discountReason || '',
                      ]).map((reason) => ({ id: reason, label: reason }))}
                      isSearchFieldRequired
                      searchPlaceholder="Search reason…"
                      placeholder="Reason"
                      selectedLabel={discountReason || undefined}
                      disabled={!hasAnyDiscount}
                      clearable={Boolean(hasAnyDiscount && discountReason)}
                      onClear={() => store.setDiscountReason('')}
                      footerAction={{
                        label: '+ Add reason',
                        onClick: openAddDiscountReason,
                      }}
                      emptyLabel="No reasons yet"
                      noMatchLabel="No matching reasons"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        padding: '6px 8px',
                        opacity: hasAnyDiscount ? 1 : 0.6,
                        borderColor: hasAnyDiscount && !discountReason ? 'var(--red)' : undefined,
                      }}
                    />
                  </div>
                  {(hasLineLevelDiscount || hasBillLevelDiscount) && (
                    <div style={{ fontSize: 10.5, color: discountReason ? 'var(--text-muted)' : 'var(--red)' }}>
                      {discountReason
                        ? (hasLineLevelDiscount ? 'Using line-item discount mode.' : 'Using bill-level discount mode.')
                        : 'Discount reason is required.'}
                    </div>
                  )}
                </>
              )}
            </div>

            <div
              style={{
                width: '100%',
                minWidth: 0,
                textAlign: 'right',
                boxSizing: 'border-box',
                paddingLeft: 8,
              }}
            >
              {cart.length > 0 && (
                <div style={{ marginBottom: 4 }}>
                  {discountAmount > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 16,
                        fontSize: 11.5,
                        color: 'var(--green)',
                        marginBottom: 2,
                      }}
                    >
                      <span>Discount</span>
                      <span style={{ fontFamily: 'DM Mono' }}>-{fmt(discountAmount)}</span>
                    </div>
                  )}
                  {gstReverse.gstReversed > 0 && (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 16,
                          fontSize: 11.5,
                          color: 'var(--green)',
                          marginBottom: 2,
                        }}
                      >
                        <span>GST reversed</span>
                        <span style={{ fontFamily: 'DM Mono' }}>-{fmt(gstReverse.gstReversed)}</span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2, lineHeight: 1.35 }}>
                        {fmt(gstReverse.inclusive)} incl. − {fmt(gstReverse.gstReversed)} GST
                        {gstReverse.rate != null ? ` (${gstReverse.rate}%)` : ''} = {fmt(gstReverse.exclusive)}
                      </div>
                    </>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                      marginBottom: 2,
                    }}
                  >
                    <span>Taxable</span>
                    <span style={{ fontFamily: 'DM Mono' }}>{fmt(subtotal)}</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                      marginBottom: cartMargin ? 2 : 0,
                    }}
                  >
                    <span>Tax</span>
                    <span style={{ fontFamily: 'DM Mono' }}>{fmt(tax)}</span>
                  </div>
                  {cartMargin && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 16,
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                        marginBottom: 4,
                      }}
                    >
                      <span>Margin</span>
                      <MarginBadge margin={cartMargin} showAmount size="sm" />
                    </div>
                  )}
                  {creditAppliedPreview > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 16,
                        fontSize: 11.5,
                        color: 'var(--accent)',
                        marginBottom: 2,
                      }}
                    >
                      <span>Account credit</span>
                      <span style={{ fontFamily: 'DM Mono' }}>-{fmt(creditAppliedPreview)}</span>
                    </div>
                  )}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 16,
                  paddingTop: cart.length > 0 ? 4 : 0,
                  borderTop: cart.length > 0 ? '1px solid var(--border-default)' : 'none',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {creditAppliedPreview > 0 ? 'Remaining' : 'Total'}
                </span>
                <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 22, fontWeight: 700, color: 'var(--accent)', lineHeight: 1.1 }}>
                  {fmt(creditAppliedPreview > 0 ? remainingDuePreview : total)}
                </span>
              </div>
              {creditAppliedPreview > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, textAlign: 'right' }}>
                  Bill total {fmt(total)}
                </div>
              )}
            </div>
          </div>

          {/* Row 2: payment methods (left) | Complete Sale under totals (30%) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 40%',
              gap: 12,
              alignItems: 'center',
              padding: '0 14px 10px',
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: 8,
              width: '100%',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ minWidth: 0 }}>
              {customer?.id && creditAvail > 0 && (
                <AlertBar type="green" icon="✓" style={{ marginBottom: 6 }}>
                  Account credit <strong>{fmt(creditAvail)}</strong> will be applied automatically
                  {remainingDuePreview > 0.001
                    ? <> — collect <strong>{fmt(remainingDuePreview)}</strong> remaining</>
                    : <> — sale fully covered</>}
                </AlertBar>
              )}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                }}
              >
                {paymentMethodOptions.map((option) => {
                  const isSelected = paymentMethod === option.id
                  const isDisabled = Boolean(option.disabled)

                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={isDisabled}
                      onClick={() => {
                        if (isDisabled) return
                        store.setPaymentMethod(isSelected ? null : option.id)
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '5px 9px',
                        minHeight: 30,
                        border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border-default)'}`,
                        background: isSelected ? 'var(--accent-bg)' : 'var(--bg-surface)',
                        color: isSelected ? 'var(--accent)' : isDisabled ? 'var(--text-muted)' : 'var(--text-secondary)',
                        borderRadius: 999,
                        cursor: isDisabled ? 'not-allowed' : 'pointer',
                        fontSize: 11.5,
                        fontWeight: 600,
                        opacity: isDisabled ? 0.6 : 1,
                        transition: 'all 0.12s ease',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
                {paymentMethod === 'credit' && (
                  <div style={{ width: '100%', fontSize: 11, color: 'var(--text-muted)' }}>
                    Remaining credit: <strong>{fmt(accountCreditRemaining)}</strong>
                  </div>
                )}
              </div>
              {paymentMethod === 'cash' && remainingDuePreview > 0.001 && (
                <CashTenderFields
                  compact
                  autoFocus
                  due={remainingDuePreview}
                  value={cashCollected}
                  onChange={store.setCashCollected}
                />
              )}
              {['card', 'upi', 'bank_transfer'].includes(paymentMethod) && remainingDuePreview > 0.001 && (
                <input
                  className="form-input"
                  value={paymentRef}
                  onChange={(e) => store.setPaymentRef(e.target.value)}
                  placeholder="Payment reference number"
                  aria-label="Payment reference number"
                  style={{ width: '100%', maxWidth: 240, marginTop: 6, padding: '6px 8px', fontSize: 12 }}
                />
              )}
            </div>

            <button
              className="btn btn-primary btn-xl"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                justifyContent: 'center',
                fontSize: 14,
                padding: '10px 12px',
                opacity: completing || !can('pos.use') || editLoading ? 0.6 : 1,
                cursor: completing || !can('pos.use') || editLoading ? 'not-allowed' : 'pointer',
              }}
              onClick={() => handleComplete()}
              disabled={completing || !can('pos.use') || editLoading}
              title={!can('pos.use') ? 'POS billing requires pos.use permission' : undefined}
            >
              {completing ? '⏳ Saving...' : editingInvoice ? `✓ Save` : `✓ Complete Sale`}
              <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 4 }}>F8</span>
            </button>
          </div>
        </div>
      </div>

      {/* Held Bills Modal */}
      <Modal open={showHeld} onClose={() => setShowHeld(false)} title="Held Bills" icon="⏸" size="sm">
        {branchHeldBills.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No held bills</div>
        ) : (
          branchHeldBills.map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{b.billNumber}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{b.cart.length} items · {b.customer?.name || 'Walk-in'}</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => { store.resumeBill(b.id, activeBranch?.id); setShowHeld(false); toast('Bill resumed') }}>Resume</button>
            </div>
          ))
        )}
      </Modal>

      {/* Leave-with-cart Confirm Modal — fires whenever the operator clicks a
          sidebar link / nav button while the cart still has lines. The
          useNavigationBlocker hook stashes the resume callback in pendingNav;
          we either invoke it (Leave) or drop it (Stay). */}
      <Modal
        open={!!pendingNav}
        onClose={() => setPendingNav(null)}
        title={editingInvoice ? 'Leave without saving edits?' : 'Leave POS with items in cart?'}
        icon="🛒"
        size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setPendingNav(null)}>Stay on POS</button>
          {!editingInvoice && (
            <button className="btn btn-ghost" onClick={() => {
              store.holdBill(activeBranch?.id)
              const proceed = pendingNav
              setPendingNav(null)
              toast('Bill held')
              proceed?.()
            }}>Hold & Leave</button>
          )}
          <button className="btn btn-danger" onClick={() => {
            store.clearCart()
            const proceed = pendingNav
            setPendingNav(null)
            proceed?.()
          }}>{editingInvoice ? 'Discard edits' : 'Discard & Leave'}</button>
        </>}
      >
        <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          You have <strong>{cart.length} item{cart.length === 1 ? '' : 's'}</strong> in the
          cart{customer ? <> for <strong>{customer.name}</strong></> : ''}. Leaving without
          completing the sale will lose this cart.
          <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--bg-raised)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Tip: <strong>Hold &amp; Leave</strong> parks the bill in the Hold list so you can resume it later.
          </div>
        </div>
      </Modal>

      {/* Batch Allocation Editor — opened from a tracked cart row's ✎ button.
          Splits a single line's qty across any combination of source batches;
          backend consumes them in this exact order on Complete Sale. */}
      <BatchAllocationModal
        open={!!allocEditor}
        onClose={() => setAllocEditor(null)}
        item={allocEditor ? {
          name: allocEditor.item.name,
          emoji: allocEditor.item.emoji,
          expiry_tracking: allocEditor.item.expiryTracking || allocEditor.item.expiry_tracking,
        } : null}
        qty={allocEditor?.qty ?? allocEditor?.item?.qty ?? 0}
        batches={allocEditor?.batches || (allocEditor ? batchListByItem[allocEditor.item.id] || [] : [])}
        allocation={allocEditor?.allocation || []}
        strategyLabel={
          allocEditor?.item?.expiryTracking || allocEditor?.item?.expiry_tracking ? 'FEFO' : 'FIFO'
        }
        onSave={(next) => {
          if (!allocEditor) return
          store.setLineBatchAllocation(allocEditor.item.id, next, /* custom */ true)
          setAllocEditor(null)
          toast.success('Batch split saved')
        }}
      />

      <ConfirmDialog
        open={showCreditWarning}
        onClose={() => setShowCreditWarning(false)}
        onConfirm={async () => {
          setShowCreditWarning(false)
          await handleComplete(true)
        }}
        title="Credit limit exceeded"
        message="The customer's available credit is exhausted for this purchase. Do you want to continue and increase the outstanding credit?"
        confirmLabel="Yes, continue"
        danger
      />

      {/* Sale Complete Modal */}
      <Modal open={showComplete} onClose={() => setShowComplete(false)} title="Sale Completed!" icon="✅" size="xl">
        {lastSale && (
          <div style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <Receipt
              sale={{
                ...lastSale,
                paymentMode: lastSale.method ?? lastSale.paymentMode,
                payment_mode: lastSale.method ?? lastSale.payment_mode,
              }}
              branch={activeBranch}
            />
          </div>
        )}
      </Modal>

      <POSRefundModal
        open={showRefund}
        onClose={() => setShowRefund(false)}
        branchId={activeBranch?.id}
        onSuccess={refreshProductStock}
      />

      <Modal
        open={showAddDiscountReason}
        onClose={() => setShowAddDiscountReason(false)}
        title="Add Discount Reason"
        icon="🏷️"
        size="sm"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddDiscountReason(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={submitNewDiscountReason}>Add Reason</button>
          </>
        )}
      >
        <FormGroup label="Discount reason" required>
          <input
            className="form-input"
            value={newDiscountReason}
            onChange={(e) => setNewDiscountReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitNewDiscountReason()
              }
            }}
            placeholder="e.g. Bulk purchase"
            autoFocus
          />
        </FormGroup>
      </Modal>

      {addCustomerModal}

    </div>
  )
}

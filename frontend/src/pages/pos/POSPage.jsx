import { useState, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { usePOSStore, useAppStore } from '@/store'
import { itemsAPI, customersAPI, salesAPI } from '@/api'
import { fetchAllList } from '@/utils/pagination'
import { fmt } from '@/utils/helpers'
import { PRODUCTS, CUSTOMERS } from '@/utils/seedData'
import { Modal, Chip } from '@/components/ui'
import { Receipt } from '@/components/Receipt'

const mapSeedProductsForBranch = (branchId) =>
  (PRODUCTS || []).map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    barcode: p.barcode,
    categoryId: p.catId,
    categoryName: p.category,
    unit: p.unit,
    cost_price: p.costPrice,
    selling_price: p.sellingPrice,
    tax_rate: p.taxRate,
    hsn_code: p.hsnCode,
    reorder_level: p.reorderLevel,
    emoji: p.emoji,
    available_stock: p.stock?.[branchId] ?? 0,
  }))

const mapSeedCustomersForBranch = (branchId) =>
  (CUSTOMERS || []).filter((c) => c.active !== false && (!c.branchId || c.branchId === branchId))

const POS_STORAGE_SPLIT = 'pos.leftPaneRatio'
const POS_STORAGE_LEADING = 'pos.leadingPanel'
const POS_DRAG_MIME = 'application/x-pos-panel'

function readStoredSplit() {
  try {
    const v = Number(localStorage.getItem(POS_STORAGE_SPLIT))
    if (Number.isFinite(v) && v >= 30 && v <= 70) return v
  } catch {
    /* ignore */
  }
  return 50
}

function readStoredLeading() {
  try {
    const v = localStorage.getItem(POS_STORAGE_LEADING)
    if (v === 'cart' || v === 'products') return v
  } catch {
    /* ignore */
  }
  return 'products'
}

/** dropSide 'left'|'right', dragged 'products'|'cart' → which panel is on the left */
function leadingPanelFromDrop(dropSide, dragged) {
  if (dropSide === 'left') return dragged
  return dragged === 'products' ? 'cart' : 'products'
}

export default function POSPage() {
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('all')
  const [showHeld, setShowHeld] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [lastSale, setLastSale] = useState(null)
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [categories, setCategories] = useState([{ id: 'all', name: 'All', icon: '⊞' }])
  const [loading, setLoading] = useState(true)
  const [completing, setCompleting] = useState(false)
  const [leftPaneRatio, setLeftPaneRatio] = useState(readStoredSplit)
  const [leadingPanel, setLeadingPanel] = useState(readStoredLeading)
  const [isResizing, setIsResizing] = useState(false)
  const [dragOverSide, setDragOverSide] = useState(null)
  const searchRef = useRef(null)
  const splitRef = useRef(null)

  const store = usePOSStore()
  const { activeBranch } = useAppStore()
  const { cart, customer, discountPct, discountAmt, heldBills, paymentMethod } = store

  // Fetch products (branch stock) and customers
  useEffect(() => {
    fetchData()
  }, [activeBranch?.id])

  const fetchData = async () => {
    const branchId = activeBranch?.id || 'br-001'
    try {
      setLoading(true)
      const [itemsData, customersData] = await Promise.all([
        fetchAllList(itemsAPI.list, { branch_id: branchId }),
        fetchAllList(customersAPI.list),
      ])
      
      setProducts(itemsData || [])
      setCustomers(customersData || [])
      
      // Extract unique categories from products
      if (itemsData && itemsData.length > 0) {
        const uniqueCats = [...new Set(itemsData.map(p => p.categoryId))]
        const catData = uniqueCats.map(catId => ({
          id: catId,
          name: itemsData.find(p => p.categoryId === catId)?.categoryName || catId,
          icon: '📦'
        }))
        setCategories([{ id: 'all', name: 'All', icon: '⊞' }, ...catData])
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
      const fallbackProducts = mapSeedProductsForBranch(branchId)
      const fallbackCustomers = mapSeedCustomersForBranch(branchId)
      setProducts(fallbackProducts)
      setCustomers(fallbackCustomers)
      const uniqueCats = [...new Set(fallbackProducts.map((p) => p.categoryId))]
      const catData = uniqueCats.map((catId) => ({
        id: catId,
        name: fallbackProducts.find((p) => p.categoryId === catId)?.categoryName || catId,
        icon: '📦',
      }))
      setCategories([{ id: 'all', name: 'All', icon: '⊞' }, ...catData])
      toast.error('API failed. Loaded seeded POS data.')
    } finally {
      setLoading(false)
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'F2') { searchRef.current?.focus(); e.preventDefault() }
      if (e.key === 'F4') { store.holdBill(); toast('Bill held'); }
      if (e.key === 'F8') handleComplete()
      if (e.key === 'Escape') searchRef.current?.blur()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [cart, paymentMethod, customer])

  const filtered = products.filter((p) => {
    const matchCat = activeCat === 'all' || p.categoryId === activeCat
    const matchQ = !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.sku && p.sku.toLowerCase().includes(search.toLowerCase())) || (p.barcode && p.barcode.includes(search))
    return matchCat && matchQ
  })

  const handleComplete = async () => {
    if (cart.length === 0) { toast.error('Cart is empty'); return }
    if (completing) return
    
    setCompleting(true)
    try {
      const sub = store.getSubtotal()
      const tax = store.getTaxTotal()
      const disc = store.getDiscount()
      const total = store.getTotal()
      
      // Call API to create sale
      const result = await salesAPI.create({
        customer_id: customer?.id || null,
        customer_name: customer?.name || 'Walk-in',
        branch_id: activeBranch.id,
        branch_name: activeBranch.name,
        cashier: 'Staff',
        items: cart.map((i) => {
          const gross = i.qty * i.price
          const lineDiscountAmount = Math.max(0, Math.min(gross, gross - i.lineTotal))
          const effPct = gross > 0 ? Math.min(100, Math.max(0, (1 - i.lineTotal / gross) * 100)) : 0
          return {
            item_id: i.id,
            name: i.name,
            qty: i.qty,
            price: i.price,
            tax_rate: i.taxRate || 0,
            line_discount: Math.round(effPct * 10000) / 10000,
            line_discount_amount: Math.round(lineDiscountAmount * 100) / 100,
          }
        }),
        discount: disc,
        payment_mode: paymentMethod,
        notes: store.notes,
      })
      
      setLastSale({
        number: result.number,
        total: result.total,
        subtotal: sub,
        taxTotal: tax,
        discount: disc,
        method: paymentMethod,
        items: cart.map(i => ({ name: i.name, qty: i.qty, price: i.price, lineTotal: i.lineTotal })),
        id: result.id,
      })
      
      setShowComplete(true)
      store.clearCart()
      toast.success(`Sale ${result.number} completed!`)
    } catch (err) {
      console.error('Failed to complete sale:', err)
      toast.error('Failed to save sale. Please try again.')
    } finally {
      setCompleting(false)
    }
  }

  const subtotal = store.getSubtotal()
  const tax = store.getTaxTotal()
  const discount = store.getDiscount()
  const total = store.getTotal()
  const lineListGross = cart.reduce((s, i) => s + i.qty * i.price, 0)
  const lineSavings = Math.max(0, lineListGross - subtotal)
  const hasLineLevelDiscount = cart.some((i) => Number(i.lineDiscountValue ?? i.lineDiscountPct ?? i.lineDiscountFlat ?? 0) > 0)
  const hasBillLevelDiscount = Number(discountPct || 0) > 0 || Number(discountAmt || 0) > 0

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

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 56px)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <div>Loading POS...</div>
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
        {...panelDropHandlers(productsDropSide)}
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
            <input ref={searchRef} className="form-input" style={{ paddingLeft: 32 }} placeholder="Search item, SKU, barcode… (F2)" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => toast('Connect to USB barcode scanner')}>📷 Scan</button>
          <button className="btn btn-secondary btn-sm" style={{ position: 'relative' }} onClick={() => setShowHeld(true)}>
            ⏸ Hold
            {heldBills.length > 0 && <span style={{ position: 'absolute', top: -4, right: -4, background: 'var(--amber)', color: '#000', fontSize: 9, fontWeight: 800, borderRadius: '50%', width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{heldBills.length}</span>}
          </button>
          <PanelDragHandle
            panel="products"
            onDragEnd={onPanelDragEnd}
            title="Drag onto the other column to swap sides"
          />
        </div>

        {/* Category pills */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {categories.map((c) => (
            <button key={c.id} onClick={() => setActiveCat(c.id)}
              style={{ padding: '6px 13px', borderRadius: 20, border: `1.5px solid ${activeCat === c.id ? 'var(--accent)' : 'var(--border-default)'}`, background: activeCat === c.id ? 'var(--accent-bg)' : 'transparent', color: activeCat === c.id ? 'var(--accent)' : 'var(--text-muted)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.12s', fontFamily: 'DM Sans,sans-serif', fontWeight: 500 }}>
              <span style={{ marginRight: 4 }}>{c.icon}</span>{c.name}
            </button>
          ))}
        </div>

        {/* Products grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
          {filtered.map((p) => {
            const isOut = p.available_stock <= 0
            const isLow = p.available_stock > 0 && p.available_stock <= (p.reorder_level || 10)
            return (
              <div key={p.id}
                onClick={() => {
                  if (!isOut) {
                    store.addItem({
                      id: p.id,
                      name: p.name,
                      price: p.selling_price,
                      taxRate: p.tax_rate || 0,
                      sku: p.sku,
                      emoji: p.emoji,
                      costPrice: p.cost_price ?? 0,
                      hsnCode: p.hsn_code || '',
                      availableStock: p.available_stock ?? 0,
                    })
                    toast.success(p.name, { duration: 800 })
                  }
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
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{isOut ? 'Out of stock' : `${p.available_stock} in stock`}</div>
              </div>
            )
          })}
        </div>

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🔍</div>
            <div style={{ fontSize: 14 }}>No products found</div>
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

        {/* Cart header */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>🧾 Cart</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Line-wise rate, HSN, margin & discounts</div>
          </div>
          <PanelDragHandle
            panel="cart"
            onDragEnd={onPanelDragEnd}
            title="Drag onto the other column to swap sides"
          />
          <div style={{ flex: 1 }} />
          <select className="form-input" style={{ padding: '5px 8px', fontSize: 12, width: 140 }} value={customer?.id || ''} onChange={(e) => { const c = customers.find((x) => x.id === e.target.value); store.setCustomer(c || null) }}>
            <option value="">Walk-in Customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => store.clearCart()} style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>✕</button>
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
              <table style={{ width: '100%', minWidth: 760, borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-raised)' }}>
                    {['Item Details', 'Qty', 'Rate', 'Margin', 'Discount', 'Line Total', ''].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: h === '' ? 'center' : 'left',
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--text-muted)',
                          padding: '9px 8px',
                          borderBottom: '1px solid var(--border-subtle)',
                          position: 'sticky',
                          top: 0,
                          zIndex: 1,
                          background: 'var(--bg-raised)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cart.map((item) => (
                    <CartRow
                      key={item.id}
                      item={item}
                      onQtyChange={(qty) => store.updateQty(item.id, qty)}
                      onRemove={() => store.removeItem(item.id)}
                      onDiscChange={(value) => store.setLineDiscount(item.id, value, item.lineDiscountType)}
                      onDiscTypeChange={(type) => store.setLineDiscountType(item.id, type)}
                      disableDiscount={hasBillLevelDiscount}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Discount row */}
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="form-input"
              style={{ flex: 1, padding: '7px 10px', fontSize: 12, opacity: hasLineLevelDiscount ? 0.6 : 1 }}
              placeholder={hasLineLevelDiscount ? 'Clear line-item discounts to use bill discount' : 'Bill discount % (>10% needs approval)'}
              type="number"
              min="0"
              max="100"
              value={discountPct || ''}
              onChange={(e) => store.setDiscount(Number(e.target.value), 0)}
              disabled={hasLineLevelDiscount}
            />
            <input className="form-input" style={{ width: 90, padding: '7px 10px', fontSize: 12 }} placeholder="Coupon" />
          </div>
          {(hasLineLevelDiscount || hasBillLevelDiscount) && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              {hasLineLevelDiscount ? 'Using line-item discount mode.' : 'Using bill-level discount mode.'}
            </div>
          )}
        </div>

        {/* Totals */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-raised)' }}>
          {lineSavings > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5, color: 'var(--green)' }}>
              <span>Line discounts</span><span style={{ fontFamily: 'DM Mono' }}>−{fmt(lineSavings)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 5 }}>
            <span>Subtotal (after line discounts)</span><span style={{ fontFamily: 'DM Mono' }}>{fmt(subtotal)}</span>
          </div>
          {discount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5, color: 'var(--green)' }}>
              <span>Discount</span><span style={{ fontFamily: 'DM Mono' }}>-{fmt(discount)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10 }}>
            <span>GST</span><span style={{ fontFamily: 'DM Mono' }}>{fmt(tax)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 700, paddingTop: 10, borderTop: '1px solid var(--border-default)', marginBottom: 12 }}>
            <span>Total</span>
            <span style={{ fontFamily: 'DM Mono', color: 'var(--accent)' }}>{fmt(total)}</span>
          </div>

          {/* Payment methods */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10 }}>
            {[{ id: 'cash', icon: '💵', label: 'Cash' }, { id: 'card', icon: '💳', label: 'Card' }, { id: 'upi', icon: '📱', label: 'UPI' }, { id: 'credit', icon: '📋', label: 'Credit' }].map((m) => (
              <button key={m.id} onClick={() => store.setPaymentMethod(m.id)}
                style={{ padding: '8px', borderRadius: 7, border: `1.5px solid ${paymentMethod === m.id ? 'var(--accent)' : 'var(--border-default)'}`, background: paymentMethod === m.id ? 'var(--accent-bg)' : 'transparent', color: paymentMethod === m.id ? 'var(--accent)' : 'var(--text-muted)', fontSize: 12.5, cursor: 'pointer', fontFamily: 'DM Sans,sans-serif', fontWeight: 500, transition: 'all 0.12s' }}>
                {m.icon} {m.label}
              </button>
            ))}
          </div>

          <button className="btn btn-primary btn-xl" style={{ width: '100%', justifyContent: 'center', fontSize: 15, opacity: completing ? 0.6 : 1, cursor: completing ? 'not-allowed' : 'pointer' }} onClick={handleComplete} disabled={completing}>
            {completing ? '⏳ Saving...' : `✓ Complete Sale — ${fmt(total)}`} <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 4 }}>F8</span>
          </button>
        </div>
      </div>

      {/* Held Bills Modal */}
      <Modal open={showHeld} onClose={() => setShowHeld(false)} title="Held Bills" icon="⏸" size="sm">
        {heldBills.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No held bills</div>
        ) : (
          heldBills.map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{b.billNumber}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{b.cart.length} items · {b.customer?.name || 'Walk-in'}</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => { store.resumeBill(b.id); setShowHeld(false); toast('Bill resumed') }}>Resume</button>
            </div>
          ))
        )}
      </Modal>

      {/* Sale Complete Modal */}
      <Modal open={showComplete} onClose={() => setShowComplete(false)} title="Sale Completed!" icon="✅" size="md">
        {lastSale && (
          <Receipt
            sale={{
              number: lastSale.number,
              total: lastSale.total,
              subtotal: lastSale.subtotal,
              taxTotal: lastSale.taxTotal,
              discount: lastSale.discount,
              paymentMode: lastSale.method,
              cashier: 'Staff',
              customerName: customer?.name || 'Walk-in',
              date: new Date(),
              items: lastSale.items || [],
            }}
            branch={activeBranch}
            onClose={() => setShowComplete(false)}
          />
        )}
      </Modal>

    </div>
  )
}

function PanelDragHandle({ panel, onDragEnd, title }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(POS_DRAG_MIME, panel)
        e.dataTransfer.setData('text/plain', panel)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={onDragEnd}
      title={title}
      aria-label={title}
      style={{
        flexShrink: 0,
        cursor: 'grab',
        padding: '6px 7px',
        borderRadius: 8,
        border: '1px solid var(--border-default)',
        background: 'var(--bg-raised)',
        color: 'var(--text-muted)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: -0.5,
        userSelect: 'none',
      }}
    >
      ⋮⋮
    </div>
  )
}

function lineMarginPct(unitPrice, costPrice) {
  const p = Number(unitPrice)
  const c = Number(costPrice)
  if (!p || p <= 0) return null
  return ((p - c) / p) * 100
}

function CartRow({ item, onQtyChange, onRemove, onDiscChange, onDiscTypeChange, disableDiscount }) {
  const marginPct = lineMarginPct(item.price, item.costPrice)
  const marginPositive = marginPct != null && marginPct >= 0
  const hsn = item.hsnCode || '—'
  const hasStock = item.availableStock != null || item.available_stock != null
  const stockQty = hasStock ? Number(item.availableStock ?? item.available_stock) || 0 : null
  const stockExceeded = stockQty != null && item.qty > stockQty
  const discType = item.lineDiscountType === 'flat' ? 'flat' : 'pct'
  const discValue = Number(item.lineDiscountValue ?? item.lineDiscountPct ?? item.lineDiscountFlat ?? 0) || 0

  return (
    <tr
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', minWidth: 230 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>{item.emoji || '📦'}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35 }}>{item.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>HSN: {hsn}</span>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>Stock: {stockQty ?? '—'}</span>
              {stockExceeded && (
                <span
                  title="Stock exceeded"
                  style={{ color: 'var(--amber)', cursor: 'help', fontSize: 12, lineHeight: 1 }}
                  aria-label="Stock exceeded"
                >
                  ⚠️
                </span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            className="form-input"
            type="number"
            min={1}
            step={1}
            value={item.qty}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) onQtyChange(v)
            }}
            style={{ width: 52, padding: '4px 6px', fontSize: 12, textAlign: 'center', fontFamily: 'DM Mono, monospace' }}
          />
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 600 }}>
        {fmt(item.price)}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
        {marginPct == null ? (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: marginPositive ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
            <span aria-hidden>{marginPositive ? '↑' : '↓'}</span>
            <span style={{ fontFamily: 'DM Mono, monospace' }}>{marginPct.toFixed(1)}%</span>
          </span>
        )}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: disableDiscount ? 0.6 : 1 }}>
          <input
            className="form-input"
            type="number"
            min={0}
            max={discType === 'pct' ? 100 : undefined}
            step={discType === 'pct' ? 0.5 : 1}
            value={discValue || ''}
            onChange={(e) => onDiscChange(Number(e.target.value) || 0)}
            disabled={disableDiscount}
            style={{ width: 86, padding: '4px 7px', fontSize: 12 }}
          />
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 7, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => onDiscTypeChange('pct')}
              disabled={disableDiscount}
              style={{
                border: 'none',
                borderRight: '1px solid var(--border-default)',
                background: discType === 'pct' ? 'var(--accent-bg)' : 'transparent',
                color: discType === 'pct' ? 'var(--accent)' : 'var(--text-muted)',
                cursor: disableDiscount ? 'not-allowed' : 'pointer',
                fontSize: 11,
                padding: '4px 7px',
                fontWeight: 600,
              }}
            >
              %
            </button>
            <button
              type="button"
              onClick={() => onDiscTypeChange('flat')}
              disabled={disableDiscount}
              style={{
                border: 'none',
                background: discType === 'flat' ? 'var(--accent-bg)' : 'transparent',
                color: discType === 'flat' ? 'var(--accent)' : 'var(--text-muted)',
                cursor: disableDiscount ? 'not-allowed' : 'pointer',
                fontSize: 11,
                padding: '4px 7px',
                fontWeight: 600,
              }}
            >
              ₹
            </button>
          </div>
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>
        {fmt(item.lineTotal)}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'center' }}>
        <button type="button" onClick={onRemove} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }} aria-label="Remove line">✕</button>
      </td>
    </tr>
  )
}

import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { itemsAPI } from '@/api'
import { fmt, stockStatus, exportToCSV } from '@/utils/helpers'
import {
  SectionHeader, Card, Tabs, SearchBar, Chip, Modal,
  FormGroup, FormRow, Select, KPICard, ProgressBar, EmptyState, Tag, PaginationBar
} from '@/components/ui'
import { DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'

const TABS = [
  { id: 'all',      label: 'All Items' },
  { id: 'low',      label: 'Low Stock' },
  { id: 'expiry',   label: 'Near Expiry' },
  { id: 'inactive', label: 'Inactive' },
]

const BRANCHES = [
  { id: 'br-001', name: 'Anna Nagar', code: 'AN' },
  { id: 'br-002', name: 'T. Nagar', code: 'TN' },
  { id: 'br-003', name: 'Vadapalani', code: 'VD' },
  { id: 'br-004', name: 'Velachery', code: 'VL' },
]

const BRANCH_COLS = BRANCHES.slice(0, 4)

const EMPTY_ITEM = {
  name: '', sku: '', barcode: '', categoryId: '', brand: '',
  unit: 'Pcs', cost_price: '', selling_price: '', tax_rate: '18',
  hsn_code: '', reorder_level: '10', opening_stock: '0', active: true,
  batch_tracking: false, expiry_tracking: false, emoji: '📦',
}

export default function ItemsPage() {
  const [tab, setTab]           = useState('all')
  const [search, setSearch]     = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [branchFilter, setBranchFilter] = useState('br-001')
  const [showAdd, setShowAdd]   = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [showAdj, setShowAdj]   = useState(null)
  const [showAdjSelect, setShowAdjSelect] = useState(false)
  const [adjSelectSearch, setAdjSelectSearch] = useState('')
  const [form, setForm]         = useState(EMPTY_ITEM)
  const [adjQty, setAdjQty]     = useState('')
  const [adjReason, setAdjReason] = useState('Physical count')
  const [items, setItems]       = useState([])
  const [itemSkip, setItemSkip] = useState(0)
  const [itemLimit, setItemLimit] = useState(DEFAULT_PAGE_SIZE)
  const [loading, setLoading]   = useState(true)
  const [categories, setCategories] = useState([])

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true)
      const data = await fetchAllList(itemsAPI.list, { branch_id: branchFilter })
      setItems(data || [])
      if (data && data.length > 0) {
        const uniqueCats = [...new Set(data.map((item) => item.categoryId))]
        const cats = uniqueCats.map((catId) => ({
          id: catId,
          name: data.find((item) => item.categoryId === catId)?.categoryName || catId,
        }))
        setCategories(cats)
      } else {
        setCategories([])
      }
    } catch (err) {
      console.error('Failed to fetch items:', err)
      toast.error('Failed to load items')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [branchFilter])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  useEffect(() => {
    setItemSkip(0)
  }, [search, catFilter, tab, branchFilter])

  const patchForm = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const filtered = useMemo(() => {
    let list = [...items]
    if (search)     list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || (p.sku && p.sku.toLowerCase().includes(search.toLowerCase())) || (p.barcode && p.barcode.includes(search)))
    if (catFilter)  list = list.filter((p) => p.categoryId === catFilter)
    if (tab === 'low')      list = list.filter((p) => p.available_stock > 0 && p.available_stock <= p.reorder_level)
    if (tab === 'expiry')   list = list.slice(0, 6)
    if (tab === 'inactive') list = list.filter((p) => p.active === false)
    return list
  }, [items, search, catFilter, tab])

  const pageRows = useMemo(() => {
    return filtered.slice(itemSkip, itemSkip + itemLimit)
  }, [filtered, itemSkip, itemLimit])

  const totals = useMemo(() => ({
    items:    items.length,
    low:      items.filter((p) => p.available_stock > 0 && p.available_stock <= p.reorder_level).length,
    outStock: items.filter((p) => p.available_stock === 0).length,
    stockVal: items.reduce((sum, p) => sum + (p.available_stock || 0) * (p.cost_price || 0), 0),
  }), [items])

  const openAdd  = () => { setForm(EMPTY_ITEM); setEditItem(null); setShowAdd(true) }
  const openEdit = (item) => { 
    setForm({
      name: item.name,
      sku: item.sku,
      barcode: item.barcode,
      categoryId: item.categoryId,
      brand: item.brand,
      unit: item.unit,
      cost_price: item.cost_price,
      selling_price: item.selling_price,
      tax_rate: item.tax_rate,
      hsn_code: item.hsn_code,
      reorder_level: item.reorder_level,
      opening_stock: item.available_stock,
      emoji: item.emoji,
      batch_tracking: item.batch_tracking || false,
      expiry_tracking: item.expiry_tracking || false,
    })
    setEditItem(item.id)
    setShowAdd(true)
  }

  const saveItem = async () => {
    if (!form.name) { toast.error('Item name is required'); return }
    if (!form.selling_price) { toast.error('Selling price is required'); return }
    try {
      // Convert form data to backend format (camelCase -> snake_case)
      const payload = {
        name: form.name,
        sku: form.sku,
        barcode: form.barcode,
        category_id: form.categoryId,
        brand: form.brand,
        unit: form.unit,
        cost_price: Number(form.cost_price),
        selling_price: Number(form.selling_price),
        tax_rate: Number(form.tax_rate),
        hsn_code: form.hsn_code,
        reorder_level: Number(form.reorder_level),
        emoji: form.emoji || '📦',
        batch_tracking: form.batch_tracking,
        expiry_tracking: form.expiry_tracking,
        opening_stock: editItem ? 0 : Number(form.opening_stock),
      }
      
      if (editItem) {
        await itemsAPI.update(editItem, payload)
        toast.success('Item updated')
      } else {
        await itemsAPI.create(payload)
        toast.success('Item added')
      }
      await fetchItems()
      setShowAdd(false)
    } catch (err) {
      console.error('Failed to save item:', err)
      toast.error('Failed to save item')
    }
  }

  const saveAdj = async () => {
    if (!adjQty) { toast.error('Enter adjusted quantity'); return }
    try {
      await itemsAPI.adjust({
        item_id: showAdj.id,
        branch_id: branchFilter,
        new_qty: Number(adjQty),
        reason: adjReason,
      })
      toast.success(`Stock adjusted for ${showAdj.name}`)
      await fetchItems()
      setShowAdj(null)
    } catch (err) {
      console.error('Failed to adjust stock:', err)
      toast.error('Failed to adjust stock')
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading items...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Items & Inventory" subtitle="Manage item master, stock levels, and adjustments">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = filtered.map(item => ({
            'Item Name': item.name,
            'SKU': item.sku || '—',
            'Barcode': item.barcode || '—',
            'Category': item.categoryName || '—',
            'Brand': item.brand || '—',
            'Unit': item.unit,
            'Cost Price (₹)': item.cost_price,
            'Selling Price (₹)': item.selling_price,
            'GST (%)': item.tax_rate,
            'Stock': item.available_stock,
            'Reorder Level': item.reorder_level,
            'Stock Value (₹)': (item.available_stock || 0) * (item.cost_price || 0),
          }))
          exportToCSV(exportData, `Items_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Items exported')
        }}>↓ Export</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowAdjSelect(true)}>⚖ Adjust Stock</button>
        <button className="btn btn-primary btn-sm" onClick={openAdd}>+ Add Item</button>
      </SectionHeader>

      {/* KPIs */}
      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Items"         value={totals.items}     color="var(--accent)"  />
        <KPICard label="Low Stock Items"     value={totals.low}       color="var(--amber)"   />
        <KPICard label="Out of Stock"        value={totals.outStock}  color="var(--red)"     />
        <KPICard label="Stock Value"         value={fmt(totals.stockVal)} color="var(--green)" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* Filters */}
      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search name, SKU, barcode…" />
        <select className="form-input" style={{ width: 180 }} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">All Categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="form-input" style={{ width: 150 }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
          {BRANCHES.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <Card bodyPadding={false}>
        {filtered.length === 0 ? <EmptyState icon="📦" title="No items found" desc="Try a different search or filter" /> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>SKU / Barcode</th>
                  <th>Category</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Price</th>
                  <th>GST</th>
                  <th className="text-right">Stock</th>
                  <th>Status</th>
                  <th style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((p) => {
                  const branchStock = p.available_stock || 0
                  const { cls, label } = stockStatus(branchStock, p.reorder_level)
                  return (
                    <tr key={p.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <span style={{ fontSize: 20 }}>{p.emoji}</span>
                          <div>
                            <div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{p.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.brand}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{p.sku}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{p.barcode}</div>
                      </td>
                      <td><Tag>{p.categoryName}</Tag></td>
                      <td className="text-right mono">{fmt(p.cost_price)}</td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(p.selling_price)}</td>
                      <td><Tag>{p.tax_rate}%</Tag></td>
                      <td className="text-right">
                        <div style={{ fontWeight: 500, fontSize: 13, color: branchStock === 0 ? 'var(--red)' : branchStock <= p.reorder_level ? 'var(--amber)' : 'var(--text-primary)' }}>{branchStock}</div>
                      </td>
                      <td><Chip status={label === 'In Stock' ? 'active' : label === 'Low Stock' ? 'low' : 'out'} label={label} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-xs" onClick={() => openEdit(p)}>Edit</button>
                          <button className="btn btn-ghost btn-xs" onClick={() => { setShowAdj(p); setAdjQty(branchStock) }}>Adj</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <PaginationBar
          total={filtered.length}
          skip={itemSkip}
          limit={itemLimit}
          onSkipChange={setItemSkip}
          onLimitChange={setItemLimit}
          disabled={loading}
        />
      </Card>

      {/* Add / Edit Item Modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={editItem ? 'Edit Item' : 'Add New Item'} icon="📦" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveItem}>{editItem ? 'Update Item' : 'Save Item'}</button>
        </>}>
        <FormRow>
          <FormGroup label="Item Name" required><input className="form-input" value={form.name} onChange={(e) => patchForm('name', e.target.value)} placeholder="e.g. Basmati Rice 5kg" /></FormGroup>
          <FormGroup label="Brand"><input className="form-input" value={form.brand} onChange={(e) => patchForm('brand', e.target.value)} placeholder="e.g. India Gate" /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="SKU"><input className="form-input" value={form.sku} onChange={(e) => patchForm('sku', e.target.value)} placeholder="Auto-generated if blank" /></FormGroup>
          <FormGroup label="Barcode"><input className="form-input" value={form.barcode} onChange={(e) => patchForm('barcode', e.target.value)} placeholder="Scan or enter" /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Category">
            <select className="form-input" value={form.categoryId} onChange={(e) => patchForm('categoryId', e.target.value)}>
              <option value="">Select Category</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormGroup>
          <FormGroup label="Unit">
            <select className="form-input" value={form.unit} onChange={(e) => patchForm('unit', e.target.value)}>
              {['Pcs', 'Kg', 'Gram', 'Litre', 'ML', 'Pack', 'Box', 'Dozen'].map((u) => <option key={u}>{u}</option>)}
            </select>
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Cost Price (₹)" required><input className="form-input" type="number" value={form.cost_price} onChange={(e) => patchForm('cost_price', e.target.value)} placeholder="0.00" /></FormGroup>
          <FormGroup label="Selling Price (₹)" required><input className="form-input" type="number" value={form.selling_price} onChange={(e) => patchForm('selling_price', e.target.value)} placeholder="0.00" /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="GST Rate">
            <select className="form-input" value={form.tax_rate} onChange={(e) => patchForm('tax_rate', e.target.value)}>
              {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
            </select>
          </FormGroup>
          <FormGroup label="HSN Code"><input className="form-input" value={form.hsn_code} onChange={(e) => patchForm('hsn_code', e.target.value)} placeholder="e.g. 1006" /></FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Reorder Level"><input className="form-input" type="number" value={form.reorder_level} onChange={(e) => patchForm('reorder_level', e.target.value)} placeholder="Min stock trigger" /></FormGroup>
          <FormGroup label="Opening Stock"><input className="form-input" type="number" value={form.opening_stock} onChange={(e) => patchForm('opening_stock', e.target.value)} placeholder="0" /></FormGroup>
        </FormRow>
        <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.batch_tracking} onChange={(e) => patchForm('batch_tracking', e.target.checked)} />
            Batch tracking
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.expiry_tracking} onChange={(e) => patchForm('expiry_tracking', e.target.checked)} />
            Expiry date tracking
          </label>
        </div>
      </Modal>

      {/* Stock Adjustment Modal */}
      <Modal open={!!showAdj} onClose={() => setShowAdj(null)} title="Stock Adjustment" icon="⚖" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdj(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveAdj}>Save Adjustment</button>
        </>}>
        {showAdj && (
          <>
            <div style={{ padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8, marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{showAdj.emoji} {showAdj.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Current stock: <strong>{showAdj.available_stock || 0}</strong> units</div>
            </div>
            <FormGroup label="New Quantity (Physical Count)" required>
              <input className="form-input" type="number" value={adjQty} onChange={(e) => setAdjQty(e.target.value)} autoFocus />
            </FormGroup>
            <FormGroup label="Reason">
              <select className="form-input" value={adjReason} onChange={(e) => setAdjReason(e.target.value)}>
                {['Physical count', 'Damaged / Spoilage', 'Theft / Shrinkage', 'Data correction', 'Expiry removal', 'Other'].map((r) => <option key={r}>{r}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Notes">
              <textarea className="form-input" placeholder="Optional notes about this adjustment" style={{ height: 70 }} />
            </FormGroup>
          </>
        )}
      </Modal>

      {/* Stock Adjustment - Item Selection Modal */}
      <Modal open={showAdjSelect} onClose={() => setShowAdjSelect(false)} title="Select Item to Adjust Stock" icon="⚖" size="md"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowAdjSelect(false)}>Close</button>
        </>}>
        <SearchBar value={adjSelectSearch} onChange={setAdjSelectSearch} placeholder="Search by name, SKU, or barcode…" />
        <div style={{ marginTop: 12, maxHeight: 400, overflowY: 'auto' }}>
          {items.filter(item => 
            adjSelectSearch === '' || 
            item.name.toLowerCase().includes(adjSelectSearch.toLowerCase()) ||
            (item.sku && item.sku.toLowerCase().includes(adjSelectSearch.toLowerCase())) ||
            (item.barcode && item.barcode.includes(adjSelectSearch))
          ).map((item) => (
            <div key={item.id} onClick={() => {
              setShowAdj(item)
              setAdjQty(item.available_stock || 0)
              setShowAdjSelect(false)
            }} style={{
              padding: '12px 14px',
              background: 'var(--bg-raised)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              marginBottom: 8,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              transition: 'all 0.2s',
            }} onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-input)'}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{item.emoji} {item.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  SKU: {item.sku} | {item.categoryName}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: item.available_stock === 0 ? 'var(--red)' : item.available_stock <= item.reorder_level ? 'var(--amber)' : 'var(--text-primary)' }}>
                  {item.available_stock || 0}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current stock</div>
              </div>
            </div>
          ))}
          {items.filter(item => 
            adjSelectSearch === '' || 
            item.name.toLowerCase().includes(adjSelectSearch.toLowerCase()) ||
            (item.sku && item.sku.toLowerCase().includes(adjSelectSearch.toLowerCase())) ||
            (item.barcode && item.barcode.includes(adjSelectSearch))
          ).length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
              No items found
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}

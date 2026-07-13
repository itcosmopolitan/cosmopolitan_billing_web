import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { itemsAPI, taxRatesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fetchAllList, unwrapPaged } from '@/utils/pagination'
import { Card, FormGroup, Modal } from '@/components/ui'
import ItemFormFields from './ItemFormFields'
import {
  EMPTY_ITEM,
  formFromItem,
  branchRowFromApi,
  validateItemForm,
  buildCreatePayload,
  buildCatalogPayload,
  buildBranchUpdatePayload,
} from './itemFormShared'

const SIDEBAR_W = 244
const SIDEBAR_W_COLLAPSED = 68
const DEFAULT_UNIT_OPTIONS = ['Pcs', 'Kg', 'Gram', 'Litre', 'ML', 'Pack', 'Box', 'Dozen']

function uniqueUnits(rows = [], current = '') {
  const seen = new Set()
  const out = []
  for (const unit of [...DEFAULT_UNIT_OPTIONS, ...rows.map((row) => row.unit), current]) {
    const value = typeof unit === 'string' ? unit.trim() : ''
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function uniqueCategories(rows = [], extras = []) {
  const seen = new Set()
  const out = []
  for (const row of [...rows, ...extras]) {
    if (!row?.id) continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export default function ItemFormPage({ mode = 'create' }) {
  const { itemId } = useParams()
  const isEdit = mode === 'edit'
  const navigate = useNavigate()
  const can = useCan()
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const defaultBranchId = activeBranch?.id || branches.find((b) => b.code !== 'WH')?.id || 'br-001'
  const footerLeft = sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W

  const [form, setForm] = useState(EMPTY_ITEM)
  const [branchConfigs, setBranchConfigs] = useState([])
  const [initialListedIds, setInitialListedIds] = useState([])
  const [editWasTracked, setEditWasTracked] = useState(false)
  const [categories, setCategories] = useState([])
  const [unitOptions, setUnitOptions] = useState(DEFAULT_UNIT_OPTIONS)
  const [taxRates, setTaxRates] = useState([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [showAddUnit, setShowAddUnit] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newUnitName, setNewUnitName] = useState('')
  const [addingCategory, setAddingCategory] = useState(false)

  const patchForm = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (isEdit && !can('item_master.edit')) {
      navigate('/item-master', { replace: true })
    } else if (!isEdit && !can('item_master.create')) {
      navigate('/item-master', { replace: true })
    }
  }, [can, navigate, isEdit])

  useEffect(() => {
    if (isEdit && loading) return
    const params = { active_only: true }
    const currentRate = form.tax_rate
    if (currentRate !== '' && currentRate != null && currentRate !== undefined) {
      params.include_inactive_rates = String(currentRate)
    }
    fetchAllList((p) => taxRatesAPI.list({ ...p, ...params }))
      .then((data) => setTaxRates(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load tax rates:', err))
  }, [])

  useEffect(() => {
    if (isEdit) return
    let cancelled = false
    itemsAPI.categories.list()
      .then((data) => {
        if (cancelled) return
        setCategories(uniqueCategories(data || []))
      })
      .catch((err) => {
        console.error('Failed to load categories:', err)
        setCategories([])
      })
    return () => { cancelled = true }
  }, [isEdit])

  useEffect(() => {
    if (!isEdit || !itemId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const [item, branchData, apiCategories] = await Promise.all([
          itemsAPI.get(itemId),
          itemsAPI.getBranches(itemId),
          itemsAPI.categories.list(),
        ])
        if (cancelled) return

        setForm(formFromItem(item))
        setEditWasTracked(Boolean(item.batch_tracking))

        const listed = (branchData.branches || []).filter((b) => b.is_available)
        const rows = listed.map(branchRowFromApi)
        const ids = listed.map((b) => b.branch_id)
        setBranchConfigs(rows)
        setInitialListedIds(ids)
        setUnitOptions(uniqueUnits([item], item.unit || 'Pcs'))
        setCategories(uniqueCategories(apiCategories || [], item.categoryId
          ? [{ id: item.categoryId, name: item.categoryName || item.categoryId }]
          : []))
      } catch (err) {
        console.error('Failed to load item:', err)
        toast.error('Failed to load item')
        navigate('/item-master', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, itemId, defaultBranchId, navigate])

  // Listen for branch deletions performed elsewhere (Items & Stock).
  useEffect(() => {
    if (!isEdit || !itemId) return undefined
    const handler = (e) => {
      try {
        const { item_id, branch_id } = e.detail || {}
        if (!item_id || item_id !== itemId) return
        // Remove the branch row if present
        setBranchConfigs((rows) => rows.filter((r) => r.branch_id !== branch_id))
        setInitialListedIds((ids) => ids.filter((id) => id !== branch_id))
      } catch (err) {
        // ignore
      }
    }
    window.addEventListener('item-branch-removed', handler)
    return () => window.removeEventListener('item-branch-removed', handler)
  }, [isEdit, itemId])

  useEffect(() => {
    if (isEdit) return
    Promise.all([
      fetchAllList(itemsAPI.list, { master_mode: true, branch_id: defaultBranchId }),
      itemsAPI.categories.list(),
    ])
      .then(([data, apiCategories]) => {
        setUnitOptions(uniqueUnits(data || [], form.unit || 'Pcs'))
        setCategories(uniqueCategories(apiCategories || []))
      })
      .catch((err) => console.error('Failed to load item metadata:', err))
  }, [defaultBranchId, isEdit])

  const openAddCategory = () => {
    setNewCategoryName('')
    setShowAddCategory(true)
  }

  const openAddUnit = () => {
    setNewUnitName('')
    setShowAddUnit(true)
  }

  const submitNewCategory = async () => {
    const name = newCategoryName.trim()
    if (!name) {
      toast.error('Category name is required')
      return
    }
    const existing = categories.find((row) => row.name.trim().toLowerCase() === name.toLowerCase())
    if (existing) {
      patchForm('categoryId', existing.id)
      setShowAddCategory(false)
      return
    }

    try {
      setAddingCategory(true)
      const created = await itemsAPI.categories.create({ name })
      const next = { id: created.id, name: created.name || name }
      setCategories((prev) => uniqueCategories(prev, [next]))
      patchForm('categoryId', next.id)
      setShowAddCategory(false)
      toast.success('Category added')
    } catch (err) {
      console.error('Failed to create category:', err)
      toast.error(err?.response?.data?.detail || 'Failed to create category')
    } finally {
      setAddingCategory(false)
    }
  }

  const submitNewUnit = () => {
    const name = newUnitName.trim()
    if (!name) {
      toast.error('Unit name is required')
      return
    }
    const existing = unitOptions.find((row) => row.trim().toLowerCase() === name.toLowerCase())
    const next = existing || name
    setUnitOptions((prev) => uniqueUnits(prev.map((unit) => ({ unit })), next))
    patchForm('unit', next)
    setShowAddUnit(false)
  }

  const goBack = () => navigate('/item-master')

  const summaryCards = [
    { label: 'Branches', value: branchConfigs.filter((bc) => bc.branch_id).length },
    { label: 'Tracked', value: form.batch_tracking ? 'Yes' : 'No' },
    { label: 'Reorder', value: form.reorder_level || 0 },
  ]

  const saveItem = async () => {
    const validation = validateItemForm(form, branchConfigs)
    if (!validation.ok) {
      toast.error(validation.error)
      return
    }

    try {
      setSaving(true)
      if (isEdit) {
        const catalog = buildCatalogPayload(form, defaultBranchId)
        const res = await itemsAPI.update(itemId, catalog)
        const branchRes = await itemsAPI.updateBranches(
          itemId,
          buildBranchUpdatePayload(branchConfigs, initialListedIds),
        )
        const ch = res?.data?.batch_tracking_change
        const br = branchRes?.data
        
        // Build toast message with all the changes
        const messages = []

        if (ch?.action === 'disabled') {
          messages.push(`${ch.batches_deleted ?? 0} batch(es) removed`)
        } else if (ch?.action === 'enabled') {
          messages.push(`${ch.batches_seeded ?? 0} opening batch(es) created`)
        }
        if (br?.total_batches_deleted) {
          messages.push(`${br.total_batches_deleted} batch(es) deleted from removed branches`)
        }
        if (messages.length > 0) {
          toast.success(`Item updated — ${messages.join('; ')}`)
        } else {
          toast.success('Item updated')
        }
      } else {
        const res = await itemsAPI.create(buildCreatePayload(form, branchConfigs, defaultBranchId))
        toast.success(
          res.approval_status === 'pending_approval' || res.approval_status === 'pending'
            ? 'Item submitted for manager approval'
            : 'Item created — add stock per branch from Items & Stock',
        )
      }
      navigate('/item-master')
    } catch (err) {
      console.error('Failed to save item:', err)
      toast.error(err?.response?.data?.detail || `Failed to ${isEdit ? 'update' : 'create'} item`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading item…</div>
      </div>
    )
  }

  return (
    <>
      <div className="page-container page-container--with-footer transfer-page-shell">
        <div className="transfer-hero">
          <div className="transfer-hero__copy">
            <div className="transfer-hero__eyebrow">Inventory master</div>
            <h1>{isEdit ? 'Edit Item' : 'New Item'}</h1>
            <p>
              {isEdit
                ? 'Update catalog defaults, branch pricing, and reorder logic in one place.'
                : 'Add a product to the central catalog with branch listing and inventory settings.'}
            </p>
          </div>
          <div className="transfer-hero__stats">
            {summaryCards.map((card) => (
              <div className="transfer-stat" key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </div>
            ))}
          </div>
        </div>

        <Card title="Product details">
          <ItemFormFields
            form={form}
            patchForm={patchForm}
            editing={isEdit}
            editWasTracked={editWasTracked}
            branches={branches}
            branchConfigs={branchConfigs}
            initialListedIds={initialListedIds}
            onBranchConfigsChange={setBranchConfigs}
            branchSectionMode={isEdit ? 'edit' : 'create'}
            itemId={itemId}
            onAddCategory={openAddCategory}
            onAddUnit={openAddUnit}
            categoryActionBusy={addingCategory}
          />
        </Card>
      </div>

      <Modal
        open={showAddCategory}
        onClose={() => !addingCategory && setShowAddCategory(false)}
        title="Add Category"
        icon="🏷️"
        size="sm"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddCategory(false)} disabled={addingCategory}>Cancel</button>
            <button className="btn btn-primary" onClick={submitNewCategory} disabled={addingCategory}>
              {addingCategory ? 'Adding…' : 'Add Category'}
            </button>
          </>
        )}
      >
        <FormGroup label="Category name" required>
          <input
            className="form-input"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="e.g. Spices"
          />
        </FormGroup>
      </Modal>

      <Modal
        open={showAddUnit}
        onClose={() => setShowAddUnit(false)}
        title="Add Unit"
        icon="📏"
        size="sm"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddUnit(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={submitNewUnit}>Add Unit</button>
          </>
        )}
      >
        <FormGroup label="Unit name" required>
          <input
            className="form-input"
            value={newUnitName}
            onChange={(e) => setNewUnitName(e.target.value)}
            placeholder="e.g. Tray"
          />
        </FormGroup>
      </Modal>

      <div className="page-footer-bar" style={{ left: footerLeft }}>
        <button type="button" className="btn btn-primary" onClick={saveItem} disabled={saving}>
          {saving ? 'Saving…' : (isEdit ? 'Update Item' : 'Save Item')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={goBack} disabled={saving}>
          Cancel
        </button>
      </div>
    </>
  )
}

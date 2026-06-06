import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { itemsAPI, taxRatesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fetchAllList } from '@/utils/pagination'
import { SectionHeader, Card } from '@/components/ui'
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
  const [taxRates, setTaxRates] = useState([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  const patchForm = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (isEdit && !can('items.edit')) {
      navigate('/item-master', { replace: true })
    } else if (!isEdit && !can('items.create')) {
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
      .then((data) => setTaxRates(data || []))
      .catch((err) => console.error('Failed to load tax rates:', err))
  }, [form.tax_rate, isEdit, loading])

  useEffect(() => {
    if (!isEdit || !itemId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const [items, branchData] = await Promise.all([
          fetchAllList(itemsAPI.list, { master_mode: true, branch_id: defaultBranchId }),
          itemsAPI.getBranches(itemId),
        ])
        if (cancelled) return

        const item = items.find((i) => i.id === itemId)
        if (!item) {
          toast.error('Item not found')
          navigate('/item-master', { replace: true })
          return
        }

        setForm(formFromItem(item))
        setEditWasTracked(Boolean(item.batch_tracking))

        const listed = (branchData.branches || []).filter((b) => b.is_available)
        const rows = listed.map(branchRowFromApi)
        const ids = listed.map((b) => b.branch_id)
        setBranchConfigs(rows)
        setInitialListedIds(ids)

        const uniqueCats = [...new Set(items.map((i) => i.categoryId).filter(Boolean))]
        setCategories(uniqueCats.map((catId) => ({
          id: catId,
          name: items.find((i) => i.categoryId === catId)?.categoryName || catId,
        })))
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

  useEffect(() => {
    if (isEdit) return
    fetchAllList(itemsAPI.list, { master_mode: true, branch_id: defaultBranchId })
      .then((data) => {
        if (!data?.length) {
          setCategories([])
          return
        }
        const uniqueCats = [...new Set(data.map((item) => item.categoryId))]
        setCategories(uniqueCats.map((catId) => ({
          id: catId,
          name: data.find((item) => item.categoryId === catId)?.categoryName || catId,
        })))
      })
      .catch((err) => console.error('Failed to load categories:', err))
  }, [defaultBranchId, isEdit])

  const goBack = () => navigate('/item-master')

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
        await itemsAPI.updateBranches(
          itemId,
          buildBranchUpdatePayload(branchConfigs, initialListedIds),
        )
        const ch = res?.data?.batch_tracking_change
        if (ch?.action === 'disabled') {
          toast.success(`Item updated — ${ch.batches_deleted ?? 0} batch(es) removed`)
        } else if (ch?.action === 'enabled') {
          toast.success(`Item updated — ${ch.batches_seeded ?? 0} opening batch(es) created`)
        } else {
          toast.success('Item updated')
        }
      } else {
        await itemsAPI.create(buildCreatePayload(form, branchConfigs, defaultBranchId))
        toast.success('Item created — add stock per branch from Items & Stock')
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
      <div className="page-container page-container--with-footer">
        <SectionHeader
          title={isEdit ? 'Edit Item' : 'New Item'}
          subtitle={isEdit
            ? 'Update catalog defaults and branch listing, pricing, and reorder levels'
            : 'Add a product to the central catalog — set defaults and which branches sell it'}
        />

        <Card title="Product details">
          <ItemFormFields
            form={form}
            patchForm={patchForm}
            categories={categories}
            taxRates={taxRates}
            editing={isEdit}
            editWasTracked={editWasTracked}
            branches={branches}
            branchConfigs={branchConfigs}
            onBranchConfigsChange={setBranchConfigs}
            branchSectionMode={isEdit ? 'edit' : 'create'}
          />
        </Card>
      </div>

      <div className="page-footer-bar" style={{ left: footerLeft }}>
        <button type="button" className="btn btn-secondary" onClick={goBack} disabled={saving}>
          ← Back to Item Master
        </button>
        <button type="button" className="btn btn-primary" onClick={saveItem} disabled={saving}>
          {saving ? 'Saving…' : (isEdit ? 'Update Item' : 'Save Item')}
        </button>
      </div>
    </>
  )
}

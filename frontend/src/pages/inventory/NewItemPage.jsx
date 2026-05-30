import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { itemsAPI, taxRatesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fetchAllList } from '@/utils/pagination'
import { SectionHeader, Card } from '@/components/ui'
import ItemFormFields from './ItemFormFields'
import {
  EMPTY_ITEM,
  createBranchRow,
  validateNewItem,
  buildCreatePayload,
} from './itemFormShared'

const SIDEBAR_W = 244
const SIDEBAR_W_COLLAPSED = 68

export default function NewItemPage() {
  const navigate = useNavigate()
  const can = useCan()
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const defaultBranchId = activeBranch?.id || branches.find((b) => b.code !== 'WH')?.id || 'br-001'
  const footerLeft = sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W

  const [form, setForm] = useState(EMPTY_ITEM)
  const [branchConfigs, setBranchConfigs] = useState([])
  const [categories, setCategories] = useState([])
  const [taxRates, setTaxRates] = useState([])
  const [saving, setSaving] = useState(false)

  const patchForm = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!can('items.create')) {
      navigate('/item-master', { replace: true })
    }
  }, [can, navigate])

  useEffect(() => {
    taxRatesAPI.list()
      .then((data) => setTaxRates(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load tax rates:', err))
  }, [])

  useEffect(() => {
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
  }, [defaultBranchId])

  const goBack = () => navigate('/item-master')

  const saveItem = async () => {
    const validation = validateNewItem(form, branchConfigs)
    if (!validation.ok) {
      toast.error(validation.error)
      return
    }

    try {
      setSaving(true)
      const payload = buildCreatePayload(form, branchConfigs, defaultBranchId)
      await itemsAPI.create(payload)
      toast.success('Item created')
      navigate('/item-master')
    } catch (err) {
      console.error('Failed to save item:', err)
      toast.error(err?.response?.data?.detail || 'Failed to create item')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-container page-container--with-footer">
        <SectionHeader
          title="New Item"
          subtitle="Add a product to the central catalog — set defaults, branch listing, and optional opening stock"
        />

        <Card title="Product details">
          <ItemFormFields
            form={form}
            patchForm={patchForm}
            categories={categories}
            taxRates={taxRates}
            branches={branches}
            branchConfigs={branchConfigs}
            onBranchConfigsChange={setBranchConfigs}
          />
        </Card>
      </div>

      <div className="page-footer-bar" style={{ left: footerLeft }}>
        <button type="button" className="btn btn-secondary" onClick={goBack} disabled={saving}>
          ← Back to Item Master
        </button>
        <button type="button" className="btn btn-primary" onClick={saveItem} disabled={saving}>
          {saving ? 'Saving…' : 'Save Item'}
        </button>
      </div>
    </>
  )
}

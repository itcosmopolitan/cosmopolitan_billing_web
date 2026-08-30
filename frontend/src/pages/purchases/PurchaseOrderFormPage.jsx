import { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { purchasesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { formatLabel } from '@/utils/helpers'
import DocumentFormShell from '@/components/DocumentFormShell'
import PurchaseOrderFormModal from './PurchaseOrderFormModal'
import { emptyPoForm, poFromRow, lineDiscountToPercent } from './purchaseFormShared'
import { entityDiscountToPayload } from '@/utils/documentFormTotals'
import { enrichPurchaseLinesWithSellPrice } from '@/utils/enrichSaleLineCosts'

export default function PurchaseOrderFormPage({ mode = 'create' }) {
  const { orderId } = useParams()
  const [searchParams] = useSearchParams()
  const readOnly = searchParams.get('view') === '1'
  const isEdit = mode === 'edit'
  const navigate = useNavigate()
  const can = useCan()
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'
  const activeBranch = useAppStore((s) => s.activeBranch)

  const [form, setForm] = useState(() => emptyPoForm(activeBranchId))
  const ppof = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const [editingNumber, setEditingNumber] = useState(null)
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  const goBack = () => navigate('/purchases?tab=orders')

  useEffect(() => {
    if (isEdit && !can('purchases.edit', 'purchases.create') && !readOnly) {
      navigate('/purchases?tab=orders', { replace: true })
    } else if (!isEdit && !can('purchases.create')) {
      navigate('/purchases?tab=orders', { replace: true })
    }
  }, [can, navigate, isEdit, readOnly])

  useEffect(() => {
    if (!isEdit || !orderId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const po = await purchasesAPI.orders.get(orderId)
        if (cancelled) return
        if (!readOnly) {
          if (['pending_approval', 'converted', 'cancelled', 'partially_received'].includes(po.status)) {
            toast.error(`Cannot edit a ${formatLabel(po.status)} purchase order`)
            navigate('/purchases?tab=orders', { replace: true })
            return
          }
          if (po.status !== 'draft' && !can('purchases.edit')) {
            toast.error('Editing this purchase order requires purchases.edit')
            navigate('/purchases?tab=orders', { replace: true })
            return
          }
        }
        const base = poFromRow(po, activeBranchId)
        const items = await enrichPurchaseLinesWithSellPrice(base.items)
        if (cancelled) return
        setForm({ ...base, items })
        setEditingNumber(po.number)
      } catch {
        toast.error('Purchase order not found')
        navigate('/purchases?tab=orders', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, orderId, activeBranchId, navigate])

  const save = async () => {
    if (saving || readOnly) return
    if (!form.vendorId) { toast.error('Pick a vendor'); return }
    if (form.items.length === 0) { toast.error('Add at least one item'); return }
    if (!form.items.every((i) => i.item_id && Number(i.qty) > 0 && Number(i.cost) >= 0)) {
      toast.error('Each line must have an item, qty > 0, and cost ≥ 0')
      return
    }
    setSaving(true)
    try {
      const payload = {
        vendor_id: form.vendorId,
        vendor_name: form.vendorName,
        branch_id: form.branchId,
        branch_name: activeBranch?.name || '',
        created_by: 'Staff',
        expected_date: form.expectedDate || null,
        items: form.items.map((i) => ({
          item_id: i.item_id,
          name: i.name,
          qty: Number(i.qty),
          cost: Number(i.cost),
          tax_rate: Number(i.taxRate || 0),
          discount: lineDiscountToPercent(i),
        })),
        discount: entityDiscountToPayload(form.items, form.discount, form.discountType, {
          lineGross: (it) => Number(it.qty || 0) * Number(it.cost || 0),
        }),
        notes: form.notes || null,
      }
      if (!isEdit) {
        const n = form.number?.trim()
        if (n) payload.number = n
      }
      if (isEdit) {
        await purchasesAPI.orders.update(orderId, payload)
        toast.success('Purchase order updated')
      } else {
        const res = await purchasesAPI.orders.create(payload)
        toast.success(
          res.status === 'pending_approval'
            ? 'Purchase order submitted for approval'
            : 'Purchase order created',
        )
      }
      navigate('/purchases?tab=orders')
    } catch (err) {
      console.error('Failed to save PO:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    )
  }

  const title = readOnly
    ? `Purchase Order — ${editingNumber || ''}`
    : isEdit
      ? `Edit Purchase Order — ${editingNumber || ''}`
      : 'Create Purchase Order'

  return (
    <DocumentFormShell
      title={title}
      subtitle="Purchase Orders"
      icon="📋"
      onBack={goBack}
      onSave={readOnly ? null : save}
      saveLabel={isEdit ? 'Save Changes' : 'Create PO'}
      saving={saving}
      readOnly={readOnly}
    >
      <PurchaseOrderFormModal
        embedded
        open
        poForm={form}
        ppof={ppof}
        editingNumber={editingNumber}
        readOnly={readOnly}
      />
    </DocumentFormShell>
  )
}

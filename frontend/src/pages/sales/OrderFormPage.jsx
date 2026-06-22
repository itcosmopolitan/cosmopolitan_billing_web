import { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { unwrapPaged } from '@/utils/pagination'
import DocumentFormShell from '@/components/DocumentFormShell'
import OrderFormModal from './OrderFormModal'
import {
  emptyOrderForm,
  orderFromRow,
  quoteFromRow,
  lineDiscountToPercent,
} from './salesFormShared'
import { entityDiscountToPayload } from '@/utils/documentFormTotals'

export default function OrderFormPage({ mode = 'create' }) {
  const { orderId } = useParams()
  const [searchParams] = useSearchParams()
  const fromQuoteId = searchParams.get('fromQuote')
  const isEdit = mode === 'edit'
  const readOnly = searchParams.get('view') === '1'
  const navigate = useNavigate()
  const can = useCan()
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'
  const branches = useAppStore((s) => s.branches)

  const [form, setForm] = useState(() => emptyOrderForm(activeBranchId))
  const pof = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const [editingNumber, setEditingNumber] = useState(null)
  const [conversionLabel, setConversionLabel] = useState(null)
  const [loading, setLoading] = useState(isEdit || !!fromQuoteId)
  const [saving, setSaving] = useState(false)

  const goBack = () => navigate('/sales?tab=orders')

  useEffect(() => {
    if (isEdit && !can('invoices.edit') && !readOnly) {
      navigate('/sales?tab=orders', { replace: true })
    } else if (!isEdit && !can('invoices.create')) {
      navigate('/sales?tab=orders', { replace: true })
    }
  }, [can, navigate, isEdit, readOnly])

  useEffect(() => {
    if (isEdit && orderId) {
      let cancelled = false
      ;(async () => {
        try {
          setLoading(true)
          const so = await salesAPI.orders.get(orderId)
          if (cancelled) return
          setForm(orderFromRow(so, activeBranchId))
          setEditingNumber(so.number)
        } catch {
          toast.error('Sales order not found')
          navigate('/sales?tab=orders', { replace: true })
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
      return () => { cancelled = true }
    }
    if (!isEdit && fromQuoteId) {
      let cancelled = false
      ;(async () => {
        try {
          setLoading(true)
          const q = await salesAPI.quotations.get(fromQuoteId)
          if (cancelled) return
          setForm(quoteFromRow(q, activeBranchId))
          setConversionLabel(q.number)
        } catch {
          toast.error('Quotation not found')
          navigate('/sales?tab=quotes', { replace: true })
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
      return () => { cancelled = true }
    }
    return undefined
  }, [isEdit, orderId, fromQuoteId, activeBranchId, navigate])

  const save = async () => {
    if (saving || readOnly) return
    if (!form.customerId) {
      toast.error('Pick a customer (or add one via the Customers page)')
      return
    }
    if (form.items.length === 0) {
      toast.error('Add at least one item')
      return
    }
    if (!form.items.every((i) => i.name && Number(i.qty) > 0 && Number(i.price) > 0)) {
      toast.error('Each item must have name, qty, and price')
      return
    }
    setSaving(true)
    try {
      const payload = {
        customer_name: form.customerName,
        customer_id: form.customerId || null,
        branch_id: form.branchId,
        branch_name: branches.find((b) => b.id === form.branchId)?.name || '',
        created_by: 'Staff',
        expected_date: form.expectedDate || null,
        items: form.items.map((i) => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: Number(i.qty),
          price: Number(i.price),
          tax_rate: Number(i.taxRate || 0),
          discount: lineDiscountToPercent(i),
        })),
        discount: entityDiscountToPayload(form.items, form.discount, form.discountType, {
          lineGross: (it) => Number(it.qty || 0) * Number(it.price || 0),
        }),
        notes: form.notes,
      }
      if (fromQuoteId && !isEdit) {
        payload.quotation_id = fromQuoteId
      }
      if (!isEdit) {
        const n = form.number?.trim()
        if (n) payload.number = n
      }
      if (isEdit) {
        await salesAPI.orders.update(orderId, payload)
        toast.success('Sales order updated')
      } else {
        await salesAPI.orders.create(payload)
        toast.success(fromQuoteId ? 'Sales order created from quotation' : 'Sales order created')
      }
      navigate('/sales?tab=orders')
    } catch (err) {
      console.error('Failed to save order:', err)
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
    ? `Sales Order — ${editingNumber || ''}`
    : conversionLabel
      ? `Create Sales Order — from ${conversionLabel}`
      : isEdit
        ? `Edit Sales Order — ${editingNumber || ''}`
        : 'Create Sales Order'

  const summaryCards = [
    { label: 'Lines', value: form.items.filter((i) => i.item_id || i.name).length },
    { label: 'Qty', value: form.items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0) },
    {
      label: 'Gross',
      value: `MVR${form.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.price) || 0), 0).toFixed(0)}`,
    },
  ]

  return (
    <DocumentFormShell
      title={title}
      subtitle="Sales Orders"
      icon="📦"
      onBack={goBack}
      backLabel="← Back to Sales Orders"
      onSave={readOnly ? null : save}
      saveLabel={isEdit ? 'Save Changes' : 'Create Sales Order'}
      saving={saving}
      readOnly={readOnly}
      summaryCards={summaryCards}
    >
      <OrderFormModal
        embedded
        open
        orderForm={form}
        pof={pof}
        editingNumber={editingNumber}
        readOnly={readOnly}
        conversionLabel={conversionLabel}
      />
    </DocumentFormShell>
  )
}

import { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { unwrapPaged } from '@/utils/pagination'
import DocumentFormShell from '@/components/DocumentFormShell'
import QuoteFormModal from './QuoteFormModal'
import {
  emptyQuoteForm,
  quoteFromRow,
  lineDiscountToPercent,
} from './salesFormShared'
import { entityDiscountToPayload } from '@/utils/documentFormTotals'
import { enrichSaleLinesWithCosts } from '@/utils/enrichSaleLineCosts'

export default function QuoteFormPage({ mode = 'create' }) {
  const { quoteId } = useParams()
  const [searchParams] = useSearchParams()
  const isEdit = mode === 'edit'
  const readOnly = searchParams.get('view') === '1'
  const navigate = useNavigate()
  const can = useCan()
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'
  const branches = useAppStore((s) => s.branches)

  const [form, setForm] = useState(() => emptyQuoteForm(activeBranchId))
  const pqf = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const [editingNumber, setEditingNumber] = useState(null)
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  const goBack = () => navigate('/sales?tab=quotes')

  useEffect(() => {
    if (isEdit && !can('invoices.edit') && !readOnly) {
      navigate('/sales?tab=quotes', { replace: true })
    } else if (!isEdit && !can('invoices.create')) {
      navigate('/sales?tab=quotes', { replace: true })
    }
  }, [can, navigate, isEdit, readOnly])

  useEffect(() => {
    if (!isEdit || !quoteId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const q = await salesAPI.quotations.get(quoteId)
        if (cancelled) return
        const base = quoteFromRow(q, activeBranchId)
        const items = await enrichSaleLinesWithCosts(base.items, base.branchId)
        if (cancelled) return
        setForm({ ...base, items })
        setEditingNumber(q.number)
      } catch {
        toast.error('Quotation not found')
        navigate('/sales?tab=quotes', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, quoteId, activeBranchId, navigate])

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
        valid_until: form.validUntil,
        items: form.items.map((i) => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: Number(i.qty),
          price: Number(i.price),
          tax_rate: Number(i.taxRate || 0),
          line_discount: lineDiscountToPercent(i),
        })),
        discount: entityDiscountToPayload(form.items, form.discount, form.discountType, {
          lineGross: (it) => Number(it.qty || 0) * Number(it.price || 0),
        }),
        notes: form.notes,
      }
      if (!isEdit) {
        const n = form.number?.trim()
        if (n) payload.number = n
      }
      if (isEdit) {
        await salesAPI.quotations.update(quoteId, payload)
        toast.success('Quotation updated')
      } else {
        await salesAPI.quotations.create(payload)
        toast.success('Quotation created successfully')
      }
      navigate('/sales?tab=quotes')
    } catch (err) {
      console.error('Failed to save quotation:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading quotation…</div>
      </div>
    )
  }

  const title = readOnly
    ? `Quotation — ${editingNumber || ''}`
    : isEdit
      ? `Edit Quotation — ${editingNumber || ''}`
      : 'Create Quotation'

  return (
    <DocumentFormShell
      title={title}
      subtitle="Quotations"
      icon="📄"
      onBack={goBack}
      onSave={readOnly ? null : save}
      saveLabel={isEdit ? 'Save Changes' : 'Create Quotation'}
      saving={saving}
      readOnly={readOnly}
    >
      <QuoteFormModal
        embedded
        open
        quoteForm={form}
        pqf={pqf}
        editingNumber={editingNumber}
        readOnly={readOnly}
      />
    </DocumentFormShell>
  )
}

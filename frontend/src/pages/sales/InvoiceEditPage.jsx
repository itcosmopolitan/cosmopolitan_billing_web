import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, itemsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import DocumentFormShell from '@/components/DocumentFormShell'
import InvoiceFormModal from './InvoiceFormModal'
import { invoiceFromRow, lineDiscountToPercent } from './salesFormShared'
import { entityDiscountToPayload } from '@/utils/documentFormTotals'
import { toApiPayload } from '@/utils/batchAllocation'

async function enrichLinesWithBatchFlags(items, branchId) {
  const out = []
  for (const line of items) {
    if (!line.item_id) {
      out.push(line)
      continue
    }
    if (line.batchTracking) {
      out.push(line)
      continue
    }
    try {
      const res = await itemsAPI.batches.list(line.item_id, { branch_id: branchId })
      out.push({
        ...line,
        batchTracking: Boolean(res?.item?.batch_tracking),
        expiryTracking: Boolean(res?.item?.expiry_tracking),
        batchAllocation: line.batchAllocation || [],
        batchAllocationCustom: Boolean(line.batchAllocationCustom),
      })
    } catch {
      out.push(line)
    }
  }
  return out
}

function invoiceEditable(inv) {
  if (!inv) return false
  if (inv.status === 'cancelled' || inv.status === 'paid') return false
  if ((inv.paidAmount || 0) > 0) return false
  if ((inv.origin || 'invoice').toLowerCase() === 'pos') return false
  return true
}

export default function InvoiceEditPage() {
  const { invoiceId } = useParams()
  const navigate = useNavigate()
  const can = useCan()

  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const pif = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!can('invoices.edit')) {
      navigate('/sales?tab=invoices', { replace: true })
    }
  }, [can, navigate])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const inv = await salesAPI.get(invoiceId)
        if (cancelled) return
        if (!invoiceEditable(inv)) {
          toast.error('This invoice cannot be edited')
          navigate('/sales?tab=invoices', { replace: true })
          return
        }
        const base = invoiceFromRow(inv, inv.branchId)
        const items = await enrichLinesWithBatchFlags(base.items, base.branchId)
        setForm({ ...base, items })
      } catch {
        toast.error('Invoice not found')
        navigate('/sales?tab=invoices', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [invoiceId, navigate])

  const save = async () => {
    if (saving || !form) return
    if (!form.customerId) {
      toast.error('Pick a customer')
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
        customer_id: form.customerId || null,
        customer_name: form.customerName,
        date: form.invoiceDate,
        due_date: form.dueDate || null,
        items: form.items.map((i) => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: Number(i.qty),
          price: Number(i.price),
          tax_rate: Number(i.taxRate || 0),
          line_discount: lineDiscountToPercent(i),
          batch_allocation: toApiPayload(i.batchAllocation),
        })),
        discount: entityDiscountToPayload(form.items, form.discount, form.discountType, {
          lineGross: (it) => Number(it.qty || 0) * Number(it.price || 0),
        }),
        notes: form.notes || null,
      }
      await salesAPI.update(invoiceId, payload)
      toast.success('Invoice updated')
      navigate('/sales?tab=invoices')
    } catch (err) {
      console.error('Failed to update invoice:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading || !form) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      </div>
    )
  }

  return (
    <DocumentFormShell
      title={`Edit Invoice — ${form.number}`}
      subtitle="Invoices"
      icon="🧾"
      onBack={() => navigate('/sales?tab=invoices')}
      backLabel="← Back"
      onSave={save}
      saveLabel="Save Changes"
      saving={saving}
    >
      <InvoiceFormModal
        embedded
        open
        editMode
        invoiceForm={form}
        pif={pif}
      />
    </DocumentFormShell>
  )
}

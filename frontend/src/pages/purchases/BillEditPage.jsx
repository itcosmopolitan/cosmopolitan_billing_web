import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { purchasesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import DocumentFormShell from '@/components/DocumentFormShell'
import BillFormModal from './BillFormModal'
import { billFromRow, lineDiscountToPercent } from './purchaseFormShared'
import { entityDiscountToPayload } from '@/utils/documentFormTotals'

export default function BillEditPage() {
  const { billId } = useParams()
  const navigate = useNavigate()
  const can = useCan()
  const activeBranch = useAppStore((s) => s.activeBranch)

  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const pbf = (k, v) => setForm((b) => ({ ...b, [k]: v }))

  useEffect(() => {
    if (!can('purchases.edit')) {
      navigate('/purchases', { replace: true })
    }
  }, [can, navigate])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const bill = await purchasesAPI.get(billId)
        if (cancelled) return
        const status = bill.status
        if (status === 'paid' || status === 'cancelled' || (bill.paidAmount || 0) > 0) {
          toast.error(`Cannot edit this bill`)
          navigate('/purchases?tab=bills', { replace: true })
          return
        }
        setForm(billFromRow(bill, bill.branchId))
      } catch {
        toast.error('Bill not found')
        navigate('/purchases?tab=bills', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [billId, navigate])

  const save = async () => {
    if (saving || !form) return
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
        date: form.billDate,
        due_date: form.dueDate || null,
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
      await purchasesAPI.update(billId, payload)
      toast.success('Bill updated')
      navigate('/purchases?tab=bills')
    } catch (err) {
      console.error('Failed to update bill:', err)
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
      title={`Edit Bill — ${form.number || billId}`}
      subtitle="Bills"
      icon="📋"
      onBack={() => navigate('/purchases?tab=bills')}
      backLabel="← Back"
      onSave={save}
      saveLabel="Save Changes"
      saving={saving}
    >
      <BillFormModal
        embedded
        open
        billForm={form}
        pbf={pbf}
        mode="bill"
        editMode
      />
    </DocumentFormShell>
  )
}

import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { purchasesAPI, itemsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import DocumentFormShell from '@/components/DocumentFormShell'
import BillFormModal from './BillFormModal'
import {
  emptyBillForm,
  billFromRow,
  poFromRow,
  lineDiscountToPercent,
} from './purchaseFormShared'
import { entityDiscountToPayload } from '@/utils/documentFormTotals'

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
      })
    } catch {
      out.push(line)
    }
  }
  return out
}

/** Full-page bill or GRN create (including PO/GRN conversions). */
export default function BillFormPage({ mode = 'bill' }) {
  const isGrn = mode === 'grn'
  const [searchParams] = useSearchParams()
  const fromPoId = searchParams.get('fromPo')
  const fromGrnId = searchParams.get('fromGrn')
  const navigate = useNavigate()
  const can = useCan()
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'
  const activeBranch = useAppStore((s) => s.activeBranch)

  const [form, setForm] = useState(() => emptyBillForm(activeBranchId))
  const pbf = (k, v) => setForm((b) => ({ ...b, [k]: v }))
  const [conversionLabel, setConversionLabel] = useState(null)
  const [loading, setLoading] = useState(!!fromPoId || !!fromGrnId)
  const [saving, setSaving] = useState(false)

  const goBack = () => {
    if (fromPoId) navigate('/purchases?tab=orders')
    else if (fromGrnId) navigate('/purchases?tab=grns')
    else navigate(isGrn ? '/purchases?tab=grns' : '/purchases?tab=bills')
  }

  useEffect(() => {
    if (!can('purchases.create')) {
      navigate('/purchases', { replace: true })
    }
  }, [can, navigate])

  useEffect(() => {
    if (!fromPoId && !fromGrnId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        if (fromPoId) {
          const po = await purchasesAPI.orders.get(fromPoId)
          if (cancelled) return
          const mapped = poFromRow(po, activeBranchId)
          const items = await enrichLinesWithBatchFlags(mapped.items, mapped.branchId)
          setForm({
            ...emptyBillForm(mapped.branchId),
            vendorId: mapped.vendorId,
            vendorName: mapped.vendorName,
            items,
            notes: mapped.notes,
          })
          setConversionLabel(po.number)
        } else if (fromGrnId) {
          const grn = await purchasesAPI.grns.get(fromGrnId)
          if (cancelled) return
          const mapped = billFromRow(grn, activeBranchId)
          const items = await enrichLinesWithBatchFlags(mapped.items, mapped.branchId)
          setForm({ ...mapped, items })
          setConversionLabel(grn.number)
        }
      } catch {
        toast.error('Source document not found')
        navigate('/purchases', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [fromPoId, fromGrnId, activeBranchId, navigate])

  const save = async () => {
    if (saving) return
    if (!form.vendorId) { toast.error('Pick a vendor'); return }
    if (form.items.length === 0) { toast.error('Add at least one item'); return }
    if (!form.items.every((i) => i.item_id && Number(i.qty) > 0 && Number(i.cost) >= 0)) {
      toast.error('Each line must have an item, qty > 0, and cost ≥ 0')
      return
    }
    if (!isGrn && form.paymentReceived && !form.paymentMethod) {
      toast.error('Pick a payment method (or uncheck Payment paid?)')
      return
    }
    setSaving(true)
    try {
      if (isGrn) {
        const payload = {
          vendor_id: form.vendorId,
          vendor_name: form.vendorName,
          branch_id: form.branchId,
          branch_name: activeBranch?.name || '',
          date: form.billDate,
          items: form.items.map((i) => ({
            item_id: i.item_id,
            name: i.name,
            qty: Number(i.qty),
            cost: Number(i.cost),
            tax_rate: Number(i.taxRate || 0),
            discount: lineDiscountToPercent(i),
            batch_number: i.batchTracking ? (i.batchNumber || undefined) : undefined,
            mfg_date: i.batchTracking ? (i.mfgDate || undefined) : undefined,
            expiry_date: i.batchTracking ? (i.expiryDate || undefined) : undefined,
          })),
          discount: entityDiscountToPayload(form.items, form.discount, form.discountType, {
            lineGross: (it) => Number(it.qty || 0) * Number(it.cost || 0),
          }),
          notes: form.notes || null,
        }
        const grnNum = form.number?.trim()
        if (grnNum) payload.number = grnNum
        if (fromPoId) payload.purchase_order_id = fromPoId
        const res = await purchasesAPI.grns.create(payload)
        toast.success(`GRN ${res.number || res.id} created — stock received`)
        navigate(fromPoId ? '/purchases?tab=grns' : '/purchases?tab=grns')
      } else {
        const payload = {
          vendor_id: form.vendorId,
          vendor_name: form.vendorName,
          branch_id: form.branchId,
          branch_name: activeBranch?.name || '',
          date: form.billDate,
          due_date: form.dueDate || null,
          items: form.items.map((i) => ({
            item_id: i.item_id,
            name: i.name,
            qty: Number(i.qty),
            cost: Number(i.cost),
            tax_rate: Number(i.taxRate || 0),
            discount: lineDiscountToPercent(i),
            batch_number: i.batchTracking ? (i.batchNumber || undefined) : undefined,
            mfg_date: i.batchTracking ? (i.mfgDate || undefined) : undefined,
            expiry_date: i.batchTracking ? (i.expiryDate || undefined) : undefined,
          })),
          discount: entityDiscountToPayload(form.items, form.discount, form.discountType, {
            lineGross: (it) => Number(it.qty || 0) * Number(it.cost || 0),
          }),
          payment_mode: form.paymentReceived ? form.paymentMethod : null,
          notes: form.notes || null,
        }
        const billNum = form.number?.trim()
        if (billNum) payload.number = billNum
        if (fromPoId) payload.purchase_order_id = fromPoId
        if (fromGrnId) payload.grn_id = fromGrnId
        const res = await purchasesAPI.create(payload)
        toast.success(`Bill ${res?.number || ''} created`)
        navigate('/purchases?tab=bills')
      }
    } catch (err) {
      console.error('Failed to save:', err)
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

  const title = conversionLabel
    ? (isGrn ? `Receive Stock — from ${conversionLabel}` : `Create Bill — from ${conversionLabel}`)
    : (isGrn ? 'New Goods Receipt (GRN)' : 'New Purchase Bill')

  const summaryCards = [
    { label: 'Lines', value: form.items.filter((i) => i.item_id).length },
    { label: 'Qty', value: form.items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0) },
    { label: 'Tracked', value: form.items.filter((i) => i.batchTracking).length },
  ]

  return (
    <DocumentFormShell
      title={title}
      subtitle={isGrn ? 'Goods Receipts' : 'Bills'}
      icon={isGrn ? '📦' : '📋'}
      hideHeader
      onBack={goBack}
      onSave={save}
      saveLabel={isGrn ? 'Receive Stock' : 'Save Bill'}
      saving={saving}
      summaryCards={summaryCards}
    >
      <BillFormModal
        embedded
        open
        billForm={form}
        pbf={pbf}
        mode={isGrn ? 'grn' : 'bill'}
        conversionLabel={conversionLabel}
      />
    </DocumentFormShell>
  )
}

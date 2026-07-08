import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI, itemsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { unwrapPaged } from '@/utils/pagination'
import DocumentFormShell from '@/components/DocumentFormShell'
import InvoiceFormModal from './InvoiceFormModal'
import { toApiPayload } from '@/utils/batchAllocation'
import {
  emptyInvoiceForm,
  invoiceFromRow,
  lineDiscountToPercent,
} from './salesFormShared'
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
        batchAllocation: line.batchAllocation || [],
        batchAllocationCustom: Boolean(line.batchAllocationCustom),
      })
    } catch {
      out.push(line)
    }
  }
  return out
}

export default function InvoiceFormPage() {
  const [searchParams] = useSearchParams()
  const fromQuoteId = searchParams.get('fromQuote')
  const fromOrderId = searchParams.get('fromOrder')
  const navigate = useNavigate()
  const can = useCan()
  const activeBranchId = useAppStore((s) => s.activeBranch?.id) || 'br-001'
  const branches = useAppStore((s) => s.branches)

  const [form, setForm] = useState(() => emptyInvoiceForm(activeBranchId))
  const pif = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const [conversionLabel, setConversionLabel] = useState(null)
  const [loading, setLoading] = useState(!!fromQuoteId || !!fromOrderId)
  const [saving, setSaving] = useState(false)

  const goBack = () => navigate(fromOrderId ? '/sales?tab=orders' : fromQuoteId ? '/sales?tab=quotes' : '/sales?tab=invoices')

  useEffect(() => {
    if (!can('invoices.create')) {
      navigate('/sales?tab=invoices', { replace: true })
    }
  }, [can, navigate])

  useEffect(() => {
    if (!fromQuoteId && !fromOrderId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        if (fromOrderId) {
          const so = await salesAPI.orders.get(fromOrderId)
          if (cancelled) return
          const base = invoiceFromRow(so, activeBranchId, { withOrderLineId: true })
          const items = await enrichLinesWithBatchFlags(base.items, base.branchId)
          setForm({ ...base, items })
          setConversionLabel(so.number)
        } else if (fromQuoteId) {
          const q = await salesAPI.quotations.get(fromQuoteId)
          if (cancelled) return
          const base = invoiceFromRow(q, activeBranchId)
          const items = await enrichLinesWithBatchFlags(base.items, base.branchId)
          setForm({ ...base, items })
          setConversionLabel(q.number)
        }
      } catch {
        toast.error('Source document not found')
        navigate('/sales', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [fromQuoteId, fromOrderId, activeBranchId, navigate])

  const save = async () => {
    if (saving) return
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
    if (form.paymentReceived && !form.paymentMethod) {
      toast.error('Pick a payment method (or uncheck Payment received?)')
      return
    }
    if (fromOrderId) {
      const sourceLines = form.items
        .filter((i) => i.orderLineId && Number(i.qty) > 0)
        .map((i) => ({ order_line_id: i.orderLineId, qty: Number(i.qty) }))
      if (sourceLines.length === 0) {
        toast.error('Include at least one line from the sales order')
        return
      }
    }
    setSaving(true)
    try {
      const payload = {
        customer_name: form.customerName,
        customer_id: form.customerId || null,
        branch_id: form.branchId,
        branch_name: branches.find((b) => b.id === form.branchId)?.name || '',
        cashier: 'Staff',
        date: form.invoiceDate,
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
        payment_mode: form.paymentReceived ? form.paymentMethod : null,
        notes: form.notes,
      }
      const n = form.number?.trim()
      if (n) payload.number = n
      if (fromQuoteId) payload.quotation_id = fromQuoteId
      if (fromOrderId) {
        payload.sales_order_id = fromOrderId
        payload.source_order_lines = form.items
          .filter((i) => i.orderLineId && Number(i.qty) > 0)
          .map((i) => ({ order_line_id: i.orderLineId, qty: Number(i.qty) }))
      }
      const res = await salesAPI.create(payload)
      toast.success(`Invoice ${res?.number || ''} created (${res?.status || ''})`)
      navigate('/sales?tab=invoices')
    } catch (err) {
      console.error('Failed to save invoice:', err)
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
    ? `Create Invoice — from ${conversionLabel}`
    : 'Create Invoice'

  const summaryCards = [
    { label: 'Lines', value: form.items.filter((i) => i.item_id).length },
    { label: 'Qty', value: form.items.reduce((sum, i) => sum + (Number(i.qty) || 0), 0) },
      {
      label: 'Gross',
      value: `MVR${form.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.price) || 0), 0).toFixed(0)}`,
    },
  ]

  return (
    <DocumentFormShell
      title={title}
      subtitle="Invoices"
      icon="🧾"
      hideHeader
      onBack={goBack}
      onSave={save}
      saveLabel="Create Invoice"
      saving={saving}
      summaryCards={summaryCards}
    >
      <InvoiceFormModal
        embedded
        open
        invoiceForm={form}
        pif={pif}
        conversionLabel={conversionLabel}
      />
    </DocumentFormShell>
  )
}

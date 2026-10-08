import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI, itemsAPI, customersAPI } from '@/api'
import { useAppStore, usePOSStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { unwrapPaged } from '@/utils/pagination'
import DocumentFormShell from '@/components/DocumentFormShell'
import { ConfirmDialog, Modal } from '@/components/ui'
import InvoiceFormModal from './InvoiceFormModal'
import { toApiPayload } from '@/utils/batchAllocation'
import {
  emptyInvoiceForm,
  invoiceFromRow,
  lineDiscountToPercent,
  findUnlistedItemsAtBranch,
  unlistedItemsFromError,
} from './salesFormShared'
import { cashTenderError } from '@/utils/cashTender'
import {
  customerRequiresImmediatePayment,
  storeCreditApplyAmount,
  remainingAfterStoreCredit,
} from '@/utils/storeCredit'
import {
  computeDocumentTotals,
  entityDiscountToPayload,
  roundSaleLineForApi,
  saleLineGross,
} from '@/utils/documentFormTotals'
import { enrichSaleLinesWithCosts } from '@/utils/enrichSaleLineCosts'
import { getChildCounterBranch, getConfiguredChildCounters } from '@/utils/childCounters'

async function enrichLinesWithBatchFlags(items, branchId) {
  const withCost = await enrichSaleLinesWithCosts(items, branchId)
  const out = []
  for (const line of withCost) {
    if (!line.item_id || line.batchTracking) {
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

async function enrichCustomerCreditFields(base) {
  if (!base?.customerId) return base
  try {
    const cust = await customersAPI.get(base.customerId)
    return {
      ...base,
      customerCreditBalance: Number(cust?.credit_balance || 0),
      customerCreditLimit: Number(cust?.credit_limit || 0),
      customerOutstanding: Number(cust?.outstanding || 0),
      customerCreditEligible: Boolean(cust?.is_credit_eligible ?? cust?.isCreditEligible),
      customerType: cust?.customer_type || cust?.type || base.customerType,
    }
  } catch {
    return base
  }
}

export default function InvoiceFormPage() {
  const [searchParams] = useSearchParams()
  const fromQuoteId = searchParams.get('fromQuote')
  const fromOrderId = searchParams.get('fromOrder')
  const navigate = useNavigate()
  const can = useCan()
  const activeBranch = useAppStore((s) => s.activeBranch)
  const activeBranchId = activeBranch?.id || 'br-001'
  const branches = useAppStore((s) => s.branches)
  const selectedChildCounter = usePOSStore((s) => s.selectedChildCounter)
  const setSelectedChildCounter = usePOSStore((s) => s.setSelectedChildCounter)
  const setChildCounterBranchId = usePOSStore((s) => s.setChildCounterBranchId)

  const [form, setForm] = useState(() => emptyInvoiceForm(activeBranchId))
  const pif = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const [conversionLabel, setConversionLabel] = useState(null)
  const [loading, setLoading] = useState(!!fromQuoteId || !!fromOrderId)
  const [saving, setSaving] = useState(false)
  const [showCreditWarning, setShowCreditWarning] = useState(false)
  const [unlistedConvertItems, setUnlistedConvertItems] = useState([])

  const goBack = () => navigate(fromOrderId ? '/sales?tab=orders' : fromQuoteId ? '/sales?tab=quotes' : '/sales?tab=invoices')

  useEffect(() => {
    if (fromQuoteId || fromOrderId || !activeBranchId) return
    setForm((current) => (
      current.branchId === activeBranchId
        ? current
        : { ...current, branchId: activeBranchId }
    ))
  }, [activeBranchId, fromOrderId, fromQuoteId])

  useEffect(() => {
    setChildCounterBranchId(form.branchId || activeBranchId || '', form.childCounterId || '')
    return () => setChildCounterBranchId('')
  }, [activeBranchId, form.branchId, form.childCounterId, setChildCounterBranchId])

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
          const base = await enrichCustomerCreditFields(
            invoiceFromRow(so, activeBranchId, { withOrderLineId: true }),
          )
          const items = await enrichLinesWithBatchFlags(base.items, base.branchId)
          setForm({ ...base, items })
          setSelectedChildCounter(base.childCounterId || '')
          setConversionLabel(so.number)
        } else if (fromQuoteId) {
          const q = await salesAPI.quotations.get(fromQuoteId)
          if (cancelled) return
          const unlisted = await findUnlistedItemsAtBranch(
            q.items || [],
            q.branchId || q.branch_id || activeBranchId,
          )
          if (cancelled) return
          if (unlisted.length) {
            setUnlistedConvertItems(unlisted)
            setConversionLabel(q.number)
            return
          }
          const base = await enrichCustomerCreditFields(invoiceFromRow(q, activeBranchId))
          const items = await enrichLinesWithBatchFlags(base.items, base.branchId)
          setForm({ ...base, items })
          setSelectedChildCounter(base.childCounterId || '')
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
  }, [fromQuoteId, fromOrderId, activeBranchId, navigate, setSelectedChildCounter])

  const save = async (allowCreditOverLimit = false) => {
    if (saving) return
    if (form.items.length === 0) {
      toast.error('Add at least one item')
      return
    }
    if (!form.items.every((i) => i.name && Number(i.qty) > 0 && Number(i.price) > 0)) {
      toast.error('Each item must have name, qty, and price')
      return
    }
    const selectedBranch = getChildCounterBranch(branches, form.branchId, activeBranch)
    const childCounters = getConfiguredChildCounters(selectedBranch)
    const selectedCounter = childCounters.find(
      (counter) => String(counter.id) === String(selectedChildCounter),
    )
    if (childCounters.length > 0 && !selectedCounter) {
      toast.error('Select a valid child counter for this invoice')
      return
    }

    const due = computeDocumentTotals(form.items, {
      entityDiscount: form.discount,
      entityDiscountType: form.discountType || '%',
      enforceExclusive: true,
    }).total

    let creditAvail = Number(form.customerCreditBalance || 0)
    let creditLimit = Number(form.customerCreditLimit || 0)
    let outstanding = Number(form.customerOutstanding || 0)
    if (form.customerId) {
    try {
      const cust = await customersAPI.get(form.customerId)
      creditAvail = Number(cust?.credit_balance || 0)
      creditLimit = Number(cust?.credit_limit || 0)
      outstanding = Number(cust?.outstanding || 0)
      setForm((f) => ({
        ...f,
        customerCreditBalance: creditAvail,
        customerCreditLimit: Number(cust?.credit_limit || 0),
        customerOutstanding: Number(cust?.outstanding || 0),
        customerCreditEligible: Boolean(cust?.is_credit_eligible ?? cust?.isCreditEligible),
      }))
    } catch {
      /* keep form balance */
    }
    }
    // Always auto-apply account credit when settling (or when it covers the bill).
    const settling = form.paymentReceived || creditAvail > 0
    const creditUse = storeCreditApplyAmount(
      creditAvail,
      due,
      form.paymentMethod !== 'credit' && settling && !!form.customerId,
    )
    const remaining = remainingAfterStoreCredit(due, creditUse)
    if (!form.paymentMethod) {
      toast.error('Pick a payment method to create the invoice')
      return
    }
    const accountCreditRemaining = Math.max(
      0,
      creditLimit - outstanding,
    )
    if (
      form.paymentMethod === 'credit'
      && !allowCreditOverLimit
      && due > accountCreditRemaining + 0.001
    ) {
      setShowCreditWarning(true)
      return
    }

    if (settling && remaining > 0.001 && !form.paymentMethod) {
      toast.error('Pick a payment method for the remaining amount (Cash / Card / Bank Transfer)')
      return
    }
    const mustPay = customerRequiresImmediatePayment({
      id: form.customerId,
      is_credit_eligible: form.customerCreditEligible,
      customer_type: form.customerType,
      credit_limit: form.customerCreditLimit,
    })
    if (mustPay && remaining > 0.001 && !form.paymentMethod) {
      toast.error('This customer is not credit eligible — select a payment method')
      return
    }
    if ((form.paymentMethod === 'upi' || form.paymentMethod === 'bank_transfer') && remaining > 0.001 && !String(form.paymentRef || '').trim()) {
      toast.error('Enter the payment reference for UPI or Bank Transfer')
      return
    }
    if (form.paymentMethod === 'cash' && remaining > 0.001) {
      const err = cashTenderError(form.cashCollected, remaining)
      if (err) { toast.error(err); return }
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
    if (fromQuoteId) {
      const unlisted = await findUnlistedItemsAtBranch(form.items, form.branchId)
      if (unlisted.length) {
        setUnlistedConvertItems(unlisted)
        return
      }
    }
    setSaving(true)
    try {
      const persistItems = form.items.map((i) => ({ ...i, ...roundSaleLineForApi(i) }))
      const payload = {
        customer_name: form.customerName || 'Walk-in',
        customer_id: form.customerId || null,
        branch_id: form.branchId,
        branch_name: branches.find((b) => b.id === form.branchId)?.name || '',
        child_counter_id: selectedCounter?.id || null,
        child_counter_name: selectedCounter?.name || null,
        cashier: 'Staff',
        date: form.invoiceDate,
        items: persistItems.map((i) => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: i.qty,
          price: i.price,
          tax_rate: Number(i.taxRate || 0),
          line_discount: lineDiscountToPercent(i),
          batch_allocation: toApiPayload(i.batchAllocation),
        })),
        discount: entityDiscountToPayload(persistItems, form.discount, form.discountType, {
          lineGross: saleLineGross,
        }),
        payment_mode: remaining > 0.001 && (form.paymentReceived || mustPay || creditUse > 0)
          ? form.paymentMethod
          : (creditUse > 0 && remaining <= 0.001 ? null : (form.paymentReceived ? form.paymentMethod : null)),
        cash_collected: form.paymentMethod === 'cash' && form.cashCollected !== ''
          ? Number(form.cashCollected)
          : undefined,
        store_credit_amount: creditUse > 0 ? creditUse : undefined,
        payment_ref: form.paymentMethod === 'upi' || form.paymentMethod === 'bank_transfer'
          ? (form.paymentRef || '').trim() || null
          : null,
        notes: form.notes,
        allow_credit_over_limit: allowCreditOverLimit,
      }
      // Settle when payment selected OR account credit covers (any portion with tender/credit).
      if (creditUse > 0 && remaining <= 0.001) {
        payload.payment_mode = null
        payload.store_credit_amount = creditUse
      } else if (creditUse > 0 || form.paymentReceived || (mustPay && form.paymentMethod)) {
        payload.payment_mode = form.paymentMethod
        if (creditUse > 0) payload.store_credit_amount = creditUse
      } else {
        payload.payment_mode = null
        delete payload.store_credit_amount
      }
      const n = form.number?.trim()
      if (n) payload.number = n
      if (fromQuoteId) payload.quotation_id = fromQuoteId
      if (fromOrderId) {
        payload.sales_order_id = fromOrderId
        payload.source_order_lines = persistItems
          .filter((i) => i.orderLineId && Number(i.qty) > 0)
          .map((i) => ({ order_line_id: i.orderLineId, qty: i.qty }))
      }
      const res = await salesAPI.create(payload)
      toast.success(`Invoice ${res?.number || ''} created (${res?.status || ''})`)
      navigate('/sales?tab=invoices')
    } catch (err) {
      console.error('Failed to save invoice:', err)
      const unlisted = unlistedItemsFromError(err)
      if (unlisted.length) setUnlistedConvertItems(unlisted)
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

  if (unlistedConvertItems.length > 0) {
    return (
      <UnlistedQuoteConvertModal
        open
        items={unlistedConvertItems}
        quoteLabel={conversionLabel}
        onClose={goBack}
      />
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
      onSave={() => save()}
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
      <ConfirmDialog
        open={showCreditWarning}
        onClose={() => setShowCreditWarning(false)}
        onConfirm={async () => {
          setShowCreditWarning(false)
          await save(true)
        }}
        title="Credit limit exceeded"
        message="The customer's available credit is exhausted for this purchase. Do you want to continue and increase the outstanding credit?"
        confirmLabel="Yes, continue"
        danger
      />
    </DocumentFormShell>
  )
}

function UnlistedQuoteConvertModal({ open, items, quoteLabel, onClose }) {
  const many = items.length > 1
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cannot convert to invoice"
      size="sm"
      icon="⚠️"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          OK
        </button>
      }
    >
      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 12 }}>
        {quoteLabel ? `Quotation ${quoteLabel} cannot be converted. ` : ''}
        You can't convert this quotation to an invoice because
        {many ? ' these items are' : ' this item is'} not configured for this
        branch in item master.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-primary)', fontSize: 14 }}>
        {items.map((name) => (
          <li key={name} style={{ marginBottom: 4 }}>{name}</li>
        ))}
      </ul>
    </Modal>
  )
}

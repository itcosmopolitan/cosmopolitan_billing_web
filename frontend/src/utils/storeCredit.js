/** Cap account-credit draw to what's available and what's owed. */
export function storeCreditApplyAmount(available, due, apply = true) {
  if (!apply) return 0
  const avail = Math.max(0, Number(available) || 0)
  const owed = Math.max(0, Number(due) || 0)
  return Math.round(Math.min(avail, owed) * 100) / 100
}

export function remainingAfterStoreCredit(due, creditApplied) {
  return Math.round(Math.max(0, (Number(due) || 0) - (Number(creditApplied) || 0)) * 100) / 100
}

/**
 * Walk-in and retail customers have no account credit facility —
 * payment (or full account-credit cover) is required at sale.
 */
export function customerRequiresImmediatePayment(customer) {
  if (!customer?.id) return true
  const type = String(
    customer.customer_type || customer.customerType || customer.type || 'retail',
  ).trim().toLowerCase()
  return type === 'retail' || type === ''
}

/** Human label for invoice settlement (tender ± account credit). */
export function formatSettlementLabel({ paymentMode, storeCreditApplied, payments } = {}) {
  let credit = Number(storeCreditApplied) || 0
  let tenderMode = paymentMode
  if (Array.isArray(payments) && payments.length) {
    credit = 0
    const tenders = []
    for (const p of payments) {
      if (p.voided) continue
      const mode = String(p.paymentMode || p.payment_mode || '').toLowerCase()
      const amt = Number(p.totalAmount ?? p.total_amount ?? 0)
      if (mode === 'credit' || mode === 'adjustment') credit += amt
      else if (mode) tenders.push(mode)
    }
    if (tenders.length) tenderMode = tenders[tenders.length - 1]
    else if (credit > 0) tenderMode = null
  }

  const modeLabel = ({
    cash: 'Cash',
    card: 'Card',
    upi: 'UPI',
    bank_transfer: 'Bank Transfer',
    credit: 'Account credit',
    adjustment: 'Outstanding',
  })[String(tenderMode || '').toLowerCase()] || (tenderMode ? String(tenderMode) : null)

  if (credit > 0 && modeLabel && !['credit', 'adjustment'].includes(String(tenderMode).toLowerCase())) {
    return `Account credit + ${modeLabel}`
  }
  if (credit > 0 && !modeLabel) return 'Account credit'
  return modeLabel || '—'
}

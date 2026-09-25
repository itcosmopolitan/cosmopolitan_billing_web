import { formatAmountInput, roundAmount } from '@/utils/decimalPrecision'

/** Always inclusive — pricing-mode preference removed. */
export function normalizeTaxPricingMode(_mode) {
  return 'inclusive'
}

export function exclusiveFromInclusive(inclusive, taxRate) {
  const amount = Number(inclusive) || 0
  const rate = Number(taxRate) || 0
  if (amount <= 0) return 0
  if (rate <= 0) return roundAmount(amount)
  return roundAmount((amount * 100) / (100 + rate))
}

export function inclusiveFromExclusive(exclusive, taxRate) {
  const amount = Number(exclusive) || 0
  const rate = Number(taxRate) || 0
  if (amount <= 0) return 0
  if (rate <= 0) return roundAmount(amount)
  return roundAmount(amount * (1 + rate / 100))
}

/** Split an entered unit price into excl. GST / GST / incl. GST. */
export function priceTaxBreakdown(entered, mode, taxRate) {
  const n = Math.max(0, Number(entered) || 0)
  const inclusive = mode === 'exclusive'
    ? inclusiveFromExclusive(n, taxRate)
    : roundAmount(n)
  const exclusive = exclusiveFromInclusive(inclusive, taxRate)
  return {
    exclusive,
    tax: roundAmount(inclusive - exclusive),
    inclusive,
  }
}

/** Catalog amounts are always stored GST-inclusive. */
export function catalogInclusiveAmount(entered, mode, taxRate) {
  if (entered === '' || entered == null) return null
  const n = Number(entered)
  if (!Number.isFinite(n)) return null
  return priceTaxBreakdown(n, mode === 'exclusive' ? 'exclusive' : 'inclusive', taxRate).inclusive
}

/** Re-express a stored GST-inclusive catalog amount in another entry mode (for display). */
export function convertEnteredTaxAmount(value, fromMode, toMode, taxRate) {
  if (value === '' || value == null) return value
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return value
  const from = fromMode === 'exclusive' ? 'exclusive' : 'inclusive'
  const to = toMode === 'exclusive' ? 'exclusive' : 'inclusive'
  if (from === to) return value
  const { inclusive } = priceTaxBreakdown(n, from, taxRate)
  if (to === 'inclusive') return formatAmountInput(inclusive)
  return formatAmountInput(exclusiveFromInclusive(inclusive, taxRate))
}

/** Tax amount extracted from one GST-inclusive discounted line total. */
export function lineTaxAmount(lineTotal, taxRate, _mode) {
  const amount = Number(lineTotal) || 0
  const rate = Number(taxRate) || 0
  if (amount <= 0 || rate <= 0) return 0
  return roundAmount(amount * rate / (100 + rate))
}

/** Split a document-level discount across inclusive line amounts. */
export function allocateFlatShares(amounts, flat) {
  const values = (amounts || []).map((a) => Math.max(0, Number(a) || 0))
  const n = values.length
  if (n === 0) return []
  const total = roundAmount(values.reduce((s, a) => s + a, 0))
  let disc = roundAmount(Math.max(0, Number(flat) || 0))
  if (disc <= 0 || total <= 0) return values.map(() => 0)
  disc = Math.min(disc, total)
  const shares = values.map(() => 0)
  let lastIdx = 0
  values.forEach((amount, i) => {
    if (amount > 0) lastIdx = i
  })
  let allocated = 0
  values.forEach((amount, i) => {
    if (i === lastIdx || amount <= 0) return
    const share = Math.min(amount, roundAmount((amount / total) * disc))
    shares[i] = share
    allocated += share
  })
  const remainder = roundAmount(disc - allocated)
  shares[lastIdx] = Math.min(values[lastIdx], Math.max(0, remainder))
  return shares
}

/**
 * Cart totals for POS checkout display and sale completion.
 * Line totals already include line-item discount. Bill discount is applied
 * next; GST is extracted from the remaining inclusive amount.
 * @param {Array<{ lineTotal: number, taxRate: number }>} cart
 */
export function calcCartTotals(cart, { discountPct = 0, discountAmt = 0 } = {}) {
  const lineTotals = (cart || []).map((item) => Number(item.lineTotal) || 0)
  const rates = (cart || []).map((item) => Number(item.taxRate) || 0)
  const grossSubtotal = roundAmount(lineTotals.reduce((s, n) => s + n, 0))

  const discount = roundAmount(
    (Number(discountAmt) || 0) + grossSubtotal * ((Number(discountPct) || 0) / 100),
  )
  const shares = allocateFlatShares(lineTotals, discount)

  let taxTotal = 0
  let netSubtotal = 0
  lineTotals.forEach((lineTotal, i) => {
    const after = roundAmount(Math.max(0, lineTotal - (shares[i] || 0)))
    const tax = lineTaxAmount(after, rates[i])
    taxTotal += tax
    netSubtotal += roundAmount(after - tax)
  })

  return {
    mode: 'inclusive',
    netSubtotal: roundAmount(netSubtotal),
    grossSubtotal,
    taxTotal: roundAmount(taxTotal),
    discount,
    total: Math.max(0, roundAmount(grossSubtotal - discount)),
  }
}

/**
 * Invoice summary math for printed tax invoices.
 * Gross amount is the raw pre-discount calculation based on qty × price.
 * Discount is the amount stripped from that gross before GST is added back.
 */
export function calcInvoiceSummary(items = [], sale = {}) {
  const grossAmount = roundAmount(
    (items || []).reduce((sum, item) => {
      const qty = Number(item?.qty ?? item?.quantity ?? 0)
      const price = Number(item?.price ?? item?.rate ?? 0)
      return sum + (qty * price)
    }, 0),
  )

  const lineNetAmount = roundAmount(
    (items || []).reduce((sum, item) => {
      const qty = Number(item?.qty ?? item?.quantity ?? 0)
      const price = Number(item?.price ?? item?.rate ?? 0)
      const lineTotal = Number(item?.lineTotal ?? item?.total ?? qty * price)
      return sum + lineTotal
    }, 0),
  )
  const headerDiscount = roundAmount(Number(sale?.discount ?? sale?.discount_amount ?? sale?.discount_amt ?? 0))
  const subtotal = roundAmount(Number(sale?.subtotal ?? sale?.netSubtotal ?? grossAmount))
  const taxTotal = roundAmount(Number(sale?.taxTotal ?? sale?.tax_total ?? 0))
  const total = roundAmount(Number(sale?.total ?? subtotal + taxTotal))
  const discountAmount = roundAmount(Math.max(0, grossAmount - lineNetAmount) + headerDiscount)

  return {
    grossAmount,
    subtotal,
    taxTotal,
    discountAmount,
    total,
  }
}

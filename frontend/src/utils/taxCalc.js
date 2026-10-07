import {
  formatAmountInput,
  getAmountDecimals,
  MAX_DECIMAL_PRECISION,
  roundAmount,
  roundToPrecision,
} from '@/utils/decimalPrecision'

/** Always inclusive — pricing-mode preference removed. */
export function normalizeTaxPricingMode(_mode) {
  return 'inclusive'
}

/**
 * @param {number} inclusive
 * @param {number} taxRate
 * @param {number} [decimals] — defaults to org amount precision; pass
 *   MAX_DECIMAL_PRECISION for POS rate entry so multi-decimal rates survive.
 */
export function exclusiveFromInclusive(inclusive, taxRate, decimals) {
  const amount = Number(inclusive) || 0
  const rate = Number(taxRate) || 0
  const d = decimals ?? getAmountDecimals()
  if (amount <= 0) return 0
  if (rate <= 0) return roundToPrecision(amount, d)
  return roundToPrecision((amount * 100) / (100 + rate), d)
}

export function inclusiveFromExclusive(exclusive, taxRate, decimals) {
  const amount = Number(exclusive) || 0
  const rate = Number(taxRate) || 0
  const d = decimals ?? getAmountDecimals()
  if (amount <= 0) return 0
  if (rate <= 0) return roundToPrecision(amount, d)
  return roundToPrecision(amount * (1 + rate / 100), d)
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

/** Taxable (excl. GST) portion of a GST-inclusive discounted line total. */
export function lineTaxableAmount(lineTotal, taxRate, _mode) {
  const amount = Number(lineTotal) || 0
  return roundAmount(amount - lineTaxAmount(amount, taxRate))
}

/** GST-inclusive line total after line discount (before document discount). */
export function lineInclusiveAfterDiscount(item) {
  const qty = Number(item?.qty ?? item?.quantity ?? 0)
  const unit = Number(item?.price ?? item?.rate ?? 0)
  const gross = roundAmount(qty * unit)
  const discountPct = Number(
    item?.discount ?? item?.discPercent ?? item?.disc_percent ?? item?.discount_pct ?? 0,
  )
  const fromDisc = roundAmount(gross * (1 - Math.min(100, Math.max(0, discountPct)) / 100))
  if (discountPct > 0) return fromDisc
  const stored = Number(item?.lineTotal ?? item?.total ?? 0)
  if (stored > 0) return roundAmount(stored)
  return fromDisc
}

/**
 * Line GST for invoice/receipt rows.
 * When Disc% is present, recompute inclusive from qty×rate so a wrongly
 * re-inflated stored lineTotal (270→291.60) cannot overstate GST.
 */
export function lineGstFromInclusive(item, entityDiscountShare = 0) {
  const inclusive = roundAmount(Math.max(0, lineInclusiveAfterDiscount(item) - (Number(entityDiscountShare) || 0)))
  const taxRate = Number(item?.taxRate ?? item?.tax_rate ?? 0)
  return lineTaxAmount(inclusive, taxRate)
}

/** Taxable (excl. GST) line amount after line + document discount. */
export function lineTaxableFromInclusive(item, entityDiscountShare = 0) {
  const inclusive = roundAmount(Math.max(0, lineInclusiveAfterDiscount(item) - (Number(entityDiscountShare) || 0)))
  const taxRate = Number(item?.taxRate ?? item?.tax_rate ?? 0)
  return lineTaxableAmount(inclusive, taxRate)
}

/** Unit rate shown to cashiers — always excl. GST (stored prices remain inclusive). */
export function displayExclusiveUnitRate(inclusiveUnitPrice, taxRate, decimals) {
  return exclusiveFromInclusive(inclusiveUnitPrice, taxRate, decimals)
}

/** Convert a cashier-entered excl. GST unit rate back to stored inclusive. */
export function storeInclusiveUnitRate(exclusiveUnitPrice, taxRate, decimals) {
  return inclusiveFromExclusive(exclusiveUnitPrice, taxRate, decimals)
}

/** POS rate/qty entry precision — wider than org display rounding. */
export const POS_ENTRY_DECIMALS = MAX_DECIMAL_PRECISION

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
 * next; GST is then extracted from the remaining inclusive amount.
 * @param {Array<{ qty?: number, price?: number, lineTotal: number, taxRate: number }>} cart
 */
export function calcCartTotals(cart, { discountPct = 0, discountAmt = 0 } = {}) {
  const rows = cart || []
  const lineTotals = rows.map((item) => Number(item.lineTotal) || 0)
  const rates = rows.map((item) => Number(item.taxRate) || 0)
  const grossSubtotal = roundAmount(lineTotals.reduce((s, n) => s + n, 0))
  const exclGross = roundAmount(rows.reduce((sum, item) => {
    const qty = Number(item.qty) || 0
    const price = Number(item.price) || 0
    const taxRate = Number(item.taxRate) || 0
    return sum + qty * exclusiveFromInclusive(price, taxRate)
  }, 0))

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

  const taxable = roundAmount(netSubtotal)
  return {
    mode: 'inclusive',
    netSubtotal: taxable,
    grossSubtotal,
    exclGross,
    taxTotal: roundAmount(taxTotal),
    // Bill-level only — used for API `discount` field.
    discount,
    // Line + bill discount in excl. GST terms (Rate×Qty − Taxable).
    discountAmount: roundAmount(Math.max(0, exclGross - taxable)),
    total: Math.max(0, roundAmount(grossSubtotal - discount)),
  }
}

/**
 * Invoice summary math for printed tax invoices.
 *
 * Saved line `lineTotal` is GST-inclusive AFTER line + document discounts.
 * GST must be extracted from that discounted base (never from pre-discount qty×rate).
 * Taxable + GST = Total Payable.
 */
export function calcInvoiceSummary(items = [], sale = {}) {
  const rows = items || []
  if (rows.length === 0) {
    const subtotal = roundAmount(Number(sale?.subtotal ?? sale?.netSubtotal ?? 0))
    const saleTax = roundAmount(Number(sale?.taxTotal ?? sale?.tax_total ?? 0))
    const total = roundAmount(Number(sale?.total ?? subtotal + saleTax))
    return {
      grossAmount: 0,
      subtotal,
      taxTotal: saleTax,
      discountAmount: roundAmount(Number(sale?.discount ?? 0)),
      total,
    }
  }

  const grossAmount = roundAmount(
    rows.reduce((sum, item) => {
      const qty = Number(item?.qty ?? item?.quantity ?? 0)
      const price = Number(item?.price ?? item?.rate ?? 0)
      return sum + (qty * price)
    }, 0),
  )

  // Excl. GST gross (before discount) — matches Rate × Qty shown on templates.
  const exclGrossAmount = roundAmount(
    rows.reduce((sum, item) => {
      const qty = Number(item?.qty ?? item?.quantity ?? 0)
      const price = Number(item?.price ?? item?.rate ?? 0)
      const taxRate = Number(item?.taxRate ?? item?.tax_rate ?? 0)
      return sum + qty * exclusiveFromInclusive(price, taxRate)
    }, 0),
  )

  const hasStoredLineTotals = rows.some((item) => Number(item?.lineTotal ?? item?.total ?? 0) > 0)
  const headerDiscount = roundAmount(Number(sale?.discount ?? sale?.discount_amount ?? sale?.discount_amt ?? 0))

  const afterLineDiscount = rows.map((item) => lineInclusiveAfterDiscount(item))
  const rates = rows.map((item) => Number(item?.taxRate ?? item?.tax_rate ?? 0))

  // Saved invoices already bake document discount into lineTotal — do not subtract again.
  // Live/partial payloads without lineTotal still need header discount applied.
  // When any line has Disc%, line totals were recomputed from rate (pre-entity),
  // so still apply header discount if present.
  const anyLineDisc = rows.some((item) => Number(
    item?.discount ?? item?.discPercent ?? item?.disc_percent ?? item?.discount_pct ?? 0,
  ) > 0)
  const entityShares = allocateFlatShares(
    afterLineDiscount,
    (hasStoredLineTotals && !anyLineDisc) ? 0 : headerDiscount,
  )

  let taxTotal = 0
  let taxable = 0
  let payable = 0
  const lineDetails = afterLineDiscount.map((lineInclusive, i) => {
    const after = roundAmount(Math.max(0, lineInclusive - (entityShares[i] || 0)))
    const tax = lineTaxAmount(after, rates[i])
    const lineTaxable = roundAmount(after - tax)
    taxTotal += tax
    taxable += lineTaxable
    payable += after
    return { inclusive: after, gst: tax, taxable: lineTaxable }
  })

  const taxableRounded = roundAmount(taxable)
  return {
    grossAmount,
    exclGrossAmount,
    subtotal: taxableRounded,
    taxTotal: roundAmount(taxTotal),
    // Discount in excl. GST terms so it matches Rate×Qty − Net Amt on the template.
    discountAmount: roundAmount(Math.max(0, exclGrossAmount - taxableRounded)),
    total: roundAmount(payable),
    entityShares,
    lineDetails,
  }
}

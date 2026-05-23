const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** @param {'inclusive'|'exclusive'|string} mode */
export function normalizeTaxPricingMode(mode) {
  return mode === 'exclusive' ? 'exclusive' : 'inclusive'
}

/** Tax amount for one discounted line total. */
export function lineTaxAmount(lineTotal, taxRate, mode) {
  const amount = Number(lineTotal) || 0
  const rate = Number(taxRate) || 0
  if (amount <= 0 || rate <= 0) return 0
  if (normalizeTaxPricingMode(mode) === 'inclusive') {
    return round2(amount * rate / (100 + rate))
  }
  return round2(amount * rate / 100)
}

/**
 * Cart totals for POS checkout display and sale completion.
 * @param {Array<{ lineTotal: number, taxRate: number }>} cart
 */
export function calcCartTotals(cart, { discountPct = 0, discountAmt = 0, taxPricingMode = 'inclusive' } = {}) {
  const mode = normalizeTaxPricingMode(taxPricingMode)
  let taxTotal = 0
  let netSubtotal = 0
  let grossSubtotal = 0

  for (const item of cart) {
    const lineTotal = Number(item.lineTotal) || 0
    const rate = Number(item.taxRate) || 0
    grossSubtotal += lineTotal
    const tax = lineTaxAmount(lineTotal, rate, mode)
    taxTotal += tax
    netSubtotal += mode === 'inclusive' ? round2(lineTotal - tax) : lineTotal
  }

  grossSubtotal = round2(grossSubtotal)
  taxTotal = round2(taxTotal)
  netSubtotal = round2(netSubtotal)

  const discountBase = mode === 'inclusive' ? grossSubtotal : netSubtotal
  const discount = round2((Number(discountAmt) || 0) + discountBase * ((Number(discountPct) || 0) / 100))

  const total = mode === 'inclusive'
    ? round2(grossSubtotal - discount)
    : round2(netSubtotal + taxTotal - discount)

  return {
    mode,
    netSubtotal,
    grossSubtotal,
    taxTotal,
    discount,
    total,
  }
}

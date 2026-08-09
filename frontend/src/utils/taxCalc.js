const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/** Always inclusive — pricing-mode preference removed. */
export function normalizeTaxPricingMode(_mode) {
  return 'inclusive'
}

/** Tax amount extracted from one GST-inclusive discounted line total. */
export function lineTaxAmount(lineTotal, taxRate, _mode) {
  const amount = Number(lineTotal) || 0
  const rate = Number(taxRate) || 0
  if (amount <= 0 || rate <= 0) return 0
  return round2(amount * rate / (100 + rate))
}

/**
 * Cart totals for POS checkout display and sale completion.
 * Prices are tax-inclusive; total = gross − discount.
 * @param {Array<{ lineTotal: number, taxRate: number }>} cart
 */
export function calcCartTotals(cart, { discountPct = 0, discountAmt = 0 } = {}) {
  let taxTotal = 0
  let netSubtotal = 0
  let grossSubtotal = 0

  for (const item of cart) {
    const lineTotal = Number(item.lineTotal) || 0
    const rate = Number(item.taxRate) || 0
    grossSubtotal += lineTotal
    const tax = lineTaxAmount(lineTotal, rate)
    taxTotal += tax
    netSubtotal += round2(lineTotal - tax)
  }

  grossSubtotal = round2(grossSubtotal)
  taxTotal = round2(taxTotal)
  netSubtotal = round2(netSubtotal)

  const discount = round2(
    (Number(discountAmt) || 0) + grossSubtotal * ((Number(discountPct) || 0) / 100),
  )

  return {
    mode: 'inclusive',
    netSubtotal,
    grossSubtotal,
    taxTotal,
    discount,
    total: Math.max(0, round2(grossSubtotal - discount)),
  }
}

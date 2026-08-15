/** Line / document margin from tax-inclusive sell amounts and unit cost. */
import { computeDocumentTotals, lineDiscountAmount, lineNetAmount } from '@/utils/documentFormTotals'
import { allocateFlatShares } from '@/utils/taxCalc'
import { roundAmount } from '@/utils/decimalPrecision'

/**
 * @returns {{ amount: number, pct: number } | null}
 */
export function marginFromRevenueAndCost(revenue, cost) {
  const rev = Number(revenue) || 0
  const c = Number(cost) || 0
  if (rev <= 0) return null
  const amount = roundAmount(rev - c)
  return { amount, pct: (amount / rev) * 100 }
}

/**
 * Line margin after line discount (and optional share of document discount).
 * @param {object} it — sale line with qty, price/costPrice, lineDiscount*
 * @param {object} [opts]
 * @param {number} [opts.entityDiscountShare] — flat MVR of document discount allocated to this line
 * @param {(it: object) => number} [opts.lineGross]
 */
export function lineMargin(it, opts = {}) {
  const qty = Number(it.qty || 0)
  const costPrice = Number(it.costPrice ?? it.cost_price ?? 0)
  if (!Number.isFinite(costPrice)) return null

  const grossFn = opts.lineGross || ((row) => Number(row.qty || 0) * Number(row.price || 0))
  let revenue = lineNetAmount(it, grossFn)
  const share = Math.max(0, Number(opts.entityDiscountShare) || 0)
  if (share > 0) revenue = roundAmount(Math.max(0, revenue - share))

  const cost = roundAmount(qty * costPrice)
  return marginFromRevenueAndCost(revenue, cost)
}

/**
 * POS cart line: `lineTotal` is already after line discount.
 */
export function posLineMargin(item, entityDiscountShare = 0) {
  const qty = Number(item.qty || 0)
  const costPrice = Number(item.costPrice ?? item.cost_price ?? 0)
  let revenue = Number(item.lineTotal || 0)
  if (entityDiscountShare > 0) revenue = roundAmount(Math.max(0, revenue - entityDiscountShare))
  const cost = roundAmount(qty * costPrice)
  return marginFromRevenueAndCost(revenue, cost)
}

/** Proportional document-discount shares per line (by line net). */
export function entityDiscountShares(items, entityDiscFlat, lineGross) {
  const grossFn = lineGross || ((row) => Number(row.qty || 0) * Number(row.price || 0))
  const nets = (items || []).map((it) => {
    const g = grossFn(it)
    return Math.max(0, g - lineDiscountAmount(it, g))
  })
  const sum = nets.reduce((s, n) => s + n, 0)
  const disc = Math.max(0, Number(entityDiscFlat) || 0)
  if (disc <= 0 || sum <= 0) return nets.map(() => 0)
  return allocateFlatShares(nets, disc)
}

/**
 * Document-level margin after all discounts.
 * @returns {{ amount: number, pct: number, cost: number, revenue: number } | null}
 */
export function documentMargin(items, opts = {}) {
  const totals = computeDocumentTotals(items, opts)
  const revenue = totals.total
  const cost = roundAmount((items || []).reduce((s, it) => {
    const qty = Number(it.qty || 0)
    const unit = Number(it.costPrice ?? it.cost_price ?? 0)
    return s + qty * unit
  }, 0))
  const m = marginFromRevenueAndCost(revenue, cost)
  if (!m) return null
  return { ...m, cost, revenue }
}

/**
 * POS cart document margin (lineTotals + cart discount).
 */
export function posDocumentMargin(cart, { discountPct = 0, discountAmt = 0 } = {}) {
  const gross = roundAmount((cart || []).reduce((s, i) => s + (Number(i.lineTotal) || 0), 0))
  const disc = roundAmount(
    (Number(discountAmt) || 0) + gross * ((Number(discountPct) || 0) / 100),
  )
  const revenue = Math.max(0, roundAmount(gross - disc))
  const cost = roundAmount((cart || []).reduce((s, i) => {
    return s + (Number(i.qty) || 0) * (Number(i.costPrice ?? i.cost_price) || 0)
  }, 0))
  const m = marginFromRevenueAndCost(revenue, cost)
  if (!m) return null
  return { ...m, cost, revenue, discount: disc, gross }
}

export function posEntityDiscountShares(cart, discountFlat) {
  const nets = (cart || []).map((i) => Number(i.lineTotal) || 0)
  const sum = nets.reduce((s, n) => s + n, 0)
  const disc = Math.max(0, Number(discountFlat) || 0)
  if (disc <= 0 || sum <= 0) return nets.map(() => 0)
  return allocateFlatShares(nets, disc)
}

const costLineGross = (it) => Number(it.qty || 0) * Number(it.cost || 0)

/**
 * Purchase line: margin vs catalog selling price after cost discounts.
 * revenue = qty × sellingPrice; cost = discounted purchase line net − entity share.
 */
export function purchaseLineMargin(it, opts = {}) {
  const qty = Number(it.qty || 0)
  const sell = Number(it.sellingPrice ?? it.selling_price ?? 0)
  if (sell <= 0 || qty <= 0) return null
  const revenue = roundAmount(qty * sell)
  let cost = lineNetAmount(it, costLineGross)
  const share = Math.max(0, Number(opts.entityDiscountShare) || 0)
  if (share > 0) cost = roundAmount(Math.max(0, cost - share))
  return marginFromRevenueAndCost(revenue, cost)
}

/** Document margin for purchase forms (sell list vs landed cost after discounts). */
export function purchaseDocumentMargin(items, opts = {}) {
  const totals = computeDocumentTotals(items, {
    ...opts,
    lineGross: opts.lineGross || costLineGross,
  })
  const cost = totals.total
  const revenue = roundAmount((items || []).reduce((s, it) => {
    return s + (Number(it.qty) || 0) * (Number(it.sellingPrice ?? it.selling_price) || 0)
  }, 0))
  const m = marginFromRevenueAndCost(revenue, cost)
  if (!m) return null
  return { ...m, cost, revenue }
}

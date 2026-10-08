/** Line + document-level discount rollup for sales/purchase forms (POS parity). */
import { allocateFlatShares, lineTaxAmount, exclusiveFromInclusive, inclusiveFromExclusive } from '@/utils/taxCalc'
import {
  ENTRY_DECIMALS,
  formatAmountFieldValue,
  formatQtyFieldValue,
  getAmountDecimals,
  hasExtraAmountPrecision,
  roundAmount,
  roundQty,
  roundToPrecision,
} from '@/utils/decimalPrecision'

/** Qty × unit price, rounded at line level (settings amount precision). */
export function saleLineGross(it) {
  return roundAmount((Number(it?.qty || 0) * Number(it?.price || 0)))
}

/** Qty × unit cost, rounded at line level (settings amount precision). */
export function purchaseLineGross(it) {
  return roundAmount((Number(it?.qty || 0) * Number(it?.cost || 0)))
}

export function lineDiscountAmount(it, gross) {
  const raw = Math.max(0, Number(it.lineDiscount || 0))
  if (it.lineDiscountType === 'MVR') return roundAmount(Math.min(gross, raw))
  return roundAmount(Math.min(gross, gross * (Math.min(raw, 100) / 100)))
}

/** Qty × unit − line discount (before document-level discount / tax display). */
export function lineNetAmount(it, lineGross) {
  const grossFn = lineGross || saleLineGross
  const gross = grossFn(it)
  return roundAmount(Math.max(0, gross - lineDiscountAmount(it, gross)))
}

/** GST on the discounted inclusive line (optional entity share already removed). */
export function lineTaxDisplay(it, lineGross, entityDiscountShare = 0) {
  const after = roundAmount(Math.max(0, lineNetAmount(it, lineGross) - (Number(entityDiscountShare) || 0)))
  return lineTaxAmount(after, Number(it.taxRate || 0))
}

/** Taxable (excl. GST) line amount after line + optional document discount share. */
export function lineTaxableDisplay(it, lineGross, entityDiscountShare = 0) {
  const after = roundAmount(Math.max(0, lineNetAmount(it, lineGross) - (Number(entityDiscountShare) || 0)))
  return roundAmount(after - lineTaxAmount(after, Number(it.taxRate || 0)))
}

/**
 * Unit rate shown excl. GST.
 * Loaded/settings-level inclusive → settings amount decimals; multi-decimal
 * draft inclusive → entry decimals (so typed digits stay visible).
 */
export function displayExclRate(inclusiveUnit, taxRate, decimals) {
  if (decimals != null) return exclusiveFromInclusive(inclusiveUnit, taxRate, decimals)
  const entryExcl = exclusiveFromInclusive(inclusiveUnit, taxRate, ENTRY_DECIMALS)
  if (hasExtraAmountPrecision(Number(inclusiveUnit)) || hasExtraAmountPrecision(entryExcl)) {
    return entryExcl
  }
  return exclusiveFromInclusive(inclusiveUnit, taxRate, getAmountDecimals())
}

/** Controlled qty input value for document forms. */
export function qtyInputValue(qty) {
  return formatQtyFieldValue(qty)
}

/** Controlled excl-rate input value for document forms. */
export function exclRateInputValue(inclusiveUnit, taxRate) {
  return formatAmountFieldValue(displayExclRate(inclusiveUnit, taxRate))
}

/**
 * Persist excl. GST entry as inclusive unit price (entry precision in UI).
 * Use roundSaleLineForApi / roundPurchaseLineForApi before saving to the DB.
 */
export function inclusiveRateFromExclInput(exclusiveUnit, taxRate, decimals) {
  const d = decimals ?? ENTRY_DECIMALS
  const excl = Math.max(0, roundToPrecision(Number(exclusiveUnit) || 0, d))
  return inclusiveFromExclusive(excl, taxRate, d)
}

/** Blur/focus-out: keep multi-decimal qty in form state. */
export function commitSaleQty(raw, fallback = 0) {
  const v = Number(raw)
  if (!Number.isFinite(v)) return roundToPrecision(Number(fallback) || 0, ENTRY_DECIMALS)
  return roundToPrecision(Math.max(0, v), ENTRY_DECIMALS)
}

/** Blur/focus-out: keep multi-decimal excl. rate → inclusive at entry precision. */
export function commitSaleExclRate(raw, taxRate, fallbackExclusive = 0) {
  const v = Number(raw)
  const excl = Number.isFinite(v) && v >= 0 ? v : fallbackExclusive
  return inclusiveRateFromExclInput(excl, taxRate, ENTRY_DECIMALS)
}

/** Round sale line qty/price to org settings for API persistence. */
export function roundSaleLineForApi(item) {
  return {
    qty: roundQty(Number(item?.qty) || 0),
    price: roundAmount(Number(item?.price) || 0),
  }
}

/** Round purchase line qty/cost to org settings for API persistence. */
export function roundPurchaseLineForApi(item) {
  return {
    qty: roundQty(Number(item?.qty) || 0),
    cost: roundAmount(Number(item?.cost) || 0),
  }
}

export function hasLineLevelDiscount(items) {
  return (items || []).some((it) => Number(it.lineDiscount || 0) > 0)
}

export function hasEntityLevelDiscount(discount) {
  return Number(discount || 0) > 0
}

/**
 * Totals for document forms. Line prices are always tax-inclusive.
 * @param {Array} items
 * @param {object} opts
 * @param {number} opts.entityDiscount
 * @param {'%'|'MVR'} opts.entityDiscountType
 * @param {(it: object) => number} opts.lineGross
 * @param {boolean} opts.enforceExclusive — when true, line vs entity are mutually exclusive (POS default)
 */
export function computeDocumentTotals(items, {
  entityDiscount = 0,
  entityDiscountType = '%',
  lineGross,
  enforceExclusive = true,
} = {}) {
  const grossFn = lineGross || saleLineGross
  const rows = items || []

  let gross = 0
  let lineDiscount = 0
  const lineNets = []
  const rates = []

  for (const it of rows) {
    const g = roundAmount(grossFn(it))
    const disc = lineDiscountAmount(it, g)
    const lineNet = roundAmount(Math.max(0, g - disc))
    gross += g
    lineDiscount += disc
    lineNets.push(lineNet)
    rates.push(Number(it.taxRate || 0))
  }

  gross = roundAmount(gross)
  lineDiscount = roundAmount(lineDiscount)
  const lineNetTotal = roundAmount(lineNets.reduce((s, n) => s + n, 0))

  const lineMode = lineDiscount > 0
  const entityMode = hasEntityLevelDiscount(entityDiscount)
  const useLine = enforceExclusive ? lineMode : lineMode
  const useEntity = enforceExclusive ? (entityMode && !lineMode) : entityMode

  let entityDiscFlat = 0
  if (useEntity) {
    const raw = Math.max(0, Number(entityDiscount) || 0)
    if (entityDiscountType === 'MVR') {
      entityDiscFlat = raw
    } else {
      entityDiscFlat = roundAmount(lineNetTotal * (Math.min(raw, 100) / 100))
    }
  }
  entityDiscFlat = roundAmount(entityDiscFlat)

  const shares = allocateFlatShares(lineNets, entityDiscFlat)
  let taxTotal = 0
  let netSubtotal = 0
  lineNets.forEach((lineNet, i) => {
    const after = roundAmount(Math.max(0, lineNet - (shares[i] || 0)))
    const tax = lineTaxAmount(after, rates[i])
    taxTotal += tax
    netSubtotal += roundAmount(after - tax)
  })

  return {
    gross,
    lineDiscount,
    lineNetTotal,
    netSubtotal: roundAmount(netSubtotal),
    taxTotal: roundAmount(taxTotal),
    entityDiscount: entityDiscFlat,
    total: Math.max(0, roundAmount(lineNetTotal - entityDiscFlat)),
    discountMode: useLine ? 'line' : (useEntity ? 'entity' : 'none'),
    taxMode: 'inclusive',
  }
}

/** Flat MVR amount for backend `discount` field. */
export function entityDiscountToPayload(items, discount, discountType, opts = {}) {
  const totals = computeDocumentTotals(items, {
    ...opts,
    entityDiscount: discount,
    entityDiscountType: discountType,
    enforceExclusive: true,
  })
  if (totals.discountMode === 'line') return 0
  return totals.entityDiscount
}

export const totalsRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  padding: '3px 0',
  fontSize: 13,
}
export const totalsLabelStyle = { color: 'var(--text-muted)' }
export const totalsValueStyle = { color: 'var(--text-primary)' }

export const discountToggleStyle = {
  display: 'inline-flex',
  border: '1px solid var(--border-default)',
  borderRadius: 7,
  overflow: 'hidden',
  flexShrink: 0,
}

export function discountToggleBtnStyle(active, disabled) {
  return {
    border: 'none',
    borderRight: active ? undefined : '1px solid var(--border-default)',
    background: active ? 'var(--accent-bg)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-muted)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    padding: '4px 7px',
    fontWeight: 600,
    opacity: disabled ? 0.6 : 1,
  }
}

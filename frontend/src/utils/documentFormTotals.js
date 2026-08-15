/** Line + document-level discount rollup for sales/purchase forms (POS parity). */
import { allocateFlatShares, lineTaxAmount } from '@/utils/taxCalc'
import { roundAmount } from '@/utils/decimalPrecision'

export function lineDiscountAmount(it, gross) {
  const raw = Math.max(0, Number(it.lineDiscount || 0))
  if (it.lineDiscountType === 'MVR') return Math.min(gross, raw)
  return Math.min(gross, gross * (Math.min(raw, 100) / 100))
}

/** Qty × unit − line discount (before document-level discount / tax display). */
export function lineNetAmount(it, lineGross) {
  const grossFn = lineGross || ((row) => Number(row.qty || 0) * Number(row.price || 0))
  const gross = grossFn(it)
  return roundAmount(Math.max(0, gross - lineDiscountAmount(it, gross)))
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
  const grossFn = lineGross || ((it) => Number(it.qty || 0) * Number(it.price || 0))
  const rows = items || []

  let gross = 0
  let lineDiscount = 0
  const lineNets = []
  const rates = []

  for (const it of rows) {
    const g = grossFn(it)
    const disc = lineDiscountAmount(it, g)
    const lineNet = Math.max(0, g - disc)
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

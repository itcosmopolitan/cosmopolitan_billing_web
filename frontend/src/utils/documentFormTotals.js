/** Line + document-level discount rollup for sales/purchase forms (POS parity). */
import { lineTaxAmount, normalizeTaxPricingMode } from '@/utils/taxCalc'

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

export function lineDiscountAmount(it, gross) {
  const raw = Math.max(0, Number(it.lineDiscount || 0))
    if (it.lineDiscountType === 'MVR') return Math.min(gross, raw)
  return Math.min(gross, gross * (Math.min(raw, 100) / 100))
}

export function hasLineLevelDiscount(items) {
  return (items || []).some((it) => Number(it.lineDiscount || 0) > 0)
}

export function hasEntityLevelDiscount(discount) {
  return Number(discount || 0) > 0
}

/**
 * @param {Array} items
 * @param {object} opts
 * @param {number} opts.entityDiscount
 * @param {'%'|'MVR'} opts.entityDiscountType
 * @param {(it: object) => number} opts.lineGross
 * @param {'inclusive'|'exclusive'} opts.taxPricingMode
 * @param {boolean} opts.enforceExclusive — when true, line vs entity are mutually exclusive (POS default)
 */
export function computeDocumentTotals(items, {
  entityDiscount = 0,
  entityDiscountType = '%',
  lineGross,
  taxPricingMode = 'inclusive',
  enforceExclusive = true,
} = {}) {
  const grossFn = lineGross || ((it) => Number(it.qty || 0) * Number(it.price || 0))
  const mode = normalizeTaxPricingMode(taxPricingMode)

  let gross = 0
  let lineDiscount = 0
  let lineNetTotal = 0
  let taxTotal = 0
  let netSubtotal = 0

  for (const it of items || []) {
    const g = grossFn(it)
    const disc = lineDiscountAmount(it, g)
    const lineNet = Math.max(0, g - disc)
    const rate = Number(it.taxRate || 0)
    const tax = lineTaxAmount(lineNet, rate, mode)

    gross += g
    lineDiscount += disc
    lineNetTotal += lineNet
    taxTotal += tax
    netSubtotal += mode === 'inclusive' ? round2(lineNet - tax) : lineNet
  }

  gross = round2(gross)
  lineDiscount = round2(lineDiscount)
  lineNetTotal = round2(lineNetTotal)
  taxTotal = round2(taxTotal)
  netSubtotal = round2(netSubtotal)

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
      const base = mode === 'inclusive' ? lineNetTotal : netSubtotal
      entityDiscFlat = round2(base * (Math.min(raw, 100) / 100))
    }
  }

  const total = mode === 'inclusive'
    ? round2(lineNetTotal - entityDiscFlat)
    : round2(netSubtotal + taxTotal - entityDiscFlat)

  return {
    gross,
    lineDiscount,
    lineNetTotal,
    netSubtotal,
    taxTotal,
    entityDiscount: round2(entityDiscFlat),
    total: Math.max(0, total),
    discountMode: useLine ? 'line' : (useEntity ? 'entity' : 'none'),
    taxMode: mode,
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

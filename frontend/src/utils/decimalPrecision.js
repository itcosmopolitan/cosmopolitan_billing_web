/** Org-level display precision for amounts and quantities. Default is 2. */

export const DEFAULT_AMOUNT_DECIMALS = 2
export const DEFAULT_QTY_DECIMALS = 2
export const MIN_DECIMAL_PRECISION = 0
export const MAX_DECIMAL_PRECISION = 6

let _amountDecimals = DEFAULT_AMOUNT_DECIMALS
let _qtyDecimals = DEFAULT_QTY_DECIMALS

export function clampPrecision(value, fallback = DEFAULT_AMOUNT_DECIMALS) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_DECIMAL_PRECISION, Math.max(MIN_DECIMAL_PRECISION, Math.round(n)))
}

export function parsePrecisionPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { amountDecimalPrecision: DEFAULT_AMOUNT_DECIMALS, quantityDecimalPrecision: DEFAULT_QTY_DECIMALS }
  }
  const amount = payload.amountDecimalPrecision ?? payload.amount_decimal_precision
  const qty = payload.quantityDecimalPrecision ?? payload.quantity_decimal_precision
  return {
    amountDecimalPrecision: clampPrecision(amount, DEFAULT_AMOUNT_DECIMALS),
    quantityDecimalPrecision: clampPrecision(qty, DEFAULT_QTY_DECIMALS),
  }
}

export function setDecimalPrecision({ amountDecimalPrecision, quantityDecimalPrecision } = {}) {
  if (amountDecimalPrecision != null) {
    _amountDecimals = clampPrecision(amountDecimalPrecision, DEFAULT_AMOUNT_DECIMALS)
  }
  if (quantityDecimalPrecision != null) {
    _qtyDecimals = clampPrecision(quantityDecimalPrecision, DEFAULT_QTY_DECIMALS)
  }
}

export function getAmountDecimals() {
  return _amountDecimals
}

export function getQtyDecimals() {
  return _qtyDecimals
}

export function roundToPrecision(n, decimals) {
  const d = clampPrecision(decimals, 0)
  const f = 10 ** d
  return Math.round((Number(n) + Number.EPSILON) * f) / f
}

export function roundAmount(n) {
  return roundToPrecision(n, getAmountDecimals())
}

export function roundQty(n) {
  return roundToPrecision(n, getQtyDecimals())
}

export function inputStep(decimals) {
  const d = clampPrecision(decimals, 0)
  if (d === 0) return '1'
  return (1 / 10 ** d).toFixed(d)
}

export function amountInputStep() {
  return inputStep(getAmountDecimals())
}

export function qtyInputStep() {
  return inputStep(getQtyDecimals())
}

export function formatAmountInput(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return ''
  return roundAmount(value).toFixed(getAmountDecimals())
}

export function formatQtyNumber(n, decimals) {
  if (n === null || n === undefined || n === '') return '—'
  const value = Number(n)
  if (!Number.isFinite(value)) return '—'
  const d = decimals ?? getQtyDecimals()
  return value.toLocaleString('en-MV', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

export function formatAmountNumber(n, decimals) {
  if (n === null || n === undefined || n === '') return '—'
  const value = Number(n)
  if (!Number.isFinite(value)) return '—'
  const d = decimals ?? getAmountDecimals()
  return value.toLocaleString('en-MV', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

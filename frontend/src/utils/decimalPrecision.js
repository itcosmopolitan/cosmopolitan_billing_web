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

/**
 * Qty/rate entry precision for POS and document forms.
 * Inputs accept up to this many fraction digits; line/totals still use
 * roundAmount / roundQty from org settings.
 */
export const ENTRY_DECIMALS = MAX_DECIMAL_PRECISION

export function entryInputStep() {
  return inputStep(ENTRY_DECIMALS)
}

export function roundEntry(n) {
  return roundToPrecision(n, ENTRY_DECIMALS)
}

/** Blur: round qty to org settings precision. */
export function commitQtyInput(raw, { min = 0, fallback = 0 } = {}) {
  const v = Number(raw)
  if (!Number.isFinite(v)) return roundQty(fallback)
  return roundQty(Math.max(min, v))
}

/** Blur: round amount to org settings precision. */
export function commitAmountInput(raw, { min = 0, fallback = 0 } = {}) {
  const v = Number(raw)
  if (!Number.isFinite(v)) return roundAmount(fallback)
  return roundAmount(Math.max(min, v))
}

/** Fraction digits implied by an input `step` (e.g. "0.01" → 2, "1" → 0). */
export function fractionDigitsFromStep(step) {
  if (step == null || step === '' || step === 'any') return null
  const s = String(step).trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  if (!s.includes('.')) return 0
  return s.split('.')[1].length
}

/**
 * Keep typed decimal text within `maxFractionDigits` while allowing
 * intermediate states ("", ".", "12.").
 */
export function sanitizeDecimalText(raw, maxFractionDigits) {
  if (raw == null) return ''
  const maxFrac = clampPrecision(maxFractionDigits, 0)
  let s = String(raw)
  if (s === '' || s === '-' || s === '.' || s === '-.') return s

  const neg = s.startsWith('-')
  let body = (neg ? s.slice(1) : s).replace(/[^\d.]/g, '')
  const firstDot = body.indexOf('.')
  if (firstDot !== -1) {
    body = body.slice(0, firstDot + 1) + body.slice(firstDot + 1).replace(/\./g, '')
  }

  const [intPart, frac] = body.split('.')
  if (frac == null) return (neg ? '-' : '') + intPart
  if (maxFrac <= 0) return (neg ? '-' : '') + intPart
  return (neg ? '-' : '') + intPart + '.' + frac.slice(0, maxFrac)
}

export function sanitizeAmountText(raw) {
  return sanitizeDecimalText(raw, getAmountDecimals())
}

export function sanitizeQtyText(raw) {
  return sanitizeDecimalText(raw, getQtyDecimals())
}

export function formatAmountInput(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return ''
  return roundAmount(value).toFixed(getAmountDecimals())
}

export function formatQtyInput(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return ''
  return roundQty(value).toFixed(getQtyDecimals())
}

/** True when value carries more fraction digits than org qty settings. */
export function hasExtraQtyPrecision(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return false
  return roundEntry(value) !== roundQty(value)
}

/** True when value carries more fraction digits than org amount settings. */
export function hasExtraAmountPrecision(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return false
  return roundEntry(value) !== roundAmount(value)
}

/**
 * Qty input display value — settings precision, no trailing-zero padding.
 * While focused the user can type any decimals; on blur `commitSaleQty`
 * rounds to settings, and this renders the result.
 */
export function formatQtyFieldValue(n) {
  if (n == null || n === '') return ''
  if (typeof n === 'string') return n
  const value = Number(n)
  if (!Number.isFinite(value)) return ''
  return String(roundQty(value))
}

/**
 * Rate/amount input display value — settings precision, no trailing-zero padding.
 * While focused the user can type any decimals; on blur the value is
 * settings-rounded, and this renders the result.
 */
export function formatAmountFieldValue(n) {
  if (n == null || n === '') return ''
  if (typeof n === 'string') return n
  const value = Number(n)
  if (!Number.isFinite(value)) return ''
  return String(roundAmount(value))
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

/**
 * App-wide: block wheel-changing focused number inputs, and clamp typed
 * fraction digits to the field's `step` (which should come from
 * amountInputStep / qtyInputStep tied to org settings).
 */
export function installNumberInputGuards() {
  if (typeof document === 'undefined') return
  if (document.documentElement.dataset.numberInputGuards === '1') return
  document.documentElement.dataset.numberInputGuards = '1'

  document.addEventListener(
    'wheel',
    (e) => {
      const el = e.target
      if (!(el instanceof HTMLInputElement)) return
      if (el.type !== 'number') return
      if (document.activeElement !== el) return
      e.preventDefault()
    },
    { passive: false },
  )

  document.addEventListener(
    'input',
    (e) => {
      const el = e.target
      if (!(el instanceof HTMLInputElement)) return
      if (el.type !== 'number') return
      if (el.readOnly || el.disabled) return
      const maxFrac = fractionDigitsFromStep(el.getAttribute('step'))
      if (maxFrac == null) return
      const next = sanitizeDecimalText(el.value, maxFrac)
      if (next === el.value) return
      const start = el.selectionStart
      el.value = next
      if (typeof start === 'number') {
        try {
          const pos = Math.min(start, next.length)
          el.setSelectionRange(pos, pos)
        } catch {
          /* not all input types support selection */
        }
      }
    },
    true,
  )
}

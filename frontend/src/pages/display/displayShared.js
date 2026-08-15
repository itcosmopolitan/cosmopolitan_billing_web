import { useCallback, useState } from 'react'
import { calcCartTotals } from '@/utils/taxCalc'
import { getAmountDecimals, getQtyDecimals } from '@/utils/decimalPrecision'

const DISPLAY_CODE_STORAGE_KEY = 'pos-display-session-code'
const DISPLAY_CODE_LENGTH = 6
/** Exclude ambiguous characters (0/O, 1/I/L). */
const DISPLAY_CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

export const EMPTY_POS_DISPLAY = {
  customer: { name: 'Walk-in', phone: '' },
  branchName: '',
  cashierName: '',
  displayCode: '',
  items: [],
  subtotal: 0,
  tax: 0,
  discount: 0,
  total: 0,
  taxMode: 'inclusive',
}

export function generateDisplayCode(length = DISPLAY_CODE_LENGTH) {
  const buf = new Uint32Array(length)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => DISPLAY_CODE_CHARS[n % DISPLAY_CODE_CHARS.length]).join('')
}

export function normalizeDisplayCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function isValidDisplayCode(code) {
  const normalized = normalizeDisplayCode(code)
  return normalized.length >= 4 && normalized.length <= 12
}

function readStoredDisplayCode() {
  try {
    const stored = sessionStorage.getItem(DISPLAY_CODE_STORAGE_KEY)
    const normalized = normalizeDisplayCode(stored)
    return isValidDisplayCode(normalized) ? normalized : null
  } catch {
    return null
  }
}

function persistDisplayCode(code) {
  try {
    sessionStorage.setItem(DISPLAY_CODE_STORAGE_KEY, code)
  } catch {
    /* ignore */
  }
}

export function getOrCreateDisplayCode() {
  const existing = readStoredDisplayCode()
  if (existing) return existing
  const code = generateDisplayCode()
  persistDisplayCode(code)
  return code
}

export function regenerateDisplayCode() {
  const code = generateDisplayCode()
  persistDisplayCode(code)
  return code
}

/** One display code per browser tab — each POS login/device gets its own room. */
export function usePosDisplaySession() {
  const [displayCode, setDisplayCode] = useState(() => getOrCreateDisplayCode())

  const regenerate = useCallback(() => {
    const next = regenerateDisplayCode()
    setDisplayCode(next)
    return next
  }, [])

  return { displayCode, regenerate }
}

/** Map live POS cart state to the WebSocket payload for the customer screen. */
export function buildPosDisplayPayload(
  cart,
  customer,
  {
    discountPct = 0,
    discountAmt = 0,
    branchName = '',
    displayCode = '',
    cashierName = '',
  } = {},
) {
  const items = (cart || []).map((row) => ({
    name: row.name || '',
    qty: Number(row.qty) || 0,
    price: Number(row.price) || 0,
    subtotal: Number(row.lineTotal) || 0,
  }))
  const totals = calcCartTotals(cart || [], { discountPct, discountAmt })

  return {
    customer: {
      name: customer?.name || 'Walk-in',
      phone: customer?.phone || '',
    },
    branchName: branchName || '',
    cashierName: cashierName || '',
    displayCode: normalizeDisplayCode(displayCode),
    items,
    subtotal: totals.netSubtotal,
    tax: totals.taxTotal,
    discount: totals.discount,
    total: totals.total,
    taxMode: totals.mode,
    amountDecimalPrecision: getAmountDecimals(),
    quantityDecimalPrecision: getQtyDecimals(),
  }
}

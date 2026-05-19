/**
 * Batch date validation — shared by Batches modal, purchases, item opening
 * stock, etc.
 *
 * Rules (sellable inventory):
 *   • Mfg date cannot be in the future (product cannot be made tomorrow).
 *   • Received date cannot be in the future.
 *   • Expiry date cannot be in the past when adding/receiving new stock.
 *   • When both mfg and expiry are set, mfg must be strictly before expiry.
 */

export function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * @param {{ mfgDate?: string, expiryDate?: string, receivedDate?: string }} fields
 * @param {{ requireExpiry?: boolean, allowPastExpiry?: boolean }} opts
 *   allowPastExpiry — set when editing a batch without changing its expiry
 *   (already-expired lots can still have mfg / notes updated).
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBatchDates(fields, opts = {}) {
  const { requireExpiry = false, allowPastExpiry = false } = opts
  const mfg = (fields.mfgDate || fields.mfg_date || '').trim()
  const exp = (fields.expiryDate || fields.expiry_date || '').trim()
  const recv = (fields.receivedDate || fields.received_date || '').trim()
  const today = todayISO()
  const errors = []

  if (mfg && mfg > today) {
    errors.push('Manufacturing date cannot be in the future')
  }
  if (recv && recv > today) {
    errors.push('Received date cannot be in the future')
  }
  if (requireExpiry && !exp) {
    errors.push('Expiry date is required for this item')
  }
  if (exp && !allowPastExpiry && exp < today) {
    errors.push('Expiry date cannot be in the past for new or updated stock')
  }
  if (mfg && exp && mfg >= exp) {
    errors.push('Manufacturing date must be before the expiry date')
  }

  return { ok: errors.length === 0, errors }
}

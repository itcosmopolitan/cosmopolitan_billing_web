import { parseISO } from 'date-fns'

const MS_PER_DAY = 1000 * 60 * 60 * 24

/** Default: warn when ≤25% of the batch's own shelf life remains. */
export const DEFAULT_SHELF_WARN_PCT = 0.25

function parseDay(d) {
  if (!d) return null
  try {
    const dt = typeof d === 'string' ? parseISO(d) : d
    if (Number.isNaN(dt.getTime())) return null
    return dt
  } catch {
    return null
  }
}

function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY)
}

/**
 * Item-aware batch expiry assessment. Avoids a global "≤30 days = near expiry"
 * rule — milk with 2 days left on a 7-day shelf is fine; biscuits with 2 days
 * on a 180-day shelf are not.
 *
 * When mfg (or received) and expiry are both known, we compare remaining shelf
 * life as a percentage of total shelf life. Below `warnPctRemaining` (default
 * 25%) → near expiry. Otherwise we show neutral "Nd left" — no "Healthy" chip
 * that implies a long shelf is still safe.
 *
 * @param {object} batch — { expiryDate, mfgDate, receivedDate, quantity }
 * @param {{ warnPctRemaining?: number }} opts
 * @returns {{
 *   expired: boolean,
 *   drained: boolean,
 *   nearExpiry: boolean,
 *   daysLeft: number|null,
 *   pctRemaining: number|null,
 *   status: string|null,
 *   statusLabel: string,
 *   dateColor: string,
 *   showUrgentIcon: boolean,
 *   title: string,
 * }}
 */
export function batchExpiryStatus(batch, opts = {}) {
  const warnPct = opts.warnPctRemaining ?? DEFAULT_SHELF_WARN_PCT
  const qty = Number(batch?.quantity ?? batch?.qty)
  const drained = Number.isFinite(qty) && qty <= 0

  const exp = parseDay(batch?.expiryDate || batch?.expiry_date)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (drained) {
    return {
      expired: false,
      drained: true,
      nearExpiry: false,
      daysLeft: exp ? daysBetween(today, exp) : null,
      pctRemaining: null,
      status: 'out',
      statusLabel: 'Drained',
      dateColor: 'var(--text-muted)',
      showUrgentIcon: false,
      title: 'Batch fully consumed',
    }
  }

  if (!exp) {
    return {
      expired: false,
      drained: false,
      nearExpiry: false,
      daysLeft: null,
      pctRemaining: null,
      status: null,
      statusLabel: '—',
      dateColor: 'var(--text-muted)',
      showUrgentIcon: false,
      title: 'No expiry date on this batch',
    }
  }

  const expDay = new Date(exp)
  expDay.setHours(0, 0, 0, 0)
  const daysLeft = daysBetween(today, expDay)
  const expired = daysLeft < 0

  if (expired) {
    return {
      expired: true,
      drained: false,
      nearExpiry: false,
      daysLeft,
      pctRemaining: 0,
      status: 'out',
      statusLabel: 'Expired',
      dateColor: 'var(--red)',
      showUrgentIcon: true,
      title: `Expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago`,
    }
  }

  const start = parseDay(batch?.mfgDate || batch?.mfg_date)
    || parseDay(batch?.receivedDate || batch?.received_date)
  const totalShelf = start ? daysBetween(start, expDay) : null

  let pctRemaining = null
  let nearExpiry = false
  let status = 'active'
  let statusLabel = `${daysLeft}d left`
  let title = `${daysLeft} day${daysLeft === 1 ? '' : 's'} until expiry`

  if (totalShelf != null && totalShelf > 0) {
    pctRemaining = daysLeft / totalShelf
    nearExpiry = pctRemaining <= warnPct
    const pctStr = Math.round(pctRemaining * 100)
    if (nearExpiry) {
      status = 'low'
      statusLabel = 'Use soon'
      title = `${daysLeft}d left (${pctStr}% of shelf life) — use or discount soon`
    } else {
      statusLabel = `${daysLeft}d left`
      title = `${daysLeft}d left (${pctStr}% of shelf life remaining)`
    }
  }

  return {
    expired: false,
    drained: false,
    nearExpiry,
    daysLeft,
    pctRemaining,
    status,
    statusLabel,
    dateColor: nearExpiry ? 'var(--amber)' : 'var(--text-muted)',
    showUrgentIcon: nearExpiry,
    title,
  }
}

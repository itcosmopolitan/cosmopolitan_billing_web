import { roundAmount } from '@/utils/decimalPrecision'
import { fmt } from '@/utils/helpers'

export function parseCashCollected(value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Split collected cash against the amount due. */
export function cashTenderSummary(collectedValue, due) {
  const dueAmt = Math.max(0, Number(due) || 0)
  const collected = parseCashCollected(collectedValue)
  if (collected == null) {
    return { collected: null, change: 0, short: 0, ready: false }
  }
  return {
    collected,
    change: roundAmount(Math.max(0, collected - dueAmt)),
    short: roundAmount(Math.max(0, dueAmt - collected)),
    ready: collected + 0.0005 >= dueAmt,
  }
}

export function cashTenderError(collectedValue, due) {
  const { collected, short, ready } = cashTenderSummary(collectedValue, due)
  if (collected == null) return 'Enter the amount collected from the customer'
  if (!ready) return `Amount collected is short by ${fmt(short)}`
  return null
}

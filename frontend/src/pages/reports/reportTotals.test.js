import { describe, expect, it } from 'vitest'
import { sumCurrencyValues } from './reportTotals'

describe('sumCurrencyValues', () => {
  it('sums amounts at display precision rather than carrying float residue', () => {
    expect(sumCurrencyValues([
      { amount: 0.1 + 0.2 },
      { amount: 0.3 },
    ], 'amount', 2)).toBe(0.6)
  })

  it('preserves signed values and configured precision', () => {
    expect(sumCurrencyValues([
      { amount: 12.345 },
      { amount: -2.345 },
      { amount: null },
    ], 'amount', 2)).toBe(10)
    expect(sumCurrencyValues([{ amount: 1.23456 }], 'amount', 3)).toBe(1.235)
  })

  it('returns null when no numeric values are present', () => {
    expect(sumCurrencyValues([{ amount: null }, { amount: 'invalid' }], 'amount', 2)).toBeNull()
  })
})

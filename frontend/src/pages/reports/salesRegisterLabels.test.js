import { describe, expect, it } from 'vitest'
import { salesRegisterColumnLabel } from './salesRegisterLabels'

describe('salesRegisterColumnLabel', () => {
  it('labels header-total amounts as GST-inclusive', () => {
    expect(salesRegisterColumnLabel({ key: 'net_amount' })).toBe('Net Amount (Incl. GST)')
    expect(salesRegisterColumnLabel({ key: 'paid_amount' })).toBe('Payment Paid (Incl. GST)')
    expect(salesRegisterColumnLabel({ key: 'remaining_amount' })).toBe('Balance Due (Incl. GST)')
  })

  it('leaves other column labels to their report definitions', () => {
    expect(salesRegisterColumnLabel({ key: 'taxable_amount' })).toBeNull()
    expect(salesRegisterColumnLabel({ key: 'tax_amount' })).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'

import { calcInvoiceSummary } from './taxCalc'

describe('calcInvoiceSummary', () => {
  it('derives gross and discount from raw qty × price and net-before-tax subtotal', () => {
    const items = [
      { qty: 2, price: 100, lineTotal: 175 },
      { qty: 3, price: 50, lineTotal: 125 },
    ]

    const sale = {
      subtotal: 300,
      taxTotal: 25,
      total: 325,
    }

    expect(calcInvoiceSummary(items, sale)).toMatchObject({
      grossAmount: 350,
      subtotal: 300,
      taxTotal: 25,
      discountAmount: 50,
      total: 325,
    })
  })

  it('treats inclusive line discounts as before-tax discounts', () => {
    const result = calcInvoiceSummary(
      [{ qty: 13, price: 12.73, lineTotal: 155.56, taxRate: 8 }],
      { subtotal: 144.04, taxTotal: 11.52, total: 155.56 },
    )

    expect(result.grossAmount).toBe(165.49)
    expect(result.discountAmount).toBe(9.93)
    expect(result.taxTotal).toBe(11.52)
    expect(result.total).toBe(155.56)
  })
})

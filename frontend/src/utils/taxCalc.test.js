import { describe, it, expect } from 'vitest'

import { calcInvoiceSummary, lineGstFromInclusive } from './taxCalc'

describe('calcInvoiceSummary', () => {
  it('derives gross and discount from raw qty × price and net inclusive line totals', () => {
    const items = [
      { qty: 2, price: 100, lineTotal: 175, taxRate: 0 },
      { qty: 3, price: 50, lineTotal: 125, taxRate: 0 },
    ]

    expect(calcInvoiceSummary(items, { subtotal: 999, taxTotal: 999, total: 999 })).toMatchObject({
      grossAmount: 350,
      subtotal: 300,
      taxTotal: 0,
      discountAmount: 50,
      total: 300,
    })
  })

  it('extracts GST from the discounted inclusive line total (not pre-discount)', () => {
    // Rate 300 incl. 8% GST, 10% line discount → taxable 250, GST 20, payable 270
    const result = calcInvoiceSummary(
      [{ qty: 1, price: 300, lineTotal: 270, taxRate: 8, discount: 10 }],
      { subtotal: 250, taxTotal: 22.22, total: 272.22 }, // stale tax must be ignored
    )

    expect(result.grossAmount).toBe(300)
    expect(result.discountAmount).toBe(30)
    expect(result.subtotal).toBe(250)
    expect(result.taxTotal).toBe(20)
    expect(result.total).toBe(270)
  })

  it('ignores wrongly re-inflated stored lineTotal (270 → 291.60)', () => {
    // Bug: API inflated inclusive-after-discount 270 as if it were exclusive.
    const result = calcInvoiceSummary(
      [{ qty: 1, price: 300, lineTotal: 291.60, taxRate: 8, discount: 10 }],
      { subtotal: 270, taxTotal: 21.60, total: 291.60 },
    )

    expect(result.subtotal).toBe(250)
    expect(result.taxTotal).toBe(20)
    expect(result.total).toBe(270)
    expect(result.discountAmount).toBe(30)
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
    expect(result.subtotal).toBe(144.04)
  })
})

describe('lineGstFromInclusive', () => {
  it('uses post-discount inclusive amount for GST extract', () => {
    expect(lineGstFromInclusive({
      qty: 1, price: 300, lineTotal: 270, taxRate: 8, discount: 10,
    })).toBe(20)
  })

  it('does not treat inclusive amounts as exclusive', () => {
    // Wrong exclusive formula on 300 would yield 24; extract yields 22.22
    expect(lineGstFromInclusive({
      qty: 1, price: 300, lineTotal: 300, taxRate: 8, discount: 0,
    })).toBe(22.22)
  })

  it('ignores reinflated lineTotal when Disc% is present', () => {
    expect(lineGstFromInclusive({
      qty: 1, price: 300, lineTotal: 291.60, taxRate: 8, discount: 10,
    })).toBe(20)
  })
})

import { describe, it, expect } from 'vitest'

import {
  applyVendorTransferPricingToPurchaseLines,
  isInternalTransferByGstin,
} from './pricingDiscounts.js'

const catalogLine = {
  item_id: 'item-1',
  name: 'Vanilla 4L',
  qty: 2,
  cost: 70,
  branchCost: 45,
  taxRate: 18,
  lineDiscount: 10,
  lineDiscountType: '%',
}

describe('isInternalTransferByGstin', () => {
  it('matches GSTINs ignoring spaces, hyphens and case', () => {
    expect(isInternalTransferByGstin({ gstin: 'ab-123 xy' }, 'AB123XY')).toBe(true)
  })

  it('does not match when either side is empty', () => {
    expect(isInternalTransferByGstin({ gstin: '' }, 'AB123XY')).toBe(false)
    expect(isInternalTransferByGstin({ gstin: 'AB123XY' }, '')).toBe(false)
  })
})

describe('applyVendorTransferPricingToPurchaseLines', () => {
  it('prices catalog lines at branch cost with 0% tax and no discount when internal', () => {
    const [line] = applyVendorTransferPricingToPurchaseLines([catalogLine], true)
    expect(line.cost).toBe(45)
    expect(line.taxRate).toBe(0)
    expect(line.lineDiscount).toBe(0)
    expect(line.lineDiscountType).toBe('%')
  })

  it('restores the original values when the vendor is no longer internal', () => {
    const internal = applyVendorTransferPricingToPurchaseLines([catalogLine], true)
    const [line] = applyVendorTransferPricingToPurchaseLines(internal, false)
    expect(line.cost).toBe(70)
    expect(line.taxRate).toBe(18)
    expect(line.lineDiscount).toBe(10)
    expect(line.lineDiscountType).toBe('%')
    expect(line.catalog).toBeUndefined()
  })

  it('keeps the first snapshot when applied repeatedly', () => {
    const once = applyVendorTransferPricingToPurchaseLines([catalogLine], true)
    const twice = applyVendorTransferPricingToPurchaseLines(once, true)
    expect(twice[0].catalog).toEqual(once[0].catalog)
    expect(twice[0].catalog.cost).toBe(70)
  })

  it('leaves free-text lines and external vendors untouched', () => {
    const freeText = { name: 'Freight', cost: 100, taxRate: 18 }
    const items = [freeText]
    expect(applyVendorTransferPricingToPurchaseLines(items, true)).toEqual(items)
    expect(applyVendorTransferPricingToPurchaseLines(items, false)).toBe(items)
  })

  it('returns the same array when an external vendor has no snapshot to restore', () => {
    const items = [catalogLine]
    expect(applyVendorTransferPricingToPurchaseLines(items, false)).toBe(items)
  })
})

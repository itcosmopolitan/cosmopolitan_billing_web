import { describe, it, expect } from 'vitest'

import {
  applyCustomerPricingToSaleLines,
  applyVendorTransferPricingToPurchaseLines,
  isInternalTransferByGstin,
  linePricingForCustomer,
  resolveSaleLinePricing,
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
  it('sets 0% tax and no discount on catalog lines when internal, keeping the entered cost', () => {
    const [line] = applyVendorTransferPricingToPurchaseLines([catalogLine], true)
    expect(line.cost).toBe(70)
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
    expect(twice[0].catalog.taxRate).toBe(18)
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

describe('sales pricing for same-GSTIN customers', () => {
  const orgGstin = '33AAZCS1429R1Z1'
  const internalCustomer = { gstin: '33aazcs1429r1z1' }
  const externalCustomer = { gstin: '29AAAAA0000A1Z5' }
  const saleItem = { id: 'item-1', selling_price: 100, cost_price: 40, tax_rate: 18 }

  it('picks the retail price with no discount instead of cost', () => {
    const resolved = resolveSaleLinePricing(saleItem, internalCustomer, orgGstin)
    expect(resolved).toMatchObject({ price: 100, discountPct: 0, internalTransfer: true })
  })

  it('keeps the retail price for external customers', () => {
    const resolved = resolveSaleLinePricing(saleItem, externalCustomer, orgGstin)
    expect(resolved).toMatchObject({ price: 100, internalTransfer: false })
  })

  it('keeps the entered price at 0% GST for same-GSTIN customers', () => {
    const priced = linePricingForCustomer(55, 18, internalCustomer, orgGstin)
    expect(priced).toMatchObject({ price: 55, taxRate: 0, internalTransfer: true })
  })

  it('keeps the typed line price and clears discount when the customer is same-GSTIN', () => {
    const line = {
      item_id: 'item-1',
      qty: 1,
      price: 55,
      taxRate: 18,
      catalogTaxRate: 18,
      lineDiscount: 5,
      lineDiscountType: '%',
    }
    const [out] = applyCustomerPricingToSaleLines([line], internalCustomer, orgGstin)
    expect(out).toMatchObject({
      price: 55,
      taxRate: 0,
      lineDiscount: 0,
      lineDiscountValue: 0,
      internalTransfer: true,
    })
  })
})

describe('stale 0% GST on reopened documents', () => {
  const saved = { item_id: 'item-1', name: 'Vanilla', qty: 1, price: 108, taxRate: 0, masterTaxRate: 8 }

  it('restores the item-master rate for a taxable customer', () => {
    const [line] = applyCustomerPricingToSaleLines([saved], { id: 'c1', classification: 'external' }, '33AAZCS1429R1Z1')
    expect(line.taxRate).toBe(8)
  })

  it('keeps 0% for an internal customer', () => {
    const [line] = applyCustomerPricingToSaleLines([saved], { id: 'c2', classification: 'internal' }, '33AAZCS1429R1Z1')
    expect(line.taxRate).toBe(0)
  })

  it('keeps 0% for a same-GSTIN customer', () => {
    const [line] = applyCustomerPricingToSaleLines(
      [saved], { id: 'c3', gstin: '33AAZCS1429R1Z1' }, '33AAZCS1429R1Z1',
    )
    expect(line.taxRate).toBe(0)
  })

  it('keeps 0% for a 0% item', () => {
    const [line] = applyCustomerPricingToSaleLines(
      [{ ...saved, masterTaxRate: 0 }], { id: 'c1', classification: 'external' }, '33AAZCS1429R1Z1',
    )
    expect(line.taxRate).toBe(0)
  })
})

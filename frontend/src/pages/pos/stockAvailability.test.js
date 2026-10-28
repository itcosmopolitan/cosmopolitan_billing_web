import { describe, expect, it } from 'vitest'
import { getPosStockAvailability } from './stockAvailability'

describe('getPosStockAvailability', () => {
  it('subtracts branch reservations from on-hand stock', () => {
    expect(getPosStockAvailability({
      available_stock: 625,
      reserved_stock: 48,
    })).toEqual({
      availableStock: 577,
      branchStock: 577,
      poolStock: 577,
    })
  })

  it('uses pool availability and branch availability in clubbed mode', () => {
    expect(getPosStockAvailability({
      available_stock: 625,
      reserved_stock: 48,
      pool_stock: 1000,
      pool_reserved_stock: 75,
      pool_available_stock: 925,
    }, 'clubbed')).toEqual({
      availableStock: 925,
      branchStock: 577,
      poolStock: 925,
    })
  })

  it('does not expose negative availability', () => {
    expect(getPosStockAvailability({
      available_stock: 4,
      reserved_stock: 7,
    }).availableStock).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { getInvoiceItemMetadata } from './invoiceItemMetadata'

function packingDisplay(item) {
  const value = getInvoiceItemMetadata(item).packaging
  return value === '' ? '—' : value
}

describe('POS packaging metadata', () => {
  it('displays packaging quantity when present', () => {
    expect(packingDisplay({
      is_packaging: true,
      packaging_quantity: 1,
      unit: 'Pcs',
    })).toBe(1)
  })

  it('falls back to Yes when packaging is enabled without quantity', () => {
    expect(packingDisplay({
      is_packaging: true,
      packaging_quantity: null,
    })).toBe('Yes')
  })

  it('displays a dash when packaging is absent', () => {
    expect(packingDisplay({
      is_packaging: false,
      packaging_quantity: null,
      unit: 'Pcs',
    })).toBe('—')
  })
})
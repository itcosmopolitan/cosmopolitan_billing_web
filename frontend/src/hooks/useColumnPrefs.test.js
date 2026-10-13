import { describe, expect, it } from 'vitest'
import { resolvePrefs } from './useColumnPrefs'

describe('resolvePrefs', () => {
  it('inserts newly added columns at their catalog position', () => {
    const defs = [
      { id: 'customer', locked: true },
      { id: 'invoice_count' },
      { id: 'quantity_sold' },
      { id: 'cost_of_sales' },
      { id: 'sales_amount' },
      { id: 'margin_pct' },
      { id: 'paid_amount' },
      { id: 'outstanding_amount' },
    ]
    const stored = {
      order: ['customer', 'invoice_count', 'quantity_sold', 'sales_amount', 'paid_amount', 'outstanding_amount'],
      hidden: [],
    }

    expect(resolvePrefs(defs, stored).order).toEqual([
      'customer',
      'invoice_count',
      'quantity_sold',
      'cost_of_sales',
      'sales_amount',
      'margin_pct',
      'paid_amount',
      'outstanding_amount',
    ])
  })
})

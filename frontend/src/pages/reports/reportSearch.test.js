import { describe, expect, it } from 'vitest'
import { searchReportRows } from './reportSearch'

describe('searchReportRows', () => {
  const rows = [
    { invoice_number: 'INV-100', customer: 'Northwind Stores', product_name: 'Olive Oil' },
    { order_number: 'SO-200', customer: 'Contoso', item_name: 'Rice' },
  ]

  it('searches all report row values without case sensitivity', () => {
    expect(searchReportRows(rows, 'inv-100')).toEqual([rows[0]])
    expect(searchReportRows(rows, 'NORTHWIND')).toEqual([rows[0]])
    expect(searchReportRows(rows, 'rice')).toEqual([rows[1]])
  })

  it('returns all rows for an empty query and no rows for a missing match', () => {
    expect(searchReportRows(rows, '  ')).toBe(rows)
    expect(searchReportRows(rows, 'not-found')).toEqual([])
  })
})
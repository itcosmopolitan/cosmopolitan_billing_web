import { describe, expect, it } from 'vitest'
import {
  PURCHASE_PDF_COLUMNS,
  SALES_PDF_COLUMNS,
  mapListPdfRows,
} from './listExport'

describe('list PDF export mapping', () => {
  it('covers the requested sales and purchase document tabs', () => {
    expect(Object.keys(SALES_PDF_COLUMNS)).toEqual(['invoices', 'orders', 'quotes', 'returns', 'payments'])
    expect(Object.keys(PURCHASE_PDF_COLUMNS)).toEqual(['bills', 'orders', 'grns', 'returns', 'payments'])
  })

  it('formats currency values and preserves empty cells', () => {
    const rows = mapListPdfRows(
      [{ amount: 1200.5, status: '' }],
      (row) => ({ 'Amount (MVR)': row.amount, Status: row.status }),
      ['Amount (MVR)', 'Status'],
    )

    expect(rows).toEqual([['1,200.50', '']])
  })
})

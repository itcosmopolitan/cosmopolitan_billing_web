import { afterEach, describe, expect, it, vi } from 'vitest'
import { billFromRow } from './purchases/purchaseFormShared'
import { invoiceFromRow } from './sales/salesFormShared'

describe('conversion document dates', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses today for a converted sales invoice and keeps saved dates while editing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 6, 12))

    expect(invoiceFromRow({ date: '2026-10-04' }, 'branch-1').invoiceDate).toBe('2026-10-06')
    expect(invoiceFromRow({ date: '2026-10-04' }, 'branch-1', { keepNumber: true }).invoiceDate)
      .toBe('2026-10-04')
  })

  it('uses today for a converted purchase bill and keeps saved dates while editing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 6, 12))

    expect(billFromRow({ date: '2026-10-04' }, 'branch-1').billDate).toBe('2026-10-06')
    expect(billFromRow({ date: '2026-10-04' }, 'branch-1', { keepNumber: true }).billDate)
      .toBe('2026-10-04')
  })
})

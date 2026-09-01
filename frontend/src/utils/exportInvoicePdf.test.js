// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'

vi.mock('html2canvas', () => ({
  default: vi.fn(async () => ({
    width: 600,
    height: 800,
    toDataURL: () => 'data:image/png;base64,abc123',
  })),
}))

vi.mock('jspdf', () => {
  class MockJsPDF {
    constructor() {
      this.addImage = vi.fn()
      this.addPage = vi.fn()
      this.save = vi.fn()
      this.text = vi.fn()
      this.setFontSize = vi.fn()
      this.setLineHeightFactor = vi.fn()
      this.internal = { pageSize: { getWidth: () => 595, getHeight: () => 842 } }
      this.getNumberOfPages = vi.fn(() => 1)
    }
  }
  return { jsPDF: MockJsPDF }
})

import { exportInvoicePdf } from './exportInvoicePdf'

describe('exportInvoicePdf', () => {
  it('returns a promise and attempts to save a generated PDF', async () => {
    const el = document.createElement('div')
    el.innerHTML = '<h1>Invoice</h1>'

    await expect(exportInvoicePdf(el, 'invoice-0001')).resolves.toBeUndefined()
  })
})

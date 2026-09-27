// @vitest-environment jsdom

import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('html2canvas', () => ({
  default: vi.fn(async (target) => {
    pdfState.targets.push(target)
    return {
      width: 794,
      height: 1123,
      toDataURL: () => 'data:image/png;base64,abc123',
    }
  }),
}))

const pdfState = vi.hoisted(() => ({ last: null, targets: [] }))

vi.mock('jspdf', () => {
  class MockJsPDF {
    constructor(options) {
      pdfState.last = this
      this.options = options
      this.addImage = vi.fn()
      this.addPage = vi.fn()
      this.save = vi.fn()
      this.text = vi.fn()
      this.setFontSize = vi.fn()
      this.setLineHeightFactor = vi.fn()
      this.internal = {
        pageSize: {
          getWidth: () => 595,
          getHeight: () => 842,
        },
      }
      this.getNumberOfPages = vi.fn(() => 1)
    }
  }
  return { jsPDF: MockJsPDF }
})

import { exportInvoicePdf } from './exportInvoicePdf'

describe('exportInvoicePdf', () => {
  beforeEach(() => {
    pdfState.targets.length = 0
  })

  it('returns a promise and attempts to save a generated PDF', async () => {
    const el = document.createElement('div')
    el.innerHTML = '<h1>Invoice</h1>'

    await expect(exportInvoicePdf(el, 'invoice-0001')).resolves.toBeUndefined()
  })

  it('reflows complete rows onto A4 pages and keeps footer content on the final page', async () => {
    const el = document.createElement('div')
    el.innerHTML = `
      <div class="page">
        <div class="header">Company header</div>
        <div class="title-row"><div class="pageno">Page 1 of 2</div></div>
        <div class="parties">Customer details</div>
        <table class="items"><thead><tr><th>Product</th></tr></thead><tbody>
          <tr><td>Item A</td></tr><tr><td>Item B</td>
        </tbody></table>
      </div>
      <div class="page continuation-page">
        <table class="items"><thead><tr><th>Product</th></tr></thead><tbody>
          <tr><td>Item C</td></tr>
        </tbody></table>
        <table class="totals"><tr><td>Total</td><td>123.00</td></tr></table>
        <div class="terms">Terms and conditions</div>
      </div>
    `
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
      return this.classList?.contains('invoice-export-page') ? 1123 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      if (!this.classList?.contains('invoice-export-page')) return 0
      const rowCount = this.querySelectorAll('.items tbody tr').length
      const headerHeight = this.querySelector('.header') ? 500 : 200
      const footerHeight = this.querySelector('.totals') ? 300 : 0
      return headerHeight + rowCount * 250 + footerHeight
    })

    await expect(exportInvoicePdf(el, 'invoice-multipage')).resolves.toBeUndefined()
    expect(pdfState.last.options.format).toBe('a4')
    expect(pdfState.last.addImage).toHaveBeenCalledTimes(2)
    expect(pdfState.last.addPage).toHaveBeenCalledTimes(1)
    expect(pdfState.targets.map((page) => page.style.width)).toEqual(['793.7007874015749px', '793.7007874015749px'])
    expect(pdfState.targets.map((page) => Array.from(page.querySelectorAll('.items tbody tr'), (row) => row.textContent.trim()))).toEqual([
      ['Item A', 'Item B'],
      ['Item C'],
    ])
    expect(pdfState.targets[0].querySelector('.totals')).toBeNull()
    expect(pdfState.targets[1].querySelector('.totals')?.textContent).toContain('123.00')
  })
})

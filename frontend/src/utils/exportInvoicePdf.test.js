// @vitest-environment jsdom

import { beforeEach, describe, it, expect, vi } from 'vitest'

import { exportInvoicePdf } from './exportInvoicePdf'

describe('exportInvoicePdf', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    global.URL.createObjectURL = vi.fn(() => 'blob:invoice')
    global.URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    global.fetch = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['pdf'], { type: 'application/pdf' }),
    }))
  })

  it('posts rendered HTML to the server PDF renderer and downloads the result', async () => {
    const el = document.createElement('div')
    el.innerHTML = '<h1>Invoice</h1>'
    document.body.appendChild(el)

    await expect(exportInvoicePdf(el, 'Tax Invoice INV-0001')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith('/api/v1/documents/invoice-pdf', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('<h1>Invoice</h1>'),
    }))
    const payload = JSON.parse(fetch.mock.calls[0][1].body)
    expect(payload.file_name).toBe('Tax_Invoice_INV-0001.pdf')
  })
})

import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'http://localhost'
const invoiceHtml = readFileSync(new URL('../../public/document-templates/invoice.html', import.meta.url), 'utf8')
const quoteHtml = readFileSync(new URL('../../public/document-templates/quotation.html', import.meta.url), 'utf8')

function getStyles(html) {
  return html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ''
}

function loadTemplate(html, path) {
  const dom = new JSDOM(html, { url: `${ORIGIN}${path}`, runScripts: 'outside-only' })
  dom.window.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1])
  return dom.window
}

function postMessage(window, data, origin = ORIGIN) {
  window.dispatchEvent(new window.MessageEvent('message', { data, origin }))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('shared document templates', () => {
  it.each([
    ['invoice', invoiceHtml],
    ['quotation', quoteHtml],
  ])('%s uses only wkhtmltopdf-compatible CSS', (_name, html) => {
    const styles = getStyles(html)
    expect(styles).not.toMatch(/@page/)
    expect(styles).not.toMatch(/display:\s*(inline-)?grid/)
    expect(styles).not.toMatch(/display:\s*(inline-)?flex/)
    expect(styles).not.toMatch(/\bgap\s*:/)
    expect(styles).not.toMatch(/var\(/)
    expect(styles).not.toMatch(/position:\s*fixed/)
  })

  it.each([
    ['invoice', invoiceHtml],
    ['quotation', quoteHtml],
  ])('%s has no fixed pixel widths so it fits A5 and A4', (_name, html) => {
    expect(getStyles(html)).not.toMatch(/width:\s*\d+px/)
  })

  it.each([
    ['invoice', invoiceHtml],
    ['quotation', quoteHtml],
  ])('%s uses the shared font stack and repeats item headers', (_name, html) => {
    const styles = getStyles(html)
    expect(styles).toContain('font-family: "Liberation Sans", Arial, Helvetica, sans-serif;')
    expect(styles).toMatch(/table\.items thead\s*\{\s*display:\s*table-header-group;?\s*\}/)
  })
})

describe('invoice template', () => {
  it('renders a Tax Invoice with the document title and item rows', async () => {
    const window = loadTemplate(invoiceHtml, '/document-templates/invoice.html')
    postMessage(window, {
      type: 'renderInvoice',
      payload: {
        documentType: 'Tax Invoice',
        branch: {},
        sale: {
          id: 'sale-1',
          number: 'INV-0001',
          items: [{ name: 'Rice 25kg premium long grain', qty: 2, unit: 'BAG', rate: 100 }],
        },
      },
    })
    await settle()

    expect(window.document.title).toBe('Tax Invoice INV-0001')
    expect(window.document.getElementById('document').textContent).toContain('Rice 25kg premium long grain')
  })

  it('renders a Stock Transfer in the same document frame', async () => {
    const window = loadTemplate(invoiceHtml, '/document-templates/invoice.html')
    postMessage(window, {
      type: 'renderInvoice',
      payload: {
        documentType: 'Stock Transfer',
        branch: {},
        sale: {
          id: 'transfer-1',
          ref_number: 'TR-0001',
          from_branch_name: 'North Branch',
          to_branch_name: 'South Branch',
          status: 'transit',
          items: [{ name: 'Transfer item', packing: '1x15KG', unit: 'KG', qty: 4 }],
        },
      },
    })
    await settle()

    const output = window.document.getElementById('document')
    expect(window.document.title).toBe('Stock Transfer TR-0001')
    expect(output.querySelector('table.header')).toBeTruthy()
    expect(output.textContent).toContain('North Branch')
    expect(output.textContent).toContain('South Branch')
    expect(output.textContent).toContain('Transfer item')
  })

  it('ignores render messages from other origins', async () => {
    const window = loadTemplate(invoiceHtml, '/document-templates/invoice.html')
    postMessage(window, {
      type: 'renderInvoice',
      payload: { documentType: 'Tax Invoice', sale: { id: 'x', number: 'INV-EVIL', items: [] }, branch: {} },
    }, 'https://evil.example')
    await settle()

    expect(window.document.getElementById('document').textContent).not.toContain('INV-EVIL')
  })
})

describe('quotation template', () => {
  it('renders a quote with the document title and item rows', async () => {
    const window = loadTemplate(quoteHtml, '/document-templates/quotation.html')
    postMessage(window, {
      type: 'renderQuote',
      payload: {
        quote: {
          id: 'quote-1',
          number: 'QT-0001',
          items: [{ name: 'Sugar 1kg', qty: 3, rate: 50 }],
        },
        branch: {},
      },
    })
    await settle()

    expect(window.document.title).toBe('Quote QT-0001')
    expect(window.document.getElementById('document').textContent).toContain('Sugar 1kg')
  })

  it('ignores render messages from other origins', async () => {
    const window = loadTemplate(quoteHtml, '/document-templates/quotation.html')
    postMessage(window, {
      type: 'renderQuote',
      payload: { quote: { id: 'x', number: 'QT-EVIL', items: [] }, branch: {} },
    }, 'https://evil.example')
    await settle()

    expect(window.document.getElementById('document').textContent).not.toContain('QT-EVIL')
  })
})

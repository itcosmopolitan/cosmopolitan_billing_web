import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

const invoiceTemplate = readFileSync(new URL('../../public/invoice-cosmo.html', import.meta.url), 'utf8')
const quoteTemplate = readFileSync(new URL('../../public/quote-cosmo.html', import.meta.url), 'utf8')
const invoiceBankDetails = 'Bank Details : BMLMVR | Account Number : 7730000271249 | Account Name : COSMOPOLITAN CHAMPA BROTHERS PVT LTD | VIBER : 7384977'
const invoiceDisclaimer = 'Disclaimer: Jurisdiction Male, Republic of Maldives, Supplier can not take any responsibility for product lost or spoil in transit after the delivery point. No return accepted, Overdue outstanding will be subjected to 1% interest per overdue day'

function getTemplateStyles(template) {
  return template.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ''
}

function getRuleStyles(styles, selector) {
  const declarations = {}
  const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, ruleSelector, ruleBody] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!ruleSelector.split(',').some((part) => part.trim() === selector)) continue
    for (const declaration of ruleBody.split(';')) {
      const separator = declaration.indexOf(':')
      if (separator === -1) continue
      declarations[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim()
    }
  }
  return declarations
}

function getItemHeaders(template) {
  const header = template.match(/<table class="items">\s*<thead>([\s\S]*?)<\/thead>/)?.[1] || ''
  return Array.from(header.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g), ([, text]) =>
    text.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  )
}

describe('quote print template', () => {
  it('uses the Invoice layout styles for shared print sections', () => {
    const invoiceStyles = getTemplateStyles(invoiceTemplate)
    const quoteStyles = getTemplateStyles(quoteTemplate)
    const sharedSectionProperties = {
      '.page': ['background', 'margin', 'padding', 'position', 'page-break-after', 'page-break-inside'],
      '.header': ['display', 'grid-template-columns', 'align-items', 'padding-bottom', 'gap'],
      '.logo-block': ['display', 'flex-direction', 'gap', 'width'],
      '.logo-img': ['width', 'height', 'display'],
      '.company-info': ['flex', 'width', 'max-width', 'padding-top', 'align-items', 'justify-content', 'text-align'],
      '.company-name': ['color', 'font-weight', 'font-size', 'margin-bottom', 'white-space', 'line-height'],
      '.company-line': ['font-size', 'color', 'line-height', 'white-space', 'overflow-x'],
      '.gold-badge': ['text-align', 'width', 'display', 'justify-content', 'align-items'],
      '.badge-img': ['width', 'height', 'display', 'margin'],
      '.gold-seal': ['width', 'height', 'border-radius', 'border', 'padding', 'margin'],
      '.title-row': ['display', 'justify-content', 'align-items', 'gap', 'margin-top', 'position'],
      '.parties': ['display', 'grid-template-columns', 'gap', 'margin-top', 'align-items'],
      '.bill-to': ['display', 'flex-direction', 'justify-content', 'min-width'],
      '.bill-to table': ['width', 'table-layout'],
      '.bill-to table td.label': ['width'],
      '.bill-to h2': ['font-size', 'margin', 'font-weight', 'letter-spacing', 'line-height'],
      '.seller-addr': ['font-size', 'text-align', 'line-height', 'color', 'display', 'flex-direction', 'justify-content'],
      '.details-box': ['border', 'padding', 'border-radius', 'background'],
      '.details-title': ['font-size', 'font-weight', 'margin-bottom', 'color'],
      'table.items': ['width', 'border-collapse', 'margin-top', 'font-size'],
      'table.items thead tr': ['border-top', 'border-bottom'],
      'table.items th': ['text-align', 'padding', 'font-weight', 'color'],
      'table.items td': ['padding', 'vertical-align'],
      '.totals': ['width', 'margin-top'],
      '.totals td': ['padding', 'font-size'],
      '.payment-section': ['margin-top', 'border-top', 'padding-top', 'font-size'],
      '.bank-details': ['margin-left', 'line-height'],
      '.terms': ['margin-top', 'font-size', 'color', 'line-height'],
      '.thankyou': ['margin-top', 'text-align', 'font-style', 'font-weight', 'font-size'],
      '.signoff': ['display', 'justify-content', 'margin-top', 'font-size', 'font-weight'],
    }

    for (const [selector, properties] of Object.entries(sharedSectionProperties)) {
      const invoiceRule = getRuleStyles(invoiceStyles, selector)
      const quoteRule = getRuleStyles(quoteStyles, selector)
      for (const property of properties) {
        expect(quoteRule[property], `${selector} ${property}`).toBe(invoiceRule[property])
      }
    }
  })

  it('renders Quote as the document heading with Invoice-identical bank details and disclaimer', () => {
    expect(quoteTemplate).toContain("<h1 class='center'>Quote</h1>")
    expect(quoteTemplate).not.toContain('Sales - Quote')
    expect(quoteTemplate).toContain('document.title = `Quote ${quote.number')
    expect(getItemHeaders(quoteTemplate)).toEqual(getItemHeaders(invoiceTemplate))
    expect(quoteTemplate).toContain("formatNumber(quoteLineDiscountPct(line), { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%")
    expect(quoteTemplate).not.toContain("line.discount || line.line_discount || 0).toFixed(2)")
    expect(quoteTemplate).toContain('formatNumber(quoteLineVatAmount(line, pricesIncludingVat))')
    expect(quoteTemplate).not.toContain("line.vatIdentifier || line.vat_identifier || 'GST')}</td>")
    const quotePageRule = getTemplateStyles(quoteTemplate).match(/(^|\n) {2}\.page\s*\{([^}]*)\}/)?.[2] || ''
    expect(quotePageRule).not.toMatch(/\bwidth\s*:/)
    expect(quoteTemplate).toContain('const pages = paginateItems(items, 14)')
    expect(quoteTemplate).toContain('pageIndex * 14 + lineIndex + 1')
    expect(getTemplateStyles(quoteTemplate)).toContain('@page { size: A5; margin: 8mm; }')
    expect(getTemplateStyles(invoiceTemplate)).toContain('@page { size: A5; margin: 8mm; }')
    expect(quoteTemplate).toContain('Quote No.')
    expect(invoiceTemplate).toContain(invoiceBankDetails)
    expect(quoteTemplate).toContain(invoiceBankDetails)
    expect(invoiceTemplate).toContain(invoiceDisclaimer)
    expect(quoteTemplate).toContain(invoiceDisclaimer)
    expect(quoteTemplate).toContain('Thank you for choosing Cosmopolitan as your preferred partner')

    const footerBlock = quoteTemplate.match(/<div class="payment-section">([\s\S]*?)<\/div>\s*<div class="terms">([\s\S]*?)<\/div>/)
    expect(footerBlock).toBeTruthy()
    expect(footerBlock[1]).toContain('<div class="bank-details">')
    expect(footerBlock[1]).not.toContain('payment-row')
    expect(footerBlock[1]).not.toContain('<br')
    expect(footerBlock[2]).not.toContain('<div')
  })

  it('keeps the printable template script syntactically valid', () => {
    const script = quoteTemplate.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Script(script)).not.toThrow()
  })

  it('renders Stock Transfer with the Invoice page structure and title', () => {
    expect(invoiceTemplate).toContain("if (sale.documentType === 'Stock Transfer')")
    expect(invoiceTemplate).toContain('<h1 class="center">Stock Transfer</h1>')
    expect(invoiceTemplate).toContain('<div class="page${pageIndex > 0 ? \' continuation-page\' : \'\'}">')
    expect(invoiceTemplate).toContain('<div class="header">')
    expect(invoiceTemplate).toContain('<div class="parties">')
    expect(invoiceTemplate).toContain('<table class="items">')
    expect(invoiceTemplate).toContain('<th>Packing</th><th>Units</th><th class="num">Qty</th>')
    expect(invoiceTemplate).toContain('transfer.from_branch_name || transfer.from_branch_id')
    expect(invoiceTemplate).toContain('transfer.to_branch_name || transfer.to_branch_id')
  })

  it('renders Stock Transfer output in the shared Invoice document frame', async () => {
    const script = invoiceTemplate.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="invoicePages"></div></body></html>',
      { url: 'http://localhost/invoice-cosmo.html?preview=1', runScripts: 'outside-only' },
    )
    const { window } = dom
    try {
      window.eval(script)
      window.dispatchEvent(new window.MessageEvent('message', {
        data: {
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
        },
      }))
      await new Promise((resolve) => setTimeout(resolve, 20))

      const output = window.document.querySelector('#invoicePages')
      expect(window.document.title).toBe('Stock Transfer TR-0001')
      expect(output.querySelector('.page .header')).toBeTruthy()
      expect(output.querySelector('.page .parties')).toBeTruthy()
      expect(output.querySelector('.page table.items')).toBeTruthy()
      expect(output.querySelector('.title-row h1').textContent).toBe('Stock Transfer')
      expect(output.textContent).toContain('North Branch')
      expect(output.textContent).toContain('South Branch')
      expect(output.textContent).toContain('Transfer item')
      expect(output.textContent).toContain('1x15KG')
      expect(output.textContent).toContain('KG')
      expect(output.textContent).toContain('4')
    } finally {
      window.close()
    }
  })
})

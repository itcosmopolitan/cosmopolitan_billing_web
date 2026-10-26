import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SalesTaxInvoice, { mapSaleToInvoice } from './SalesTaxInvoice'

describe('mapSaleToInvoice customer GST', () => {
  it('uses customer GST and never falls back to generic organization GST', () => {
    const customerInvoice = mapSaleToInvoice({
      customerName: 'Customer Ltd',
      customerGstin: 'CUSTOMER-GST',
      gstNo: 'ORGANIZATION-GST',
      items: [],
    }, {})
    const invoiceWithoutCustomerGst = mapSaleToInvoice({
      customerName: 'Customer Ltd',
      gstNo: 'ORGANIZATION-GST',
      items: [],
    }, {})

    expect(customerInvoice.customerGstin).toBe('CUSTOMER-GST')
    expect(invoiceWithoutCustomerGst.customerGstin).toBe('')
  })
})

describe('SalesTaxInvoice bank details', () => {
  it('prints the branch mobile instead of a Viber number', () => {
    const invoice = mapSaleToInvoice({ number: 'INV-1', items: [] }, {})
    const output = renderToStaticMarkup(createElement(SalesTaxInvoice, {
      invoice,
      branch: { mobile: '738 1234' },
    }))

    expect(output).toContain('MOBILE : 738 1234')
    expect(output).not.toContain('VIBER')
  })
})
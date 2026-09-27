import { describe, expect, it } from 'vitest'
import { mapSaleToInvoice } from './SalesTaxInvoice'

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
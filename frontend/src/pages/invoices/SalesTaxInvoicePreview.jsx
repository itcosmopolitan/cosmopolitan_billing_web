import React from 'react'
import SalesTaxInvoice from '@/components/invoices/SalesTaxInvoice'

const sampleInvoice = {
  copyType: 'CUSTOMER COPY',
  billTo: {
    name: 'Walk-in',
    contactPerson: 'Walk-in Customer',
    addressLines: [],
  },
  billToCustomerNo: '',
  gstNo: '',
  invoiceNo: 'POS-2026-1862',
  postingDate: '30. July 2026',
  phoneNo: '',
  email: '',
  homePage: '',
  gstRegNo: '',
  salesperson: '',
  paymentDueDate: '',
  lineItems: [
    { description: 'Mango Juice', packing: '1L', origin: 'Maldives', units: 'Bottle', qty: 2, rate: 45, gstAmount: 3.6, lineTotal: 93.6 },
    { description: 'Water Bottle', packing: '500ml', origin: 'Maldives', units: 'Bottle', qty: 4, rate: 15, gstAmount: 2.4, lineTotal: 62.4 },
    { description: 'Coffee Beans', packing: '250g', origin: 'Sri Lanka', units: 'Pack', qty: 1, rate: 120, gstAmount: 9.6, lineTotal: 129.6 },
    { description: 'Milk Powder', packing: '400g', origin: 'India', units: 'Pack', qty: 2, rate: 80, gstAmount: 12.8, lineTotal: 172.8 },
  ],
  gstRatePercent: 4,
  totalExclGst: 458.4,
  totalGst: 28.4,
  totalInclGst: 486.8,
  amountInWords: 'FOUR HUNDRED EIGHTY SIX RUFIYAA AND EIGHTY CENTS ONLY',
}

const fullInvoice = {
  copyType: 'COSMOPOLITAN COPY',
  billTo: {
    name: 'Aqua Supplies Pvt Ltd',
    contactPerson: 'Mr. Ahmed',
    addressLines: ['Hulhumale', 'Male', 'Republic of Maldives'],
  },
  billToCustomerNo: 'C-1001',
  gstNo: 'MDV-1001234',
  invoiceNo: 'MDV-0185613',
  orderNo: 'ORD-1024',
  purchaseOrderNo: 'PO-889',
  postingDate: '30. July 2026',
  phoneNo: '+960 3344555',
  email: 'accounts@aquasupplies.mv',
  homePage: 'www.aquasupplies.mv',
  gstRegNo: 'GST-001',
  salesperson: 'Ali Hassan',
  paymentDueDate: '30. August 2026',
  lineItems: Array.from({ length: 22 }, (_, index) => ({
    itemNo: `${index + 1}`,
    description: `Inventory Item ${index + 1}`,
    packing: 'Case',
    origin: 'Maldives',
    units: 'PCS',
    qty: 10 + index,
    rate: 120 + index,
    gstAmount: 10 + index,
    lineTotal: (10 + index) * (120 + index),
  })),
  gstRatePercent: 8,
  totalExclGst: 123456,
  totalGst: 9876,
  totalInclGst: 133332,
  amountInWords: 'ONE HUNDRED THIRTY THREE THOUSAND THREE HUNDRED THIRTY TWO RUFIYAA ONLY',
}

const sampleBranch = {
  company: 'Cosmopolitan Champa Brothers Maldives Pvt Ltd',
  address: 'LOT NO-10627, Haivakaru Magu, Hulhumale\'e, Maldives',
  phone: '+960 331 0477',
  email: 'info@cosmopolitanmv.com',
  homepage: 'www.cosmopolitanmv.com',
  logo: '/assets/cosmopolitan-logo.png',
}

export default function SalesTaxInvoicePreview() {
  return (
    <div style={{ padding: 24, background: '#f4f7fb', minHeight: '100vh' }}>
      <h2 style={{ margin: '0 0 16px', color: '#1b3e6f' }}>Sales Tax Invoice Preview</h2>
      <div style={{ display: 'grid', gap: 24 }}>
        <SalesTaxInvoice invoice={sampleInvoice} branch={sampleBranch} />
        <SalesTaxInvoice invoice={fullInvoice} branch={sampleBranch} />
      </div>
    </div>
  )
}

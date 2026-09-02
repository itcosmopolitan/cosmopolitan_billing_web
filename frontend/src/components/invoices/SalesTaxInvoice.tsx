import React, { useState } from 'react'
import { formatAmountNumber, formatQtyNumber, getAmountDecimals } from '@/utils/decimalPrecision'
import { getInvoiceItemMetadata } from '@/utils/invoiceItemMetadata'
import amountToWords from '@/utils/amountToWords'

export interface InvoiceLineItem {
  itemNo?: string
  sku?: string
  description: string
  packing?: string
  origin?: string
  units?: string
  qty: number
  rate: number
  discountPct?: number
  gstAmount: number
  lineTotal: number
}

export interface Invoice {
  copyType: 'COSMOPOLITAN COPY' | 'CUSTOMER COPY' | null
  billTo: {
    name: string
    contactPerson?: string
    addressLines?: string[]
  }
  billToCustomerNo?: string
  gstNo?: string
  invoiceNo: string
  orderNo?: string
  purchaseOrderNo?: string
  postingDate: string
  phoneNo?: string
  email?: string
  homePage?: string
  gstRegNo?: string
  salesperson?: string
  paymentDueDate?: string
  lineItems: InvoiceLineItem[]
  gstRatePercent: number
  totalExclGst: number
  totalGst: number
  totalInclGst: number
  amountInWords: string
  discountAmount?: number
  discountPct?: number
}

const LOGO_SRC = '/assets/cosmopolitan-logo.png'
const COMPANY_NAME = 'Cosmopolitan Champa Brothers Maldives Pvt Ltd'
const TAGLINE = 'where quality and service matters'
const HEADER_CONTACT_LINE = 'Tel : +960 3350000 | E-mail : info@cosmopolitanmv.com | www.cosmopolitanmv.com'
const BANK_DETAILS = [
  { label: 'A/C NAME', value: 'COSMOPOLITAN CHAMPA BROTHERS MALDIVES PVT LTD' },
  { label: 'Bank Account No', value: '001-001-0001234' },
  { label: 'Bank Name', value: 'Bank of Maldives' },
  { label: 'Bank Address', value: 'Male', },
  { label: 'Swift Code', value: 'BMLMDVMV' },
]
const LEGAL_TERMS = [
  'Goods once sold will not be taken back or exchanged.',
  'Please make payment within the stated terms to avoid any inconvenience.',
  'All disputes related to this invoice shall be subject to Maldives jurisdiction.',
  'Any delay in payment may attract the applicable late charges.',
  'This invoice is issued for the stated goods and amounts only.',
  'Kindly retain a copy for your records and future reference.',
]

function parseNumber(value: number | string | undefined | null, fallback = 0) {
  const number = Number(value ?? fallback)
  return Number.isNaN(number) ? fallback : number
}

export function mapSaleToInvoice(sale: any, branch: any): Invoice {
  const customerName = `${sale?.customerName || sale?.customer_name || ''}`.trim()
  const isWalkin = !customerName || customerName.toLowerCase() === 'walk-in' || customerName.toLowerCase() === 'walkin'
  const rawItems = Array.isArray(sale?.items) ? sale.items : []
  const lineItems = rawItems.map((item: any) => {
    const qty = parseNumber(item?.qty ?? item?.quantity ?? 0)
    const rate = parseNumber(item?.price ?? item?.rate ?? 0)
    const lineTotal = parseNumber(item?.lineTotal ?? item?.total ?? qty * rate)
    const gstAmount = parseNumber(item?.gstAmount ?? item?.taxAmount ?? item?.tax_amount ?? 0)
    const discountPct = parseNumber(item?.discount ?? item?.discPercent ?? item?.disc_percent ?? item?.discount_pct ?? 0)
    const metadata = getInvoiceItemMetadata(item)
    return {
      itemNo: item?.itemNo || item?.item_no || '',
      sku: item?.sku ?? '',
      description: `${item?.name || item?.description || ''}`,
      packing: metadata.packaging,
      origin: metadata.origin,
      units: metadata.units,
      qty,
      rate,
      discountPct: discountPct || undefined,
      gstAmount: gstAmount || parseNumber((lineTotal * parseNumber(item?.taxRate ?? item?.tax_rate ?? 0)) / 100),
      lineTotal,
    }
  })

  const subtotal = parseNumber(sale?.subtotal ?? lineItems.reduce((sum: number, item: InvoiceLineItem) => sum + item.lineTotal, 0))
  const totalGst = parseNumber(sale?.taxTotal ?? sale?.tax_total ?? 0)
  const totalInclGst = parseNumber(sale?.total ?? subtotal + totalGst)
  const discountAmount = parseNumber(sale?.discount ?? sale?.discount_amount ?? sale?.discount_amt ?? 0)
  const discountBase = totalInclGst + discountAmount
  const discountPct = discountBase && discountAmount ? Math.round((discountAmount / discountBase) * 100) : 0
  const gstRatePercent = parseNumber(sale?.gstRatePercent ?? sale?.tax_rate_percent ?? sale?.taxRate ?? sale?.tax_rate ?? sale?.taxPercent ?? sale?.tax_percent ?? 0)
  const postingDate = `${sale?.date || sale?.invoiceDate || sale?.invoice_date || ''}`.trim()

  const customerAddressLines = [
    sale?.customerStreet1 || sale?.customer_street1,
    sale?.customerStreet2 || sale?.customer_street2,
    sale?.customerStreet3 || sale?.customer_street3,
    sale?.customerCity || sale?.customer_city || sale?.city,
    sale?.customerStateProvince || sale?.customer_state_province,
    sale?.customerCountry || sale?.customer_country || sale?.country,
    sale?.customerPostalCode || sale?.customer_postal_code || sale?.postal_code,
  ].filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim())

  return {
    copyType: null,
    billTo: {
      name: customerName || 'Walk-in',
      contactPerson: sale?.contactPerson || sale?.contact_person || '',
      addressLines: customerAddressLines.length > 0
        ? customerAddressLines
        : sale?.addressLines || sale?.address_lines || (sale?.customerAddress ? [sale.customerAddress] : []) || (sale?.customer_address ? [sale.customer_address] : []),
    },
    billToCustomerNo: sale?.customerCode || sale?.customer_code || '',
    gstNo: sale?.gstNo || sale?.gst_no || '',
    invoiceNo: `${sale?.number || sale?.invoiceNo || sale?.invoice_no || ''}`,
    orderNo: sale?.orderNo || sale?.order_no || '',
    purchaseOrderNo: sale?.purchaseOrderNo || sale?.purchase_order_no || '',
    postingDate: postingDate || '—',
    phoneNo: sale?.phoneNo || sale?.phone_no || branch?.phone || '',
    email: sale?.email || branch?.email || '',
    homePage: sale?.homePage || sale?.homepage || branch?.homepage || branch?.website || '',
    gstRegNo: sale?.gstRegNo || sale?.gst_reg_no || branch?.gst || branch?.gstin || '',
    salesperson: sale?.salesperson || sale?.cashier || sale?.cashierName || sale?.salesperson_name || sale?.salesPerson || '',
    paymentDueDate: sale?.dueDate || sale?.due_date || '',
    lineItems,
    gstRatePercent: gstRatePercent || (subtotal ? Math.round((totalGst / subtotal) * 100) : 0),
    totalExclGst: subtotal,
    totalGst: totalGst,
    totalInclGst,
    discountAmount: discountAmount || undefined,
    discountPct: discountPct || undefined,
    amountInWords: `${sale?.amountInWords || amountToWords(totalInclGst)}`,
  }
}

function formatNumber(value: number | string | undefined | null, digits?: number) {
  if (value === null || value === undefined || value === '') return ''
  const number = Number(value)
  if (Number.isNaN(number)) return ''
  const d = digits ?? getAmountDecimals()
  return number.toLocaleString('en-MV', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

function formatOptionalText(value?: string) {
  return value ?? ''
}

function renderBillToBlock(invoice: Invoice) {
  const hasMeta = Boolean(invoice.billTo.contactPerson || (invoice.billTo.addressLines || []).some(Boolean))
  if (!hasMeta) {
    return <div className="bill-to-line">{invoice.billTo.name}</div>
  }

  return (
    <div className="bill-to-block">
      <div className="bill-to-name">{invoice.billTo.name}</div>
      {invoice.billTo.contactPerson ? <div>{invoice.billTo.contactPerson}</div> : null}
      {(invoice.billTo.addressLines || []).filter(Boolean).map((line, index) => (
        <div key={`${line}-${index}`}>{line}</div>
      ))}
    </div>
  )
}

function SealWithFallback() {
  const [imgLoaded, setImgLoaded] = useState<boolean | null>(null)
  const src = '/assets/gold-100-seal.png'
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <img
        src={src}
        alt="Gold 100 seal"
        className="gold-seal-img"
        onLoad={() => setImgLoaded(true)}
        onError={() => setImgLoaded(false)}
        style={{ display: imgLoaded === false ? 'none' : 'block' }}
      />
      {imgLoaded === false || imgLoaded === null ? (
        <div className="gold-seal" aria-hidden={imgLoaded === false ? 'false' : 'true'}>
          <div className="gold-corporate">Corporate Maldives</div>
          <div className="gold-text">GOLD</div>
          <div className="gold-100">100</div>
          <div className="gold-year">2023</div>
        </div>
      ) : null}
    </div>
  )
}

export default function SalesTaxInvoice({ invoice, branch }: { invoice: Invoice, branch?: any }) {
  const logoSrc = branch?.logo || branch?.logo_url || LOGO_SRC
  const companyName = branch?.company || COMPANY_NAME
  const customerName = invoice.billTo?.name || 'Walk-in'
  const customerNameLower = customerName.trim().toLowerCase()
  const isWalkin = customerNameLower === 'walk-in' || customerNameLower === 'walkin' || customerNameLower === 'walk in' || customerNameLower === 'walkin customer' || customerNameLower === 'cash customer'
  const displayEmail = invoice.email || branch?.email || branch?.emailAddress || branch?.email_address || ''
  const displayHomepage = invoice.homePage || branch?.homePage || branch?.homepage || branch?.website || ''
  const displayGstRegNo = branch?.gstRegNo || branch?.gst || branch?.gstin || ''
  const companyAddressLines: string[] = Array.isArray(branch?.address)
    ? branch.address.filter(Boolean)
    : (branch?.address ? String(branch.address).split(/\n|<br\s*\/?\s*>/i).filter(Boolean) : ['LOT NO-10627, Haivakaru Magu,  T : 960 331 0477  E : info@cosmopolitan.com.mv', "Hulhumale', Republic of Maldives,  F : 960 331 0458  W : www.cosmopolitan.com.mv"])
  const customerAddressLines = (invoice.billTo?.addressLines || []).filter(Boolean)
  const rowsPerPage = 16
  const totalPages = Math.max(1, Math.ceil((invoice.lineItems || []).length / rowsPerPage))
  const pageItems = Array.from({ length: totalPages }, (_, pageIndex) => {
    const start = pageIndex * rowsPerPage
    const end = start + rowsPerPage
    return invoice.lineItems.slice(start, end)
  })

  return (
    <div className="invoice-template-shell">
      <style>{styles}</style>
      {pageItems.map((rows, pageIndex) => {
        const pageNumber = pageIndex + 1
        const isLastPage = pageNumber === totalPages

        return (
          <div className="page" key={`${invoice.invoiceNo}-${pageNumber}`}>
            <div className="header">
              <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                <div className="logo-block">
                  <img className="logo-img" src={logoSrc} alt="Cosmopolitan" />
                  <div className="logo-tag">"where quality and service matters"</div>
                  <div className="fssc">◆ FSSC 22000</div>
                </div>
              </div>

              <div className="company-info">
                <div className="company-name">{companyName}</div>
                <div className="company-line">LOT NO-10627, Haivakaru Magu,  T : 960 331 0477  E : info@cosmopolitan.com.mv</div>
                <div className="company-line">Hulhumale', Republic of Maldives,  F : 960 331 0458  W : www.cosmopolitan.com.mv</div>
              </div>

              <div className="gold-badge">
                <img
                  className="badge-img"
                  src="/assets/gold-100-seal.png"
                  alt="Gold 100 seal"
                  onError={(event) => {
                    const target = event.currentTarget as HTMLImageElement
                    target.style.display = 'none'
                  }}
                />
              </div>
            </div>

            <div className="title-row">
              {invoice.copyType ? <div className="copy-label">{invoice.copyType}</div> : null}
              <h1>Sales Invoice</h1>
              <div className="pageno">Page {pageNumber} of {totalPages}</div>
            </div>

            <div className="parties">
              <div className="bill-to details-box">
                <div className="details-title">Customer Details</div>
                <h2>{customerName}</h2>
                {customerAddressLines.length ? (
                  <div className="addr-line">{customerAddressLines.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}</div>
                ) : null}

                <table style={{ marginTop: 10, width: '100%' }}>
                  {!isWalkin && invoice.billToCustomerNo ? (
                    <tr><td className="label">Bill-to Customer No.</td><td>{invoice.billToCustomerNo}</td></tr>
                  ) : null}
                  {!isWalkin && invoice.gstNo ? (
                    <tr><td className="label">Customer GST IN</td><td>{invoice.gstNo}</td></tr>
                  ) : null}
                  <tr><td className="label">Invoice No.</td><td>{invoice.invoiceNo}</td></tr>
                  <tr><td className="label">Posting Date</td><td>{invoice.postingDate}</td></tr>
                </table>
              </div>

              <div className="seller-addr details-box">
                <div className="details-title">Branch Details</div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{companyName}</div>
                <div style={{ marginBottom: 8 }}>
                  {companyAddressLines.map((line, index) => <div key={`org-${index}`}>{line}</div>)}
                </div>
                <table style={{ width: '100%' }}>
                  <tr><td className="label">Phone No.</td><td>{invoice.phoneNo || branch?.phone || ''}</td></tr>
                  <tr><td className="label">Branch E-Mail</td><td>{displayEmail}</td></tr>
                  <tr><td className="label">Website</td><td>{displayHomepage}</td></tr>
                  <tr><td className="label">GST Reg no</td><td>{displayGstRegNo}</td></tr>
                  <tr><td className="label">Salesperson</td><td>{invoice.salesperson || ''}</td></tr>
                </table>
              </div>
            </div>

            <table className="items">
              <thead>
                <tr>
                  <th>Product ID</th>
                  <th>Description</th>
                  <th>Packing</th>
                  <th>Origin</th>
                  <th>Units</th>
                  <th className="num">Qty</th>
                  <th className="num">Rate</th>
                  <th className="num">Disc %</th>
                  <th className="num">GST</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, rowIndex) => {
                  const qty = Number(item.qty || 0)
                  const rate = Number(item.rate || 0)
                  const discountPct = Number(item.discountPct ?? 0)
                  const gstAmount = Number(item.gstAmount || 0)
                  const amount = Number(item.lineTotal || 0)

                  return (
                    <tr key={`${item.description}-${rowIndex}`}>
                      <td>{item.sku ?? ''}</td>
                      <td>{item.description}</td>
                      <td>{item.packing ?? ''}</td>
                      <td>{item.origin ?? ''}</td>
                      <td>{item.units ?? ''}</td>
                      <td className="num">{formatQtyNumber(qty)}</td>
                      <td className="num">{formatNumber(rate)}</td>
                      <td className="num">{discountPct ? `${formatNumber(discountPct, 2)}%` : ''}</td>
                      <td className="num">{formatNumber(gstAmount)}</td>
                      <td className="num">{formatNumber(amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {isLastPage ? (
              <>
                <table className="totals">
                  <tr>
                    <td colSpan={6}></td>
                    <td className="tlabel">Total MVR Excl. GST</td>
                    <td className="tval">{formatNumber(invoice.totalExclGst)}</td>
                  </tr>
                  {invoice.discountAmount ? (
                    <tr>
                      <td colSpan={6}></td>
                      <td className="tlabel">Discount ({invoice.discountPct ?? 0}%)</td>
                      <td className="tval">-{formatNumber(invoice.discountAmount)}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <td colSpan={6}></td>
                    <td className="tlabel">{invoice.gstRatePercent}% GST</td>
                    <td className="tval">{formatNumber(invoice.totalGst)}</td>
                  </tr>
                  <tr className="grand">
                    <td colSpan={6}></td>
                    <td className="tlabel grand">Total MVR Incl. GST</td>
                    <td className="tval grand">{formatNumber(invoice.totalInclGst)}</td>
                  </tr>
                </table>

                <div className="amount-words">******* {invoice.amountInWords}</div>

                <div className="payment-section">
                  <div className="payment-row">
                    <div className="plabel">Payment Due Date</div>
                    <div className="pcolon">:</div>
                    <div>{invoice.paymentDueDate || ''}</div>
                  </div>
                  <div className="payment-row">
                    <div className="plabel">Terms &amp; Conditions</div>
                    <div className="pcolon">:</div>
                    <div>30DAYS &nbsp; from date of invoice to our account as follows:</div>
                  </div>
                  <div className="bank-details">
                    A/C NAME : Cosmopolitan Champa Brothers Maldives Pvt Ltd<br />
                    Bank Account No : 7730000519444<br />
                    Bank Name : Bank of Maldives<br />
                    Bank Address : Boduthakurufaanu Magu, Malé 20094<br />
                    Swift Code : MALBMVMVXXX
                  </div>
                </div>

                <div className="terms">
                  <div>- Cosmopolitan (Champa Bros. Maldives Pvt Ltd) cannot take any responsibility for product lost or spoil in transit</div>
                  <div>- Overdue outstanding will be subject to 1% interest per overdue day.</div>
                  <div>- Any invoice discrepancies should be made clear via e-mail/fax no later than 24 hours after receiving.</div>
                  <div>- In case of currency fluctuations, invoices must be settled by the latest maximum legal rate as advised by the MMA.</div>
                  <div>- By accepting COSMOPOLITAN and/or other products described in the Invoice, the customer accepts these terms and conditions</div>
                  <div>- The above document is governed by and enforced in accordance with the laws and regulations of the Republic of Maldives.</div>
                </div>

                <div className="thankyou">Thank you for choosing Cosmopolitan as your preferred partner</div>
                <div className="signoff">
                  <div>Recieved By</div>
                </div>
              </>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
const styles = `
  * { box-sizing: border-box; }
  .invoice-template-shell {
    font-family: Arial, Helvetica, sans-serif;
    color: #222;
    background: #fff;
    font-size: 11px;
  }
  .page {
    width: 595px;
    background: #fff;
    margin: 20px auto;
    padding: 30px 40px 20px 40px;
    position: relative;
    page-break-after: always;
    page-break-inside: avoid;
  }
  .page:last-child { page-break-after: auto; }
  table.items { page-break-inside: auto; }
  table.items thead, table.items tbody, table.items tbody tr { page-break-inside: avoid; }
  .header {
    display: grid;
    grid-template-columns: 140px 1fr 90px;
    align-items: flex-start;
    padding-bottom: 6px;
    gap: 1px;
  }
  .logo-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 140px;
  }
  .logo-img {
    width: 120px;
    height: auto;
    display: block;
  }
  .logo-tag {
    font-size: 10px;
    font-style: italic;
    color: #444;
  }
  .fssc {
    font-size: 10px;
    color: #2e7d32;
    font-weight: bold;
    margin-top: 6px;
  }
  .company-info {
    flex: 1;
    max-width: 350px;
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
  }
  .company-name {
    color: #6dbe4b;
    font-weight: 800;
    font-size: 10px;
    margin-bottom: 4px;
    white-space: nowrap;
    line-height: 1.2;
  }
  .company-line {
    font-size: 8px;
    color: #222;
    line-height: 1.4;
    white-space: pre;
  }
  .gold-badge {
    text-align: center;
    width: 90px;
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }
  .badge-img {
    width: 70px;
    height: auto;
    display: block;
    margin: 0 auto;
  }
  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-top: 6px;
    position: relative;
  }
  .copy-label {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: #fff;
    background: #1b3e6f;
    padding: 3px 7px;
    border-radius: 4px;
    margin-bottom: 4px;
  }
  .title-row h1 {
    font-size: 16px;
    margin: 0;
    color: #111;
    letter-spacing: 0.4px;
    font-weight: 800;
    flex: 1;
    text-align: center;
  }
  .pageno {
    font-size: 9.5px;
    color: #555;
    white-space: nowrap;
  }
  .parties {
    display: grid;
    grid-template-columns: 1.2fr 0.8fr;
    gap: 22px;
    margin-top: 18px;
    align-items: start;
  }
  .bill-to {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .bill-to h2 {
    font-size: 15px;
    margin: 0 0 6px 0;
    font-weight: 700;
    letter-spacing: 0.3px;
    line-height: 1.2;
  }
  .addr-line {
    font-size: 10.5px;
    line-height: 1.35;
    color: #222;
    white-space: pre-wrap;
    margin-top: 2px;
  }
  .seller-addr {
    font-size: 10.5px;
    text-align: left;
    line-height: 1.35;
    color: #222;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
  }
  .details-box {
    border: 1px solid rgba(0,0,0,0.08);
    padding: 10px 12px;
    border-radius: 6px;
    background: #fbfbfb;
  }
  .details-title {
    font-size: 11px;
    font-weight: 800;
    margin-bottom: 8px;
    color: #1b3e6f;
  }
  .label {
    color: #333;
    white-space: nowrap;
    width: 130px;
    font-weight: 700;
    font-size: 9.8px;
    letter-spacing: 0.3px;
    padding: 2px 3px;
  }
  table td {
    padding: 2px 3px;
    vertical-align: top;
    line-height: 1.25;
  }
  table tr {
    border-bottom: 1px solid rgba(0,0,0,0.08);
  }
  table tr:last-child td { border-bottom: none; }
  table.items {
    width: 100%;
    border-collapse: collapse;
    margin-top: 20px;
    font-size: 10.5px;
  }
  table.items thead tr {
    border-top: 1.5px solid #1b3e6f;
    border-bottom: 1.5px solid #1b3e6f;
  }
  table.items th {
    text-align: left;
    padding: 5px 4px;
    font-weight: bold;
    color: #1b3e6f;
  }
  table.items td {
    padding: 4px 4px;
    vertical-align: top;
  }
  table.items th.num, table.items td.num {
    text-align: right;
  }
  table.items tbody tr {
    border-bottom: 1px solid #eee;
  }
  .totals {
    width: 100%;
    margin-top: 4px;
  }
  .totals td {
    padding: 3px 4px;
    font-size: 10.5px;
  }
  .totals .tlabel {
    text-align: right;
    padding-right: 10px;
  }
  .totals .tval {
    text-align: right;
    width: 110px;
  }
  .totals .grand {
    border-top: 1.5px solid #1b3e6f;
    font-weight: bold;
  }
  .amount-words {
    margin-top: 10px;
    font-size: 10.5px;
    font-weight: bold;
    letter-spacing: 0.5px;
  }
  .payment-section {
    margin-top: 22px;
    border-top: 1px solid #333;
    padding-top: 10px;
    font-size: 10.5px;
  }
  .payment-row {
    display: flex;
    margin-bottom: 4px;
  }
  .payment-row .plabel {
    width: 160px;
    flex-shrink: 0;
  }
  .payment-row .pcolon {
    width: 12px;
  }
  .bank-details {
    margin-left: 172px;
    line-height: 1.5;
  }
  .terms {
    margin-top: 16px;
    font-size: 9.5px;
    color: #333;
    line-height: 1.6;
  }
  .terms div { margin-bottom: 1px; }
  .thankyou {
    margin-top: 24px;
    text-align: center;
    font-style: italic;
    font-weight: bold;
    font-size: 11px;
  }
  .signoff {
    display: flex;
    justify-content: space-between;
    margin-top: 40px;
    font-size: 10.5px;
    font-weight: bold;
  }
  @page { size: A5; margin: 18mm; }
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; width: auto; }
  }
`

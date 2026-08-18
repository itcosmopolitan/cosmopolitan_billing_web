import React, { useState } from 'react'
import { formatAmountNumber, formatQtyNumber, getAmountDecimals } from '@/utils/decimalPrecision'
import { getInvoiceItemMetadata } from '@/utils/invoiceItemMetadata'

export interface InvoiceLineItem {
  itemNo?: string
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

export function amountToWords(value: number | string | undefined | null) {
  const n = Number(value ?? 0)
  if (Number.isNaN(n)) return 'ZERO RUFIYAA AND ZERO LAARI ONLY'

  const rupees = Math.floor(n)
  const laari = Math.round((n - rupees) * 100)
  const ones = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN']
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']

  const chunk = (num: number): string => {
    if (num < 20) return ones[num]
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '')
    const rem = num % 100
    return ones[Math.floor(num / 100)] + ' HUNDRED' + (rem ? ' ' + chunk(rem) : '')
  }

  if (rupees === 0 && laari === 0) return 'ZERO RUFIYAA AND ZERO LAARI ONLY'

  const parts: string[] = []
  let remaining = rupees
  let scaleIndex = 0
  const scale = ['', 'THOUSAND', 'MILLION', 'BILLION']
  while (remaining > 0) {
    const part = remaining % 1000
    if (part > 0) parts.unshift(chunk(part) + (scale[scaleIndex] ? ' ' + scale[scaleIndex] : ''))
    remaining = Math.floor(remaining / 1000)
    scaleIndex += 1
  }

  const rupeesText = parts.join(' ') || 'ZERO'
  const laariText = laari === 0 ? 'ZERO' : chunk(laari)
  return `${rupeesText} RUFIYAA AND ${laariText} LAARI ONLY`
}

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
    copyType: isWalkin ? 'CUSTOMER COPY' : 'COSMOPOLITAN COPY',
    billTo: {
      name: customerName || 'Walk-in',
      contactPerson: sale?.contactPerson || sale?.contact_person || '',
      addressLines: customerAddressLines.length > 0
        ? customerAddressLines
        : sale?.addressLines || sale?.address_lines || (sale?.customerAddress ? [sale.customerAddress] : []) || (sale?.customer_address ? [sale.customer_address] : []),
    },
    billToCustomerNo: sale?.customerCode || sale?.customer_code || sale?.customerId || sale?.customer_id || '',
    gstNo: sale?.gstNo || sale?.gst_no || '',
    invoiceNo: `${sale?.number || sale?.invoiceNo || sale?.invoice_no || ''}`,
    orderNo: sale?.orderNo || sale?.order_no || '',
    purchaseOrderNo: sale?.purchaseOrderNo || sale?.purchase_order_no || '',
    postingDate: postingDate || '—',
    phoneNo: sale?.phoneNo || sale?.phone_no || branch?.phone || '',
    email: sale?.email || branch?.email || '',
    homePage: sale?.homePage || sale?.homepage || branch?.homepage || branch?.website || '',
    gstRegNo: sale?.gstRegNo || sale?.gst_reg_no || branch?.gst || branch?.gstin || '',
    salesperson: sale?.salesperson || sale?.cashier || sale?.cashierName || '',
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
  const displayEmail = invoice.email || branch?.email || branch?.emailAddress || branch?.email_address || ''
  const displayHomepage = invoice.homePage || branch?.homePage || branch?.homepage || branch?.website || ''
  const displayGstRegNo = invoice.gstRegNo || branch?.gstRegNo || branch?.gst || branch?.gstin || ''
  const companyAddressLines: string[] = Array.isArray(branch?.address)
    ? branch.address.filter(Boolean)
    : (branch?.address ? String(branch.address).split(/\n|<br\s*\/?\s*>/i).filter(Boolean) : ['LOT NO-10627, Haivakaru Magu,  T : 960 331 0477  E : info@cosmopolitan.com.mv', "Hulhumale', Republic of Maldives,  F : 960 331 0458  W : www.cosmopolitan.com.mv"])
  const rowsPerPage = 15
  const totalPages = Math.max(1, Math.ceil((invoice.lineItems || []).length / rowsPerPage))
  const pageItems = Array.from({ length: totalPages }, (_, pageIndex) => {
    const start = pageIndex * rowsPerPage
    const end = start + rowsPerPage
    return invoice.lineItems.slice(start, end)
  })

  return (
    <div className="invoice-template-shell">
      <style>{styles}</style>
      {pageItems.map((rows, index) => {
        const pageNumber = index + 1
        return (
          <div className="invoice-page" key={`${invoice.invoiceNo}-${pageNumber}`}>
            <div className="invoice-header" style={{ alignItems: 'center' }}>
              <div className="logo-column" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                <img src={logoSrc} alt="Cosmopolitan logo" className="logo-image" style={{ width: 150 }} />
                <div className="badge badge--green" style={{ padding: '6px 10px', minWidth: 110, fontSize: 11 }}>FSSC 22000</div>
              </div>

              <div className="company-center" style={{ flex: 1, textAlign: 'center', paddingLeft: 12, paddingRight: 12 }}>
                <div className="company-name-row" style={{ fontSize: 18, color: '#28c23d', fontWeight: 800 }}>{companyName}</div>
                {companyAddressLines.map((ln: string, i: number) => (
                  <div key={`addr-${i}`} style={{ fontSize: 12 }}>{ln}</div>
                ))}
              </div>

              <div className="company-right" style={{ width: 120, display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                <SealWithFallback />
              </div>
            </div>

            <div className="title-row">
              <div className="title-copy-wrap">
                {invoice.copyType ? <div className="copy-label">{invoice.copyType}</div> : null}
                <div className="title-text">Sales Tax-Invoice</div>
              </div>
              <div className="page-number">Page {pageNumber} of {totalPages}</div>
            </div>

            <div className="party-grid">
              <div className="details-box">
                <div className="details-title">Customer Details</div>
                <div className="customer-name">{customerName}</div>
                {(invoice.billTo.addressLines || []).filter(Boolean).length ? (
                  <div className="customer-address">{(invoice.billTo.addressLines || []).filter(Boolean).map((line, i) => <div key={`${line}-${i}`}>{line}</div>)}</div>
                ) : null}

                <div className="detail-list" style={{ marginTop: 10 }}>
                  <div className="detail-row"><span className="detail-label">Invoice No.</span><span className="detail-value">{formatOptionalText(invoice.invoiceNo)}</span></div>
                  <div className="detail-row"><span className="detail-label">Purchase Order No</span><span className="detail-value">{formatOptionalText(invoice.purchaseOrderNo)}</span></div>
                  <div className="detail-row"><span className="detail-label">Posting Date</span><span className="detail-value">{formatOptionalText(invoice.postingDate)}</span></div>
                </div>
              </div>

              <div className="details-box">
                <div className="details-title">Branch Details</div>
                <div className="customer-name" style={{ marginBottom: 8 }}>{companyName}</div>
                <div className="customer-address" style={{ marginBottom: 10 }}>
                  {companyAddressLines.map((line: string, i: number) => <div key={`org-${i}`}>{line}</div>)}
                </div>

                <div className="detail-list">
                  <div className="detail-row"><span className="detail-label">Phone No.</span><span className="detail-value">{formatOptionalText(invoice.phoneNo || branch?.phone)}</span></div>
                  <div className="detail-row"><span className="detail-label">Branch E-Mail</span><span className="detail-value">{formatOptionalText(displayEmail)}</span></div>
                  <div className="detail-row"><span className="detail-label">Home Page</span><span className="detail-value">{formatOptionalText(displayHomepage)}</span></div>
                  <div className="detail-row"><span className="detail-label">GST Reg no</span><span className="detail-value">{formatOptionalText(displayGstRegNo)}</span></div>
                  <div className="detail-row"><span className="detail-label">Salesperson</span><span className="detail-value">{formatOptionalText(invoice.salesperson)}</span></div>
                </div>
              </div>
            </div>

            <table className="invoice-table">
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Description</th>
                  <th>Packing</th>
                  <th>Origin</th>
                  <th>Units</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th>Disc %</th>
                  <th>GST</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, rowIndex) => (
                  <tr key={`${item.description}-${rowIndex}`}>
                    <td>{item.itemNo ?? ''}</td>
                    <td>{item.description}</td>
                    <td>{item.packing ?? ''}</td>
                    <td>{item.origin ?? ''}</td>
                    <td>{item.units ?? ''}</td>
                    <td>{formatQtyNumber(item.qty)}</td>
                    <td>{formatNumber(item.rate)}</td>
                    <td>{item.discountPct ? `${formatNumber(item.discountPct, 2)}%` : ''}</td>
                    <td>{formatNumber(item.gstAmount)}</td>
                    <td>{formatNumber(item.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {pageNumber === totalPages ? (
              <>
                <div className="totals-block">
                  <div className="totals-row">
                    <span>Total MRF Excl. GST</span>
                    <span>{formatNumber(invoice.totalExclGst)}</span>
                  </div>
                  <div className="totals-row">
                    <span>{invoice.gstRatePercent}% GST</span>
                    <span>{formatNumber(invoice.totalGst)}</span>
                  </div>
                  <div className="totals-row totals-row--total">
                    <span>Total MRF Incl. GST</span>
                    <span>{formatNumber(invoice.totalInclGst)}</span>
                  </div>
                </div>

                <div className="amount-words">******* {invoice.amountInWords}</div>

                <div className="payment-section">
                  <div className="payment-row">
                    <div>Payment Due Date :</div>
                    <div>{formatOptionalText(invoice.paymentDueDate)}</div>
                  </div>
                  <div className="payment-row">
                    <div>Terms & Conditions :</div>
                    <div>30DAYS from date of invoice to our account as follows:</div>
                  </div>
                  <div className="bank-details">
                    {BANK_DETAILS.map((detail) => (
                      <div className="bank-detail-row" key={detail.label}>
                        <div className="bank-label">{detail.label}</div>
                        <div className="bank-value">{detail.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <ul className="legal-list">
                  {LEGAL_TERMS.map((term) => (
                    <li key={term}>{term}</li>
                  ))}
                </ul>

                <div className="thank-you">Thank you for choosing Cosmopolitan as your preferred partner</div>

                <div className="signature-row">
                  <div>Recieved By</div>
                  <div className="signature-right">For COSMOPOLITAN</div>
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
    color: #1b3e6f;
    background: #ffffff;
    font-size: 11px;
    line-height: 1.35;
  }
  .invoice-page {
    width: 100%;
    max-width: 850px;
    margin: 0 auto 28px;
    padding: 18px 20px 24px;
    background: #fff;
    break-after: page;
  }
  .invoice-page:last-child { break-after: auto; }
  .invoice-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 8px;
  }
  .logo-column {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #1b6fb5;
  }
  .logo-image {
    width: 86px;
    height: 86px;
    object-fit: contain;
  }
  .logo-tagline {
    font-size: 11px;
    font-weight: 600;
    color: #2e7d32;
    text-transform: lowercase;
  }
  .header-badges {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 82px;
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge--green {
    background: #eaf7ea;
    color: #2e7d32;
    border: 1px solid #2e7d32;
  }
  .badge--gold {
    background: #f8e8a8;
    color: #8b6a00;
    border: 1px solid #8b6a00;
  }
  .gold-seal {
    width: 86px;
    height: 86px;
    border-radius: 50%;
    border: 3px solid #c89b43;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #fff;
    color: #8b6a00;
    text-align: center;
    padding: 4px;
  }
  .gold-seal .gold-corporate { font-size: 9px; letter-spacing: 0.6px; color: #8b6a00; margin-bottom: 0; text-transform: uppercase }
  .gold-seal .gold-text { font-size: 11px; font-weight: 700; margin-top: 2px; letter-spacing: 0.6px }
  .gold-seal .gold-100 { font-size: 28px; font-weight: 900; line-height: 0.9; margin-top: 0; color: #8b6a00 }
  .gold-seal .gold-year { font-size: 10px; margin-top: 2px; color: #6d6d6d }
  .gold-seal-img { width: 86px; height: 86px; object-fit: contain; display: block }
  .company-contact-row {
    font-size: 10px;
    color: #333;
    margin-bottom: 2px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }
  .company-name-row {
    font-size: 18px;
    font-weight: 800;
    color: #1aa34a;
    margin-bottom: 6px;
    text-transform: none;
  }
//   .company-left { flex: 1; }
//   .company-right { text-align: right; font-size: 11px; color: #222 }
  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .title-copy-wrap { display: flex; flex-direction: column; gap: 4px; }
  .copy-label {
    font-size: 10px;
    text-transform: uppercase;
    color: #6d6d6d;
    letter-spacing: 0.4px;
    text-align: right;
  }
  .title-text {
    font-size: 18px;
    font-weight: 700;
    color: #1b3e6f;
  }
  .page-number {
    font-size: 10px;
    color: #4a4a4a;
  }
  .party-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin: 14px 0 12px;
  }
  .details-box {
    border: 1px solid rgba(0,0,0,0.10);
    border-radius: 6px;
    background: rgba(248,249,250,0.85);
    padding: 12px 12px 8px;
    min-height: 160px;
  }
  .details-title {
    font-size: 12px;
    font-weight: 800;
    color: #1b3e6f;
    margin-bottom: 8px;
  }
  .customer-name {
    font-size: 16px;
    font-weight: 800;
    color: #1b3e6f;
    margin-bottom: 4px;
  }
  .customer-address {
    font-size: 11px;
    color: #2b2b2b;
    line-height: 1.45;
  }
  .detail-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .detail-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 10px;
    align-items: start;
    font-size: 11px;
  }
  .detail-label {
    font-weight: 700;
    color: #1b3e6f;
  }
  .detail-value {
    color: #1f1f1f;
    word-break: break-word;
  }
  .info-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 12px;
  }
  .info-column {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .info-row {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 8px;
    align-items: start;
  }
  .info-label {
    font-weight: 700;
    color: #1b3e6f;
  }
  .info-value { min-height: 14px; }
  .bill-to-section {
    margin-bottom: 10px;
    border-top: 1px solid #1b3e6f;
    padding-top: 8px;
  }
  .section-label {
    font-size: 11px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .bill-to-line, .bill-to-block { min-height: 16px; }
  .bill-to-name { font-weight: 700; }
  .invoice-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    margin-bottom: 12px;
  }
  .invoice-table th {
    padding: 6px 4px;
    border-bottom: 1px solid #1b3e6f;
    text-align: left;
    font-weight: 700;
    color: #1b3e6f;
  }
  .invoice-table td {
    padding: 5px 4px;
    border-bottom: 1px solid #e8e8e8;
    vertical-align: top;
  }
  .totals-block {
    margin-left: auto;
    width: 320px;
    border-top: 1px solid #1b3e6f;
    margin-bottom: 10px;
  }
  .totals-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid #e8e8e8;
    font-weight: 600;
  }
  .totals-row--total {
    border-top: 1px solid #1b3e6f;
    border-bottom: none;
    font-weight: 700;
    padding-top: 8px;
  }
  .amount-words {
    font-weight: 700;
    margin-bottom: 12px;
  }
  .payment-section {
    margin-bottom: 12px;
  }
  .payment-row {
    display: grid;
    grid-template-columns: 170px 1fr;
    gap: 8px;
    margin-bottom: 6px;
  }
  .bank-details {
    margin-top: 8px;
    border-top: 1px solid #1b3e6f;
    padding-top: 8px;
  }
  .bank-detail-row {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 8px;
    margin-bottom: 4px;
  }
  .bank-label {
    font-weight: 700;
    color: #1b3e6f;
  }
  .legal-list {
    padding-left: 18px;
    margin: 0 0 12px;
    color: #2b2b2b;
  }
  .legal-list li { margin-bottom: 4px; }
  .thank-you {
    text-align: center;
    font-style: italic;
    margin: 16px 0 18px;
    color: #1b3e6f;
  }
  .signature-row {
    display: flex;
    justify-content: space-between;
    padding-top: 20px;
    border-top: 1px solid #d7d7d7;
    font-size: 11px;
  }
  .signature-right {
    font-weight: 700;
    color: #1b3e6f;
  }
  @media print {
    body { margin: 0; background: #fff; }
    .invoice-template-shell { padding: 0; }
    .invoice-page { max-width: none; margin: 0; padding: 12mm; box-shadow: none; page-break-after: always; }
    .invoice-page:last-child { page-break-after: auto; }
  }
`

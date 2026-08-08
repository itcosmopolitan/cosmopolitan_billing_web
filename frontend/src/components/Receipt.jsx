import { useRef } from 'react'
import { fmt, fmtDate, fmtDateTime } from '@/utils/helpers'
import { getColumnDefinitions, getColumnStructure, useInvoiceConfig } from '@/utils/invoiceConfig'
import SalesTaxInvoice, { mapSaleToInvoice } from '@/components/invoices/SalesTaxInvoice'
import openInvoicePrintWindow from '@/utils/printInvoice'

const formatNumber = (value, options = {}) => {
  const number = Number(value)
  if (value === null || value === undefined || Number.isNaN(number)) return '—'
  return number.toLocaleString('en-MV', {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  })
}

const amountToWords = (value) => {
  const n = Number(value)
  if (Number.isNaN(n)) return '—'
  const rupees = Math.floor(n)
  const laari = Math.round((n - rupees) * 100)
  const ones = ['ZERO','ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE','TEN','ELEVEN','TWELVE','THIRTEEN','FOURTEEN','FIFTEEN','SIXTEEN','SEVENTEEN','EIGHTEEN','NINETEEN']
  const tens = ['','','TWENTY','THIRTY','FORTY','FIFTY','SIXTY','SEVENTY','EIGHTY','NINETY']

  const chunk = (num) => {
    if (num < 20) return ones[num]
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '')
    const rem = num % 100
    return ones[Math.floor(num / 100)] + ' HUNDRED' + (rem ? ' ' + chunk(rem) : '')
  }

  if (rupees === 0 && laari === 0) return 'ZERO RUFIYAA AND ZERO LAARI ONLY'

  const parts = []
  let remaining = rupees
  let scaleIndex = 0
  const scale = ['', 'THOUSAND', 'MILLION', 'BILLION']

  while (remaining > 0) {
    const part = remaining % 1000
    if (part > 0) {
      const prefix = chunk(part)
      parts.unshift(prefix + (scale[scaleIndex] ? ' ' + scale[scaleIndex] : ''))
    }
    remaining = Math.floor(remaining / 1000)
    scaleIndex += 1
  }

  const rupeesText = parts.join(' ') || 'ZERO'
  const laariText = laari === 0 ? 'ZERO' : chunk(laari)
  return `${rupeesText} RUFIYAA AND ${laariText} LAARI ONLY`
}

const formatCurrency = (value) => formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 2 })

// ─── Invoice Print Component ────────────────────────────────────────────────
export function Receipt({ sale, branch }) {
  const ref = useRef(null)
  const config = useInvoiceConfig()
  const columns = getColumnDefinitions(config)

  const getItemTaxAmount = (item) => {
    const qty = Number(item.qty || item.quantity || 0)
    const rate = Number(item.price || item.rate || 0)
    const discountPct = Number(item.discount || item.discPercent || 0)
    const amount = Number(item.lineTotal || item.total || qty * rate)
    const taxable = discountPct ? amount * (1 - discountPct / 100) : amount
    const taxRate = Number(item.taxRate ?? item.tax_rate ?? 0)
    return Math.round((taxable * taxRate) / 100 * 100) / 100
  }

  const getInvoiceCellValue = (item, key) => {
    const qty = Number(item.qty || item.quantity || 0)
    const rate = Number(item.price || item.rate || 0)
    const discountPct = Number(item.discount || item.discPercent || 0)
    const amount = Number(item.lineTotal || item.total || qty * rate)
    switch (key) {
      case 'description': return item.name || ''
      case 'hsn': return item.hsnCode || item.hsn_code || ''
      case 'attr': return item.attribute || item.batch || item.attr || ''
      case 'packing': return item.size || item.package || item.packing || ''
      case 'origin': return item.origin || item.country || item.manufacturer || ''
      case 'units': return item.units || item.unit || ''
      case 'qty': return qty
      case 'rate': return rate
      case 'disc': return discountPct
      case 'gst': return getItemTaxAmount(item)
      case 'amount': return amount
      default: return ''
    }
  }

  const printInvoice = () => {
    const printedAt = fmtDateTime(new Date())
    const company = branch?.company || 'Champa Brothers Maldives Pvt Ltd'
    const shopName = branch?.name || 'C.Shop'
    const address = branch?.address || 'LOT11155 / HULHUMALE PHASE 01'
    const phone = branch?.phone || '3350000'
    const gstNo = branch?.gst || branch?.gstin || '1017548GST501'
    const billTo = sale.customerName && sale.customerName !== 'Walk-in' ? sale.customerName : 'Walk-in'
    const billToAddressLines = [
      sale.customerStreet1 || sale.customer_street1,
      sale.customerStreet2 || sale.customer_street2,
      sale.customerStreet3 || sale.customer_street3,
      sale.customerCity || sale.customer_city || sale.city,
      sale.customerStateProvince || sale.customer_state_province,
      sale.customerCountry || sale.customer_country || sale.country,
      sale.customerPostalCode || sale.customer_postal_code || sale.postal_code,
    ];

    // delegate to shared helper
    openInvoicePrintWindow(sale, branch);

    if (!billToAddressLines.length || billToAddressLines.every(l => !l)) {
      billToAddressLines.push(...(sale.addressLines || sale.address_lines || (sale.customerAddress ? [sale.customerAddress] : []) || (sale.customer_address ? [sale.customer_address] : []) || []));
    }
    const logoUrl = branch?.logo || branch?.logo_url
    const invoiceDate = sale.date || sale.invoiceDate || sale.invoice_date || ''
    const dueDate = sale.dueDate || sale.due_date || null
    const paymentTerms = sale.paymentTerms || sale.payment_terms || '30 DAYS'
    const customerId = sale.customerId || sale.customer_id || '—'
    const totalInWords = amountToWords(sale.total || 0)

    const taxPercent = Number(sale.taxRate ?? sale.tax_rate ?? sale.taxPercent ?? sale.tax_percent ?? 0) || (sale.subtotal ? Math.round(((sale.taxTotal || sale.tax_total || 0) / sale.subtotal) * 100) : 0)

    const columns = getColumnDefinitions(config)
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Invoice ${sale.number}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: Arial, sans-serif; font-size: 11px; background: white; color: #000; padding: 16px; width: 100%; max-width: 770px; margin: 0 auto; }
          .center { text-align: center; }
          .right { text-align: right; }
          .bold { font-weight: 700; }
          .divider { border-top: 1px solid #000; margin: 10px 0; }
          .title { font-size: 18px; font-weight: 700; letter-spacing: 0.4px; }
          .subtle { font-size: 10px; color: #333; }
          .small { font-size: 10px; }
          table { width: 100%; border-collapse: collapse; font-size: 10.6px; }
          td, th { padding: 4px 4px; vertical-align: top; }
          th { font-weight: 700; border-bottom: 1px solid #000; }
          .item-cell { padding: 6px 4px; }
          .summary td { padding: 3px 0; }
          .footer-note { font-size: 10px; margin-top: 8px; line-height: 1.4; }
          .terms { font-size: 9.5px; line-height: 1.4; margin-top: 10px; }
          .terms strong { display: block; margin-bottom: 4px; }
          @page { size: A4; margin: 18mm; }
          html, body { height: 100%; }
          .print-header,
          .print-footer { position: fixed; left: 0; right: 0; background: white; z-index: 10; }
          .print-header { top: 0; padding: 12px 16px 10px; border-bottom: 1px solid #000; }
          .print-footer { bottom: 0; padding: 8px 16px; border-top: 1px solid #000; font-size: 9px; }
          .page-counter { white-space: nowrap; }
          .page-counter::after { content: 'Page ' counter(page); }
          @media print {
            body { padding: 0; }
            body > .print-main { margin-top: 175px; margin-bottom: 110px; }
            thead { display: table-header-group; }
            tfoot { display: table-footer-group; }
            tr { page-break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <div class="print-header">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;font-size:10px;">
            <div style="line-height:1.3;">
              <div class="bold" style="font-size:13px;">${shopName}</div>
              <div>${company}</div>
              <div>${address}</div>
              <div>Phone: ${phone}</div>
              <div>GST No: ${gstNo}</div>
            </div>
            <div style="text-align:right; line-height:1.4;">
              ${config.showPrintedDate ? `<div>Printed: ${printedAt}</div>` : ''}
              ${config.showStore ? `<div>Store: ${shopName}</div>` : ''}
              ${config.showCashier ? `<div>Cashier: Admin</div>` : ''}
              <div style="margin-top:6px;"><span class="bold">Invoice No.</span> ${sale.number || '—'}</div>
              <div><span class="bold">Posting Date</span> ${fmtDate(invoiceDate)}</div>
              <div><span class="bold">Bill-to Customer No.</span> ${customerId}</div>
              <div><span class="bold">GST Reg no</span> ${gstNo}</div>
              <div class="page-counter" style="margin-top:6px;"></div>
            </div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top: 10px; font-size: 11px;">
            <div class="bold" style="font-size:13px;">Sales Tax-Invoice</div>
            ${paymentTerms ? `<div style="font-size:10px;">${paymentTerms}</div>` : ''}
          </div>
        </div>
        <div class="print-main">
        ${config.headerStyle === 'logo' ? `
          <div class="center" style="margin-bottom:12px;">
            ${logoUrl ? `<img src="${logoUrl}" alt="${shopName}" style="max-width:140px;max-height:60px;object-fit:contain;" />` : `<div class="title">${shopName}</div>`}
          </div>
        ` : `
          <div class="center title" style="margin-bottom:6px;">${shopName}</div>
          ${config.headerStyle === 'full' ? `
            <div class="center invoice-header-line">${company}</div>
            <div class="center invoice-header-line">${address}</div>
            <div class="center invoice-header-line">PHONE : ${phone}</div>
            <div class="center invoice-header-line">TIN: ${gstNo}</div>
          ` : ''}
        `}
        <div class="center bold" style="margin:10px 0 4px;">TAX INVOICE</div>

        <div class="divider"></div>
        ${config.showCustomer ? `<div style="margin:6px 0 4px;"><span class="bold">Bill To:</span> ${billTo}${billToAddressLines && billToAddressLines.length ? `<div style="margin-top:4px; font-size:10px;">${billToAddressLines.filter(Boolean).map(line => line.trim()).filter(Boolean).join('<br/>')}</div>` : ''}</div>` : ''}
        <div class="divider"></div>

        <table>
          <thead>
            <tr>
              ${columns.map((col) => `<th style="width:${col.width}; text-align:${col.align};">${col.label}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${(sale.items || []).map((item, index) => {
              const row = columns.map((col) => {
                const raw = col.key === 'no' ? index + 1 : getInvoiceCellValue(item, col.key)
                if (col.key === 'rate' || col.key === 'gst' || col.key === 'amount') {
                  return `<td class="item-cell right">${formatCurrency(raw)}</td>`
                }
                if (col.key === 'disc') {
                  return `<td class="item-cell right">${raw}%</td>`
                }
                return `<td class="item-cell" style="text-align:${col.align};">${raw}</td>`
              }).join('')
              return `<tr>${row}</tr>`
            }).join('')}
          </tbody>
        </table>

        <div class="divider"></div>
        <table class="summary">
          <tr>
            <td>Total MRF Excl. GST</td>
              <td class="right">${formatNumber(sale.subtotal || sale.items?.reduce((sum, i) => sum + (Number(i.lineTotal || i.total || (Number(i.qty || 0) * Number(i.price || i.rate || 0))) || 0), 0) || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
          ${`
            <tr>
              <td>${taxPercent}% GST</td>
              <td class="right">${formatNumber(sale.taxTotal || sale.tax_total || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          `}
          <tr class="bold">
            <td>TOTAL</td>
            <td class="right">${formatNumber(sale.total || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        </table>

        ${config.showPayment ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:11px;margin-top:8px;">
            <div>Payment</div>
            <div style="text-align:right">${(sale.paymentMode || sale.payment_mode || 'CASH').toUpperCase()}</div>
          </div>
        ` : ''}

        ${paymentTerms ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:10px;margin-top:8px;">
            <div>Payment Terms</div>
            <div style="text-align:right">${paymentTerms}</div>
          </div>
        ` : ''}

        ${dueDate ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:10px;margin-top:4px;">
            <div>Payment Due Date :</div>
            <div style="text-align:right">${fmtDate(dueDate)}</div>
          </div>
        ` : ''}

        <div style="text-align:center; margin-top:6px; margin-bottom:4px; font-size:10px;">
          <div style="text-align:center; margin-bottom:6px; font-weight:700;">***</div>
          <div style="font-weight:700;">${totalInWords}</div>
          <div style="text-align:center; margin-top:6px; font-weight:700;">***</div>
        </div>

        <div class="terms">
          <strong>Terms & Conditions :</strong>
          <div>From date of invoice to our account as follows:</div>
          <div>A/C NAME : Cosmopolitan Champa Brothers Maldives Pvt Ltd</div>
          <div>Bank Account No : 7730000519444</div>
          <div>Bank Name : Bank of Maldives</div>
          <div>Bank Address : Boduthakurufaanu Magu, Malé 20094</div>
          <div style="margin-top:6px;">- Cosmopolitan (Champa Bros. Maldives Pvt Ltd) cannot take any responsibility for product lost or spoil in transit</div>
          <div>- Overdue outstanding will be subject to 1% interest per overdue day.</div>
          <div>- Any invoice discrepancies should be made clear via e-mail/fax no later than 48 hours after receiving.</div>
          <div>- In case of currency fluctuations, invoices must be settled by the latest maximum legal rate as advised by the MMA.</div>
          <div>- By accepting COSMOPOLITAN and/or other products described in the Invoice, the customer accepts these terms and conditions</div>
          <div>- The above document is governed by and enforced in accordance with the laws and regulations of the Republic of Maldives.</div>
        </div>

        <div class="divider"></div>
        <div style="font-size:10px; margin-top:8px; text-align:center;">Thank you for choosing Cosmopolitan as your preferred partner</div>
        <div style="display:grid;grid-template-columns:1fr 1fr; gap:16px; font-size:10px; margin-top:16px;">
          <div style="text-align:left;">For COSMOPOLITAN</div>
          <div style="text-align:right;">Received By</div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; margin-top:2px;">
          <div>Swift Code : MALBMVMVXXX</div>
          <div></div>
        </div>
      </div>
      <div class="print-footer">
        <div style="display:flex; justify-content:space-between; gap: 16px; font-size: 10px;">
          <div>Hulhumale', Maldives. LOT NO-10627, Haivakaru Magu, Cosmopolitan Champa Brothers Maldives Pvt Ltd</div>
          <div></div>
        </div>
      </div>
      </body>
      </html>
    `

    const win = window.open('', '_blank', 'width=560,height=900')
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 500)
  }

  const printInvoiceCosmo = async () => {
    const printedAt = fmtDateTime(new Date())
    const totalInWords = amountToWords(sale.total || 0)
    const taxPercent = Number(sale.taxRate ?? sale.tax_rate ?? sale.taxPercent ?? sale.tax_percent ?? 0) || (sale.subtotal ? Math.round(((sale.taxTotal || sale.tax_total || 0) / sale.subtotal) * 100) : 0)

    const authToken = typeof window !== 'undefined' ? window.localStorage.getItem('retailos_token') : null
    const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

    // Ensure we have a fully-hydrated sale before printing
    let fullSale = sale
    try {
      const needsFetch = !sale || (
        sale?.id &&
        (
          !sale.salesperson ||
          !sale.email ||
          !sale.phoneNo ||
          !sale.orderNo ||
          !sale.purchaseOrderNo ||
          (!sale.gstNo && !sale.gst_no && !sale.gst)
        )
      )
      if (needsFetch && sale?.id) {
        const res = await fetch(`/api/v1/sales/${sale.id}`, {
          headers: {
            Accept: 'application/json',
            ...authHeaders,
          },
        })
        if (res.ok) fullSale = await res.json()
      }
    } catch (e) {
      // ignore and proceed with whatever we have
    }

    // Organisation fallback for branch-level metadata
    let org = null
    try {
      const r = await fetch('/api/v1/settings/organisation', {
        headers: {
          Accept: 'application/json',
          ...authHeaders,
        },
      })
      if (r.ok) org = await r.json()
    } catch (e) {
      /* ignore */
    }

    const branchMerged = { ...(branch || {}) }
    // merge organisation only for missing branch-level fields; don't overwrite branch values
    if (org) {
      branchMerged.gstin = branchMerged.gstin || org.gstin || org.gstin
      branchMerged.website = branchMerged.website || org.website
      branchMerged.homePage = branchMerged.homePage || org.website || org.homePage
      branchMerged.email = branchMerged.email || org.email
      branchMerged.phone = branchMerged.phone || org.phone || ''
    }

    const saleToSend = {
      ...fullSale,
      salesperson: fullSale?.salesperson || fullSale?.cashier || fullSale?.cashierName || fullSale?.salesperson_name || fullSale?.salesPerson || '',
      // ensure phone/email on the sale payload: sale -> branch -> org
      phoneNo: fullSale?.phoneNo || fullSale?.phone_no || branchMerged?.phone || branchMerged?.tel || org?.phone || '',
      email: fullSale?.email || branchMerged?.email || org?.email || '',
      totalInWords,
      taxPercent,
    }
    // Normalize aliases expected by the print template
    branchMerged.gstin = branchMerged.gstin || branchMerged.gst || branchMerged.gstNo || branchMerged.gst_no || ''
    branchMerged.gst = branchMerged.gst || branchMerged.gstin || ''
    branchMerged.gstNo = branchMerged.gstNo || branchMerged.gst || branchMerged.gstin || ''
    branchMerged.gst_no = branchMerged.gst_no || branchMerged.gstin || ''
    branchMerged.website = branchMerged.website || branchMerged.homepage || ''
    branchMerged.homePage = branchMerged.homePage || branchMerged.homepage || branchMerged.website || ''
    branchMerged.email = branchMerged.email || branchMerged.emailAddress || branchMerged.email_address || ''
    branchMerged.phone = branchMerged.phone || branchMerged.tel || branchMerged.phoneNo || branchMerged.phone_no || ''

    const payload = { sale: saleToSend, branch: branchMerged, printedAt }
    console.debug('[PrintInvoiceCosmo] payload', {
      sale: {
        id: saleToSend.id,
        number: saleToSend.number,
        salesperson: saleToSend.salesperson,
        email: saleToSend.email,
        phoneNo: saleToSend.phoneNo,
        gstNo: saleToSend.gstNo || saleToSend.gst_no || saleToSend.gst,
      },
      branch: {
        gst: branchMerged.gst,
        gstNo: branchMerged.gstNo,
        gst_no: branchMerged.gst_no,
        gstin: branchMerged.gstin,
        email: branchMerged.email,
        website: branchMerged.website,
        homePage: branchMerged.homePage,
      },
    })
    const win = window.open('/invoice-cosmo.html', '_blank')
    // try to postMessage until the window is ready
    const interval = setInterval(() => {
      try {
        if (!win || win.closed) { clearInterval(interval); return }
        win.postMessage({ type: 'renderInvoice', payload }, window.location.origin)
        clearInterval(interval)
      } catch (e) {
        // keep trying
      }
    }, 200)
    setTimeout(() => { try { win.focus() } catch (e) {} }, 500)
  }

  const shareWhatsApp = () => {
    const items = (sale.items || []).map(i => `• ${i.name} x${i.qty} = MVR${i.lineTotal || i.qty * i.price}`).join('\n')
    const msg = `*Cosmopolitan — ${branch?.name}*\n` +
      `Invoice: *${sale.number}*\n` +
      `Date: ${fmtDate(sale.date || new Date())}\n` +
      `─────────────────\n${items}\n` +
      `─────────────────\n` +
      `Taxable amount: MVR${(sale.subtotal || 0).toLocaleString('en-MV')}\n` +
      (sale.discount ? `Discount: -MVR${sale.discount.toLocaleString('en-MV')}\n` : '') +
      `Tax amount: MVR${(sale.taxTotal || sale.tax_total || 0).toLocaleString('en-MV')}\n` +
      `*TOTAL: MVR${(sale.total || 0).toLocaleString('en-MV')}*\n` +
      `Payment: ${(sale.paymentMode || sale.payment_mode || '').toUpperCase()}\n\n` +
      `Thank you for your purchase! 🙏`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale) return null

  const invoiceData = mapSaleToInvoice(sale, branch)

  return (
    <div>
      <div ref={ref} style={{
        background: '#fff',
        padding: 0,
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        maxWidth: 920,
        margin: '0 auto',
      }}>
        <SalesTaxInvoice invoice={invoiceData} branch={branch} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
        <button className="btn btn-primary" onClick={printInvoiceCosmo}>🖨 Print Invoice</button>
      </div>
    </div>
  )
}

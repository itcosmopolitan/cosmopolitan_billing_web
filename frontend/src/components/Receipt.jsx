import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtDate, fmtDateTime } from '@/utils/helpers'
import { formatAmountNumber, formatQtyNumber, getAmountDecimals } from '@/utils/decimalPrecision'
import { getColumnDefinitions, getColumnStructure, useInvoiceConfig } from '@/utils/invoiceConfig'
import SalesTaxInvoice, { mapSaleToInvoice } from '@/components/invoices/SalesTaxInvoice'
import { ThermalReceipt } from '@/components/ThermalReceipt'
import { resolveInvoiceItemField } from '@/utils/invoiceItemMetadata'
import openInvoicePrintWindow from '@/utils/printInvoice'
import amountToWords from '@/utils/amountToWords'
import { settingsAPI } from '@/api'
import { formatSettlementLabel } from '@/utils/storeCredit'

const formatNumber = (value, options = {}) => {
  const number = Number(value)
  if (value === null || value === undefined || Number.isNaN(number)) return '—'
  const amountDecimals = getAmountDecimals()
  return number.toLocaleString('en-MV', {
    minimumFractionDigits: options.minimumFractionDigits ?? amountDecimals,
    maximumFractionDigits: options.maximumFractionDigits ?? amountDecimals,
  })
}

const formatCurrency = (value) => formatAmountNumber(value)

// ─── Invoice Print Component ────────────────────────────────────────────────
export function Receipt({ sale, branch }) {
  const ref = useRef(null)
  const thermalRef = useRef(null)
  const [invoiceFormat, setInvoiceFormat] = useState('standard') // 'standard' or 'thermal'
  const [orgProfile, setOrgProfile] = useState(null)
  const config = useInvoiceConfig()
  const columns = getColumnDefinitions(config)

  useEffect(() => {
    let active = true
    settingsAPI.getOrganisation()
      .then((res) => {
        const data = res?.data ?? res
        if (active) setOrgProfile(data)
      })
      .catch(() => {
        if (active) setOrgProfile(null)
      })
    return () => {
      active = false
    }
  }, [])

  const mergedBranch = useMemo(() => {
    const base = { ...(branch || {}) }
    const org = orgProfile || {}

    base.gstin = base.gstin || base.gst || base.gstNo || base.gst_no || org.gstin || ''
    base.gst = base.gst || base.gstin || org.gstin || ''
    base.gstNo = base.gstNo || base.gst || base.gstin || org.gstin || ''
    base.gst_no = base.gst_no || base.gstin || org.gstin || ''

    base.website = base.website || base.homepage || base.homePage || org.website || ''
    base.homePage = base.homePage || base.homepage || base.website || org.website || org.homePage || ''
    base.email = base.email || base.emailAddress || base.email_address || org.email || ''
    base.phone = base.phone || base.tel || base.phoneNo || base.phone_no || org.phone || ''

    return base
  }, [branch, orgProfile])

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
    const customerId = sale.customerCode || sale.customer_code || sale.customerId || sale.customer_id || '—'
    const totalInWords = amountToWords(sale.total, '—')

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
            <div class="bold" style="font-size:13px;">Sales Invoice</div>
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
                const raw = col.key === 'no' ? index + 1 : (col.key === 'packing' || col.key === 'origin' || col.key === 'units'
                  ? resolveInvoiceItemField(item, col.key)
                  : getInvoiceCellValue(item, col.key))
                if (col.key === 'rate' || col.key === 'gst' || col.key === 'amount') {
                  return `<td class="item-cell right">${formatCurrency(raw)}</td>`
                }
                if (col.key === 'qty') {
                  return `<td class="item-cell right">${formatQtyNumber(raw)}</td>`
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
          ${sale.discount ? `
          <tr>
            <td>Discount</td>
            <td class="right">-${formatNumber(sale.discount)}</td>
          </tr>
          ` : ''}
          <tr>
            <td>Total MRF Excl. GST</td>
              <td class="right">${formatNumber(sale.subtotal || sale.items?.reduce((sum, i) => sum + (Number(i.lineTotal || i.total || (Number(i.qty || 0) * Number(i.price || i.rate || 0))) || 0), 0) || 0)}</td>
          </tr>
          ${`
            <tr>
              <td>${taxPercent}% GST</td>
              <td class="right">${formatNumber(sale.taxTotal || sale.tax_total || 0)}</td>
            </tr>
          `}
          <tr class="bold">
            <td>TOTAL</td>
            <td class="right">${formatNumber(sale.total || 0)}</td>
          </tr>
        </table>

        ${config.showPayment ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:11px;margin-top:8px;">
            <div>Payment</div>
            <div style="text-align:right">${formatSettlementLabel({
              paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
              storeCreditApplied: sale.storeCreditApplied,
              payments: sale.payments,
            })}</div>
          </div>
          ${Number(sale.storeCreditApplied || 0) > 0 ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:11px;margin-top:4px;">
            <div>Account credit applied</div>
            <div style="text-align:right">${formatNumber(sale.storeCreditApplied)}</div>
          </div>
          ` : ''}
          ${sale.cashCollected != null && Number(sale.cashCollected) > 0 ? `
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:11px;margin-top:4px;">
            <div>Cash collected</div>
            <div style="text-align:right">${formatNumber(sale.cashCollected)}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;font-size:12px;margin-top:4px;font-weight:700;">
            <div>Change</div>
            <div style="text-align:right">${formatNumber(sale.cashChange || 0)}</div>
          </div>
          ` : ''}
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
          <div>- Any invoice discrepancies should be made clear via e-mail/fax no later than 24 hours after receiving.</div>
          <div>- In case of currency fluctuations, invoices must be settled by the latest maximum legal rate as advised by the MMA.</div>
          <div>- By accepting COSMOPOLITAN and/or other products described in the Invoice, the customer accepts these terms and conditions</div>
          <div>- The above document is governed by and enforced in accordance with the laws and regulations of the Republic of Maldives.</div>
        </div>

        <div class="divider"></div>
        <div style="font-size:10px; margin-top:8px; text-align:center;">Thank you for choosing Cosmopolitan as your preferred partner</div>
        <div style="display:grid;grid-template-columns:1fr 1fr; gap:16px; font-size:10px; margin-top:16px;">
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
      `Payment: ${formatSettlementLabel({
        paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
        storeCreditApplied: sale.storeCreditApplied,
        payments: sale.payments,
      })}\n` +
      (Number(sale.storeCreditApplied || 0) > 0
        ? `Account credit: MVR${Number(sale.storeCreditApplied).toLocaleString('en-MV')}\n`
        : '') +
      (sale.cashCollected != null && Number(sale.cashCollected) > 0
        ? `Cash collected: MVR${Number(sale.cashCollected).toLocaleString('en-MV')}\nChange: MVR${Number(sale.cashChange || 0).toLocaleString('en-MV')}\n`
        : '') +
      `\nThank you for your purchase! 🙏`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale) return null

  const invoiceData = mapSaleToInvoice(sale, mergedBranch)

  const handlePrint = () => {
    if (invoiceFormat === 'standard') {
      openInvoicePrintWindow(sale, branch)
    } else if (invoiceFormat === 'thermal' && thermalRef.current) {
      thermalRef.current.print()
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 16 }}>
        <div className="tabs-bar" role="tablist" style={{ marginBottom: 0, justifySelf: 'start', maxWidth: '100%', minWidth: 0 }}>
          <button
            className={`tab-btn ${invoiceFormat === 'standard' ? 'active' : ''}`}
            role="tab"
            aria-selected={invoiceFormat === 'standard'}
            onClick={() => setInvoiceFormat('standard')}
          >
            📄 Standard Format
          </button>
          <button
            className={`tab-btn ${invoiceFormat === 'thermal' ? 'active' : ''}`}
            role="tab"
            aria-selected={invoiceFormat === 'thermal'} 
            onClick={() => setInvoiceFormat('thermal')}
          >
            🖨 Thermal Receipt
          </button>
        </div>
        <button className="btn btn-primary" onClick={handlePrint} style={{ flexShrink: 0 }}>🖨 Print</button>
      </div>

      <div ref={ref} style={{
        background: '#fff',
        padding: 0,
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        maxWidth: invoiceFormat === 'thermal' ? 420 : 920,
        margin: '0 auto',
      }}>
        {invoiceFormat === 'standard' ? (
          <SalesTaxInvoice invoice={invoiceData} branch={mergedBranch} />
        ) : (
          <ThermalReceipt ref={thermalRef} sale={sale} branch={mergedBranch} />
        )}
      </div>

    </div>
  )
}

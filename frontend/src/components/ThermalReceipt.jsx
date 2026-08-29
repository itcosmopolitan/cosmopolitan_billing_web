import { useRef, forwardRef, useImperativeHandle } from 'react'
import { fmt, fmtDate, fmtDateTime } from '@/utils/helpers'
import { getColumnStructure, useInvoiceConfig } from '@/utils/invoiceConfig'
import { formatSettlementLabel } from '@/utils/storeCredit'

// ─── Thermal Receipt Component ────────────────────────────────────────────────
export const ThermalReceipt = forwardRef(function ThermalReceipt({ sale, branch }, ref) {
  const previewRef = useRef(null)
  const config = useInvoiceConfig()

  const printReceipt = () => {
    const printedAt = fmtDateTime(new Date())
    const company = branch?.company || 'Champa Brothers Maldives Pvt Ltd'
    const shopName = branch?.name || 'C.Shop'
    const address = branch?.address || 'LOT11155 / HULHUMALE PHASE 01'
    const phone = branch?.phone || '3350000'
    const gstNo = branch?.gst || '1017548GST501'
    const billTo = sale.customerName && sale.customerName !== 'Walk-in' ? sale.customerName : 'Walk-in'
    const logoUrl = branch?.logo || branch?.logo_url

    const formatCurrency = (value) => {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
      return fmt(value)
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Receipt ${sale.number}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Courier New', monospace; font-size: 11px; background: white; color: #000; padding: 12px; width: 420px; }
          .center { text-align: center; }
          .right { text-align: right; }
          .bold { font-weight: bold; }
          .divider { border-top: 1px dashed #000; margin: 6px 0; }
          .title { font-size: 16px; font-weight: bold; }
          .subtle { font-size: 10px; color: #333; }
          table { width: 100%; border-collapse: collapse; font-size: 10.8px; }
          td, th { padding: 2px 4px; vertical-align: top; }
          th { font-weight: bold; border-bottom: 1px solid #000; }
          .summary td { padding: 2px 0; }
          .footer-note { font-size: 10px; margin-top: 8px; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        ${config.showPrintedDate || config.showStore || config.showCashier ? `
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;font-size:10px;">
            ${config.showPrintedDate ? `<div>Printed: ${printedAt}</div>` : '<div></div>'}
            ${config.showStore ? `<div>Store: ${shopName}</div>` : '<div></div>'}
            ${config.showCashier ? `<div>Cashier: Admin</div>` : '<div></div>'}
          </div>
        ` : ''}
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:10px;font-size:10px;">
          <div></div>
        </div>

        ${config.headerStyle === 'logo' ? `
          <div class="center" style="margin-bottom:6px;">
            ${logoUrl ? `<img src="${logoUrl}" alt="${shopName}" style="max-width:120px;max-height:48px;object-fit:contain;" />` : `<div class="title">${shopName}</div>`}
          </div>
        ` : `
          <div class="center bold" style="letter-spacing:1px;margin-bottom:4px;">REPRINTED</div>
          <div class="center title" style="margin-bottom:6px;">${company}</div>
          ${config.headerStyle === 'full' ? `
            <div class="center subtle">${address}</div>
            <div class="center subtle">PHONE : ${phone}</div>
          ` : ''}
        `}
        <div class="center bold" style="margin:10px 0 4px;">TAX INVOICE</div>
        ${config.headerStyle === 'full' ? `<div class="center subtle">TIN: ${gstNo}</div>` : ''}

        <div class="divider"></div>
        ${config.showCustomer ? `<div style="margin:4px 0;"><span class="bold">Bill To:</span> ${billTo}</div>` : ''}
        <div class="divider"></div>

        <table>
          <thead>
            <tr>
              <th style="width:30%" class="left">Item Name</th>
              ${config.showHsn ? '<th style="width:10%">HSN</th>' : ''}
              ${config.showAttr ? '<th style="width:15%">Attribute</th>' : ''}
              ${config.showSize ? '<th style="width:12%">Size</th>' : ''}
              ${config.showDisc ? '<th style="width:10%" class="right">Disc %</th>' : ''}
              <th style="width:8%" class="right">Qty</th>
              <th style="width:15%" class="right">Price</th>
              <th style="width:15%" class="right">Total</th>
            </tr>
          </thead>
          <tbody>
            ${(sale.items || []).map((item) => {
              const discount = item.discount ?? item.discPercent ?? 0
              const taxMark = (item.taxRate ?? 0) > 0 ? ' <strong>(T)</strong>' : ''
              return `
                <tr>
                  <td>${item.name}${taxMark}</td>
                  ${config.showHsn ? `<td>${item.hsnCode || item.hsn_code || ''}</td>` : ''}
                  ${config.showAttr ? `<td>${item.brand || item.attribute || item.batch || ''}</td>` : ''}
                  ${config.showSize ? `<td>${item.unit || item.size || item.package || ''}</td>` : ''}
                  ${config.showDisc ? `<td style="text-align:right">${discount}%</td>` : ''}
                  <td style="text-align:right">${item.qty || 0}</td>
                  <td style="text-align:right">${formatCurrency(item.price)}</td>
                  <td style="text-align:right">${formatCurrency(item.lineTotal || item.qty * item.price)}</td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>

        <div class="divider"></div>
        <table class="summary">
          <tr>
            <td>Subtotal</td>
            <td class="right">${formatCurrency(sale.subtotal || sale.items?.reduce((sum, i) => sum + (i.lineTotal || i.qty * i.price), 0) || 0)}</td>
          </tr>
          <tr>
            <td>Tax Amount</td>
            <td class="right">${formatCurrency(sale.taxTotal || sale.tax_total || 0)}</td>
          </tr>
          <tr class="bold">
            <td>RECEIPT TOTAL</td>
            <td class="right">${formatCurrency(sale.total || 0)}</td>
          </tr>
        </table>

        ${config.showPayment ? `
          <table class="summary">
            <tr>
              <td>Payment Mode</td>
              <td class="right">${formatSettlementLabel({
                paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
                storeCreditApplied: sale.storeCreditApplied,
                payments: sale.payments,
              })}</td>
            </tr>
          </table>
        ` : ''}

        <div class="divider"></div>
        <div class="center footer-note">
          <div>${config.footerMsg}</div>
          <div>${config.footerNote}</div>
        </div>
      </body>
      </html>
    `

    const win = window.open('', '_blank', 'width=420,height=900')
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
        ? `Account credit: ${fmt(sale.storeCreditApplied)}\n`
        : '') +
      `\n` +
      `Thank you for your purchase! 🙏`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale) return null

  useImperativeHandle(ref, () => ({
    print: printReceipt
  }))

  const billToName = sale.customerName && sale.customerName !== 'Walk-in' ? sale.customerName : 'Walk-in'

  return (
    <div>
      <div ref={previewRef} style={{
        fontFamily: "'Courier New', monospace",
        fontSize: 11,
        background: '#fff',
        color: '#000',
        padding: '16px',
        border: '1px dashed var(--border-default)',
        borderRadius: 8,
        maxWidth: 420,
        margin: '0 auto',
        lineHeight: 1.4,
      }}>
        {(config.showPrintedDate || config.showStore || config.showCashier) && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8, fontSize: 10 }}>
            {config.showPrintedDate && <div>Printed: {fmtDateTime(new Date())}</div>}
            {config.showStore && <div>Store: {branch?.name || 'C.Shop'}</div>}
            {config.showCashier && <div>Cashier: Admin</div>}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginBottom: 8, fontSize: 10 }}>
          <div></div>
          {/* <div style={{ textAlign: 'right', fontWeight: 700, textTransform: 'uppercase' }}>Sales Receipt #HELD</div> */}
        </div>

        {config.headerStyle === 'logo' ? (
          <div style={{ textAlign: 'center', marginBottom: 6 }}>
            {(branch?.logo || branch?.logo_url) ? (
              <img src={branch.logo || branch.logo_url} alt={branch?.name || 'C.Shop'} style={{ maxWidth: 120, maxHeight: 48, objectFit: 'contain' }} />
            ) : (
              <div style={{ fontSize: 18, fontWeight: 700 }}>{branch?.name || 'C.Shop'}</div>
            )}
          </div>
        ) : (
          <>
            <div style={{ textAlign: 'center', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>REPRINTED</div>
            <div style={{ textAlign: 'center', fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{branch?.company || 'Champa Brothers Maldives Pvt Ltd'}</div>
            {config.headerStyle === 'full' && (
              <>
                <div style={{ textAlign: 'center', fontSize: 11 }}>{branch?.address || 'LOT11155 / HULHUMALE PHASE 01'}</div>
                <div style={{ textAlign: 'center', fontSize: 11 }}>PHONE : {branch?.phone || '3350000'} / VIBER : 7957182</div>
              </>
            )}
          </>
        )}
        <div style={{ textAlign: 'center', fontWeight: 700, margin: '10px 0 2px' }}>TAX INVOICE</div>
        {config.headerStyle === 'full' && <div style={{ textAlign: 'center', fontSize: 11 }}>TIN: {branch?.gst || '1017548GST501'}</div>}

        <div style={{ borderTop: '1px dashed #999', margin: '8px 0' }} />
        {config.showCustomer && <div style={{ marginBottom: 6 }}><span style={{ fontWeight: 700 }}>Bill To:</span> {billToName}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: getColumnStructure(config), gap: 6, fontWeight: 700, borderBottom: '1px solid #000', paddingBottom: 4, fontSize: 10.5 }}>
          <div>Item Name</div>
          {config.showHsn && <div>HSN</div>}
          {config.showAttr && <div>Attribute</div>}
          {config.showSize && <div>Size</div>}
          {config.showDisc && <div style={{ textAlign: 'right' }}>Disc %</div>}
          <div style={{ textAlign: 'right' }}>Qty</div>
          <div style={{ textAlign: 'right' }}>Price</div>
          <div style={{ textAlign: 'right' }}>Ext Price</div>
        </div>
        {(sale.items || []).map((item, index) => {
          const taxMark = (item.taxRate ?? 0) > 0 ? <strong>(T)</strong> : null
          return (
          <div key={index} style={{ display: 'grid', gridTemplateColumns: getColumnStructure(config), gap: 6, padding: '4px 0', fontSize: 10.5 }}>
            <div>{item.name}{taxMark}</div>
            {config.showHsn && <div>{item.hsnCode || item.hsn_code || ''}</div>}
            {config.showAttr && <div>{item.brand || item.attribute || item.batch || ''}</div>}
            {config.showSize && <div>{item.unit || item.size || item.package || ''}</div>}
            {config.showDisc && <div style={{ textAlign: 'right' }}>{item.discount ?? item.discPercent ?? 0}%</div>}
            <div style={{ textAlign: 'right' }}>{item.qty || 0}</div>
            <div style={{ textAlign: 'right' }}>{fmt(item.price)}</div>
            <div style={{ textAlign: 'right' }}>{fmt(item.lineTotal || item.qty * item.price)}</div>
          </div>
        )
        })}

        <div style={{ borderTop: '1px dashed #999', margin: '10px 0' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 11, marginBottom: 2 }}>
          <div>Subtotal</div>
          <div style={{ textAlign: 'right' }}>{fmt(sale.subtotal || sale.items?.reduce((sum, i) => sum + (i.lineTotal || i.qty * i.price), 0) || 0)}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 11, marginBottom: 2 }}>
          <div>Tax Amount</div>
          <div style={{ textAlign: 'right' }}>{fmt(sale.taxTotal || sale.tax_total || 0)}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
          <div>RECEIPT TOTAL</div>
          <div style={{ textAlign: 'right' }}>{fmt(sale.total || 0)}</div>
        </div>

        {config.showPayment && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 11, marginBottom: 8 }}>
            <div>Payment Mode</div>
            <div style={{ textAlign: 'right' }}>{formatSettlementLabel({
              paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
              storeCreditApplied: sale.storeCreditApplied,
              payments: sale.payments,
            })}</div>
          </div>
        )}

        <div style={{ borderTop: '1px dashed #999', margin: '8px 0' }} />
        <div style={{ textAlign: 'center', fontSize: 10, lineHeight: 1.6 }}>
          <div>{config.footerMsg}</div>
          <div>{config.footerNote}</div>
        </div>
      </div>
    </div>
  )
})

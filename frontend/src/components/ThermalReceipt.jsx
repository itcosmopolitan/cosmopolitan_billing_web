import { useRef, forwardRef, useImperativeHandle, useEffect } from 'react'
import { fmt, fmtDate, fmtDateTime } from '@/utils/helpers'
import { useInvoiceConfig } from '@/utils/invoiceConfig'
import { formatSettlementLabel } from '@/utils/storeCredit'

// ─── 80mm Thermal Receipt (IFS-style layout) ──────────────────────────────
// Paper width: 80mm → ~300px printable area at 96dpi (72mm content, 4mm margins)
const PAPER_WIDTH_PX = 302

export const ThermalReceipt = forwardRef(function ThermalReceipt({ sale, branch }, ref) {
  const previewRef = useRef(null)
  const barcodeRef = useRef(null)
  const config = useInvoiceConfig()

  const company = branch?.company || 'Champa Brothers Maldives Pvt Ltd'
  const tagline = branch?.tagline || 'Wholesales & Retail'
  const shopName = branch?.name || 'C.Shop'
  const branchLabel = branch?.branchLabel || branch?.name || 'Shop 1 / Male\''
  const address = branch?.address || 'Boduthakurufanu Magu, Male'
  const phone = branch?.phone || '304 3313'
  const mobile = branch?.mobile || '738 4977'
  const email = branch?.email || 'shop-male@cosmopolitan.com.mv'
  const gstNo = branch?.gst || '1017548GST501'
  const logoUrl = branch?.logo || branch?.logo_url

  const bankName = branch?.bankAccountName || 'Cosmopolitan'
  const bankAccount = branch?.bankAccount || ''

  const customerName = sale.customerName && sale.customerName !== 'Walk-in' ? sale.customerName : 'Walk-in'
  const customerTin = sale.customerTin || sale.customer_tin || ''
  const deliveryMethod = sale.deliveryMethod || sale.delivery_method || ''
  const cashierName = sale.cashierName || sale.cashier_name || 'Admin'
  const docNo = sale.number || sale.docNo || ''

  const formatCurrency = (value) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
    return fmt(value)
  }

  const grossAmount = sale.subtotal || sale.items?.reduce((sum, i) => sum + (i.lineTotal || i.qty * i.price), 0) || 0
  const discountAmount = sale.discount || 0
  const gstAmount = sale.taxTotal || sale.tax_total || 0
  const payable = sale.total || 0

  const cashCollected = sale.cashCollected ?? (sale.paymentMode === 'Cash' ? payable : 0)
  const cashRefunded = sale.cashRefunded || 0
  const cardNo = sale.cardNo || sale.card_no || ''
  const cardAmt = sale.cardAmt || sale.card_amt || 0

  // ─── Print (popup window) ───────────────────────────────────────────────
  const printReceipt = () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Receipt ${docNo}</title>
        <style>
          @page { size: 80mm 200mm; margin: 0; }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { width: 80mm; min-width: 80mm; max-width: 80mm; }
          body { font-family: 'Courier New', monospace; font-size: 10.5px; background: white; color: #000; padding: 3mm; }
          .center { text-align: center; }
          .right { text-align: right; }
          .bold { font-weight: bold; }
          .dashed { border-top: 1px dashed #000; margin: 5px 0; }
          .title { font-size: 13px; font-weight: bold; }
          .subtle { font-size: 9.5px; }
          table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
          .item-row td { padding: 1px 0; vertical-align: top; }
          .item-desc { font-weight: bold; }
          .box { border: 1px solid #000; padding: 4px 6px; margin: 6px 0; }
          .box-title { text-align: center; font-weight: bold; font-size: 10px; border-bottom: 1px dashed #000; margin-bottom: 3px; padding-bottom: 2px; }
          .kv { display: flex; justify-content: space-between; font-size: 9.5px; padding: 1px 0; }
          .kv .label { flex: 0 0 40%; }
          .kv .value { flex: 1; text-align: right; }
          .disclaimer { font-size: 8.5px; margin-top: 6px; }
          .disclaimer li { margin-left: 12px; }
          @media print {
            @page { size: 80mm 200mm; margin: 0; }
            html, body { width: 80mm; min-width: 80mm; max-width: 80mm; }
            body { padding: 2mm; }
          }
        </style>
      </head>
      <body>
        <div class="center subtle bold" style="margin-bottom:4px;">Branch : ${branchLabel}</div>
        <div class="dashed"></div>

        <div class="center" style="margin-bottom:4px;">
          ${logoUrl ? `<img src="${logoUrl}" alt="${shopName}" style="max-width:90px;max-height:40px;object-fit:contain;" />` : ''}
          <div class="title">${company}</div>
          <div class="subtle">${tagline}</div>
          <div class="subtle">${address}</div>
          <div class="subtle">Tel: ${phone}  M: ${mobile}</div>
        </div>
        <div class="center subtle" style="margin-bottom:2px;">E : ${email}</div>
        <div class="center subtle bold" style="margin-bottom:4px;">TIN: ${gstNo}</div>

        <div class="center bold" style="margin:4px 0;">Tax Invoice / Receipt</div>
        <div class="dashed"></div>

        <table>
          <thead>
            <tr class="bold">
              <td style="width:12%">Sno</td>
              <td>Product Description</td>
              <td class="right" style="width:22%">MVR</td>
            </tr>
          </thead>
          <tbody>
            ${(sale.items || []).map((item, idx) => {
              const netAmt = item.lineTotal || item.qty * item.price
              const disc = item.discount ?? item.discPercent ?? 0
              const gstVal = item.gstValue ?? item.taxAmount ?? 0
              return `
                <tr class="item-row">
                  <td colspan="3">
                    <div style="display:flex;"><span class="bold" style="flex:0 0 12%;">${idx + 1}</span><span style="flex:1;">${item.name}</span></div>
                  </td>
                </tr>
                <tr class="item-row">
                  <td colspan="3">
                    <table style="width:100%;font-size:9px;">
                      <tr class="bold"><td>UOM</td><td class="right">Qty</td><td class="right">Rate</td><td class="right">Disc.</td><td class="right">GST</td><td class="right">Net Amt</td></tr>
                      <tr><td>${item.unit || item.size || item.package || '1/1'}</td><td class="right">${item.qty || 0}</td><td class="right">${formatCurrency(item.price)}</td><td class="right">${disc}%</td><td class="right">${formatCurrency(gstVal)}</td><td class="right">${formatCurrency(netAmt)}</td></tr>
                    </table>
                  </td>
                </tr>
                <tr><td colspan="3"><div class="dashed"></div></td></tr>
              `
            }).join('')}
          </tbody>
        </table>

        <div class="box">
          <div class="box-title">Summary</div>
          <div class="kv"><span class="label">Gross Amount</span><span class="value">${formatCurrency(grossAmount)}</span></div>
          <div class="kv"><span class="label">Discount</span><span class="value">${formatCurrency(discountAmount)}</span></div>
          <div class="kv"><span class="label">GST Value</span><span class="value">${formatCurrency(gstAmount)}</span></div>
          <div class="kv bold"><span class="label">Payable</span><span class="value">${formatCurrency(payable)}</span></div>
          <div class="kv bold"><span class="label">Invoice Amount (MVR)</span><span class="value">${formatCurrency(payable)}</span></div>
        </div>

        ${config.showPayment !== false ? `
          <div class="box">
            <div class="box-title">Payment Details</div>
            <div class="kv"><span class="label">Cash Collected</span><span class="value">${formatCurrency(cashCollected)}</span></div>
            <div class="kv"><span class="label">Cash Refunded</span><span class="value">${formatCurrency(-Math.abs(cashRefunded))}</span></div>
            <div class="kv"><span class="label">Credit / Debit Card No</span><span class="value">${cardNo || '—'}</span></div>
            ${cardNo ? `<div class="kv"><span class="label">Card Amt</span><span class="value">${formatCurrency(cardAmt)}</span></div>` : ''}
            <div class="kv" style="margin-top:2px;"><span class="label">Payment Mode</span><span class="value">${formatSettlementLabel({
              paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
              storeCreditApplied: sale.storeCreditApplied,
              payments: sale.payments,
            })}</span></div>
          </div>
        ` : ''}

        <div class="box">
          <div class="box-title">Customer Details</div>
          <div class="kv"><span class="label">Customer</span><span class="value">${customerName}</span></div>
          ${customerTin ? `<div class="kv"><span class="label">TIN</span><span class="value">${customerTin}</span></div>` : ''}
          ${deliveryMethod ? `<div class="kv"><span class="label">Delivery</span><span class="value">${deliveryMethod}</span></div>` : ''}
          <div class="kv"><span class="label">Cashier</span><span class="value">${cashierName}</span></div>
          <div class="kv"><span class="label">Date</span><span class="value">${fmtDateTime(sale.date || new Date())}</span></div>
          <div class="kv"><span class="label">Doc.No</span><span class="value">${docNo}</span></div>
        </div>

        ${bankAccount ? `
          <div class="box">
            <div class="box-title">Bank Details</div>
            <div class="kv"><span class="label">Account Name</span><span class="value">${bankName}</span></div>
            <div class="kv"><span class="label">A/c No</span><span class="value">${bankAccount}</span></div>
          </div>
        ` : ''}

        <div class="dashed"></div>
        <div class="center bold" style="margin-bottom:4px;">Thank You! Visit Us Again</div>

        <div class="disclaimer">
          <div class="bold">Disclaimer:</div>
          <ol style="padding-left:14px;">
            <li>Jurisdiction Male, Republic of Maldives.</li>
            <li>This is a computer generated invoice / Receipt and hence no signature required.</li>
            <li>No Returns Accepted.</li>
          </ol>
        </div>

        <div class="center" style="margin-top:8px;">
          <svg id="print-barcode"></svg>
          <div class="subtle">${docNo}</div>
        </div>

        <script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js"></script>
        <script>
          try {
            JsBarcode("#print-barcode", "${docNo}", { format: "CODE128", width: 1.4, height: 36, fontSize: 0, margin: 0 });
          } catch (e) {}
        </script>
      </body>
      </html>
    `

    const win = window.open('', '_blank', 'width=340,height=900')
    win.document.write(html)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 600)
  }

  const shareWhatsApp = () => {
    const items = (sale.items || []).map(i => `• ${i.name} x${i.qty} = MVR${i.lineTotal || i.qty * i.price}`).join('\n')
    const msg = `*${company} — ${branchLabel}*\n` +
      `Invoice: *${docNo}*\n` +
      `Date: ${fmtDate(sale.date || new Date())}\n` +
      `─────────────────\n${items}\n` +
      `─────────────────\n` +
      `Gross amount: MVR${grossAmount.toLocaleString('en-MV')}\n` +
      (discountAmount ? `Discount: -MVR${discountAmount.toLocaleString('en-MV')}\n` : '') +
      `GST value: MVR${gstAmount.toLocaleString('en-MV')}\n` +
      `*Payable: MVR${payable.toLocaleString('en-MV')}*\n` +
      `Payment: ${formatSettlementLabel({
        paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
        storeCreditApplied: sale.storeCreditApplied,
        payments: sale.payments,
      })}\n` +
      (Number(sale.storeCreditApplied || 0) > 0 ? `Account credit: ${fmt(sale.storeCreditApplied)}\n` : '') +
      `\nThank you for your purchase! 🙏`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale) return null

  useImperativeHandle(ref, () => ({
    print: printReceipt
  }))

  // Render on-screen preview barcode once the component mounts / sale changes
  useEffect(() => {
    let cancelled = false
    import('jsbarcode').then((mod) => {
      if (cancelled || !barcodeRef.current || !docNo) return
      const JsBarcode = mod.default || mod
      try {
        JsBarcode(barcodeRef.current, docNo, { format: 'CODE128', width: 1.3, height: 34, fontSize: 0, margin: 0 })
      } catch (e) { /* ignore invalid values */ }
    }).catch(() => { /* jsbarcode not installed — barcode preview skipped */ })
    return () => { cancelled = true }
  }, [docNo])

  // ─── On-screen preview ───────────────────────────────────────────────────
  return (
    <div>
      <div ref={previewRef} style={{
        fontFamily: "'Courier New', monospace",
        fontSize: 10.5,
        background: '#fff',
        color: '#000',
        padding: '12px',
        border: '1px dashed var(--border-default)',
        borderRadius: 8,
        maxWidth: PAPER_WIDTH_PX,
        margin: '0 auto',
        lineHeight: 1.4,
      }}>
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 10 }}>Branch : {branchLabel}</div>
        <div style={{ borderTop: '1px dashed #999', margin: '5px 0' }} />

        <div style={{ textAlign: 'center', marginBottom: 4 }}>
          {logoUrl && <img src={logoUrl} alt={shopName} style={{ maxWidth: 90, maxHeight: 40, objectFit: 'contain' }} />}
          <div style={{ fontSize: 13, fontWeight: 700 }}>{company}</div>
          <div style={{ fontSize: 9.5 }}>{tagline}</div>
          <div style={{ fontSize: 9.5 }}>{address}</div>
          <div style={{ fontSize: 9.5 }}>Tel: {phone}  M: {mobile}</div>
        </div>
        <div style={{ textAlign: 'center', fontSize: 9.5 }}>E : {email}</div>
        <div style={{ textAlign: 'center', fontSize: 9.5, fontWeight: 700, marginBottom: 4 }}>TIN: {gstNo}</div>

        <div style={{ textAlign: 'center', fontWeight: 700, margin: '4px 0' }}>Tax Invoice / Receipt</div>
        <div style={{ borderTop: '1px dashed #999', margin: '5px 0' }} />

        <div style={{ display: 'flex', fontWeight: 700, fontSize: 9.5 }}>
          <div style={{ flex: '0 0 12%' }}>Sno</div>
          <div style={{ flex: 1 }}>Product Description</div>
        </div>
        {(sale.items || []).map((item, idx) => {
          const netAmt = item.lineTotal || item.qty * item.price
          const disc = item.discount ?? item.discPercent ?? 0
          const gstVal = item.gstValue ?? item.taxAmount ?? 0
          return (
            <div key={idx}>
              <div style={{ display: 'flex', fontSize: 9.5, marginTop: 4 }}>
                <div style={{ flex: '0 0 12%', fontWeight: 700 }}>{idx + 1}</div>
                <div style={{ flex: 1 }}>{item.name}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', fontSize: 9, marginTop: 2 }}>
                <div style={{ fontWeight: 700 }}>UOM</div>
                <div style={{ fontWeight: 700, textAlign: 'right' }}>Qty</div>
                <div style={{ fontWeight: 700, textAlign: 'right' }}>Rate</div>
                <div style={{ fontWeight: 700, textAlign: 'right' }}>Disc.</div>
                <div style={{ fontWeight: 700, textAlign: 'right' }}>GST</div>
                <div style={{ fontWeight: 700, textAlign: 'right' }}>Net Amt</div>
                <div>{item.unit || item.size || item.package || '1/1'}</div>
                <div style={{ textAlign: 'right' }}>{item.qty || 0}</div>
                <div style={{ textAlign: 'right' }}>{fmt(item.price)}</div>
                <div style={{ textAlign: 'right' }}>{disc}%</div>
                <div style={{ textAlign: 'right' }}>{fmt(gstVal)}</div>
                <div style={{ textAlign: 'right' }}>{fmt(netAmt)}</div>
              </div>
              <div style={{ borderTop: '1px dashed #999', margin: '5px 0' }} />
            </div>
          )
        })}

        <div style={{ border: '1px solid #000', padding: '4px 6px', margin: '6px 0' }}>
          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 10, borderBottom: '1px dashed #000', marginBottom: 3, paddingBottom: 2 }}>Summary</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Gross Amount</span><span>{fmt(grossAmount)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Discount</span><span>{fmt(discountAmount)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>GST Value</span><span>{fmt(gstAmount)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, fontWeight: 700 }}><span>Payable</span><span>{fmt(payable)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, fontWeight: 700 }}><span>Invoice Amount (MVR)</span><span>{fmt(payable)}</span></div>
        </div>

        {config.showPayment !== false && (
          <div style={{ border: '1px solid #000', padding: '4px 6px', margin: '6px 0' }}>
            <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 10, borderBottom: '1px dashed #000', marginBottom: 3, paddingBottom: 2 }}>Payment Details</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Cash Collected</span><span>{fmt(cashCollected)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Cash Refunded</span><span>{fmt(-Math.abs(cashRefunded))}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Credit / Debit Card No</span><span>{cardNo || '—'}</span></div>
            {cardNo && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Card Amt</span><span>{fmt(cardAmt)}</span></div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, marginTop: 2 }}>
              <span>Payment Mode</span>
              <span>{formatSettlementLabel({
                paymentMode: sale.paymentMode || sale.payment_mode || sale.method,
                storeCreditApplied: sale.storeCreditApplied,
                payments: sale.payments,
              })}</span>
            </div>
          </div>
        )}

        <div style={{ border: '1px solid #000', padding: '4px 6px', margin: '6px 0' }}>
          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 10, borderBottom: '1px dashed #000', marginBottom: 3, paddingBottom: 2 }}>Customer Details</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Customer</span><span>{customerName}</span></div>
          {customerTin && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>TIN</span><span>{customerTin}</span></div>}
          {deliveryMethod && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Delivery</span><span>{deliveryMethod}</span></div>}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Cashier</span><span>{cashierName}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Date</span><span>{fmtDateTime(sale.date || new Date())}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Doc.No</span><span>{docNo}</span></div>
        </div>

        {bankAccount && (
          <div style={{ border: '1px solid #000', padding: '4px 6px', margin: '6px 0' }}>
            <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 10, borderBottom: '1px dashed #000', marginBottom: 3, paddingBottom: 2 }}>Bank Details</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>Account Name</span><span>{bankName}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5 }}><span>A/c No</span><span>{bankAccount}</span></div>
          </div>
        )}

        <div style={{ borderTop: '1px dashed #999', margin: '8px 0' }} />
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 10, marginBottom: 4 }}>Thank You! Visit Us Again</div>

        <div style={{ fontSize: 8.5 }}>
          <div style={{ fontWeight: 700 }}>Disclaimer:</div>
          <ol style={{ paddingLeft: 14, margin: 0 }}>
            <li>Jurisdiction Male, Republic of Maldives.</li>
            <li>This is a computer generated invoice / Receipt and hence no signature required.</li>
            <li>No Returns Accepted.</li>
          </ol>
        </div>

        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <svg ref={barcodeRef} />
          <div style={{ fontSize: 9.5 }}>{docNo}</div>
        </div>
      </div>
    </div>
  )
})

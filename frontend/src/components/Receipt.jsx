import { useRef } from 'react'
import { fmt, fmtDate } from '@/utils/helpers'

// ─── Thermal Receipt Component ────────────────────────────────────────────────
export function Receipt({ sale, branch, onClose }) {
  const ref = useRef(null)

  const printReceipt = () => {
    const win = window.open('', '_blank', 'width=380,height=700')
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Receipt ${sale.number}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: 'Courier New', monospace; font-size: 12px; background: white; color: #000; padding: 8px; width: 302px; }
          .center { text-align: center; }
          .right   { text-align: right; }
          .bold    { font-weight: bold; }
          .divider { border-top: 1px dashed #000; margin: 6px 0; }
          .logo    { font-size: 16px; font-weight: bold; margin-bottom: 2px; }
          table    { width: 100%; border-collapse: collapse; }
          td       { padding: 2px 0; vertical-align: top; font-size: 11px; }
          .total-row td { font-size: 13px; font-weight: bold; padding-top: 4px; }
          .footer  { font-size: 10px; margin-top: 8px; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="center">
          <div class="logo">Sri Murugan Traders</div>
          <div>${branch?.name || 'Anna Nagar Branch'}</div>
          <div>${branch?.address || 'Chennai'}</div>
          <div>Phone: ${branch?.phone || ''}</div>
          <div>GSTIN: ${branch?.gst || ''}</div>
        </div>
        <div class="divider"></div>
        <div>Invoice: <strong>${sale.number}</strong></div>
        <div>Date: ${fmtDate(sale.date || new Date())}</div>
        <div>Cashier: ${sale.cashier || 'Staff'}</div>
        ${sale.customerName && sale.customerName !== 'Walk-in' ? `<div>Customer: ${sale.customerName}</div>` : ''}
        <div class="divider"></div>
        <table>
          <tr><td class="bold">Item</td><td class="bold right">Qty</td><td class="bold right">Price</td><td class="bold right">Total</td></tr>
          <tr><td colspan="4"><div class="divider" style="margin:2px 0"></div></td></tr>
          ${(sale.items || []).map(item => `
            <tr>
              <td style="max-width:130px;overflow:hidden">${item.name}</td>
              <td class="right">${item.qty}</td>
              <td class="right">₹${item.price}</td>
              <td class="right">₹${item.lineTotal || (item.qty * item.price)}</td>
            </tr>
          `).join('')}
        </table>
        <div class="divider"></div>
        <table>
          <tr><td>Subtotal</td><td class="right">₹${(sale.subtotal || 0).toLocaleString('en-IN')}</td></tr>
          ${(sale.discount || 0) > 0 ? `<tr><td>Discount</td><td class="right">-₹${sale.discount.toLocaleString('en-IN')}</td></tr>` : ''}
          <tr><td>GST</td><td class="right">₹${(sale.taxTotal || sale.tax_total || 0).toLocaleString('en-IN')}</td></tr>
          <tr class="total-row"><td>TOTAL</td><td class="right">₹${(sale.total || 0).toLocaleString('en-IN')}</td></tr>
          <tr><td>Payment</td><td class="right">${(sale.paymentMode || sale.payment_mode || 'cash').toUpperCase()}</td></tr>
        </table>
        <div class="divider"></div>
        <div class="center footer">
          <div>Thank you for shopping with us!</div>
          <div>Goods once sold will not be taken back</div>
          <div>For queries: ${branch?.phone || '044-XXXX XXXX'}</div>
          <div style="margin-top:6px">*** THANK YOU — VISIT AGAIN ***</div>
        </div>
      </body>
      </html>
    `)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print(); win.close() }, 500)
  }

  const shareWhatsApp = () => {
    const items = (sale.items || []).map(i => `• ${i.name} x${i.qty} = ₹${i.lineTotal || i.qty * i.price}`).join('\n')
    const msg = `*Sri Murugan Traders — ${branch?.name}*\n` +
      `Invoice: *${sale.number}*\n` +
      `Date: ${fmtDate(sale.date || new Date())}\n` +
      `─────────────────\n${items}\n` +
      `─────────────────\n` +
      `Subtotal: ₹${(sale.subtotal || 0).toLocaleString('en-IN')}\n` +
      (sale.discount ? `Discount: -₹${sale.discount.toLocaleString('en-IN')}\n` : '') +
      `GST: ₹${(sale.taxTotal || sale.tax_total || 0).toLocaleString('en-IN')}\n` +
      `*TOTAL: ₹${(sale.total || 0).toLocaleString('en-IN')}*\n` +
      `Payment: ${(sale.paymentMode || sale.payment_mode || '').toUpperCase()}\n\n` +
      `Thank you for your purchase! 🙏`
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank')
  }

  if (!sale) return null

  return (
    <div>
      {/* Preview */}
      <div ref={ref} style={{
        fontFamily: "'Courier New', monospace",
        fontSize: 12,
        background: '#fff',
        color: '#000',
        padding: '16px',
        border: '1px dashed var(--border-default)',
        borderRadius: 8,
        maxWidth: 302,
        margin: '0 auto',
        lineHeight: 1.5,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 'bold' }}>Sri Murugan Traders</div>
          <div>{branch?.name}</div>
          <div style={{ fontSize: 10.5 }}>{branch?.address}</div>
          <div style={{ fontSize: 10.5 }}>{branch?.phone}</div>
          {branch?.gst && <div style={{ fontSize: 10 }}>GSTIN: {branch.gst}</div>}
        </div>

        <div style={{ borderTop: '1px dashed #999', margin: '6px 0' }} />
        <div>Invoice: <strong>{sale.number}</strong></div>
        <div>Date: {fmtDate(sale.date || new Date())}</div>
        <div>Cashier: {sale.cashier || 'Staff'}</div>
        {sale.customerName && sale.customerName !== 'Walk-in' && <div>Customer: {sale.customerName}</div>}

        <div style={{ borderTop: '1px dashed #999', margin: '6px 0' }} />
        {(sale.items || []).map((item, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 4, fontSize: 11 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{item.qty} × {fmt(item.price)}</span>
            <span style={{ whiteSpace: 'nowrap', minWidth: 60, textAlign: 'right' }}>{fmt(item.lineTotal || item.qty * item.price)}</span>
          </div>
        ))}

        <div style={{ borderTop: '1px dashed #999', margin: '6px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span>Subtotal</span><span>{fmt(sale.subtotal)}</span>
        </div>
        {(sale.discount || 0) > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#e00' }}>
            <span>Discount</span><span>-{fmt(sale.discount)}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span>GST</span><span>{fmt(sale.taxTotal || sale.tax_total)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: 14, marginTop: 4, paddingTop: 4, borderTop: '1px dashed #999' }}>
          <span>TOTAL</span><span>{fmt(sale.total)}</span>
        </div>
        <div style={{ fontSize: 11 }}>Payment: {(sale.paymentMode || sale.payment_mode || '').toUpperCase()}</div>

        <div style={{ textAlign: 'center', marginTop: 8, fontSize: 10.5, borderTop: '1px dashed #999', paddingTop: 6 }}>
          <div>Thank you for shopping with us!</div>
          <div>Goods once sold will not be taken back</div>
          <div style={{ marginTop: 4, fontWeight: 'bold' }}>*** VISIT AGAIN ***</div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center' }}>
        <button className="btn btn-primary" onClick={printReceipt}>🖨 Print Receipt</button>
        <button className="btn btn-success" onClick={shareWhatsApp}>💬 WhatsApp</button>
        <button className="btn btn-secondary" onClick={() => {
          const text = `${sale.number} | ${fmt(sale.total)} | ${sale.customerName || 'Walk-in'}`
          navigator.clipboard?.writeText(text)
          window.open(`mailto:?subject=Invoice ${sale.number}&body=Dear Customer,%0A%0APlease find your invoice details:%0A${encodeURIComponent(`Invoice: ${sale.number}\nTotal: ${fmt(sale.total)}`)}`)
        }}>📧 Email</button>
      </div>
    </div>
  )
}

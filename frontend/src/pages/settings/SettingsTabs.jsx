/**
 * Tab bodies for the Settings page that are mostly read-only / placeholder
 * UI: Tax Config, Document Numbering, Invoice Template. Extracted out of
 * SettingsPage to keep that file under 500 lines and easier to navigate.
 *
 * Org / Branches / Users / Roles tabs remain in the parent because they
 * share the parent's state (form, modals, fetchers). Move them out only
 * once they get bigger.
 */
import toast from 'react-hot-toast'
import { TAX_RATES } from '@/utils/seedData'
import { Card, AlertBar, Tag } from '@/components/ui'

export function TaxConfigTab() {
  return (
    <>
      <AlertBar type="blue" icon="ℹ" style={{ marginBottom: 16 }}>
        Tax rates are used for invoice calculations and GST reports only. Cosmopolitan Pro does not file returns or integrate with government portals.
      </AlertBar>
      <Card title="GST Rate Configuration" bodyPadding={false}>
        <table className="data-table">
          <thead><tr><th>Rate</th><th>Description</th><th>HSN Examples</th><th>Applicable To</th><th></th></tr></thead>
          <tbody>
            {TAX_RATES.map((r) => (
              <tr key={r.rate}>
                <td><span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'DM Mono', color: 'var(--accent)' }}>{r.rate}%</span></td>
                <td><span style={{ fontWeight: 500 }}>{r.label}</span></td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'DM Mono' }}>{r.examples.split(',')[0]}</td>
                <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{r.examples}</td>
                <td><button className="btn btn-ghost btn-xs">Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div style={{ height: 16 }} />
      <Card title="Other Tax Settings">
        {[
          { label: 'Tax Inclusive Pricing', desc: 'Show prices inclusive of GST at POS', value: 'Off' },
          { label: 'Auto-calculate GST on purchases', desc: 'Apply tax rates automatically on purchase entry', value: 'On' },
          { label: 'Show HSN Code on invoices', desc: 'Print HSN/SAC codes on sales invoices', value: 'On' },
          { label: 'CGST + SGST split on invoices', desc: 'Show tax breakup as CGST and SGST separately', value: 'On' },
        ].map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-primary)' }}>{r.label}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{r.desc}</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => toast('Toggle setting')}>{r.value}</button>
          </div>
        ))}
      </Card>
    </>
  )
}

export function NumberingTab() {
  return (
    <Card title="Document Number Formats">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[
          { doc: 'Sales Invoice', prefix: 'INV', format: 'INV-YYYY-####', sample: 'INV-2024-1847', branch: 'Per Branch' },
          { doc: 'Purchase Bill', prefix: 'PUR', format: 'PUR-YYYY-####', sample: 'PUR-2024-0412', branch: 'Centralised' },
          { doc: 'POS Receipt',   prefix: 'POS', format: 'POS-YYYY-####', sample: 'POS-2024-1848', branch: 'Per Branch' },
          { doc: 'Stock Transfer',prefix: 'TRF', format: 'TRF-YYYY-###',  sample: 'TRF-2024-041',  branch: 'Centralised' },
          { doc: 'Credit Note',   prefix: 'CN',  format: 'CN-YYYY-####',  sample: 'CN-2024-0012',  branch: 'Per Branch' },
          { doc: 'Quotation',     prefix: 'QT',  format: 'QT-YYYY-####',  sample: 'QT-2024-0088',  branch: 'Per Branch' },
        ].map((r) => (
          <div key={r.doc} style={{ display: 'grid', gridTemplateColumns: '160px 140px 160px 140px auto', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.doc}</span>
            <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: 'var(--accent)' }}>{r.format}</span>
            <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: 'var(--text-muted)' }}>{r.sample}</span>
            <span style={{ fontSize: 11.5 }}><Tag>{r.branch}</Tag></span>
            <button className="btn btn-ghost btn-xs" onClick={() => toast('Edit format')}>Edit</button>
          </div>
        ))}
      </div>
    </Card>
  )
}

export function InvoiceTemplateTab() {
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <Card title="Invoice Template Settings">
        {[
          { label: 'Header',         options: ['Company name + logo','Logo only','Name only'] },
          { label: 'Show HSN Codes', options: ['Yes','No'] },
          { label: 'Show Item Desc', options: ['Yes','No'] },
          { label: 'Tax Display',    options: ['CGST+SGST','Integrated GST','Total GST only'] },
          { label: 'Footer Text',    type: 'textarea', value: 'Thank you for your business!\nGoods once sold cannot be returned.' },
          { label: 'Terms',          type: 'textarea', value: 'Payment due within 30 days. Interest @ 2% per month on overdue.' },
        ].map((r) => (
          <div key={r.label} style={{ marginBottom: 12 }}>
            <label className="form-label">{r.label}</label>
            {r.type === 'textarea'
              ? <textarea className="form-input" defaultValue={r.value} style={{ height: 64 }} />
              : <select className="form-input"><option>{r.options[0]}</option>{r.options.slice(1).map((o) => <option key={o}>{o}</option>)}</select>}
          </div>
        ))}
        <button className="btn btn-primary btn-sm" onClick={() => toast('Template settings saved')}>Save Template</button>
      </Card>
      <Card title="Invoice Preview">
        <div style={{ border: '1px solid var(--border-default)', borderRadius: 10, padding: 20, fontFamily: 'DM Mono', fontSize: 11.5, background: 'var(--bg-raised)', lineHeight: 1.7 }}>
          <div style={{ textAlign: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>SRI MURUGAN TRADERS PVT LTD</div>
            <div>12, Anna Nagar West, Chennai — 600 040</div>
            <div>GSTIN: 33AAZCS1429R1Z1 | Ph: 044-2626 1234</div>
          </div>
          <div style={{ textAlign: 'center', fontWeight: 700, borderTop: '1px solid var(--border-default)', borderBottom: '1px solid var(--border-default)', padding: '4px 0', margin: '8px 0' }}>TAX INVOICE</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div><div>Invoice #: INV-2024-1847</div><div>Date: 16/04/2024</div></div>
            <div><div>Customer: Rajesh Stores</div><div>GSTIN: 33ABCDE1234F1Z5</div></div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead><tr>{['Item','Qty','Rate','GST','Amount'].map((h) => <th key={h} style={{ padding: '4px 6px', borderBottom: '1px solid var(--border-default)', textAlign: h === 'Item' ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
            <tbody>
              <tr>{['Basmati Rice 5kg','20','₹299','0%','₹5,980'].map((c, i) => <td key={i} style={{ padding: '3px 6px', textAlign: i === 0 ? 'left' : 'right' }}>{c}</td>)}</tr>
            </tbody>
          </table>
          <div style={{ textAlign: 'right', borderTop: '1px solid var(--border-default)', paddingTop: 6 }}>
            <div>Subtotal: ₹5,980 | CGST: ₹0 | SGST: ₹0</div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Total: ₹5,980</div>
          </div>
        </div>
      </Card>
    </div>
  )
}

/**
 * Tab bodies for the Settings page that are mostly read-only / placeholder
 * UI: Tax Config, Document Numbering, Invoice Template. Extracted out of
 * SettingsPage to keep that file under 500 lines and easier to navigate.
 *
 * Org / Branches / Users / Roles tabs remain in the parent because they
 * share the parent's state (form, modals, fetchers). Move them out only
 * once they get bigger.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { settingsAPI, taxRatesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { useAppStore } from '@/store'
import { Card, AlertBar, Tag, Modal, FormGroup, FormRow } from '@/components/ui'
import { getInvoiceConfig, saveInvoiceConfig, getColumnStructure, getColumnHeaders } from '@/utils/invoiceConfig'

const SCOPE_LABELS = {
  per_branch: 'Per Branch',
  centralised: 'Centralised',
}

const EMPTY_TAX_FORM = { rate: '', label: '', examples: '' }
const INVOICE_CHECKBOX_GROUP_STYLE = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
  columnGap: 20,
  rowGap: 8,
}

/** Client-side preview — mirrors backend `render_number`. */
function previewFormat(prefix, formatStr, seq) {
  const year = new Date().getFullYear()
  let out = (formatStr || '').replace(/PREFIX/g, prefix).replace(/YYYY/g, String(year))
  out = out.replace(/MM/g, String(new Date().getMonth() + 1).padStart(2, '0'))
  out = out.replace(/DD/g, String(new Date().getDate()).padStart(2, '0'))
  const m = /(#+)/.exec(out)
  if (!m) return out
  const pad = m[1].length
  return out.slice(0, m.index) + String(seq).padStart(pad, '0') + out.slice(m.index + pad)
}

export function TaxConfigTab() {
  const can = useCan()
  const taxPricingMode = useAppStore((s) => s.taxPricingMode)
  const setTaxPricingMode = useAppStore((s) => s.setTaxPricingMode)
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [savingMode, setSavingMode] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_TAX_FORM)
  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const loadRates = useCallback(async () => {
    try {
      setLoading(true)
      const data = await taxRatesAPI.list()
      setRates(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error(err)
      setRates([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRates() }, [loadRates])

  useEffect(() => {
    taxRatesAPI.getSettings()
      .then((s) => setTaxPricingMode(s?.tax_pricing_mode || 'inclusive'))
      .catch((err) => console.error(err))
      .finally(() => setSettingsLoading(false))
  }, [setTaxPricingMode])

  const toggleTaxPricingMode = async () => {
    const next = taxPricingMode === 'inclusive' ? 'exclusive' : 'inclusive'
    setSavingMode(true)
    try {
      const res = await taxRatesAPI.updateSettings({ tax_pricing_mode: next })
      setTaxPricingMode(res?.tax_pricing_mode || next)
      toast.success(`Pricing set to ${next === 'inclusive' ? 'tax inclusive' : 'tax exclusive'}`)
    } catch (err) {
      console.error(err)
    } finally {
      setSavingMode(false)
    }
  }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_TAX_FORM)
    setShowModal(true)
  }

  const openEdit = (tax) => {
    setEditing(tax)
    setForm({
      rate: String(tax.rate),
      label: tax.label,
      examples: tax.examples || '',
    })
    setShowModal(true)
  }

  const saveTax = async () => {
    const rate = Number(form.rate)
    if (Number.isNaN(rate) || rate < 0 || rate > 100) {
      toast.error('Enter a valid rate between 0 and 100')
      return
    }
    if (!form.label.trim()) {
      toast.error('Label is required')
      return
    }
    const payload = {
      rate,
      label: form.label.trim(),
      examples: form.examples.trim(),
    }
    try {
      if (editing) {
        await taxRatesAPI.update(editing.id, payload)
        toast.success('Tax rate updated')
      } else {
        await taxRatesAPI.create(payload)
        toast.success('Tax rate created')
      }
      setShowModal(false)
      setEditing(null)
      setForm(EMPTY_TAX_FORM)
      await loadRates()
    } catch (err) {
      console.error(err)
    }
  }

  const deleteTax = async (tax) => {
    if (tax.is_system) {
      toast.error('Default tax rates cannot be deleted')
      return
    }
    if (!window.confirm(`Delete "${tax.label}" (${tax.rate}%)?`)) return
    try {
      await taxRatesAPI.delete(tax.id)
      toast.success('Tax rate deleted')
      await loadRates()
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <>
      <AlertBar type="blue" icon="ℹ" style={{ marginBottom: 16 }}>
        Tax rates are used for invoice calculations and GST reports only. Cosmopolitan Pro does not file returns or integrate with government portals.
      </AlertBar>
      <Card
        title="GST Rate Configuration"
        titleRight={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {can('settings.edit') ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={toggleTaxPricingMode}
                disabled={settingsLoading || savingMode}
                title={taxPricingMode === 'inclusive'
                  ? 'Shelf prices include tax'
                  : 'Tax added at checkout'}
              >
                {settingsLoading ? '…' : (taxPricingMode === 'inclusive' ? 'Tax inclusive' : 'Tax exclusive')}
              </button>
            ) : (
              <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>
                {taxPricingMode === 'inclusive' ? 'Tax inclusive' : 'Tax exclusive'}
              </span>
            )}
            {can('settings.edit') && (
              <button className="btn btn-primary btn-sm" onClick={openCreate}>+ Add Tax Rate</button>
            )}
          </div>
        }
        bodyPadding={false}
      >
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading tax rates…
          </div>
        ) : rates.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No tax rates configured. Add 0% and 8% or create custom rates.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th className="text-right">Rate</th>
                <th>Description</th>
                <th>Applicable To</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rates.filter((r) => r.active !== false).map((r) => (
                <tr key={r.id}>
                  <td className="text-right">
                    <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
                      {r.rate}%
                    </span>
                  </td>
                  <td><span style={{ fontWeight: 500 }}>{r.label}</span></td>
                  <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{r.examples || '—'}</td>
                  <td>
                    {can('settings.edit') && (
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => openEdit(r)}>Edit</button>
                        {!r.is_system && (
                          <button className="btn btn-danger btn-xs" onClick={() => deleteTax(r)}>Delete</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal
        open={showModal}
        onClose={() => { setShowModal(false); setEditing(null) }}
        title={editing ? 'Edit Tax Rate' : 'Add Tax Rate'}
        icon="🧾"
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setShowModal(false); setEditing(null) }}>Cancel</button>
            <button className="btn btn-primary" onClick={saveTax}>{editing ? 'Save Changes' : 'Create Tax Rate'}</button>
          </>
        }
      >
        <FormRow>
          <FormGroup label="Rate (%)" required>
            <input
              className="form-input"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={form.rate}
              onChange={(e) => pf('rate', e.target.value)}
              disabled={!!editing?.is_system}
            />
          </FormGroup>
          <FormGroup label="Label" required>
            <input
              className="form-input"
              value={form.label}
              onChange={(e) => pf('label', e.target.value)}
              placeholder="e.g. GST 8%"
            />
          </FormGroup>
        </FormRow>
        <FormGroup label="Applicable To (optional)">
          <textarea
            className="form-input"
            style={{ height: 72 }}
            value={form.examples}
            onChange={(e) => pf('examples', e.target.value)}
            placeholder="Describe which products use this rate"
          />
        </FormGroup>
        {editing?.is_system && (
          <AlertBar type="blue" icon="ℹ">
            Default rates (0% and 8%) cannot be deleted. You can edit the label and description.
          </AlertBar>
        )}
      </Modal>
    </>
  )
}

export function NumberingTab() {
  const can = useCan()
  const canEdit = can('settings.edit')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ prefix: '', format: '', scope: 'per_branch', next_seq: 1 })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await settingsAPI.listNumbering()
      setRows(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error(e)
      toast.error('Failed to load document numbering')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const liveSample = useMemo(() => {
    if (!editing) return ''
    return previewFormat(form.prefix, form.format, Number(form.next_seq) || 1)
  }, [editing, form.prefix, form.format, form.next_seq])

  const openEdit = (row) => {
    setEditing(row)
    setForm({
      prefix: row.prefix,
      format: row.format,
      scope: row.scope,
      next_seq: row.next_seq,
    })
  }

  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const save = async () => {
    if (!editing) return
    if (!form.prefix?.trim()) {
      toast.error('Prefix is required')
      return
    }
    if (!/#+/.test(form.format || '')) {
      toast.error('Format must include # placeholders for the sequence (e.g. INV-YYYY-####)')
      return
    }
    setSaving(true)
    try {
      const updated = await settingsAPI.updateNumbering(editing.doc_type, {
        prefix: form.prefix.trim(),
        format: form.format.trim(),
        scope: form.scope,
        next_seq: Number(form.next_seq),
      })
      setRows((prev) => prev.map((r) => (r.doc_type === updated.doc_type ? updated : r)))
      toast.success(`${editing.label} numbering saved`)
      setEditing(null)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <AlertBar type="blue" icon="ℹ" style={{ marginBottom: 16 }}>
        Configure how invoices, bills, and other documents are numbered. Changes apply to newly created documents. Use <code>YYYY</code>, <code>MM</code>, <code>DD</code>, and <code>#</code> for the auto-increment sequence.
      </AlertBar>
      <Card title="Document Number Formats">
        {loading ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
            No numbering rules found. Restart the backend to seed defaults, or run <code>python src/seed.py</code>.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r) => (
              <div key={r.doc_type} style={{ display: 'grid', gridTemplateColumns: '160px 140px 160px 120px auto', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.label}</span>
                <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: 'var(--accent)' }}>{r.format}</span>
                <span style={{ fontSize: 12, fontFamily: 'DM Mono', color: 'var(--text-muted)' }}>{r.sample}</span>
                <span style={{ fontSize: 11.5 }}><Tag>{SCOPE_LABELS[r.scope] || r.scope}</Tag></span>
                {canEdit ? (
                  <button className="btn btn-ghost btn-xs" onClick={() => openEdit(r)}>Edit</button>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>View only</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={!!editing}
        onClose={() => !saving && setEditing(null)}
        title={editing ? `Edit — ${editing.label}` : 'Edit format'}
        icon="🔢"
        size="md"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <FormRow>
          <FormGroup label="Prefix" required>
            <input className="form-input" value={form.prefix} onChange={(e) => pf('prefix', e.target.value)} />
          </FormGroup>
          <FormGroup label="Scope" required>
            <select className="form-input" value={form.scope} onChange={(e) => pf('scope', e.target.value)}>
              <option value="per_branch">Per Branch</option>
              <option value="centralised">Centralised</option>
            </select>
          </FormGroup>
        </FormRow>
        <FormGroup label="Format" required>
          <input
            className="form-input"
            value={form.format}
            onChange={(e) => pf('format', e.target.value)}
            placeholder="INV-YYYY-####"
            style={{ fontFamily: 'DM Mono' }}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Example: INV-YYYY-#### — the # group sets sequence width (4 digits).
          </div>
        </FormGroup>
        <FormGroup label="Next sequence number">
          <input
            className="form-input"
            type="number"
            min={1}
            value={form.next_seq}
            onChange={(e) => pf('next_seq', e.target.value)}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Resets counters for this document type to start from this number.
          </div>
        </FormGroup>
        <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Preview</div>
          <div style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--accent)' }}>{liveSample || '—'}</div>
        </div>
      </Modal>
    </>
  )
}

export function InvoiceTemplateTab() {
  const savedConfig = useMemo(() => getInvoiceConfig(), [])
  const [headerStyle, setHeaderStyle] = useState(savedConfig.headerStyle)
  const [showAttr, setShowAttr] = useState(savedConfig.showAttr)
  const [showSize, setShowSize] = useState(savedConfig.showSize)
  const [showDisc, setShowDisc] = useState(savedConfig.showDisc)
  const [showHsn, setShowHsn] = useState(savedConfig.showHsn)
  const [taxMode, setTaxMode] = useState(savedConfig.taxMode)
  const [showCustomer, setShowCustomer] = useState(savedConfig.showCustomer)
  const [showPayment, setShowPayment] = useState(savedConfig.showPayment)
  const [showPrintedDate, setShowPrintedDate] = useState(savedConfig.showPrintedDate)
  const [showStore, setShowStore] = useState(savedConfig.showStore)
  const [showCashier, setShowCashier] = useState(savedConfig.showCashier)
  const [footerMsg, setFooterMsg] = useState(savedConfig.footerMsg)
  const [footerNote, setFooterNote] = useState(savedConfig.footerNote)

  const sampleItems = [
    { name: 'Milk Powder 2.5Kg', hsn: '1901', attr: 'Fine Quality', size: '2.5KG', disc: '0', qty: '1', price: 'MVR270.00', cgst: '0', sgst: '0', total: 'MVR270.00' },
    { name: 'milky mist Milk Full Cream', hsn: '0401', attr: 'Fresh', size: '1Ltr', disc: '5', qty: '2', price: 'MVR17.80', cgst: '0.90', sgst: '0.90', total: 'MVR35.60' },
  ]

  const currentConfig = useMemo(() => ({
    headerStyle, showAttr, showSize, showDisc, showHsn, taxMode, showCustomer, showPayment, showPrintedDate, showStore, showCashier, footerMsg, footerNote
  }), [headerStyle, showAttr, showSize, showDisc, showHsn, taxMode, showCustomer, showPayment, showPrintedDate, showStore, showCashier, footerMsg, footerNote])

  const columnGrid = useMemo(() => getColumnStructure(currentConfig), [currentConfig])
  const columnHeaders = useMemo(() => getColumnHeaders(currentConfig), [currentConfig])

  const handleSave = () => {
    saveInvoiceConfig(currentConfig)
    toast.success('Invoice template saved!')
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
      <Card title="Invoice Template Settings">
        <FormGroup label="Header Style">
          <select className="form-input" value={headerStyle} onChange={(e) => setHeaderStyle(e.target.value)}>
            <option value="full">Full (name, address, GST, phone)</option>
            <option value="nameonly">Name only</option>
            <option value="logo">Logo only</option>
          </select>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Company name, address, GST ID, and phone</div>
        </FormGroup>

        <FormGroup label="Item Details to Show" required>
          <div style={INVOICE_CHECKBOX_GROUP_STYLE}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showAttr} onChange={(e) => setShowAttr(e.target.checked)} />
              <span>Item attributes (color, size, etc.)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showSize} onChange={(e) => setShowSize(e.target.checked)} />
              <span>Size column</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showDisc} onChange={(e) => setShowDisc(e.target.checked)} />
              <span>Discount % column</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showHsn} onChange={(e) => setShowHsn(e.target.checked)} />
              <span>HSN codes</span>
            </label>
          </div>
        </FormGroup>

        <FormGroup label="Tax Display Mode">
          <select className="form-input" value={taxMode} onChange={(e) => setTaxMode(e.target.value)}>
            <option value="total">Total only</option>
            <option value="itemized">Show itemized tax breakdown</option>
          </select>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Display tax information at bottom of receipt</div>
        </FormGroup>

        <FormGroup label="Header Fields">
          <div style={INVOICE_CHECKBOX_GROUP_STYLE}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showPrintedDate} onChange={(e) => setShowPrintedDate(e.target.checked)} />
              <span>Show printed date & time</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showStore} onChange={(e) => setShowStore(e.target.checked)} />
              <span>Show store name</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showCashier} onChange={(e) => setShowCashier(e.target.checked)} />
              <span>Show cashier name</span>
            </label>
          </div>
        </FormGroup>

        <FormGroup label="Other Options">
          <div style={INVOICE_CHECKBOX_GROUP_STYLE}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showCustomer} onChange={(e) => setShowCustomer(e.target.checked)} />
              <span>Show customer name / GSTIN</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={showPayment} onChange={(e) => setShowPayment(e.target.checked)} />
              <span>Show payment method</span>
            </label>
          </div>
        </FormGroup>

        <FormGroup label="Footer Message">
          <textarea 
            className="form-input" 
            value={footerMsg} 
            onChange={(e) => setFooterMsg(e.target.value)} 
            style={{ height: 80 }} 
          />
        </FormGroup>

        <FormGroup label="Footer Note (Secondary)">
          <textarea 
            className="form-input" 
            value={footerNote} 
            onChange={(e) => setFooterNote(e.target.value)} 
            style={{ height: 80 }} 
          />
        </FormGroup>

        <button className="btn btn-primary" onClick={handleSave}>💾 Save Template Configuration</button>
      </Card>

      <Card title="Live Preview">
        <div style={{ border: '1px solid var(--border-default)', borderRadius: 10, padding: 16, fontFamily: 'DM Mono, monospace', fontSize: 10.5, color: 'var(--text-primary)', background: 'var(--bg-raised)', lineHeight: 1.4, maxHeight: 600, overflowY: 'auto' }}>
          {/* Top info line */}
          {(showPrintedDate || showStore || showCashier) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 9, marginBottom: 8, textAlign: 'center' }}>
              {showPrintedDate && <div>Printed: 27 May 2026, 2:30 PM</div>}
              {showStore && <div>Store: Champa Shop</div>}
              {showCashier && <div>Cashier: Admin</div>}
            </div>
          )}

          {/* Header */}
          {headerStyle !== 'logo' && (
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              {(headerStyle === 'full' || headerStyle === 'nameonly') && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Champa Brothers Maldives Pvt Ltd</div>
                  {headerStyle === 'full' && (
                    <>
                      <div style={{ fontSize: 10 }}>LOT11155 / HULHUMALE PHASE 01</div>
                      <div style={{ fontSize: 10 }}>PHONE : 3350000 / VIBER : 7957182</div>
                      <div style={{ fontSize: 10 }}>TIN: 1017548GST501</div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          <div style={{ fontWeight: 700, textAlign: 'center', margin: '8px 0', fontSize: 12 }}>TAX INVOICE</div>
          {showCustomer && <div style={{ margin: '6px 0', fontSize: 10 }}><span style={{ fontWeight: 700 }}>Bill To:</span> Sample Customer</div>}

          {/* Column headers */}
          <div style={{ display: `grid`, gridTemplateColumns: columnGrid, gap: 4, fontWeight: 700, borderBottom: '1px solid #000', paddingBottom: 4, marginBottom: 4, fontSize: 10.5 }}>
            {columnHeaders.map((h) => (
              <div key={h} style={{ textAlign: h === 'Item Name' ? 'left' : 'right' }}>{h}</div>
            ))}
          </div>

          {/* Sample rows */}
          {sampleItems.map((item, idx) => (
            <div key={idx} style={{ display: `grid`, gridTemplateColumns: columnGrid, gap: 4, padding: '3px 0', fontSize: 10 }}>
              {['name', 'hsn', 'attr', 'size', 'disc', 'qty', 'price', 'total'].map((field) => {
                if (field === 'hsn' && !showHsn) return null
                if (field === 'attr' && !showAttr) return null
                if (field === 'size' && !showSize) return null
                if (field === 'disc' && !showDisc) return null
                const value = field === 'price' ? item.price : field === 'disc' ? item.disc + '%' : item[field]
                return (
                  <div key={field} style={{ textAlign: ['name'].includes(field) ? 'left' : 'right' }}>
                    {value}
                  </div>
                )
              })}
            </div>
          ))}

          <div style={{ borderTop: '1px solid #000', margin: '8px 0' }} />

          {/* Totals */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 10, marginBottom: 2 }}>
            <div>Subtotal</div>
            <div>MVR305.60</div>
          </div>
          {taxMode === 'itemized' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 10, marginBottom: 2 }}>
              <div>Tax (18%)</div>
              <div>MVR27.50</div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontWeight: 700, fontSize: 11, marginBottom: 2 }}>
            <div>TOTAL</div>
            <div>MVR333.10</div>
          </div>

          {showPayment && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, fontSize: 10 }}>
              <div>Payment</div>
              <div>CASH</div>
            </div>
          )}

          <div style={{ borderTop: '1px solid #000', margin: '8px 0' }} />
          <div style={{ textAlign: 'center', fontSize: 9.5, lineHeight: 1.5 }}>
            <div>{footerMsg}</div>
            <div>{footerNote}</div>
          </div>
        </div>
      </Card>
    </div>
  )
}

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

const SCOPE_LABELS = {
  per_branch: 'Per Branch',
  centralised: 'Centralised',
}

const EMPTY_TAX_FORM = { rate: '', label: '', examples: '' }

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

/**
 * Tab bodies for the Settings page: Tax Config, Document Numbering, Invoice
 * Template. Extracted out of SettingsPage to keep that file easier to navigate.
 *
 * Org / Branches / Users / Roles tabs remain in the parent because they
 * share the parent's state (form, modals, fetchers). Move them out only
 * once they get bigger.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { settingsAPI, taxRatesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { Card, AlertBar, Tag, Modal, FormGroup, FormRow, PaginationBar, SortableHeader, Chip, RowActionsMenu, AutocompleteDropdown } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import {
  apiToConfig,
  configToApi,
  getColumnStructure,
  getColumnHeaders,
  getColumnKeys,
  notifyInvoiceConfigChanged,
  DEFAULT_INVOICE_CONFIG,
} from '@/utils/invoiceConfig'

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

const SAMPLE_BRANCH_CODE = 'TN'

/** Insert BRANCH after the first segment (e.g. CN-YYYY-#### → CN-BRANCH-YYYY-####). */
function ensureBranchInFormat(formatStr) {
  const fmt = (formatStr || '').trim()
  if (!fmt || /\bBRANCH\b/.test(fmt)) return fmt
  const dash = fmt.indexOf('-')
  if (dash === -1) return `${fmt}-BRANCH`
  return `${fmt.slice(0, dash)}-BRANCH${fmt.slice(dash)}`
}

/** Drop BRANCH token and tidy doubled separators. */
function stripBranchFromFormat(formatStr) {
  let out = (formatStr || '')
    .replace(/-BRANCH-/g, '-')
    .replace(/BRANCH-/g, '')
    .replace(/-BRANCH/g, '')
    .replace(/BRANCH/g, '')
  out = out.replace(/-{2,}/g, '-')
  return out.replace(/^-|-$/g, '')
}

/** Client-side preview — mirrors backend `render_number`. */
function previewFormat(prefix, formatStr, seq, { branchCode = SAMPLE_BRANCH_CODE, scope = 'per_branch' } = {}) {
  const year = new Date().getFullYear()
  let out = (formatStr || '').replace(/PREFIX/g, prefix)
  if (/\bBRANCH\b/.test(out)) {
    const code = scope === 'per_branch' ? String(branchCode || '').trim().toUpperCase() : ''
    if (code) {
      out = out.replace(/BRANCH/g, code)
    } else {
      out = stripBranchFromFormat(out)
    }
  }
  out = out.replace(/YYYY/g, String(year))
  out = out.replace(/MM/g, String(new Date().getMonth() + 1).padStart(2, '0'))
  out = out.replace(/DD/g, String(new Date().getDate()).padStart(2, '0'))
  const m = /(#+)/.exec(out)
  if (!m) return out
  const pad = m[1].length
  return out.slice(0, m.index) + String(seq).padStart(pad, '0') + out.slice(m.index + pad)
}

export function TaxConfigTab({ refreshKey = 0 }) {
  const can = useCan()
  const [rates, setRates] = useState([])
  const [taxTotal, setTaxTotal] = useState(0)
  const [taxSkip, setTaxSkip] = useState(0)
  const [taxLimit, setTaxLimit] = useState(DEFAULT_PAGE_SIZE)
  const [taxSortBy, setTaxSortBy] = useState('rate')
  const [taxSortOrder, setTaxSortOrder] = useState('asc')
  const [taxListVersion, setTaxListVersion] = useState(0)
  const [taxHasMorePage, setTaxHasMorePage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [taxSaving, setTaxSaving] = useState(false)
  const [taxRowBusy, setTaxRowBusy] = useState(false)
  const [form, setForm] = useState(EMPTY_TAX_FORM)
  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const syncPageLimit = (perPage, limit) => {
    const effective = perPage ?? limit
    if (effective) setTaxLimit((prev) => (prev === effective ? prev : effective))
  }

  const onTaxSort = (key) => {
    if (taxSortBy === key) setTaxSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    else {
      setTaxSortBy(key)
      setTaxSortOrder('asc')
    }
    setTaxSkip(0)
  }

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const raw = await taxRatesAPI.list({
          skip: taxSkip,
          limit: taxLimit,
          sort_by: taxSortBy,
          sort_order: taxSortOrder,
          active_only: false,
        }, { signal: controller.signal })
        if (!cancelled) {
          const { items, total, limit, perPage, hasMorePage } = unwrapPaged(raw)
          setRates(items || [])
          setTaxTotal(total)
          setTaxHasMorePage(hasMorePage)
          syncPageLimit(perPage, limit)
        }
      } catch (err) {
        if (err?.code === 'ERR_CANCELED') return
        console.error(err)
        if (!cancelled) {
          setRates([])
          setTaxTotal(0)
          setTaxHasMorePage(false)
          toast.error('Failed to load tax configuration')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [refreshKey, taxSkip, taxLimit, taxListVersion, taxSortBy, taxSortOrder])

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
    if (taxSaving) return
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
    setTaxSaving(true)
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
      setTaxListVersion((v) => v + 1)
    } catch (err) {
      console.error(err)
    } finally {
      setTaxSaving(false)
    }
  }

  const toggleTaxActive = async (tax) => {
    if (taxRowBusy || taxSaving) return
    const nextActive = !tax.is_active
    setTaxRowBusy(true)
    try {
      await taxRatesAPI.update(tax.id, { is_active: nextActive })
      toast.success(nextActive ? 'Tax rate marked as active' : 'Tax rate marked as inactive')
      setTaxListVersion((v) => v + 1)
    } catch (err) {
      console.error(err)
    } finally {
      setTaxRowBusy(false)
    }
  }

  return (
    <>
      <Card
        title="GST Rate Configuration"
        titleRight={
          can('settings.edit') ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>+ Add Tax Rate</button>
          ) : null
        }
        bodyPadding={false}
      >
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading tax rates…
          </div>
        ) : taxTotal === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No tax rates configured. Add 0% and 8% or create custom rates.
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Rate" sortKey="rate" sortBy={taxSortBy} sortOrder={taxSortOrder} onSort={onTaxSort} className="text-right" align="right" />
                    <SortableHeader label="Description" sortKey="label" sortBy={taxSortBy} sortOrder={taxSortOrder} onSort={onTaxSort} />
                    <SortableHeader label="Applicable To" sortKey="examples" sortBy={taxSortBy} sortOrder={taxSortOrder} onSort={onTaxSort} />
                    <SortableHeader label="Status" sortKey="is_active" sortBy={taxSortBy} sortOrder={taxSortOrder} onSort={onTaxSort} />
                    <th style={{ width: 48 }} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => (
                    <tr key={r.id}>
                      <td className="text-right">
                        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
                          {r.rate}%
                        </span>
                      </td>
                      <td><span style={{ fontWeight: 500 }}>{r.label}</span></td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{r.examples || '—'}</td>
                      <td><Chip status={r.is_active ? 'active' : 'inactive'} /></td>
                      <td className="text-right">
                        <RowActionsMenu
                          busy={taxRowBusy || taxSaving}
                          ariaLabel={`Actions for ${r.label}`}
                          actions={[
                            {
                              label: 'Edit tax rate',
                              hidden: !can('settings.edit'),
                              onClick: () => openEdit(r),
                            },
                            {
                              label: r.is_active ? 'Mark as inactive' : 'Mark as active',
                              hidden: !can('settings.edit'),
                              onClick: () => toggleTaxActive(r),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PaginationBar
              total={taxTotal}
              skip={taxSkip}
              limit={taxLimit}
              hasMorePage={taxHasMorePage}
              onSkipChange={setTaxSkip}
              onLimitChange={setTaxLimit}
              disabled={loading}
            />
          </>
        )}
      </Card>

      <Modal
        open={showModal}
        onClose={() => { setShowModal(false); setEditing(null) }}
        title={editing ? 'Edit Tax Rate' : 'Add Tax Rate'}
        icon="🧾"
        size="sm"
        busy={taxSaving}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setShowModal(false); setEditing(null) }} disabled={taxSaving}>Cancel</button>
            <button className="btn btn-primary" onClick={saveTax} disabled={taxSaving}>
              {taxSaving ? 'Saving…' : (editing ? 'Save Changes' : 'Create Tax Rate')}
            </button>
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

export function NumberingTab({ refreshKey = 0 }) {
  const can = useCan()
  const canEdit = can('settings.edit')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ prefix: '', format: '', scope: 'per_branch', next_seq: 1 })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (signal) => {
    try {
      setLoading(true)
      const data = await settingsAPI.listNumbering(signal ? { signal } : undefined)
      setRows(Array.isArray(data) ? data : [])
    } catch (e) {
      if (e?.code === 'ERR_CANCELED') return
      console.error(e)
      toast.error('Failed to load document numbering')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load, refreshKey])

  const liveSample = useMemo(() => {
    if (!editing) return ''
    return previewFormat(form.prefix, form.format, Number(form.next_seq) || 1, {
      scope: form.scope,
      branchCode: SAMPLE_BRANCH_CODE,
    })
  }, [editing, form.prefix, form.format, form.next_seq, form.scope])

  const openEdit = (row) => {
    const scope = row.scope || 'per_branch'
    const format = scope === 'per_branch'
      ? ensureBranchInFormat(row.format)
      : row.format
    setEditing(row)
    setForm({
      prefix: row.prefix,
      format,
      scope,
      next_seq: row.next_seq,
    })
  }

  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const onScopeChange = (scope) => {
    setForm((f) => {
      let format = f.format
      if (scope === 'per_branch') format = ensureBranchInFormat(format)
      else format = stripBranchFromFormat(format)
      return { ...f, scope, format }
    })
  }

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
    if (form.scope === 'per_branch' && !/\bBRANCH\b/.test(form.format || '')) {
      toast.error('Per-branch formats should include BRANCH (e.g. CN-BRANCH-YYYY-####)')
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
      <AlertBar className="mb-5" type="blue" icon="ℹ" style={{ marginBottom: 16 }}>
        Configure how invoices, bills, and other documents are numbered. Changes apply to newly created documents. Use <code>YYYY</code>, <code>MM</code>, <code>DD</code>, <code>BRANCH</code> (branch short code when scope is Per Branch), and <code>#</code> for the auto-increment sequence.
      </AlertBar>
      <Card>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
            No numbering rules found. Restart the backend to seed defaults, or run <code>python src/seed.py</code>.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: '22%' }} />
                <col style={{ width: '28%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '12%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Document Type</th>
                  <th>Format</th>
                  <th>Preview</th>
                  <th>Scope</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.doc_type}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{r.label}</td>
                    <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all' }}>
                      {r.format}
                    </td>
                    <td style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                      {r.sample}
                    </td>
                    <td>
                      <Tag>{SCOPE_LABELS[r.scope] || r.scope}</Tag>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {canEdit ? (
                        <button className="btn btn-ghost btn-xs" onClick={() => openEdit(r)}>Edit</button>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>View only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
            <AutocompleteDropdown
              value={form.scope}
              onChange={onScopeChange}
              options={[
                { id: 'per_branch', label: 'Per Branch' },
                { id: 'centralised', label: 'Centralised' },
              ]}
              isSearchFieldRequired={false}
            />
          </FormGroup>
        </FormRow>
        <FormGroup label="Format" required>
          <input
            className="form-input"
            value={form.format}
            onChange={(e) => pf('format', e.target.value)}
            placeholder="CN-BRANCH-YYYY-####"
            style={{ fontFamily: 'DM Mono' }}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Placeholders: <code>PREFIX</code>, <code>BRANCH</code>, <code>YYYY</code>, <code>MM</code>, <code>DD</code>, <code>####</code>.
            {form.scope === 'per_branch' ? (
              <> Per branch: include <code>BRANCH</code> so the branch code appears (e.g. CN-BRANCH-YYYY-#### → CN-{SAMPLE_BRANCH_CODE}-2026-0013).</>
            ) : (
              <> Centralised numbers omit the branch code.</>
            )}
          </div>
          {form.scope === 'per_branch' && !/\bBRANCH\b/.test(form.format || '') && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              style={{ marginTop: 6 }}
              onClick={() => pf('format', ensureBranchInFormat(form.format))}
            >
              Insert BRANCH into format
            </button>
          )}
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
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            Preview{form.scope === 'per_branch' ? ` (sample branch code ${SAMPLE_BRANCH_CODE})` : ''}
          </div>
          <div style={{ fontFamily: 'DM Mono', fontSize: 13, color: 'var(--accent)' }}>{liveSample || '—'}</div>
        </div>
      </Modal>
    </>
  )
}

export function InvoiceTemplateTab({ refreshKey = 0 }) {
  const can = useCan()
  const canEdit = can('settings.edit')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [orgPreview, setOrgPreview] = useState({ name: '', address: '', phone: '', gstin: '' })

  const [headerStyle, setHeaderStyle] = useState(DEFAULT_INVOICE_CONFIG.headerStyle)
  const [showAttr, setShowAttr] = useState(DEFAULT_INVOICE_CONFIG.showAttr)
  const [showSize, setShowSize] = useState(DEFAULT_INVOICE_CONFIG.showSize)
  const [showDisc, setShowDisc] = useState(DEFAULT_INVOICE_CONFIG.showDisc)
  const [showHsn, setShowHsn] = useState(DEFAULT_INVOICE_CONFIG.showHsn)
  const [taxMode, setTaxMode] = useState(DEFAULT_INVOICE_CONFIG.taxMode)
  const [showCustomer, setShowCustomer] = useState(DEFAULT_INVOICE_CONFIG.showCustomer)
  const [showPayment, setShowPayment] = useState(DEFAULT_INVOICE_CONFIG.showPayment)
  const [showPrintedDate, setShowPrintedDate] = useState(DEFAULT_INVOICE_CONFIG.showPrintedDate)
  const [showStore, setShowStore] = useState(DEFAULT_INVOICE_CONFIG.showStore)
  const [showCashier, setShowCashier] = useState(DEFAULT_INVOICE_CONFIG.showCashier)
  const [footerMsg, setFooterMsg] = useState(DEFAULT_INVOICE_CONFIG.footerMsg)
  const [footerNote, setFooterNote] = useState(DEFAULT_INVOICE_CONFIG.footerNote)

  const applyConfig = useCallback((cfg) => {
    setHeaderStyle(cfg.headerStyle)
    setShowAttr(cfg.showAttr)
    setShowSize(cfg.showSize)
    setShowDisc(cfg.showDisc)
    setShowHsn(cfg.showHsn)
    setTaxMode(cfg.taxMode)
    setShowCustomer(cfg.showCustomer)
    setShowPayment(cfg.showPayment)
    setShowPrintedDate(cfg.showPrintedDate)
    setShowStore(cfg.showStore)
    setShowCashier(cfg.showCashier)
    setFooterMsg(cfg.footerMsg)
    setFooterNote(cfg.footerNote)
  }, [])

  const load = useCallback(async (signal) => {
    try {
      setLoading(true)
      const [template, org] = await Promise.all([
        settingsAPI.getInvoiceTemplate(signal ? { signal } : undefined),
        settingsAPI.getOrganisation(signal ? { signal } : undefined).catch(() => null),
      ])
      if (signal?.aborted) return
      if (template) applyConfig(apiToConfig(template))
      if (org?.name) {
        setOrgPreview({
          name: org.name,
          address: org.address || '',
          phone: org.phone || '',
          gstin: org.gstin || '',
        })
      }
    } catch (err) {
      if (err?.code === 'ERR_CANCELED') return
      console.error(err)
      toast.error('Failed to load invoice template')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [applyConfig])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load, refreshKey])

  const sampleItems = [
    { name: 'Milk Powder 2.5Kg', hsn: '1901', attr: 'Fine Quality', size: '2.5KG', origin: 'IN', units: 'Kg', disc: '0', qty: '1', price: '270.00', gst: '0.00', total: '270.00' },
    { name: 'milky mist Milk Full Cream', hsn: '0401', attr: 'Fresh', size: '1Ltr', origin: 'IN', units: 'Ltr', disc: '5', qty: '2', price: '17.80', gst: '1.60', total: '35.60' },
  ]

  const currentConfig = useMemo(() => ({
    headerStyle, showAttr, showSize, showDisc, showHsn, taxMode,
    showCustomer, showPayment, showPrintedDate, showStore, showCashier, footerMsg, footerNote,
  }), [headerStyle, showAttr, showSize, showDisc, showHsn, taxMode, showCustomer, showPayment, showPrintedDate, showStore, showCashier, footerMsg, footerNote])

  const columnGrid = useMemo(() => getColumnStructure(currentConfig), [currentConfig])
  const columnHeaders = useMemo(() => getColumnHeaders(currentConfig), [currentConfig])
  const previewColumnKeys = useMemo(() => getColumnKeys(currentConfig), [currentConfig])

  const handleSave = async () => {
    setSaving(true)
    try {
      const saved = await settingsAPI.updateInvoiceTemplate(configToApi(currentConfig))
      const next = apiToConfig(saved)
      applyConfig(next)
      notifyInvoiceConfigChanged(next)
      toast.success('Invoice template saved')
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const previewCompany = orgPreview.name || 'Cosmopolitian Campa brothers'
  const previewAddress = orgPreview.address || '-'
  const previewPhone = orgPreview.phone || '—'
  const previewGst = orgPreview.gstin || '—'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
      <Card title="Invoice Template Settings">
        {loading ? (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
        <FormGroup label="Header Style">
          <AutocompleteDropdown
            value={headerStyle}
            onChange={setHeaderStyle}
            options={[
              { id: 'full', label: 'Full (name, address, GST, phone)' },
              { id: 'nameonly', label: 'Name only' },
              { id: 'logo', label: 'Logo only' },
            ]}
            isSearchFieldRequired={false}
            disabled={!canEdit}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Company name, address, GST ID, and phone</div>
        </FormGroup>

        <FormGroup label="Item Details to Show" required>
          <div style={INVOICE_CHECKBOX_GROUP_STYLE}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showAttr} onChange={(e) => setShowAttr(e.target.checked)} disabled={!canEdit} />
              <span>Item attributes (color, size, etc.)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showSize} onChange={(e) => setShowSize(e.target.checked)} disabled={!canEdit} />
              <span>Size column</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showDisc} onChange={(e) => setShowDisc(e.target.checked)} disabled={!canEdit} />
              <span>Discount % column</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showHsn} onChange={(e) => setShowHsn(e.target.checked)} disabled={!canEdit} />
              <span>HSN codes</span>
            </label>
          </div>
        </FormGroup>

        <FormGroup label="Tax Display Mode">
          <AutocompleteDropdown
            value={taxMode}
            onChange={setTaxMode}
            options={[
              { id: 'total', label: 'Total only' },
              { id: 'itemized', label: 'Show itemized tax breakdown' },
            ]}
            isSearchFieldRequired={false}
            disabled={!canEdit}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Display tax information at bottom of receipt</div>
        </FormGroup>

        <FormGroup label="Header Fields">
          <div style={INVOICE_CHECKBOX_GROUP_STYLE}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showPrintedDate} onChange={(e) => setShowPrintedDate(e.target.checked)} disabled={!canEdit} />
              <span>Show printed date & time</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showStore} onChange={(e) => setShowStore(e.target.checked)} disabled={!canEdit} />
              <span>Show store name</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showCashier} onChange={(e) => setShowCashier(e.target.checked)} disabled={!canEdit} />
              <span>Show cashier name</span>
            </label>
          </div>
        </FormGroup>

        <FormGroup label="Other Options">
          <div style={INVOICE_CHECKBOX_GROUP_STYLE}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showCustomer} onChange={(e) => setShowCustomer(e.target.checked)} disabled={!canEdit} />
              <span>Show customer name / GST Reg No</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={showPayment} onChange={(e) => setShowPayment(e.target.checked)} disabled={!canEdit} />
              <span>Show payment method</span>
            </label>
          </div>
        </FormGroup>

        <FormGroup label="Footer Message">
          <textarea className="form-input" value={footerMsg} onChange={(e) => setFooterMsg(e.target.value)} style={{ height: 80 }} disabled={!canEdit} />
        </FormGroup>

        <FormGroup label="Footer Note (Secondary)">
          <textarea className="form-input" value={footerNote} onChange={(e) => setFooterNote(e.target.value)} style={{ height: 80 }} disabled={!canEdit} />
        </FormGroup>

        {canEdit && (
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : '💾 Save Template Configuration'}
          </button>
        )}
          </>
        )}
      </Card>

      <Card title="Live Preview">
        <div style={{ border: '1px solid var(--border-default)', borderRadius: 10, padding: 16, fontFamily: 'Arial, sans-serif', fontSize: 10.5, color: 'var(--text-primary)', background: 'var(--bg-raised)', lineHeight: 1.4, maxHeight: 600, overflowY: 'auto' }}>
          {(showPrintedDate || showStore || showCashier) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 9, marginBottom: 8, textAlign: 'center' }}>
              {showPrintedDate && <div>Printed: 27 May 2026, 2:30 PM</div>}
              {showStore && <div>Store: Sample Branch</div>}
              {showCashier && <div>Cashier: Admin</div>}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginBottom: 10, fontSize: 10 }}>
            <div />
            <div style={{ textAlign: 'right', fontWeight: 700 }}>Invoice: INV-2026-1048</div>
          </div>

          {headerStyle !== 'logo' && (
            <div style={{ textAlign: 'center', marginBottom: 8 }}>
              {(headerStyle === 'full' || headerStyle === 'nameonly') && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{previewCompany}</div>
                  {headerStyle === 'full' && (
                    <>
                      <div style={{ fontSize: 10 }}>{previewAddress}</div>
                      <div style={{ fontSize: 10 }}>PHONE : {previewPhone}</div>
                      <div style={{ fontSize: 10 }}>TIN: {previewGst}</div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          <div style={{ fontWeight: 700, textAlign: 'center', margin: '8px 0', fontSize: 12 }}>TAX INVOICE</div>
          {showCustomer && <div style={{ margin: '6px 0', fontSize: 10 }}><span style={{ fontWeight: 700 }}>Bill To:</span> Sample Customer</div>}

          <div style={{ display: 'grid', gridTemplateColumns: columnGrid, gap: 4, fontWeight: 700, borderBottom: '1px solid var(--text-secondary)', paddingBottom: 4, marginBottom: 4, fontSize: 10.5 }}>
            {columnHeaders.map((h) => (
              <div key={h} style={{ textAlign: ['Description', 'No.'].includes(h) ? 'left' : 'right' }}>{h}</div>
            ))}
          </div>

          {sampleItems.map((item, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: columnGrid, gap: 4, padding: '3px 0', fontSize: 10 }}>
              {previewColumnKeys.map((key) => {
                if (key === 'hsn' && !showHsn) return null
                if (key === 'attr' && !showAttr) return null
                if (key === 'packing' && !showSize) return null
                if (key === 'disc' && !showDisc) return null
                let value = ''
                switch (key) {
                  case 'no': value = idx + 1; break
                  case 'description': value = item.name; break
                  case 'hsn': value = item.hsn; break
                  case 'attr': value = item.attr; break
                  case 'packing': value = item.size; break
                  case 'origin': value = item.origin || 'IN'; break
                  case 'units': value = item.units || 'Can'; break
                  case 'qty': value = item.qty; break
                  case 'rate': value = item.price; break
                  case 'disc': value = `${item.disc}%`; break
                  case 'gst': value = item.gst || '0'; break
                  case 'amount': value = item.total; break
                  default: value = ''
                }
                return (
                  <div key={key} style={{ textAlign: key === 'description' ? 'left' : 'right' }}>
                    {value}
                  </div>
                )
              })}
            </div>
          ))}

          <div style={{ borderTop: '1px solid var(--text-secondary)', margin: '8px 0' }} />

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
          <div style={{ textAlign: 'center', fontSize: 9.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            <div>{footerMsg}</div>
            <div>{footerNote}</div>
          </div>
        </div>
      </Card>
    </div>
  )
}

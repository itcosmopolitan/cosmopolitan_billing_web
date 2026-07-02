import { useEffect, useState, useCallback } from 'react'
import toast from 'react-hot-toast'
import { itemsAPI } from '@/api'
import { Modal, FormGroup, FormRow, EmptyState, Chip, AlertBar, DatePicker } from '@/components/ui'
import { fmt, fmtDate, fmtDateTime } from '@/utils/helpers'
import { batchExpiryStatus } from '@/utils/batchExpiry'
import { validateBatchDates, todayISO } from '@/utils/batchDates'

// Blank shape used by both add & edit modes. Keeping a single shape avoids
// the "undefined controlled input" gotcha when flipping between modes.
const EMPTY_FORM = { qty: '', batch_number: '', mfg_date: '', expiry_date: '', cost_price: '', notes: '' }

/**
 * Per-item batch viewer. Loads batches for the given item @ branch, shows
 * them in FEFO order (nearest expiry first), and lets operators add new
 * batches or edit existing metadata via a single form panel.
 *
 * Quantity changes are intentionally routed through the main Stock Adjustment
 * modal so aggregate stock and per-batch counts stay in sync. The edit panel
 * therefore hides the qty field and surfaces a hint pointing to Adjust.
 */
export default function BatchesModal({ item, branchId, onClose, onChanged, canAdd = false }) {
  const open = !!item
  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(false)
  const [includeEmpty, setIncludeEmpty] = useState(false)
  // formMode: 'closed' | 'add' | 'edit'. When 'edit', editingId points at
  // the batch being edited so submit knows which row to PATCH.
  const [formMode, setFormMode] = useState('closed')
  const [editingId, setEditingId] = useState(null)
  // Snapshot of dates when edit opens — used to allow unchanged past expiry.
  const [editSnapshot, setEditSnapshot] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!item) return
    try {
      setLoading(true)
      const data = await itemsAPI.batches.list(item.id, {
        branch_id: branchId,
        include_empty: includeEmpty,
        include_inactive: true,
      })
      setBatches(data?.items || [])
    } catch (err) {
      console.error('Failed to load batches:', err)
      setBatches([])
    } finally {
      setLoading(false)
    }
  }, [item, branchId, includeEmpty])

  useEffect(() => {
    if (open) {
      load()
      setFormMode('closed')
      setEditingId(null)
      setEditSnapshot(null)
      setForm(EMPTY_FORM)
    }
  }, [open, load])

  const strategy = item?.expiry_tracking ? 'FEFO (nearest expiry first)' : (item?.batch_tracking ? 'FIFO (oldest received first)' : 'Untracked')
  const totalQty = batches.reduce((s, b) => s + (b.quantity || 0), 0)

  const openAdd = () => {
    setForm({ ...EMPTY_FORM, cost_price: '' })
    setEditingId(null)
    setEditSnapshot(null)
    setFormMode('add')
  }

  const openEdit = (b) => {
    setEditSnapshot({
      mfg_date: b.mfgDate || '',
      expiry_date: b.expiryDate || '',
    })
    setForm({
      qty:          String(b.quantity ?? ''),
      batch_number: b.batchNumber || '',
      mfg_date:     b.mfgDate || '',
      expiry_date:  b.expiryDate || '',
      cost_price:   b.costPrice != null ? String(b.costPrice) : '',
      notes:        b.notes || '',
    })
    setEditingId(b.id)
    setFormMode('edit')
  }

  const closeForm = () => {
    setFormMode('closed')
    setEditingId(null)
    setEditSnapshot(null)
    setForm(EMPTY_FORM)
  }

  const checkDates = () => {
    const isEdit = formMode === 'edit'
    const expiryUnchanged = isEdit && editSnapshot
      && (form.expiry_date || '').trim() === (editSnapshot.expiry_date || '').trim()
    const { ok, errors } = validateBatchDates(
      { mfgDate: form.mfg_date, expiryDate: form.expiry_date },
      {
        requireExpiry: Boolean(item?.expiry_tracking) && (
          formMode === 'add' || (isEdit && !expiryUnchanged && !(form.expiry_date || '').trim())
        ),
        allowPastExpiry: isEdit && expiryUnchanged,
      },
    )
    if (!ok) {
      toast.error(errors[0])
      return false
    }
    return true
  }

  const submitForm = async () => {
    if (formMode === 'add') {
      if (!form.qty || Number(form.qty) <= 0) { toast.error('Enter a positive qty'); return }
      if (!checkDates()) return
      setSaving(true)
      try {
        await itemsAPI.batches.create(item.id, {
          branch_id: branchId,
          qty: Number(form.qty),
          batch_number: form.batch_number || undefined,
          mfg_date: form.mfg_date || undefined,
          expiry_date: form.expiry_date || undefined,
          cost_price: Number(form.cost_price || item.cost_price || 0),
          notes: form.notes || undefined,
        })
        toast.success('Batch added')
        closeForm()
        await load()
        onChanged?.()
      } catch (err) {
        console.error('Failed to add batch:', err)
      } finally {
        setSaving(false)
      }
      return
    }
    if (formMode === 'edit' && editingId) {
      if (!checkDates()) return
      setSaving(true)
      try {
        await itemsAPI.batches.patch(editingId, {
          batch_number: form.batch_number || undefined,
          mfg_date: form.mfg_date || undefined,
          expiry_date: form.expiry_date || undefined,
          notes: form.notes || undefined,
        })
        toast.success('Batch updated')
        closeForm()
        await load()
        onChanged?.()
      } catch (err) {
        console.error('Failed to patch batch:', err)
      } finally {
        setSaving(false)
      }
    }
  }

  if (!item) return null

  const isAdd = formMode === 'add'
  const isEdit = formMode === 'edit'
  const formOpen = isAdd || isEdit
  const formTitle = isEdit ? 'Edit Batch' : 'Add New Batch'
  const today = todayISO()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${item.emoji || '📦'} ${item.name} — Batches`}
      icon="🧴"
      size="lg"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        {canAdd && !formOpen && item.batch_tracking && (
          <button className="btn btn-primary" onClick={openAdd}>+ Add Batch</button>
        )}
      </>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Strategy</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{strategy}</div>
        </div>
        <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Active Batches</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{batches.filter((b) => b.quantity > 0).length}</div>
        </div>
        <div style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total Quantity</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{totalQty} {item.unit}</div>
        </div>
      </div>

      {!item.batch_tracking && (
        <AlertBar type="amber" icon="ℹ">
          This item is untracked — adjustments work against an aggregate counter.
          Enable Batch tracking on the item to start recording lots.
        </AlertBar>
      )}

      {formOpen && (
        <div style={{ padding: 14, background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div className="form-label" style={{ marginBottom: 0, color: 'var(--accent)' }}>{formTitle}</div>
            {isEdit && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>id: {editingId?.slice(-8)}</span>
            )}
          </div>

          {isEdit && (
            <div style={{ marginBottom: 12 }}>
              <AlertBar type="blue" icon="ℹ">
                Quantity is read-only here. To add or remove stock from this batch, use{' '}
                <strong>Stock Adjustment</strong> and pick this batch as the target — that keeps
                aggregate stock and per-batch counts in sync.
              </AlertBar>
            </div>
          )}

          <FormRow>
            <FormGroup label={isEdit ? 'Quantity (read-only)' : 'Quantity'} required={isAdd}>
              <input
                className="form-input"
                type="number"
                value={form.qty}
                onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                disabled={isEdit}
                autoFocus={isAdd}
                style={isEdit ? { background: 'var(--bg-subtle)', cursor: 'not-allowed' } : undefined}
              />
            </FormGroup>
            <FormGroup label="Batch / Lot #">
              <input
                className="form-input"
                value={form.batch_number}
                onChange={(e) => setForm((f) => ({ ...f, batch_number: e.target.value }))}
                placeholder={isAdd ? 'Auto if blank' : ''}
              />
            </FormGroup>
          </FormRow>
          <FormRow>
            <FormGroup label="Mfg. Date">
              <DatePicker max={today} value={form.mfg_date} onChange={(v) => setForm((f) => ({ ...f, mfg_date: v }))} title="Cannot be in the future" />
            </FormGroup>
            <FormGroup label={`Expiry Date${item.expiry_tracking ? ' *' : ''}`}>
              <DatePicker min={today} value={form.expiry_date} onChange={(v) => setForm((f) => ({ ...f, expiry_date: v }))} title="Must be today or later" />
            </FormGroup>
          </FormRow>
          <FormRow>
            <FormGroup label="Cost / Unit (MVR)">
              <input
                className="form-input"
                type="number"
                value={form.cost_price}
                onChange={(e) => setForm((f) => ({ ...f, cost_price: e.target.value }))}
                placeholder={isAdd ? `Defaults to ${fmt(item.cost_price)}` : ''}
                disabled={isEdit}
                style={isEdit ? { background: 'var(--bg-subtle)', cursor: 'not-allowed' } : undefined}
              />
            </FormGroup>
            <FormGroup label="Notes">
              <input className="form-input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
            </FormGroup>
          </FormRow>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="btn btn-secondary btn-sm" onClick={closeForm} disabled={saving}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={submitForm} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Batch'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
          Listed in {item.expiry_tracking ? 'FEFO' : 'FIFO-ish'} order.
          {' '}Status uses each batch&apos;s own shelf life (mfg/received → expiry):
          <strong> Use soon</strong> when ≤25% remains — not a fixed day count.
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={includeEmpty} onChange={(e) => setIncludeEmpty(e.target.checked)} />
          Show drained batches
        </label>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <table className="data-table" style={{ marginBottom: 0 }}>
          <thead>
            <tr>
              <th>Batch #</th>
              <th>Source</th>
              <th>Received</th>
              <th>Mfg</th>
              <th>Expiry</th>
              <th className="text-right">Qty</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Loading…</td></tr>
            ) : batches.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 0 }}><EmptyState icon="🧴" title="No batches yet" desc={canAdd ? 'Add your first batch to start FIFO/FEFO tracking' : 'No batches recorded at this branch'} /></td></tr>
            ) : batches.map((b) => {
              const expInfo = batchExpiryStatus(b)
              const isRowEditing = isEdit && editingId === b.id
              return (
                <tr key={b.id} style={isRowEditing ? { background: 'var(--accent-bg)' } : undefined}>
                  <td>
                    <span className="mono" style={{ fontSize: 12 }}>{b.batchNumber}</span>
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    <Chip label={b.sourceType || 'manual'} />
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.receivedDate ? fmtDate(b.receivedDate) : fmtDateTime(b.createdAt)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.mfgDate ? fmtDate(b.mfgDate) : '—'}</td>
                  <td
                    style={{ fontSize: 12, color: expInfo.dateColor, fontWeight: expInfo.expired || expInfo.nearExpiry ? 600 : 400 }}
                    title={expInfo.title}
                  >
                    {b.expiryDate ? fmtDate(b.expiryDate) : '—'}
                  </td>
                  <td className="text-right mono" style={{ fontWeight: 600 }}>{b.quantity}<span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 10.5 }}> / {b.initialQty}</span></td>
                  <td title={expInfo.title}>
                    {expInfo.status
                      ? <Chip status={expInfo.status} label={expInfo.statusLabel} />
                      : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{expInfo.statusLabel}</span>}
                  </td>
                  <td>
                    {canAdd && (
                      isRowEditing ? (
                        <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>Editing…</span>
                      ) : (
                        <button className="btn btn-ghost btn-xs" onClick={() => openEdit(b)} disabled={formOpen}>
                          Edit
                        </button>
                      )
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        ℹ Quantity changes go through Stock Adjustment to keep aggregate stock in sync.
      </div>
    </Modal>
  )
}

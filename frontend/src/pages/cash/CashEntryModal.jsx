import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { cashAPI } from '@/api'
import { FormGroup, Modal } from '@/components/ui'

const DEFAULT_FORM = {
  type: 'out',
  category: '',
  description: '',
  amount: '',
  ref: '',
  date: '',
}

export default function CashEntryModal({ open, onClose, branchId, onSaved, editEntry = null, categories = [] }) {
  const [form, setForm] = useState(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      if (editEntry) {
        setForm({
          type: editEntry.type || 'out',
          category: editEntry.category || '',
          description: editEntry.description || '',
          amount: String(editEntry.amount || ''),
          ref: editEntry.ref || '',
          date: editEntry.date || '',
        })
      } else {
        const today = new Date().toISOString().slice(0, 10)
        setForm({ ...DEFAULT_FORM, date: today })
      }
    }
  }, [open, editEntry])

  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const filteredCats = categories.filter(
    (c) => c.active && (c.direction === form.type || c.direction === 'both')
  )

  const handleSave = async () => {
    if (!form.amount || Number(form.amount) <= 0) { toast.error('Enter a valid amount'); return }
    if (!form.description || form.description.trim().length < 3) { toast.error('Description must be at least 3 characters'); return }
    if (!form.category) { toast.error('Select a category'); return }
    setSaving(true)
    try {
      if (editEntry) {
        await cashAPI.update(branchId, editEntry.id, {
          description: form.description,
          category: form.category,
          amount: Number(form.amount),
          ref: form.ref,
        })
        toast.success('Entry updated')
      } else {
        await cashAPI.add(branchId, {
          type: form.type,
          category: form.category,
          description: form.description,
          amount: Number(form.amount),
          ref: form.ref || undefined,
          date: form.date || undefined,
        })
        toast.success('Cash entry recorded')
      }
      onSaved?.()
      onClose()
    } catch {
      // Global interceptor already toasted
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editEntry ? 'Edit Cash Entry' : 'New Cash Entry'}
      icon="💰"
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : editEntry ? 'Save Changes' : 'Save Entry'}
          </button>
        </>
      }
    >
      {!editEntry && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
          {[{ id: 'in', label: '💵 Cash In' }, { id: 'out', label: '💸 Cash Out' }].map((t) => (
            <button
              key={t.id}
              onClick={() => { pf('type', t.id); pf('category', '') }}
              style={{
                padding: 10, borderRadius: 8, cursor: 'pointer',
                fontFamily: 'DM Sans,sans-serif', fontSize: 13, fontWeight: 500,
                border: `1.5px solid ${form.type === t.id ? 'var(--accent)' : 'var(--border-default)'}`,
                background: form.type === t.id ? 'var(--accent-bg)' : 'transparent',
                color: form.type === t.id ? 'var(--accent)' : 'var(--text-muted)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <FormGroup label="Category" required>
        <select className="form-input" value={form.category} onChange={(e) => pf('category', e.target.value)}>
          <option value="">— Select —</option>
          {filteredCats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          {filteredCats.length === 0 && (
            <option disabled>No categories for this type</option>
          )}
        </select>
      </FormGroup>

      <FormGroup label="Amount (MVR)" required>
        <input
          className="form-input"
          type="number"
          min="0.01"
          step="0.01"
          value={form.amount}
          onChange={(e) => pf('amount', e.target.value)}
          autoFocus
          placeholder="0.00"
        />
      </FormGroup>

      <FormGroup label="Description" required>
        <input
          className="form-input"
          value={form.description}
          onChange={(e) => pf('description', e.target.value)}
          placeholder="Brief description (min 3 chars)"
        />
      </FormGroup>

      <FormGroup label="Reference / Bill No.">
        <input
          className="form-input"
          value={form.ref}
          onChange={(e) => pf('ref', e.target.value)}
          placeholder="Optional — invoice or bill number"
        />
      </FormGroup>

      {!editEntry && (
        <FormGroup label="Date">
          <input
            className="form-input"
            type="date"
            value={form.date}
            onChange={(e) => pf('date', e.target.value)}
          />
        </FormGroup>
      )}
    </Modal>
  )
}

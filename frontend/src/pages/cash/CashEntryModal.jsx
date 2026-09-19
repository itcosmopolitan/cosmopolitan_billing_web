import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { cashAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { FormGroup, Modal, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { amountInputStep } from '@/utils/decimalPrecision'

const DEFAULT_FORM = {
  type: 'in',
  category: '',
  description: '',
  amount: '',
  ref: '',
  date: '',
}

const DIRECTION_OPTIONS = [
  { id: 'in', label: 'Cash In' },
  { id: 'out', label: 'Cash Out' },
  { id: 'both', label: 'Both' },
]

function unwrapCategories(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  return []
}

function categoryMatchesType(cat, type) {
  if (cat?.active === false) return false
  const direction = String(cat?.direction || 'both').toLowerCase()
  return direction === type || direction === 'both'
}

export default function CashEntryModal({
  open,
  onClose,
  branchId,
  onSaved,
  editEntry = null,
  categories = [],
  onCategoriesChange,
}) {
  const can = useCan()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [cats, setCats] = useState(() => unwrapCategories(categories))
  const [showAddCat, setShowAddCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatDirection, setNewCatDirection] = useState('out')
  const [addingCat, setAddingCat] = useState(false)

  const canAddCategory = can('cash.entry', 'cash.edit', 'settings.edit')

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
      setShowAddCat(false)
      setNewCatName('')
    }
  }, [open, editEntry])

  useEffect(() => {
    if (!open) return undefined
    setCats(unwrapCategories(categories))
    let cancelled = false
    cashAPI.categories.list()
      .then((data) => {
        if (cancelled) return
        const rows = unwrapCategories(data)
        setCats(rows)
        onCategoriesChange?.(rows)
      })
      .catch(() => {})
    return () => { cancelled = true }
    // Parent `categories` is only used as the opening snapshot; a live refetch
    // would loop if we also write back via onCategoriesChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const filteredCats = cats.filter((c) => categoryMatchesType(c, form.type))

  const openAddCategory = () => {
    setNewCatName('')
    setNewCatDirection(form.type || 'out')
    setShowAddCat(true)
  }

  const handleAddCategory = async () => {
    const name = newCatName.trim()
    if (name.length < 2) {
      toast.error('Category name must be at least 2 characters')
      return
    }
    const existing = cats.find((c) => String(c.name || '').trim().toLowerCase() === name.toLowerCase())
    if (existing) {
      if (categoryMatchesType(existing, form.type)) pf('category', existing.name)
      setShowAddCat(false)
      toast.success('Category already exists')
      return
    }
    setAddingCat(true)
    try {
      const created = await cashAPI.categories.create({
        name,
        direction: newCatDirection || form.type || 'both',
      })
      const row = {
        id: created.id,
        name: created.name || name,
        direction: created.direction || newCatDirection,
        active: created.active !== false,
        is_system: Boolean(created.is_system),
        sort_order: created.sort_order || 0,
      }
      const next = [...cats, row]
      setCats(next)
      onCategoriesChange?.(next)
      pf('category', row.name)
      setShowAddCat(false)
      toast.success('Category added')
    } catch {
      // Global interceptor already toasted
    } finally {
      setAddingCat(false)
    }
  }

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
    <>
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
          <AutocompleteDropdown
            value={form.category}
            onChange={(v) => pf('category', v)}
            options={filteredCats.map((c) => ({ id: c.name, label: c.name }))}
            isSearchFieldRequired
            placeholder="Select category…"
            searchPlaceholder="Search categories…"
            emptyLabel={cats.length === 0 ? 'No categories yet' : 'No categories for this type'}
            footerAction={canAddCategory ? { label: '+ Add category', onClick: openAddCategory } : null}
          />
        </FormGroup>

        <FormGroup label="Amount (MVR)" required>
          <input
            className="form-input"
            type="number"
            min={amountInputStep()}
            step={amountInputStep()}
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
            <DatePicker
              value={form.date}
              onChange={(v) => pf('date', v)}
            />
          </FormGroup>
        )}
      </Modal>

      <Modal
        open={open && showAddCat}
        onClose={() => !addingCat && setShowAddCat(false)}
        title="Add Category"
        icon="🏷️"
        size="sm"
        zIndex={1050}
        busy={addingCat}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowAddCat(false)} disabled={addingCat}>Cancel</button>
            <button className="btn btn-primary" onClick={handleAddCategory} disabled={addingCat}>
              {addingCat ? 'Adding…' : 'Add Category'}
            </button>
          </>
        }
      >
        <FormGroup label="Name" required>
          <input
            className="form-input"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="e.g. Petty cash, Bank deposit"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory() }}
          />
        </FormGroup>
        <FormGroup label="Applies to">
          <AutocompleteDropdown
            value={newCatDirection}
            onChange={setNewCatDirection}
            options={DIRECTION_OPTIONS}
            isSearchFieldRequired={false}
          />
        </FormGroup>
      </Modal>
    </>
  )
}

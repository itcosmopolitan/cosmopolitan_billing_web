/**
 * Permission matrix modal for editing a single role.
 *
 * - Renders one row per module (from the live permission catalog) with one
 *   checkbox per action plus a row header that toggles the whole module
 *   (which we store as `module.*`).
 * - Master "Grant all" toggle stores `["*"]`.
 * - Super admin is never editable here — replaced with a "Full Access" badge
 *   (server enforces this too: see backend/src/routes/roles.py _normalize_perms).
 *
 * See docs/USERS_AND_ROLES.md §8.6.
 */
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, FormGroup, FormRow, AlertBar } from '@/components/ui'
import { rolesAPI } from '@/api'

const COLOR_OPTIONS = ['blue', 'teal', 'amber', 'green', 'coral', 'purple', 'gray']

// UI-only hierarchy: render `users` as a nested child under `settings` (users
// management IS conceptually part of the Settings module). Permission strings
// on the wire stay flat — `users.view`, `settings.edit`, etc. — so this is
// purely a presentational grouping. Backend catalog + system role perm lists
// are unchanged.
//
// Add more groupings here as the product grows (e.g. settings could later own
// `audit` too). Modules listed as children are skipped from the top-level
// render loop; they only appear nested under their parent.
const HIERARCHY = {
  settings: ['users'],
}
// Flat set of every module that's a child of some parent — used to skip
// rendering it again at the top level.
const NESTED_MODULES = new Set(Object.values(HIERARCHY).flat())

/** Convert ["items.*", "pos.use", "*"] → { items: 'all', pos: Set('use'), _all: true }. */
function indexGranted(perms = [], catalog = {}) {
  const idx = { _all: false }
  if (perms.includes('*')) {
    idx._all = true
    Object.keys(catalog).forEach((m) => { idx[m] = 'all' })
    return idx
  }
  perms.forEach((p) => {
    if (typeof p !== 'string') return
    if (p.endsWith('.*')) {
      idx[p.slice(0, -2)] = 'all'
    } else {
      const [mod, act] = p.split('.')
      if (!idx[mod] || idx[mod] === 'all') {
        if (idx[mod] !== 'all') idx[mod] = new Set()
      }
      if (idx[mod] instanceof Set) idx[mod].add(act)
    }
  })
  return idx
}

/** Convert the editor index back to the wire format. */
function flattenIndex(idx, catalog) {
  if (idx._all) return ['*']
  const out = []
  Object.entries(catalog).forEach(([mod, acts]) => {
    const v = idx[mod]
    if (v === 'all') {
      out.push(`${mod}.*`)
    } else if (v instanceof Set) {
      acts.forEach((a) => { if (v.has(a)) out.push(`${mod}.${a}`) })
    }
  })
  return out
}

function moduleState(idx, mod, actions) {
  const v = idx[mod]
  if (idx._all || v === 'all') return 'all'
  if (v instanceof Set && v.size > 0) return v.size === actions.length ? 'all' : 'some'
  return 'none'
}

/** Combined state of a parent module + its children. The parent checkbox
 *  reflects the whole group: 'all' iff every action across parent + children
 *  is granted; 'none' iff none are; 'some' otherwise. */
function groupState(idx, parent, children, catalog) {
  if (idx._all) return 'all'
  const mods = [parent, ...children]
  let granted = 0
  let total = 0
  for (const m of mods) {
    const acts = catalog[m] || []
    total += acts.length
    const v = idx[m]
    if (v === 'all') granted += acts.length
    else if (v instanceof Set) granted += v.size
  }
  if (granted === 0) return 'none'
  if (granted === total) return 'all'
  return 'some'
}

export default function RoleEditor({
  open,
  onClose,
  role,            // null = create mode; object = edit mode
  catalog,         // { module: [actions] }
  onSaved,         // (savedRole) => void
}) {
  const isEdit = !!role
  const isSuperAdmin = role?.key === 'super_admin'

  const [label, setLabel] = useState('')
  const [keyVal, setKeyVal] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('blue')
  const [idx, setIdx] = useState({ _all: false })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (isEdit) {
      setLabel(role.label || '')
      setKeyVal(role.key || '')
      setDescription(role.description || '')
      setColor(role.color || 'blue')
      setIdx(indexGranted(role.permissions || [], catalog))
    } else {
      setLabel('')
      setKeyVal('')
      setDescription('')
      setColor('blue')
      setIdx({ _all: false })
    }
  }, [open, role, catalog, isEdit])

  const modules = useMemo(() => Object.entries(catalog || {}), [catalog])

  const toggleAll = () => setIdx((cur) => {
    const next = { _all: !cur._all }
    if (next._all) Object.keys(catalog).forEach((m) => { next[m] = 'all' })
    return next
  })

  const toggleModule = (mod) => setIdx((cur) => {
    const next = { ...cur, _all: false }
    const state = moduleState(cur, mod, catalog[mod] || [])
    if (state === 'all') {
      delete next[mod]
    } else {
      next[mod] = 'all'
    }
    return next
  })

  // Cascading parent toggle — affects the parent's own actions AND every
  // child's actions in one shot. If everything in the group is already
  // granted, revoke everything; otherwise grant everything.
  const toggleGroup = (parent, children) => setIdx((cur) => {
    const next = { ...cur, _all: false }
    const mods = [parent, ...children]
    const state = groupState(cur, parent, children, catalog)
    if (state === 'all') {
      for (const m of mods) delete next[m]
    } else {
      for (const m of mods) next[m] = 'all'
    }
    return next
  })

  const toggleAction = (mod, act) => setIdx((cur) => {
    const next = { ...cur, _all: false }
    const v = cur[mod]
    let setForMod
    if (v === 'all') {
      setForMod = new Set(catalog[mod] || [])
    } else if (v instanceof Set) {
      setForMod = new Set(v)
    } else {
      setForMod = new Set()
    }
    if (setForMod.has(act)) setForMod.delete(act); else setForMod.add(act)
    if (setForMod.size === 0) {
      delete next[mod]
    } else if (setForMod.size === (catalog[mod] || []).length) {
      next[mod] = 'all'
    } else {
      next[mod] = setForMod
    }
    return next
  })

  const save = async () => {
    if (!label.trim()) { toast.error('Label is required'); return }
    if (!isEdit && !keyVal.trim()) { toast.error('Key is required'); return }
    if (!isEdit && !/^[a-z0-9_-]+$/.test(keyVal)) {
      toast.error('Key must be lowercase letters, digits, _ or -')
      return
    }
    const permissions = isSuperAdmin ? ['*'] : flattenIndex(idx, catalog)
    if (!isSuperAdmin && permissions.length === 0) {
      toast.error('Select at least one permission before saving.')
      return
    }
    setSaving(true)
    try {
      const saved = isEdit
        ? await rolesAPI.update(role.id, { label, description, color, permissions })
        : await rolesAPI.create({ key: keyVal, label, description, color, permissions })
      toast.success(isEdit ? 'Role updated' : 'Role created')
      onSaved?.(saved)
      onClose()
    } catch (e) {
      console.error(e)
      // toast already fired by global axios interceptor
    } finally {
      setSaving(false)
    }
  }

  const totalGranted = isSuperAdmin
    ? '∞'
    : (idx._all
        ? Object.values(catalog || {}).reduce((s, a) => s + a.length, 0)
        : Object.entries(idx).filter(([k]) => k !== '_all').reduce((s, [mod, v]) => {
            if (v === 'all') return s + (catalog[mod]?.length || 0)
            if (v instanceof Set) return s + v.size
            return s
          }, 0))

  const canSave = isSuperAdmin || totalGranted > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit Role — ${role?.label}` : 'New Role'}
      icon="🛡"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={saving || !canSave}
            title={!canSave ? 'Select at least one permission' : undefined}
          >
            {saving ? 'Saving…' : (isEdit ? 'Update Role' : 'Create Role')}
          </button>
        </>
      }
    >
      <FormRow>
        <FormGroup label="Label" required>
          <input className="form-input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </FormGroup>
        <FormGroup label="Key" required>
          <input
            className="form-input"
            value={keyVal}
            onChange={(e) => setKeyVal(e.target.value)}
            disabled={isEdit}
            placeholder="e.g. shift_supervisor"
            style={isEdit ? { opacity: 0.6 } : undefined}
          />
        </FormGroup>
      </FormRow>

      <FormRow>
        <FormGroup label="Description">
          <input className="form-input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormGroup>
        <FormGroup label="Color">
          <select className="form-input" value={color} onChange={(e) => setColor(e.target.value)}>
            {COLOR_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FormGroup>
      </FormRow>

      {isSuperAdmin ? (
        <AlertBar type="amber" icon="🛡">
          Super Admin always has full access. The permission matrix is hidden because it can&apos;t be changed.
        </AlertBar>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!idx._all} onChange={toggleAll} />
              Grant all permissions (<code>*</code>)
            </label>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
              Granted: <strong>{totalGranted}</strong>
            </div>
          </div>

          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
            {modules.map(([mod, actions]) => {
              // Skip modules that are rendered as a nested child of some
              // parent — they appear only under their parent below.
              if (NESTED_MODULES.has(mod)) return null

              const childKeys = HIERARCHY[mod] || []
              const isParent = childKeys.length > 0

              // Parent rows display the GROUP state on their checkbox (so
              // ticking the parent cascades) while their per-action chips
              // still reflect only the parent's own actions.
              const selfState = moduleState(idx, mod, actions)
              const headerState = isParent
                ? groupState(idx, mod, childKeys, catalog)
                : selfState

              return (
                <div key={mod}>
                  <ModuleRow
                    mod={mod}
                    actions={actions}
                    idx={idx}
                    headerState={headerState}
                    onToggleHeader={() => (
                      isParent ? toggleGroup(mod, childKeys) : toggleModule(mod)
                    )}
                    onToggleAction={toggleAction}
                    disabled={idx._all}
                  />
                  {/* Render any nested children indented + tree-guide. Visual
                      grouping only — under the hood `users.*` is still its
                      own catalog entry; the parent toggle just cascades. */}
                  {childKeys.map((childMod) => {
                    const childActs = catalog[childMod] || []
                    const childState = moduleState(idx, childMod, childActs)
                    return (
                      <ModuleRow
                        key={childMod}
                        mod={childMod}
                        actions={childActs}
                        idx={idx}
                        headerState={childState}
                        onToggleHeader={() => toggleModule(childMod)}
                        onToggleAction={toggleAction}
                        disabled={idx._all}
                        nested
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}

/** One row of the permission matrix — used for both top-level modules and
 *  nested children. The `nested` prop turns on the left indent + tree-guide
 *  visual that signals "this is a child of the row above". */
function ModuleRow({ mod, actions, idx, headerState, onToggleHeader, onToggleAction, disabled, nested = false }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '170px 1fr',
      gap: 8,
      padding: nested ? '8px 12px 8px 36px' : '8px 12px',
      borderBottom: '1px solid var(--border-subtle)',
      background: headerState !== 'none' ? 'var(--bg-raised)' : 'transparent',
      // Tree-guide for nested rows: a vertical line on the left margin that
      // visually connects them to the parent above. Margin keeps the row's
      // grid width consistent with non-nested rows (the indent comes from
      // padding-left above, not margin).
      position: 'relative',
    }}>
      {nested && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 18,
            top: 0,
            bottom: 0,
            width: 0,
            borderLeft: '2px solid var(--border-default)',
          }}
        />
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
        <input
          type="checkbox"
          checked={headerState === 'all'}
          ref={(el) => { if (el) el.indeterminate = headerState === 'some' }}
          onChange={onToggleHeader}
          disabled={disabled}
        />
        <span style={{ fontSize: 13, fontWeight: 500, textTransform: 'capitalize' }}>{mod}</span>
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {actions.map((act) => {
          const v = idx[mod]
          const checked = idx._all || v === 'all' || (v instanceof Set && v.has(act))
          return (
            <label key={act} style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              borderRadius: 14,
              border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-default)'}`,
              background: checked ? 'var(--accent-bg)' : 'transparent',
              color: checked ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: 11.5,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            }}>
              <input
                type="checkbox"
                checked={!!checked}
                onChange={() => onToggleAction(mod, act)}
                disabled={disabled}
                style={{ display: 'none' }}
              />
              {act}
            </label>
          )
        })}
      </div>
    </div>
  )
}

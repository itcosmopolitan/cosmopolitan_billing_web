import { useEffect, useMemo, useState } from 'react'
import * as Icon from '@/components/ui/Icons'
import { resolvePrefs } from '@/hooks/useColumnPrefs'

/**
 * Zoho-style customize columns dialog.
 *
 * defs: [{ id, label, locked?, defaultHidden? }]
 * value: { order: string[], hidden: string[] }
 */
export default function CustomizeColumnsModal({
  open,
  onClose,
  defs = [],
  value,
  onSave,
}) {
  const [order, setOrder] = useState([])
  const [hidden, setHidden] = useState([])
  const [search, setSearch] = useState('')
  const [dragId, setDragId] = useState(null)

  useEffect(() => {
    if (!open) return
    const resolved = resolvePrefs(defs, value)
    setOrder(resolved.order)
    setHidden(resolved.hidden)
    setSearch('')
    setDragId(null)
  }, [open, defs, value])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const defMap = useMemo(() => {
    const m = new Map()
    defs.forEach((d) => m.set(d.id, d))
    return m
  }, [defs])

  const rows = useMemo(
    () => order.map((id) => defMap.get(id)).filter(Boolean),
    [order, defMap],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => String(r.label || r.id).toLowerCase().includes(q))
  }, [rows, search])

  const selectedCount = order.filter((id) => !hidden.includes(id)).length
  const totalCount = defs.length

  const toggle = (id) => {
    const def = defMap.get(id)
    if (!def || def.locked) return
    setHidden((prev) => (
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ))
  }

  const moveBefore = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== fromId)
      const toIdx = next.indexOf(toId)
      if (toIdx < 0) return prev
      next.splice(toIdx, 0, fromId)
      return next
    })
  }

  const handleSave = () => {
    onSave?.(resolvePrefs(defs, { order, hidden }))
  }

  if (!open) return null

  return (
    <div
      className="modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className="modal col-prefs-modal-shell" style={{ maxWidth: 420 }}>
        <div className="modal-header col-prefs-modal__header">
          <h3 className="col-prefs-modal__title">
            <span>Customize Columns</span>
            <span className="col-prefs-modal__count">
              {selectedCount} of {totalCount} Selected
            </span>
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm col-prefs-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="modal-body col-prefs-modal">
          <div className="col-prefs-modal__search search-wrap">
            <Icon.Search size={15} className="search-icon" />
            <input
              className="form-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              aria-label="Search columns"
            />
          </div>

          <div className="col-prefs-modal__list" role="list">
            {filtered.length === 0 ? (
              <div className="col-prefs-modal__empty">No columns match “{search.trim()}”</div>
            ) : filtered.map((col) => {
              const checked = !hidden.includes(col.id)
              const locked = Boolean(col.locked)
              return (
                <div
                  key={col.id}
                  role="listitem"
                  className={`col-prefs-modal__row${dragId === col.id ? ' is-dragging' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    setDragId(col.id)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', col.id)
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const fromId = e.dataTransfer.getData('text/plain') || dragId
                    moveBefore(fromId, col.id)
                    setDragId(null)
                  }}
                >
                  <span className="col-prefs-modal__grip" title="Drag to reorder" aria-hidden>
                    <Icon.GripVertical size={16} />
                  </span>

                  {locked ? (
                    <span className="col-prefs-modal__lock" title="Required column" aria-label="Locked">
                      <Icon.Lock size={15} />
                    </span>
                  ) : (
                    <label className="col-prefs-modal__check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(col.id)}
                      />
                      <span className="col-prefs-modal__check-ui" aria-hidden />
                    </label>
                  )}

                  <span className="col-prefs-modal__label">{col.label || col.id}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="btn btn-primary" onClick={handleSave}>
            Save
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** Narrow header cell with the column-settings (sliders) control. */
export function ColumnPrefsTrigger({ onClick, ariaLabel = 'Customize columns' }) {
  return (
    <th className="col-prefs-trigger-th" aria-label={ariaLabel}>
      <button
        type="button"
        className="col-prefs-trigger"
        onClick={onClick}
        title={ariaLabel}
        aria-label={ariaLabel}
      >
        <Icon.SlidersHorizontal size={16} />
      </button>
    </th>
  )
}

/** Matching empty body cell so the trigger column aligns. */
export function ColumnPrefsSpacer() {
  return <td className="col-prefs-trigger-td" aria-hidden />
}

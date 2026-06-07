import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// ─── Modal ────────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, footer, size = 'md', icon }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const widths = { sm: '400px', md: '560px', lg: '720px', xl: '900px' }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: widths[size] }}>
        <div className="modal-header">
          {icon && <span style={{ fontSize: 20 }}>{icon}</span>}
          <h3 style={{ flex: 1 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: '4px 8px' }}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

// ─── Drawer ───────────────────────────────────────────────────────────────────
export function Drawer({ open, onClose, title, children, footer, icon }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          {icon && <span style={{ fontSize: 20 }}>{icon}</span>}
          <h3 style={{ flex: 1 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: '4px 8px' }}>✕</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </>
  )
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab-btn ${active === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon && <span style={{ marginRight: 5 }}>{tab.icon}</span>}
          {tab.label}
          {tab.count !== undefined && (
            <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 10, background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

// ─── Status Chip ──────────────────────────────────────────────────────────────
export function Chip({ status, label, custom }) {
  const map = {
    paid:     { cls: 'chip-paid',     lbl: 'Paid' },
    active:   { cls: 'chip-active',   lbl: 'Active' },
    pending:  { cls: 'chip-pending',  lbl: 'Pending' },
    overdue:  { cls: 'chip-overdue',  lbl: 'Overdue' },
    draft:    { cls: 'chip-draft',    lbl: 'Draft' },
    partial:  { cls: 'chip-partial',  lbl: 'Partial' },
    transit:  { cls: 'chip-transit',  lbl: 'In Transit' },
    received: { cls: 'chip-paid',     lbl: 'Received' },
    low:      { cls: 'chip-low',      lbl: 'Low Stock' },
    out:      { cls: 'chip-out',      lbl: 'Out of Stock' },
    cancelled:{ cls: 'chip-out',      lbl: 'Cancelled' },
    inactive: { cls: 'chip-out',      lbl: 'Inactive' },
  }
  if (custom) {
    return <span className="chip" style={{ background: custom.bg, color: custom.color }}>{label}</span>
  }
  const { cls, lbl } = map[status] || { cls: 'chip-draft', lbl: status }
  return <span className={`chip ${cls}`}>{label || lbl}</span>
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 20, color = 'var(--accent)' }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke={color} strokeOpacity="0.2" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────
export function EmptyState({ icon = '📭', title, desc, action }) {
  return (
    <div className="empty-state">
      <div className="icon">{icon}</div>
      {title && <div className="title">{title}</div>}
      {desc && <div className="desc">{desc}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}

// ─── Form Group ───────────────────────────────────────────────────────────────
export function FormGroup({ label, error, children, required }) {
  return (
    <div className="form-group">
      {label && <label className="form-label">{label}{required && <span style={{ color: 'var(--red)', marginLeft: 3 }}>*</span>}</label>}
      {children}
      {error && <div className="form-error">{error}</div>}
    </div>
  )
}

// ─── FormRow ──────────────────────────────────────────────────────────────────
export function FormRow({ children, cols = 2 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
      {children}
    </div>
  )
}

// ─── Select Input ─────────────────────────────────────────────────────────────
export function Select({ label, value, onChange, options, required, error }) {
  return (
    <FormGroup label={label} required={required} error={error}>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
        ))}
      </select>
    </FormGroup>
  )
}

// ─── Search Bar ───────────────────────────────────────────────────────────────
export function SearchBar({ value, onChange, placeholder = 'Search...', style }) {
  return (
    <div className="search-wrap" style={{ flex: 1, ...style }}>
      <svg className="search-icon" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        className="form-input"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ paddingLeft: 32 }}
      />
    </div>
  )
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger = false }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      icon={danger ? '⚠️' : '❓'}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => { onConfirm(); onClose() }}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{message}</p>
    </Modal>
  )
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
export function KPICard({ label, value, delta, deltaUp, icon, color = 'var(--accent)', onClick, sub }) {
  return (
    <div className="kpi-card" onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      {icon && (
        <div style={{ position: 'absolute', right: 16, top: 16, width: 36, height: 36, borderRadius: 10, background: color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 8, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color, letterSpacing: '-0.5px', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
      {delta && (
        <div style={{ fontSize: 11, marginTop: 6, display: 'flex', alignItems: 'center', gap: 4, color: deltaUp ? 'var(--green)' : 'var(--red)' }}>
          <span>{deltaUp ? '▲' : '▼'}</span>
          <span>{delta}</span>
        </div>
      )}
    </div>
  )
}

// ─── Section Header ───────────────────────────────────────────────────────────
export function SectionHeader({ title, subtitle, children }) {
  return (
    <div className="section-hdr">
      <div>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {subtitle && <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{subtitle}</p>}
      </div>
      {children && <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>{children}</div>}
    </div>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────
export function Card({ title, titleRight, children, bodyPadding = true, style }) {
  // Wrap string/number titles in an <h4> for a11y + visual consistency. When
  // the caller passes a React element (e.g. a SegmentedToggle in the title
  // slot), render it as-is — h4 nesting an interactive widget is invalid
  // HTML and confuses screen readers. The caller is responsible for any
  // wrapping its element needs.
  const titleIsText = typeof title === 'string' || typeof title === 'number'
  return (
    <div className="card" style={style}>
      {title && (
        <div className="card-header">
          {titleIsText
            ? <h4 style={{ flex: 1, margin: 0 }}>{title}</h4>
            : <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0 }}>{title}</div>}
          {titleRight}
        </div>
      )}
      <div style={bodyPadding ? {} : { padding: 0 }} className={bodyPadding ? 'card-body' : ''}>
        {children}
      </div>
    </div>
  )
}

// ─── Alert Bar ────────────────────────────────────────────────────────────────
export function AlertBar({ type = 'blue', icon, children }) {
  return (
    <div className={`alert alert-${type}`}>
      {icon && <span style={{ flexShrink: 0, fontSize: 15 }}>{icon}</span>}
      <span>{children}</span>
    </div>
  )
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
export function ProgressBar({ value, max = 100, color = 'var(--accent)', height = 6 }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <div className="progress-bar" style={{ height }}>
      <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
export function Avatar({ initials, size = 32, color = 'var(--accent)' }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color + '28', border: `1px solid ${color}44`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 600, color, flexShrink: 0,
    }}>
      {initials}
    </div>
  )
}

// ─── Tag ─────────────────────────────────────────────────────────────────────
export function Tag({ children, color }) {
  return (
    <span className="tag" style={color ? { background: color + '18', color } : {}}>
      {children}
    </span>
  )
}

export { PaginationBar } from './PaginationBar'
export { SortableHeader } from './SortableHeader'

// ─── Segmented Toggle ────────────────────────────────────────────────────────
// Pill-style segmented control. Use when picking between a small number of
// mutually-exclusive options (Users/Roles, payment modes, period selectors).
// Options is an array of {id, label} or array of strings.
//
//   <SegmentedToggle
//     value={subTab}
//     onChange={setSubTab}
//     options={[{id:'users', label:'Users'}, {id:'roles', label:'Roles'}]}
//   />
export function SegmentedToggle({ value, onChange, options, ariaLabel }) {
  const opts = options.map((o) => (typeof o === 'string' ? { id: o, label: o } : o))
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        padding: 4,
        gap: 2,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 999,
      }}
    >
      {opts.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            style={{
              padding: '6px 18px',
              border: 'none',
              borderRadius: 999,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--text-muted)',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── MultiSelect ──────────────────────────────────────────────────────────────
// Office-style checkbox-popover multi-select. Click the trigger to open a
// panel of checkboxes; the first row is "Select all" which bulk-toggles
// every option. The trigger button summarises the current selection
// ("N of M selected") so admins don't need to open the popover to know the
// count — opening it reveals the per-row checkmarks for the detail.
//
// Search:
//   When `options.length >= 8`, a sticky search input appears at the top
//   of the popover. Case-insensitive substring match on `option.label`.
//   "Select all" then operates on the FILTERED set only — Excel / Google
//   Sheets / Slack convention. The current selection outside the filter is
//   left untouched.
//
// Props:
//   options:     [{ id, label }]            — full pickable set
//   value:       [id, id, ...]              — currently selected ids
//   onChange:    (newIds[]) => void
//   placeholder: string                     — trigger label when nothing selected
//   disabled:    boolean                    — gray-out + ignore interactions
//
// Popover rendering note:
//   The popover is portaled to document.body with position:fixed so it
//   escapes any ancestor `overflow: hidden|auto` clipping (e.g. when used
//   inside a Modal whose `.modal` has `overflow-y: auto`). Coordinates are
//   computed from the trigger's getBoundingClientRect() and re-computed on
//   scroll (capture, to catch nested scroll containers) + window resize.
//   Auto-flips above the trigger when there's not enough room below.
//
// Accessibility:
//   - Trigger is a button with `aria-expanded` / `aria-haspopup="listbox"`.
//   - Panel has `role="listbox"` with `aria-multiselectable`.
//   - Each row is a `<label>` wrapping a real `<input type="checkbox">`,
//     so screen readers and keyboard users get native behavior.
//   - Escape or outside-click closes the panel. Native tab order works.

// Visible bounds for the popover. Anything taller than this is internally
// scrollable; the placement logic picks above-vs-below based on this.
const POPOVER_MAX_H = 260
const POPOVER_GAP   = 4   // px between trigger edge and popover edge
const VIEWPORT_PAD  = 8   // px from viewport edge so popover never sits flush

export function MultiSelect({ options, value, onChange, placeholder = 'Choose…', disabled = false }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, maxHeight: POPOVER_MAX_H })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const searchRef = useRef(null)

  const valueSet = new Set(value || [])

  // Filtered view of options (case-insensitive label substring match).
  // The "Select all" checkbox + indeterminate state operate on this set —
  // matches the Excel / Google Sheets / Slack convention where filter +
  // select-all combine intuitively (type "warehouse" then tick "Select all"
  // = tick every Warehouse-matching branch, leaving the rest untouched).
  const q = search.trim().toLowerCase()
  const filteredOptions = q
    ? options.filter((o) => (o.label || '').toLowerCase().includes(q))
    : options
  const filteredSelectedCount = filteredOptions.reduce(
    (n, o) => n + (valueSet.has(o.id) ? 1 : 0), 0,
  )
  const allChecked = filteredOptions.length > 0
    && filteredSelectedCount === filteredOptions.length
  const someChecked = !allChecked && filteredSelectedCount > 0

  // Compute popover position relative to the viewport. Flips above the
  // trigger when the space below is too small AND there's more room above.
  // Clamps maxHeight to whichever side it ends up on. Pure function of the
  // trigger rect — safe to call from layout/scroll/resize handlers.
  const reposition = () => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PAD
    const spaceAbove = rect.top - VIEWPORT_PAD
    const flipUp = spaceBelow < Math.min(POPOVER_MAX_H, 160) && spaceAbove > spaceBelow
    const maxHeight = Math.max(120, Math.min(POPOVER_MAX_H, flipUp ? spaceAbove : spaceBelow))
    setCoords({
      top: flipUp
        ? Math.max(VIEWPORT_PAD, rect.top - maxHeight - POPOVER_GAP)
        : rect.bottom + POPOVER_GAP,
      left: rect.left,
      width: rect.width,
      maxHeight,
    })
  }

  // Position synchronously on open so the popover never paints in the
  // wrong place even for one frame.
  useLayoutEffect(() => {
    if (open) reposition()
  }, [open])

  // Outside-click + Escape close + scroll/resize repositioning. Listeners
  // only attach while open. `scroll` uses capture so nested scrollable
  // ancestors (e.g. the modal-body) also trigger repositioning.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target)
      const inPopover = popoverRef.current && popoverRef.current.contains(e.target)
      if (!inTrigger && !inPopover) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Auto-focus the search box when the popover opens so the user can start
  // typing immediately. Runs in useLayoutEffect on `open` change so focus
  // lands before the browser paints (no flash of "trigger still focused").
  useLayoutEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus()
    }
  }, [open])

  // Clear the search term when the popover closes, so re-opening shows the
  // full list. Stash inside an effect rather than the close handlers so
  // every close path (Escape, outside-click, disabled flip) clears it.
  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  const toggle = (id) => {
    if (disabled) return
    onChange(valueSet.has(id)
      ? (value || []).filter((v) => v !== id)
      : [...(value || []), id])
  }

  // "Select all" toggles only the FILTERED set. When all visible options
  // are already selected → unselect them (leave selections outside the
  // filter untouched). Otherwise add every visible option to the selection.
  const toggleAll = () => {
    if (disabled) return
    const filteredIds = new Set(filteredOptions.map((o) => o.id))
    if (allChecked) {
      onChange((value || []).filter((id) => !filteredIds.has(id)))
    } else {
      const merged = new Set(value || [])
      filteredOptions.forEach((o) => merged.add(o.id))
      onChange([...merged])
    }
  }

  const triggerLabel = (value || []).length === 0
    ? placeholder
    : `${(value || []).length} of ${options.length} selected`

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      aria-multiselectable="true"
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
        overflowY: 'auto',
        // Modal overlay is z-index 1000; popover needs to sit above it.
        zIndex: 1100,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        padding: 4,
      }}
    >
      {options.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          No options available
        </div>
      ) : (
        <>
          {/* Sticky search header so the input + Select-all stay visible while
              scrolling the option list. Visible only when there are enough
              options to make scrolling likely (>=8) — otherwise it's noise. */}
          {options.length >= 8 && (
            <div style={{
              position: 'sticky', top: 0, zIndex: 1,
              background: 'var(--bg-surface)',
              padding: '2px 2px 4px',
              borderBottom: '1px solid var(--border-subtle)',
              marginBottom: 2,
            }}>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="form-input"
                style={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}

          {filteredOptions.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
              No matches for &ldquo;{search}&rdquo;
            </div>
          ) : (
            <>
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', cursor: 'pointer', borderRadius: 4,
                  fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                  background: allChecked ? 'var(--bg-raised)' : 'transparent',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = allChecked ? 'var(--bg-raised)' : 'transparent' }}
              >
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked }}
                  onChange={toggleAll}
                />
                <span>
                  Select all ({filteredOptions.length}
                  {q && filteredOptions.length !== options.length ? ' matching' : ''})
                </span>
              </label>
              <div style={{ height: 1, background: 'var(--border-subtle)', margin: '2px 0' }} />
              {filteredOptions.map((o) => {
                const checked = valueSet.has(o.id)
                return (
                  <label
                    key={o.id}
                    role="option"
                    aria-selected={checked}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 10px', cursor: 'pointer', borderRadius: 4,
                      fontSize: 12.5, color: 'var(--text-primary)',
                      background: checked ? 'var(--bg-raised)' : 'transparent',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = checked ? 'var(--bg-raised)' : 'transparent' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.id)}
                    />
                    <span>{o.label}</span>
                  </label>
                )
              })}
            </>
          )}
        </>
      )}
    </div>,
    document.body,
  ) : null

  return (
    <div
      style={{
        opacity: disabled ? 0.55 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="form-input"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          color: (value || []).length === 0 ? 'var(--text-muted)' : 'var(--text-primary)',
          width: '100%',
        }}
      >
        <span>{triggerLabel}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>▾</span>
      </button>
      {popover}
    </div>
  )
}

// ─── SearchSelect ─────────────────────────────────────────────────────────────
// Single-select dropdown with a searchable popover and optional loading state.
export function SearchSelect({
  options = [],
  value = '',
  onChange,
  placeholder = 'Select…',
  loading = false,
  loadingLabel = 'Loading…',
  emptyLabel = 'No items found',
  noMatchLabel = 'No matches',
  disabled = false,
  searchPlaceholder = 'Search…',
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, maxHeight: POPOVER_MAX_H })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const searchRef = useRef(null)

  const q = search.trim().toLowerCase()
  const filteredOptions = q
    ? options.filter((o) => {
      const hay = (o.searchText || o.label || '').toLowerCase()
      return hay.includes(q)
    })
    : options

  const selected = options.find((o) => o.id === value)
  const triggerLabel = loading
    ? loadingLabel
    : (selected?.label || placeholder)

  const reposition = () => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PAD
    const spaceAbove = rect.top - VIEWPORT_PAD
    const flipUp = spaceBelow < Math.min(POPOVER_MAX_H, 160) && spaceAbove > spaceBelow
    const maxHeight = Math.max(120, Math.min(POPOVER_MAX_H, flipUp ? spaceAbove : spaceBelow))
    setCoords({
      top: flipUp
        ? Math.max(VIEWPORT_PAD, rect.top - maxHeight - POPOVER_GAP)
        : rect.bottom + POPOVER_GAP,
      left: rect.left,
      width: rect.width,
      maxHeight,
    })
  }

  useLayoutEffect(() => {
    if (open) reposition()
  }, [open])

  useLayoutEffect(() => {
    if (open && searchRef.current) searchRef.current.focus()
  }, [open])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  useEffect(() => {
    if (disabled || loading) setOpen(false)
  }, [disabled, loading])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target)
      const inPopover = popoverRef.current && popoverRef.current.contains(e.target)
      if (!inTrigger && !inPopover) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const pick = (id) => {
    if (disabled || loading) return
    onChange(id)
    setOpen(false)
  }

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
        overflowY: 'auto',
        zIndex: 1100,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        padding: 4,
      }}
    >
      <div style={{
        position: 'sticky', top: 0, zIndex: 1,
        background: 'var(--bg-surface)',
        padding: '2px 2px 4px',
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 2,
      }}>
        <input
          ref={searchRef}
          type="text"
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input"
          style={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {loading ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {loadingLabel}
        </div>
      ) : options.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {emptyLabel}
        </div>
      ) : filteredOptions.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {q ? `${noMatchLabel} for "${search.trim()}"` : emptyLabel}
        </div>
      ) : (
        filteredOptions.map((o) => {
          const active = o.id === value
          return (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => pick(o.id)}
              style={{
                display: 'block',
                width: '100%',
                padding: '8px 10px',
                border: 'none',
                borderRadius: 4,
                textAlign: 'left',
                fontSize: 12.5,
                cursor: 'pointer',
                color: 'var(--text-primary)',
                background: active ? 'var(--bg-raised)' : 'transparent',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = active ? 'var(--bg-raised)' : 'transparent' }}
            >
              {o.label}
            </button>
          )
        })
      )}
    </div>,
    document.body,
  ) : null

  return (
    <div style={{ opacity: disabled || loading ? 0.65 : 1 }}>
      <button
        ref={triggerRef}
        type="button"
        className="form-input"
        onClick={() => !disabled && !loading && setOpen((o) => !o)}
        disabled={disabled || loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          textAlign: 'left', cursor: disabled || loading ? 'not-allowed' : 'pointer',
          color: selected && !loading ? 'var(--text-primary)' : 'var(--text-muted)',
          width: '100%',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLabel}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8, flexShrink: 0 }}>
          {loading ? '…' : '▾'}
        </span>
      </button>
      {popover}
    </div>
  )
}

// ─── TruncatedChipList ───────────────────────────────────────────────────────
// Display a list of labels as inline chips, capped at `maxVisible`. When the
// list overflows, an interactive "+N more" pill appears at the end; clicking
// it opens a portaled popover that shows ALL items in a scrollable list
// with a sticky search input. View-only — no checkboxes, no selection.
//
// Use for read-only table cells where a row's "tags" / "branches" /
// "categories" can be long enough to dominate the row visually. Pair with
// MultiSelect for the edit path; the two share the same portal + auto-flip
// + outside-click / Escape close behavior (intentionally duplicated rather
// than extracted into a shared hook — single second consumer doesn't yet
// justify the abstraction; revisit when a third floating UI lands).
//
// Props:
//   items:        [{ id, label }]  — full list to display
//   maxVisible:   number           — chips before "+N more" appears (default 5)
//   chipStyle:    object           — optional overrides for inline chip CSS
//   popoverTitle: string           — small heading at the top of the popover
//                                     (default "All items")

const POPOVER_MAX_H_TR = 280
const POPOVER_GAP_TR   = 4
const VIEWPORT_PAD_TR  = 8
const SEARCH_THRESHOLD = 8  // matches MultiSelect — only show search above this many items

const DEFAULT_CHIP_STYLE = {
  padding: '2px 8px',
  borderRadius: 20,
  fontSize: 11,
  fontWeight: 500,
  background: 'var(--bg-raised)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border-subtle)',
  whiteSpace: 'nowrap',
}

export function TruncatedChipList({ items, maxVisible = 5, chipStyle, popoverTitle = 'All items' }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, maxHeight: POPOVER_MAX_H_TR })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const searchRef = useRef(null)

  const safeItems = Array.isArray(items) ? items : []
  const visible = safeItems.slice(0, maxVisible)
  const overflowCount = Math.max(0, safeItems.length - maxVisible)

  const q = search.trim().toLowerCase()
  const filtered = q
    ? safeItems.filter((it) => (it.label || '').toLowerCase().includes(q))
    : safeItems

  const reposition = () => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PAD_TR
    const spaceAbove = rect.top - VIEWPORT_PAD_TR
    const flipUp = spaceBelow < Math.min(POPOVER_MAX_H_TR, 180) && spaceAbove > spaceBelow
    const maxHeight = Math.max(140, Math.min(POPOVER_MAX_H_TR, flipUp ? spaceAbove : spaceBelow))
    // Anchor popover's right edge to the trigger's right edge — feels natural
    // since the "+N more" pill is at the end of the chip strip. Clamp left
    // so it doesn't fall off the screen for narrow viewports.
    const width = 280
    const right = rect.right
    const left = Math.max(VIEWPORT_PAD_TR, right - width)
    setCoords({
      top: flipUp
        ? Math.max(VIEWPORT_PAD_TR, rect.top - maxHeight - POPOVER_GAP_TR)
        : rect.bottom + POPOVER_GAP_TR,
      left,
      width,
      maxHeight,
    })
  }

  useLayoutEffect(() => {
    if (open) reposition()
  }, [open])

  useLayoutEffect(() => {
    if (open && searchRef.current) searchRef.current.focus()
  }, [open])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target)
      const inPopover = popoverRef.current && popoverRef.current.contains(e.target)
      if (!inTrigger && !inPopover) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const mergedChipStyle = { ...DEFAULT_CHIP_STYLE, ...(chipStyle || {}) }

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      aria-label={popoverTitle}
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
        overflowY: 'auto',
        zIndex: 1100,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        padding: 4,
      }}
    >
      <div style={{
        position: 'sticky', top: 0, zIndex: 1,
        background: 'var(--bg-surface)',
        padding: '6px 8px 8px',
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 4,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: safeItems.length >= SEARCH_THRESHOLD ? 6 : 0,
        }}>
          {popoverTitle} ({safeItems.length})
        </div>
        {safeItems.length >= SEARCH_THRESHOLD && (
          <input
            ref={searchRef}
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="form-input"
            style={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
            spellCheck={false}
            autoComplete="off"
          />
        )}
      </div>
      {filtered.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          No matches for &ldquo;{search}&rdquo;
        </div>
      ) : (
        filtered.map((it) => (
          <div
            key={it.id}
            role="option"
            style={{
              padding: '7px 10px', fontSize: 12.5,
              color: 'var(--text-primary)', borderRadius: 4,
            }}
          >
            {it.label}
          </div>
        ))
      )}
    </div>,
    document.body,
  ) : null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {visible.map((it) => (
        <span key={it.id} style={mergedChipStyle}>{it.label}</span>
      ))}
      {overflowCount > 0 && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Show all ${safeItems.length} ${popoverTitle.toLowerCase()}`}
          style={{
            padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
            background: 'transparent',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            cursor: 'pointer', whiteSpace: 'nowrap',
            fontFamily: 'inherit',
          }}
        >
          +{overflowCount} more
        </button>
      )}
      {popover}
    </div>
  )
}

// ─── Inline Bar Chart ─────────────────────────────────────────────────────────
export function BarList({ items, valueFormatter = (v) => v, color = 'var(--accent)' }) {
  const max = Math.max(...items.map((i) => i.value))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <div style={{ width: 100, color: 'var(--text-secondary)', textAlign: 'right', flexShrink: 0, fontSize: 11.5 }}>{item.label}</div>
          <div style={{ flex: 1, height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 4, background: item.color || color, width: `${(item.value / max) * 100}%`, transition: 'width 0.8s cubic-bezier(0.4,0,0.2,1)' }} />
          </div>
          <div style={{ width: 80, textAlign: 'right', fontSize: 11.5, color: 'var(--text-secondary)', fontFamily: 'DM Mono,monospace' }}>
            {valueFormatter(item.value)}
          </div>
        </div>
      ))}
    </div>
  )
}

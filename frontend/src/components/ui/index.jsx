import { useEffect, useRef } from 'react'

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
  return (
    <div className="card" style={style}>
      {title && (
        <div className="card-header">
          <h4 style={{ flex: 1, margin: 0 }}>{title}</h4>
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

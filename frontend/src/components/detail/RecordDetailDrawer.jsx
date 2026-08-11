import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Wide record detail drawer used from list row-click.
 * Supports summary metrics strip + internal tabs (Overview / Lines / …).
 */
export default function RecordDetailDrawer({
  open,
  onClose,
  title,
  subtitle,
  icon,
  size = 'lg',
  headerActions = null,
  summary = null,
  tabs = null,
  activeTab = null,
  onTabChange = null,
  footer = null,
  children,
  busy = false,
}) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && !busy) onClose?.()
    }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose, busy])

  if (!open) return null

  const sizeClass = size === 'md' || size === 'xl' || size === 'lg' ? `drawer--${size}` : 'drawer--lg'

  return createPortal(
    <>
      <div className="drawer-overlay" onClick={() => !busy && onClose?.()} />
      <div className={`drawer ${sizeClass}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Details'}>
        <div className="drawer-header">
          {icon ? <span style={{ fontSize: 22, lineHeight: 1, marginTop: 2 }}>{icon}</span> : null}
          <div className="drawer-header__main">
            <h3 className="drawer-header__title">{title}</h3>
            {subtitle ? <div className="drawer-header__subtitle">{subtitle}</div> : null}
          </div>
          <div className="drawer-header__actions">
            {headerActions}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              disabled={busy}
              style={{ padding: '4px 8px' }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {Array.isArray(summary) && summary.length > 0 ? (
          <div className="drawer-summary">
            {summary.map((cell) => (
              <div key={cell.label} className="drawer-summary__cell">
                <div className="drawer-summary__label">{cell.label}</div>
                <div className="drawer-summary__value" style={cell.tone ? { color: cell.tone } : undefined}>
                  {cell.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {Array.isArray(tabs) && tabs.length > 0 ? (
          <div className="drawer-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`drawer-tab${activeTab === tab.id ? ' is-active' : ''}`}
                onClick={() => onTabChange?.(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-footer">{footer}</div> : null}
      </div>
    </>,
    document.body,
  )
}

export function DetailSection({ title, children }) {
  return (
    <div className="drawer-section">
      {title ? <div className="drawer-section__title">{title}</div> : null}
      {children}
    </div>
  )
}

export function DetailFields({ fields = [], columns = 2 }) {
  return (
    <div className={`drawer-fields${columns === 1 ? ' drawer-fields--single' : ''}`}>
      {fields.map((f) => (
        <div key={f.label}>
          <div className="drawer-field__label">{f.label}</div>
          <div className="drawer-field__value">{f.value ?? '—'}</div>
        </div>
      ))}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Icon from '@/components/ui/Icons'

function MiniSpinner({ size = 14 }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Three-dot row action menu. Pass `actions` as
 * [{ label, onClick, hidden?, disabled?, danger?, loadingLabel? }].
 *
 * Async `onClick` handlers are awaited; the trigger and all items stay
 * disabled until the promise settles. Pass `busy` when the parent page
 * already has an in-flight row action (blocks every menu on the page).
 */
export default function RowActionsMenu({ actions, ariaLabel = 'Row actions', busy = false }) {
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [pendingLabel, setPendingLabel] = useState(null)

  const menuBusy = busy || !!pendingLabel

  const visible = (actions || []).filter((a) => !a.hidden)
  if (visible.length === 0) return null

  const updatePosition = () => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const menuW = 168
    let left = rect.right - menuW
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - menuW - VIEWPORT_PAD))
    const top = Math.min(rect.bottom + 4, window.innerHeight - 8)
    setPos({ top, left })
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    const onDoc = (e) => {
      if (
        triggerRef.current?.contains(e.target)
        || menuRef.current?.contains(e.target)
      ) return
      if (menuBusy) return
      setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !menuBusy) setOpen(false)
    }
    const onScroll = () => { if (!menuBusy) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, menuBusy])

  useEffect(() => {
    if (menuBusy) setOpen(false)
  }, [menuBusy])

  const runAction = async (action) => {
    if (action.disabled || menuBusy) return
    setOpen(false)
    const result = action.onClick?.()
    if (!result || typeof result.then !== 'function') return
    setPendingLabel(action.label)
    try {
      await result
    } finally {
      setPendingLabel(null)
    }
  }

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        minWidth: 168,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-md)',
        zIndex: 1100,
        overflow: 'hidden',
        padding: '4px 0',
      }}
    >
      {visible.map((action) => {
        const isPending = pendingLabel === action.label
        const itemDisabled = action.disabled || menuBusy
        const label = isPending
          ? (action.loadingLabel || `${action.label}…`)
          : action.label
        return (
          <button
            key={action.label}
            type="button"
            role="menuitem"
            disabled={itemDisabled}
            onClick={() => runAction(action)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '8px 14px',
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: itemDisabled ? 'not-allowed' : 'pointer',
              color: action.danger ? 'var(--red)' : 'var(--text-secondary)',
              opacity: itemDisabled ? 0.5 : 1,
            }}
            onMouseEnter={(e) => {
              if (itemDisabled) return
              e.currentTarget.style.background = action.danger ? 'var(--red-bg)' : 'var(--bg-hover)'
              if (!action.danger) e.currentTarget.style.color = 'var(--text-primary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = action.danger ? 'var(--red)' : 'var(--text-secondary)'
            }}
          >
            {isPending && <MiniSpinner size={14} />}
            {label}
          </button>
        )
      })}
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-secondary btn-sm page-actions-menu__trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={menuBusy}
        disabled={menuBusy}
        onClick={() => {
          if (menuBusy) return
          setOpen((v) => !v)
        }}
        style={{ opacity: menuBusy ? 0.5 : 1 }}
      >
        {menuBusy && pendingLabel ? <MiniSpinner size={14} /> : <Icon.MoreVertical size={16} />}
      </button>
      {menu}
    </>
  )
}

const VIEWPORT_PAD = 8

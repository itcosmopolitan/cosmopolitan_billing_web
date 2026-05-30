import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Icon from '@/components/ui/Icons'

/**
 * Three-dot row action menu. Pass `actions` as
 * [{ label, onClick, hidden?, disabled?, danger? }].
 */
export default function RowActionsMenu({ actions, ariaLabel = 'Row actions' }) {
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })

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
      setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

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
      {visible.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          onClick={() => {
            if (action.disabled) return
            setOpen(false)
            action.onClick?.()
          }}
          style={{
            display: 'block',
            width: '100%',
            padding: '8px 14px',
            border: 'none',
            background: 'transparent',
            textAlign: 'left',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: action.disabled ? 'not-allowed' : 'pointer',
            color: action.danger ? 'var(--red)' : 'var(--text-secondary)',
            opacity: action.disabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (action.disabled) return
            e.currentTarget.style.background = action.danger ? 'var(--red-bg)' : 'var(--bg-hover)'
            if (!action.danger) e.currentTarget.style.color = 'var(--text-primary)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = action.danger ? 'var(--red)' : 'var(--text-secondary)'
          }}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-xs"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ padding: '4px 8px', lineHeight: 1 }}
      >
        <Icon.MoreVertical size={16} />
      </button>
      {menu}
    </>
  )
}

const VIEWPORT_PAD = 8

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Icon from '@/components/ui/Icons'

const VIEWPORT_PAD = 8

/** Standard Export + Refresh actions for list page headers. */
export function buildListPageMenuActions({ onExport, onRefresh, hideExport = false }) {
  const actions = []
  if (!hideExport && onExport) {
    actions.push({
      label: 'Export',
      icon: <Icon.Download size={16} />,
      onClick: onExport,
    })
  }
  if (onRefresh) {
    actions.push({
      label: 'Refresh List',
      icon: <Icon.RefreshCw size={16} />,
      onClick: onRefresh,
    })
  }
  return actions
}

/**
 * Header three-dot menu for page-level actions (Export, Refresh, etc.).
 * actions: [{ label, icon: ReactNode, onClick, hidden?, disabled? }]
 */
export default function PageActionsMenu({ actions, ariaLabel = 'More actions' }) {
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
    const menuW = 200
    let left = rect.right - menuW
    left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - menuW - VIEWPORT_PAD))
    const top = Math.min(rect.bottom + 4, window.innerHeight - 8)
    setPos({ top, left })
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    const onDoc = (e) => {
      if (triggerRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
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

  const runAction = (action) => {
    if (action.disabled) return
    setOpen(false)
    action.onClick?.()
  }

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="page-actions-menu"
      style={{ top: pos.top, left: pos.left }}
    >
      {visible.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          className="page-actions-menu__item"
          onClick={() => runAction(action)}
        >
          {action.icon && (
            <span className="page-actions-menu__icon" aria-hidden>
              {action.icon}
            </span>
          )}
          <span className="page-actions-menu__label">{action.label}</span>
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
        className="btn btn-secondary btn-sm page-actions-menu__trigger"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon.MoreVertical size={16} />
      </button>
      {menu}
    </>
  )
}

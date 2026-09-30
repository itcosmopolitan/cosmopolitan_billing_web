import { Fragment, useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const menuW = 200
      const menuH = Math.min(visible.length * 38 + 8, window.innerHeight - VIEWPORT_PAD * 2)
      let left = rect.right - menuW
      left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - menuW - VIEWPORT_PAD))
      const availableAbove = rect.top - VIEWPORT_PAD
      const availableBelow = window.innerHeight - rect.bottom - VIEWPORT_PAD
      const openBelow = availableBelow >= menuH || availableBelow >= availableAbove
      const top = openBelow
        ? Math.min(rect.bottom + 4, window.innerHeight - menuH - VIEWPORT_PAD)
        : Math.max(VIEWPORT_PAD, rect.top - menuH - 4)
      setPos({ top, left })
    }
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
  }, [open, menuBusy, visible.length])

  useEffect(() => {
    if (menuBusy) setOpen(false)
  }, [menuBusy])

  if (visible.length === 0) return null

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
      className="row-actions-menu"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        maxHeight: `calc(100vh - ${VIEWPORT_PAD * 2}px)`,
      }}
    >
      {visible.map((action, index) => {
        const isPending = pendingLabel === action.label
        const itemDisabled = action.disabled || menuBusy
        const label = isPending
          ? (action.loadingLabel || `${action.label}…`)
          : action.label
        return (
          <Fragment key={action.label}>
            {action.danger && index > 0 && !visible[index - 1].danger && (
              <div className="row-actions-menu__separator" role="separator" />
            )}
            <button
              type="button"
              role="menuitem"
              className={`row-actions-menu__item${action.danger ? ' is-danger' : ''}`}
              disabled={itemDisabled}
              onClick={() => runAction(action)}
            >
              {isPending && <MiniSpinner size={14} />}
              {label}
            </button>
          </Fragment>
        )
      })}
    </div>,
    document.body,
  ) : null

  return (
    <span data-no-row-click style={{ display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-sm page-actions-menu__trigger row-actions-menu__trigger"
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
    </span>
  )
}

const VIEWPORT_PAD = 8

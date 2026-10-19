import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as Icon from '@/components/ui/Icons'

const VIEWPORT_PAD = 8

export function ListPageActionButtons({ onExport, onRefresh, hideExport = false }) {
  return (
    <>
      {!hideExport && onExport && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onExport}>
          <Icon.Download size={15} />
          Export
        </button>
      )}
      {onRefresh && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
          <Icon.RefreshCw size={15} />
          Refresh
        </button>
      )}
    </>
  )
}

/** Standard list export actions for page headers. */
export function buildListPageMenuActions({
  onExport,
  onExportPdf,
  onRefresh,
  hideExport = false,
  hideExportPdf = false,
  exportLabel = 'Export Excel',
  exportDisabled = false,
  exportPdfLabel = 'Export PDF',
  exportPdfDisabled = false,
}) {
  const actions = []
  if (!hideExport && onExport) {
    actions.push({
      label: exportLabel,
      icon: <Icon.Download size={16} />,
      disabled: exportDisabled,
      placement: 'header',
      onClick: onExport,
    })
  }
  if (!hideExportPdf && onExportPdf) {
    actions.push({
      label: exportPdfLabel,
      icon: <Icon.Download size={16} />,
      disabled: exportPdfDisabled,
      placement: 'header',
      onClick: onExportPdf,
    })
  }
  // if (onRefresh) {
  //   actions.push({
  //     label: 'Refresh List',
  //     icon: <Icon.RefreshCw size={16} />,
  //     onClick: onRefresh,
  //   })
  // }
  return actions
}

/**
 * Renders header actions as buttons and keeps other page actions in the menu.
 * actions: [{ label, icon: ReactNode, onClick, placement?, hidden?, disabled? }]
 */
export default function PageActionsMenu({ actions, ariaLabel = 'More actions' }) {
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  const available = (actions || []).filter((a) => !a.hidden)
  const headerActions = available.filter((action) => action.placement === 'header')
  const visible = available.filter((action) => action.placement !== 'header')

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

  if (visible.length === 0 && headerActions.length === 0) return null

  const runAction = (action) => {
    if (action.disabled) return
    setOpen(false)
    action.onClick?.()
  }

  const menu = open && visible.length > 0 ? createPortal(
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {headerActions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
      {visible.length > 0 && (
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
      )}
      {menu}
    </div>
  )
}

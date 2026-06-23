import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6
const VIEWPORT_PAD = 8
const ROW_H = 34

/**
 * Compact payment-method picker for the POS cart footer. Opens upward so
 * options are not clipped by the bottom of the viewport (native <select>
 * cannot flip direction reliably).
 */
export default function PosPaymentMethodSelect({ value, onChange, options, placeholder = 'Method…' }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  const selected = options.find((o) => o.id === value && !o.disabled)

  const reposition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const listHeight = options.length * ROW_H + 8
    const top = Math.max(VIEWPORT_PAD, rect.top - listHeight - GAP)
    setCoords({ top, left: rect.left, width: rect.width })
  }, [options.length])

  useLayoutEffect(() => {
    if (open) reposition()
  }, [open, reposition])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      const inTrigger = triggerRef.current?.contains(e.target)
      const inPopover = popoverRef.current?.contains(e.target)
      if (!inTrigger && !inPopover) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  const pick = (id) => {
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
        zIndex: 1100,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: '0 -4px 20px rgba(15, 23, 42, 0.14)',
        padding: 4,
      }}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={o.id === value}
          disabled={o.disabled}
          onClick={() => !o.disabled && pick(o.id)}
          style={{
            display: 'block',
            width: '100%',
            height: ROW_H,
            padding: '0 10px',
            border: 'none',
            borderRadius: 6,
            textAlign: 'left',
            fontSize: 12,
            lineHeight: `${ROW_H}px`,
            cursor: o.disabled ? 'not-allowed' : 'pointer',
            color: o.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
            background: o.id === value ? 'var(--accent-bg)' : 'transparent',
            opacity: o.disabled ? 0.55 : 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {o.label}
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
        className="form-input"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: 152,
          minWidth: 132,
          maxWidth: '100%',
          height: 34,
          padding: '0 10px',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
          color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
          flexShrink: 0,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label || placeholder}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 6, flexShrink: 0 }}>▴</span>
      </button>
      {popover}
    </>
  )
}

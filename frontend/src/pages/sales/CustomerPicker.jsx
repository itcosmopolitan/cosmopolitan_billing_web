/**
 * CustomerPicker — strict typeahead used inside OrderFormModal +
 * QuoteFormModal + PaymentFormModal to pick a real customer for the
 * SO / Quote / Payment. Mirrors the shape of InventoryItemPicker and
 * VendorPicker so the three pickers feel identical.
 *
 * STRICT: there is no free-form fallback. If the operator wants a
 * customer that doesn't exist, they need to create it from the Customers
 * page first.
 *
 * Popover positioning (2026-05-25):
 *   Dropdown is portaled to document.body with position:fixed so it
 *   escapes any ancestor `overflow: auto` clipping (e.g. a Modal whose
 *   `.modal-body` clips absolute children). Coordinates are recomputed
 *   on scroll/resize; flips above the trigger when there's not enough
 *   room below. Same pattern as MultiSelect (see ISS-012 in WORKSHEET).
 *
 * Two visual states:
 *   • Unselected (value == null)
 *       → input + portaled dropdown with debounced results from
 *         customersAPI.list({ search }).
 *   • Selected (value = { id, name })
 *       → locked name as static text + small × button to clear.
 *
 * Props:
 *   • value     — null | { id, name }
 *   • onPick(c) — full customer record (id, name, phone, gst_in, ...)
 *   • onClear() — back to unselected
 *   • disabled  — readOnly mode (view); hides input + × button.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { customersAPI } from '@/api'
import { unwrapPaged } from '@/utils/pagination'

const DEBOUNCE_MS = 250
const PAGE_SIZE = 30
const POPOVER_MAX_H = 240
const POPOVER_GAP = 4
const VIEWPORT_PAD = 8

export default function CustomerPicker({
  value,
  onPick,
  onClear,
  disabled = false,
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, maxHeight: POPOVER_MAX_H })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)

  // Compute popover placement relative to the viewport. Flips above when
  // there's not enough room below. Pure function of the trigger rect —
  // safe to call from scroll/resize handlers.
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

  // Outside-click / Escape / scroll / resize handling. Scroll uses
  // capture so nested scrollable ancestors (e.g. the modal-body) also
  // trigger repositioning.
  useEffect(() => {
    if (!open) return undefined
    function onDown(e) {
      const inTrigger = triggerRef.current && triggerRef.current.contains(e.target)
      const inPopover = popoverRef.current && popoverRef.current.contains(e.target)
      if (!inTrigger && !inPopover) setOpen(false)
    }
    function onKey(e) {
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

  // Debounced search. Fetches only when open AND nothing selected.
  useEffect(() => {
    if (value) return
    if (!open) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const raw = await customersAPI.list({
          search: search || undefined,
          per_page: PAGE_SIZE,
          page_no: 1,
          sort_by: 'name',
          sort_order: 'asc',
          include_total: false,
        })
        if (cancelled) return
        const rows = unwrapPaged(raw).items || []
        setResults(rows.filter((r) => r.active !== false))
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, open, value])

  // ── Selected state ──────────────────────────────────────────────────
  if (value) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          minHeight: 38,
          border: '1px solid var(--border-default)',
          borderRadius: 6,
          background: 'var(--bg-raised)',
        }}
      >
        <span
          style={{
            fontWeight: 500,
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={value.name}
        >
          {value.name}
        </span>
        {!disabled && (
          <button
            type="button"
            onClick={onClear}
            title="Clear customer"
            aria-label="Clear picked customer"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: '2px 6px',
              borderRadius: 4,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-surface)'
              e.currentTarget.style.color = 'var(--red)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = 'var(--text-muted)'
            }}
          >
            ×
          </button>
        )}
      </div>
    )
  }

  // ── Portal-positioned popover (escapes modal-body's overflow:auto) ──
  const popover = open && !disabled ? createPortal(
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
        overflowY: 'auto',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        zIndex: 10000,
        boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
      }}
    >
      {loading && (
        <div style={{ padding: 10, color: 'var(--text-muted)', fontSize: 12 }}>
          Searching…
        </div>
      )}
      {!loading && results.length === 0 && (
        <div style={{ padding: 10, color: 'var(--text-muted)', fontSize: 12 }}>
          {search
            ? `No customers match "${search}". Add via the Customers page.`
            : 'No customers found. Add via the Customers page.'}
        </div>
      )}
      {!loading &&
        results.map((c) => {
          const phone = c.phone || ''
          const gst = c.gst_in || ''
          const hintParts = []
          if (phone) hintParts.push(phone)
          if (gst) hintParts.push(gst)
          if (!hintParts.length && c.customer_type) hintParts.push(c.customer_type)
          const hint = hintParts.join(' · ')
          return (
            <div
              key={c.id}
              role="option"
              tabIndex={0}
              onClick={() => {
                onPick(c)
                setSearch('')
                setOpen(false)
              }}
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                borderBottom: '1px solid var(--border-subtle)',
                fontSize: 13,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-bg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span
                style={{
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
              >
                {c.name}
              </span>
              {hint && (
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {hint}
                </span>
              )}
            </div>
          )
        })}
    </div>,
    document.body,
  ) : null

  // ── Unselected state ────────────────────────────────────────────────
  return (
    <div ref={triggerRef} style={{ position: 'relative' }}>
      <input
        className="form-input"
        placeholder="Search customers…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        autoComplete="off"
      />
      {popover}
    </div>
  )
}

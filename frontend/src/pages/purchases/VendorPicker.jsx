/**
 * VendorPicker — strict typeahead used inside BillFormModal +
 * PurchaseOrderFormModal to pick a real vendor. Mirror of CustomerPicker
 * — same UX, same shape, swap in /vendors/ instead of /customers/.
 *
 * STRICT: no free-form fallback. Operator must pick from existing
 * vendors (create one via Vendors page if missing). Bills + POs always
 * need a real vendor — anonymous purchases don't exist as a workflow.
 *
 * Props:
 *   • value     — null | { id, name }
 *   • onPick(v) — full vendor record (id, name, phone, gst_in, ...)
 *   • onClear() — back to unselected
 *   • disabled  — view mode
 */
import { useEffect, useRef, useState } from 'react'
import { vendorsAPI } from '@/api'
import { unwrapPaged } from '@/utils/pagination'

const DEBOUNCE_MS = 250
const PAGE_SIZE = 30

export default function VendorPicker({ value, onPick, onClear, disabled = false }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)

  // Close on outside click.
  useEffect(() => {
    function onDoc(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Debounced search. Fetches only when open AND nothing selected.
  useEffect(() => {
    if (value) return
    if (!open) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const raw = await vendorsAPI.list({
          search: search || undefined,
          per_page: PAGE_SIZE,
          page_no: 1,
          sort_by: 'name',
          sort_order: 'asc',
          include_total: false,
        })
        if (cancelled) return
        const rows = unwrapPaged(raw).items || []
        setResults(rows)
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

  // Selected state — locked name + × clear button.
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
            title="Clear vendor"
            aria-label="Clear picked vendor"
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

  // Unselected — typeahead + dropdown.
  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <input
        className="form-input"
        placeholder="Search vendors…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        autoComplete="off"
      />
      {open && !disabled && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            marginTop: 4,
            maxHeight: 240,
            overflowY: 'auto',
            zIndex: 100,
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
                ? `No vendors match "${search}". Add via the Vendors page.`
                : 'No vendors found. Add via the Vendors page.'}
            </div>
          )}
          {!loading &&
            results.map((v) => {
              // Hint priority: phone is most-identifying (operator usually
              // has it from the AP file). GSTIN added when present for
              // B2B compliance.
              const hintParts = []
              if (v.phone) hintParts.push(v.phone)
              if (v.gst_in) hintParts.push(v.gst_in)
              const hint = hintParts.join(' · ')
              return (
                <div
                  key={v.id}
                  role="option"
                  tabIndex={0}
                  onClick={() => {
                    onPick(v)
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
                    {v.name}
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
        </div>
      )}
    </div>
  )
}

/**
 * CustomerPicker — strict typeahead used inside OrderFormModal +
 * QuoteFormModal to pick a real customer for the SO/Quote. Mirrors the
 * shape of InventoryItemPicker so the two pickers feel identical.
 *
 * STRICT: there is no free-form fallback. If the operator wants a
 * customer that doesn't exist, they need to create it from the Customers
 * page first. (User explicitly chose strict — SO/Quote are formal
 * documents that need a real counter-party, and an empty/free-form name
 * makes downstream actions like Convert to Invoice, payment recording,
 * and credit_balance tracking ambiguous.)
 *
 * Two visual states:
 *   • Unselected (value == null)
 *       → input + dropdown popover with debounced results from
 *         customersAPI.list({ search }).
 *   • Selected (value = { id, name })
 *       → locked name as static text + small × button to clear.
 *
 * Props:
 *   • value     — null | { id, name } — current selection.
 *   • onPick(c) — called with the full customer record (id, name,
 *                 phone, gst_in, outstanding, credit_balance, ...).
 *   • onClear() — called when the operator clicks ×.
 *   • disabled  — readOnly mode (view); hides input + × button.
 *
 * The dropdown is `position: absolute` inside a `position: relative`
 * wrapper so it scrolls with the modal content (same approach as
 * InventoryItemPicker). The wider parent FormGroup gives it enough
 * width that the phone/GSTIN hint doesn't get clipped.
 */
import { useEffect, useRef, useState } from 'react'
import { customersAPI } from '@/api'
import { unwrapPaged } from '@/utils/pagination'

const DEBOUNCE_MS = 250
const PAGE_SIZE = 30

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
  const wrapperRef = useRef(null)

  // Close on outside click. Without this, opening one picker then
  // clicking elsewhere in the modal leaves the popover floating.
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
  // Empty search hits the API too (returns first N customers
  // alphabetically) so the very first focus shows something useful.
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
        // Hide inactive customers — they can't be paid against / credited
        // against, so picking one for a fresh SO/Quote is almost always
        // an error. (If you DO need to bill an inactive customer, the
        // Customers page lets you reactivate.)
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

  // ── Unselected state — typeahead ────────────────────────────────────
  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
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
            <div
              style={{
                padding: 10,
                color: 'var(--text-muted)',
                fontSize: 12,
              }}
            >
              Searching…
            </div>
          )}
          {!loading && results.length === 0 && (
            <div
              style={{
                padding: 10,
                color: 'var(--text-muted)',
                fontSize: 12,
              }}
            >
              {search
                ? `No customers match "${search}". Add via the Customers page.`
                : 'No customers found. Add via the Customers page.'}
            </div>
          )}
          {!loading &&
            results.map((c) => {
              // Hint priority: phone is most-identifying for retail customers
              // (operator usually has it from the till). GSTIN is added when
              // present for B2B; falls back to customer type.
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
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--accent-bg)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
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
        </div>
      )}
    </div>
  )
}

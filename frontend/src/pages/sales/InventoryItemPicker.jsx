/**
 * InventoryItemPicker — typeahead used inside OrderFormModal +
 * QuoteFormModal to pick a real inventory item for a Sales Order /
 * Quotation line. Replaces the legacy free-form item-name input so
 * every saved line carries a real `item_id` (per 2026-05-24 strict
 * scope agreed with user).
 *
 * Two visual states:
 *   • Unselected (value == null)
 *       → renders an input + a dropdown popover with debounced
 *         results from itemsAPI.list({ branch_id, search, pos_mode }).
 *         Clicking a row calls onPick(item) with the full inventory
 *         record so the parent can fill name/price/taxRate.
 *   • Selected (value = { id, name })
 *       → renders the locked name as static text + a small × button
 *         that calls onClear(). The × is hidden when `disabled`.
 *
 * Props:
 *   • branchId      — required. Scopes the search to the active branch
 *                     (matches the line's branch — SO/Quote modals pass
 *                     orderForm.branchId / quoteForm.branchId). Refetches
 *                     when this changes.
 *   • value         — null | { id, name } — current selection.
 *   • onPick(item)  — called with the full inventory record (id, name,
 *                     selling_price, tax_rate, available_stock, etc.).
 *   • onClear()     — called when the operator clicks ×.
 *   • disabled      — readOnly mode (view); hides the × button and the
 *                     input.
 *   • excludeIds    — item IDs already picked in OTHER rows of the same
 *                     form. Filtered out of the dropdown client-side so
 *                     the operator can't accidentally double-pick the
 *                     same SKU. Pass [] if no exclusions.
 *
 * Style choice: dropdown is `position: absolute` inside a `position:
 * relative` wrapper so it scrolls with the modal content. Unlike the
 * MultiSelect portal-fix (ISS-012), this dropdown lives in the items
 * table row itself — when the modal body scrolls, the dropdown moves
 * with its anchor cell, which is the correct behavior here.
 */
import { useEffect, useRef, useState } from 'react'
import { itemsAPI } from '@/api'
import { unwrapPaged } from '@/utils/pagination'
import { fmt } from '@/utils/helpers'

const DEBOUNCE_MS = 250
const PAGE_SIZE = 30

export default function InventoryItemPicker({
  branchId,
  value,
  onPick,
  onClear,
  disabled = false,
  excludeIds = [],
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)
  const inputRef = useRef(null)
  const lastQueryRef = useRef(null)

  // Close the dropdown when the operator clicks outside the picker. Without
  // this, opening one picker then clicking elsewhere in the modal would
  // leave the popover floating over other rows.
  useEffect(() => {
    function onDoc(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Debounced search. Fetches when the dropdown is open, whether a value
  // is already selected or not. This lets the picker reopen as a dropdown
  // for re-selection without forcing the user to clear first.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const key = `${open ? 1 : 0}|${branchId || ''}|${search || ''}|${excludeIds.join('|')}`
    if (lastQueryRef.current === key) return
    lastQueryRef.current = key
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const raw = await itemsAPI.list({
          branch_id: branchId,
          search: search || undefined,
          per_page: PAGE_SIZE,
          page_no: 1,
          sort_by: 'name',
          sort_order: 'asc',
          pos_mode: true,
          include_total: false,
        })
        if (cancelled) return
        const rows = (unwrapPaged(raw).items || []).filter(
          (r) => !excludeIds.includes(r.id),
        )
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
    // excludeIds is recreated on every parent render — depend on its
    // serialized form so we don't refetch needlessly when the parent
    // re-renders with the same set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, open, branchId, excludeIds.join('|')])

  // ── Selected state ──────────────────────────────────────────────────
  if (value) {
    return (
      <div ref={wrapperRef} style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          className="form-input"
          placeholder="Search inventory…"
          value={open ? search : value.name}
          onChange={(e) => {
            setSearch(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          disabled={disabled}
          autoComplete="off"
          aria-label={`Selected item ${value.name}. Type to replace.`}
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
                {open && search
                  ? `No items match "${search}"`
                  : 'No items found in this branch'}
              </div>
            )}
            {!loading &&
              results.map((r) => {
                const stock = r.available_stock ?? 0
                const oos = stock <= 0
                return (
                  <div
                    key={r.id}
                    role="option"
                    tabIndex={0}
                    onClick={() => {
                      onPick(r)
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
                      {r.name}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: oos ? 'var(--red)' : 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {fmt(r.selling_price)} ·{' '}
                      {oos ? 'Out of stock' : `${stock} in stock`}
                    </span>
                  </div>
                )
              })}
          </div>
        )}
        {!disabled && (
          <button
            type="button"
            onClick={onClear}
            title="Clear item"
            aria-label="Clear picked item"
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
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
              e.currentTarget.style.background = 'var(--bg-raised)'
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
        ref={inputRef}
        className="form-input"
        placeholder="Search inventory…"
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
                ? `No items match "${search}"`
                : 'No items found in this branch'}
            </div>
          )}
          {!loading &&
            results.map((r) => {
              const stock = r.available_stock ?? 0
              const oos = stock <= 0
              return (
                <div
                  key={r.id}
                  role="option"
                  tabIndex={0}
                  onClick={() => {
                    onPick(r)
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
                    {r.name}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: oos ? 'var(--red)' : 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {fmt(r.selling_price)} ·{' '}
                    {oos ? 'Out of stock' : `${stock} in stock`}
                  </span>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}

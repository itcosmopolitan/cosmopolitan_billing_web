/**
 * InventoryItemPicker — typeahead used inside sales + purchase line-item
 * forms (invoice, quote, SO, bill, PO) and stock transfers.
 *
 * Two visual states:
 *   • Unselected (value == null) — search input + dropdown
 *   • Selected (value = { id, name }) — name in the input, × to clear
 *
 * The dropdown loads the first page (`PAGE_SIZE`) on open, then appends
 * further pages as the operator scrolls near the bottom.
 *
 * Props:
 *   • branchId, value, onPick(item), onClear(), disabled, excludeIds
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { itemsAPI } from '@/api'
import { unwrapPaged } from '@/utils/pagination'
import { fmt, fmtQty } from '@/utils/helpers'

const DEBOUNCE_MS = 250
const PAGE_SIZE = 30
const LOAD_MORE_PX = 56

const DROPDOWN_STYLE = {
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
}

function mergeById(prev, rows) {
  if (!rows.length) return prev
  const seen = new Set(prev.map((r) => r.id))
  const added = rows.filter((r) => !seen.has(r.id))
  if (!added.length) return prev
  return [...prev, ...added]
}

function StatusRow({ children }) {
  return (
    <div style={{ padding: 10, color: 'var(--text-muted)', fontSize: 12 }}>
      {children}
    </div>
  )
}

function ResultRow({ item, onPick }) {
  const stock = item.available_stock ?? 0
  const oos = stock <= 0
  return (
    <div
      role="option"
      tabIndex={0}
      onClick={() => onPick(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick(item)
        }
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
        {item.name}
      </span>
      <span
        style={{
          fontSize: 11,
          color: oos ? 'var(--red)' : 'var(--text-muted)',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {fmt(item.selling_price)} ·{' '}
        {oos ? 'Out of stock' : `${fmtQty(stock)} in stock`}
      </span>
    </div>
  )
}

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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [pageNo, setPageNo] = useState(1)
  const [open, setOpen] = useState(false)

  const wrapperRef = useRef(null)
  const listRef = useRef(null)
  const fetchGenRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const hasMoreRef = useRef(false)
  const pageNoRef = useRef(1)
  const excludeKey = excludeIds.join('|')

  hasMoreRef.current = hasMore
  pageNoRef.current = pageNo

  useEffect(() => {
    function onDoc(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const fetchPage = useCallback(async (page) => {
    const raw = await itemsAPI.list({
      branch_id: branchId,
      search: search || undefined,
      per_page: PAGE_SIZE,
      page_no: page,
      sort_by: 'name',
      sort_order: 'asc',
      pos_mode: true,
      include_total: false,
    })
    const data = unwrapPaged(raw)
    const rows = (data.items || []).filter((r) => !excludeIds.includes(r.id))
    return {
      rows,
      pageNo: data.pageNo || page,
      hasMorePage: Boolean(data.hasMorePage),
    }
  }, [branchId, search, excludeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // First page — open, search, branch, or exclusion set changed.
  useEffect(() => {
    if (!open) return undefined
    const gen = ++fetchGenRef.current
    loadingMoreRef.current = false
    setLoadingMore(false)
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await fetchPage(1)
        if (gen !== fetchGenRef.current) return
        setResults(data.rows)
        setPageNo(data.pageNo)
        setHasMore(data.hasMorePage)
      } catch {
        if (gen !== fetchGenRef.current) return
        setResults([])
        setPageNo(1)
        setHasMore(false)
      } finally {
        if (gen === fetchGenRef.current) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      fetchGenRef.current += 1
    }
  }, [open, fetchPage])

  const loadMore = useCallback(async () => {
    if (!open || loading || loadingMoreRef.current || !hasMoreRef.current) return
    const gen = fetchGenRef.current
    const nextPage = pageNoRef.current + 1
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const data = await fetchPage(nextPage)
      if (gen !== fetchGenRef.current) return
      setResults((prev) => mergeById(prev, data.rows))
      setPageNo(data.pageNo)
      setHasMore(data.hasMorePage)
    } catch {
      if (gen === fetchGenRef.current) setHasMore(false)
    } finally {
      if (gen === fetchGenRef.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [open, loading, fetchPage])

  // If the first page doesn't fill the dropdown, pull the next page so the
  // operator isn't stuck with a short list that never scrolls.
  useLayoutEffect(() => {
    if (!open || loading || loadingMore || !hasMore) return
    const el = listRef.current
    if (!el) return
    if (el.scrollHeight <= el.clientHeight + LOAD_MORE_PX) {
      loadMore()
    }
  }, [open, loading, loadingMore, hasMore, results, loadMore])

  const handleScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= LOAD_MORE_PX) {
      loadMore()
    }
  }

  const pick = (item) => {
    onPick(item)
    setSearch('')
    setOpen(false)
  }

  const inputValue = value && !open ? value.name : search
  const emptyMessage = search
    ? `No items match "${search}"`
    : 'No items found in this branch'

  const dropdown = open && !disabled && (
    <div ref={listRef} style={DROPDOWN_STYLE} onScroll={handleScroll}>
      {loading && results.length === 0 && <StatusRow>Searching…</StatusRow>}
      {!loading && results.length === 0 && <StatusRow>{emptyMessage}</StatusRow>}
      {results.map((r) => (
        <ResultRow key={r.id} item={r} onPick={pick} />
      ))}
      {loadingMore && <StatusRow>Loading more…</StatusRow>}
    </div>
  )

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <input
        className="form-input"
        placeholder="Search inventory…"
        value={inputValue}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
        autoComplete="off"
        aria-label={value ? `Selected item ${value.name}. Type to replace.` : 'Search inventory'}
      />
      {dropdown}
      {value && !disabled && (
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

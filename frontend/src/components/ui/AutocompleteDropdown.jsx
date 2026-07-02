import { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api'

const GAP = 6
const VIEWPORT_PAD = 8
const ROW_H = 34
const POPOVER_MAX_H = 280
const DEBOUNCE_MS = 250

function normalizeAutocompleteRows(data) {
  const rows = Array.isArray(data) ? data : (data?.items || [])
  return rows.map((r) => ({
    id: r.id,
    label: r.text ?? r.label ?? r.name ?? '',
    searchText: r.text ?? r.label ?? r.name ?? '',
    disabled: Boolean(r.disabled),
    raw: r,
  }))
}

/**
 * Compact single-select dropdown with optional local options or remote
 * autocomplete (`fetchUrl`). Pass `isSearchFieldRequired` on every usage —
 * when true, shows a search field (local filter or remote `search_text`).
 */
export default function AutocompleteDropdown({
  value,
  onChange,
  onSelectOption,
  options = [],
  prependOptions = [],
  placeholder = 'Select…',
  selectedLabel,
  isSearchFieldRequired = false,
  searchPlaceholder = 'Search…',
  fetchUrl,
  fetchParams,
  direction = 'auto',
  loading = false,
  loadingLabel = 'Loading…',
  emptyLabel = 'No items found',
  noMatchLabel = 'No matches',
  disabled = false,
  clearable = false,
  onClear,
  style,
  className = 'form-input',
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [apiOptions, setApiOptions] = useState([])
  const [apiLoading, setApiLoading] = useState(false)
  const [pickedLabel, setPickedLabel] = useState('')
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, maxHeight: POPOVER_MAX_H, flipUp: false })
  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const searchRef = useRef(null)
  const fetchRequestIdRef = useRef(0)

  const remote = Boolean(fetchUrl)
  const fetchParamsKey = JSON.stringify(fetchParams || {})
  const effectiveOptions = useMemo(
    () => (remote ? [...prependOptions, ...apiOptions] : [...prependOptions, ...options]),
    [remote, prependOptions, apiOptions, options],
  )
  const effectiveLoading = remote ? apiLoading : loading

  const q = search.trim().toLowerCase()
  const filteredOptions = isSearchFieldRequired && q
    ? effectiveOptions.filter((o) => {
      const hay = (o.searchText ?? o.label ?? '').toLowerCase()
      return hay.includes(q)
    })
    : effectiveOptions

  const selected = effectiveOptions.find((o) => o.id === value && !o.disabled)
  const triggerLabel = selected?.label || (value && (selectedLabel || pickedLabel)) || placeholder
  const hasSelection = Boolean(selected || (value && selectedLabel))
  const listLoading = effectiveLoading && filteredOptions.length === 0

  const reposition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PAD
    const spaceAbove = rect.top - VIEWPORT_PAD

    let flipUp = false
    if (direction === 'up') {
      flipUp = true
    } else if (direction === 'down') {
      flipUp = false
    } else {
      flipUp = spaceBelow < Math.min(POPOVER_MAX_H, 160) && spaceAbove > spaceBelow
    }

    const maxHeight = Math.max(120, Math.min(
      POPOVER_MAX_H,
      flipUp ? spaceAbove : spaceBelow,
    ))

    const listHeight = Math.min(
      Math.max(filteredOptions.length, listLoading ? 1 : 0) * ROW_H + (isSearchFieldRequired ? 44 : 8),
      maxHeight,
    )

    const top = flipUp
      ? Math.max(VIEWPORT_PAD, rect.top - listHeight - GAP)
      : rect.bottom + GAP

    setCoords({
      top,
      left: rect.left,
      width: rect.width,
      maxHeight,
      flipUp,
    })
  }, [direction, filteredOptions.length, isSearchFieldRequired, listLoading])

  useLayoutEffect(() => {
    if (open) reposition()
  }, [open, reposition])

  useLayoutEffect(() => {
    if (open && isSearchFieldRequired && searchRef.current) searchRef.current.focus()
  }, [open, isSearchFieldRequired])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!remote || !open) return undefined
    const requestId = ++fetchRequestIdRef.current
    const delay = isSearchFieldRequired && search.trim() ? DEBOUNCE_MS : 0
    const timer = setTimeout(async () => {
      setApiLoading(true)
      try {
        const params = Object.fromEntries(
          Object.entries({ ...(fetchParams || {}) }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
        )
        const trimmed = search.trim()
        if (isSearchFieldRequired && trimmed) params.search_text = trimmed
        const data = await api.get(fetchUrl, { params })
        if (requestId !== fetchRequestIdRef.current) return
        setApiOptions(normalizeAutocompleteRows(data))
      } catch {
        if (requestId !== fetchRequestIdRef.current) return
        setApiOptions([])
      } finally {
        if (requestId === fetchRequestIdRef.current) setApiLoading(false)
      }
    }, delay)
    return () => clearTimeout(timer)
  }, [remote, open, search, fetchUrl, fetchParamsKey, isSearchFieldRequired])

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

  const pick = (opt) => {
    if (disabled || opt.disabled) return
    setPickedLabel(opt.label || '')
    onChange?.(opt.id)
    onSelectOption?.(opt)
    setOpen(false)
  }

  const handleClear = (e) => {
    e.stopPropagation()
    setPickedLabel('')
    onChange?.('')
    onSelectOption?.(null)
    onClear?.()
  }

  useEffect(() => {
    if (!value) setPickedLabel('')
  }, [value])

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
        overflowY: 'auto',
        zIndex: 1100,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: coords.flipUp
          ? '0 -4px 20px rgba(15, 23, 42, 0.14)'
          : '0 8px 24px rgba(0,0,0,0.18)',
        padding: 4,
      }}
    >
      {isSearchFieldRequired && (
        <div style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          background: 'var(--bg-surface)',
          padding: '2px 2px 4px',
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 2,
        }}
        >
          <input
            ref={searchRef}
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="form-input"
            style={{ fontSize: 12, padding: '6px 8px', width: '100%' }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      )}
      {listLoading ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {loadingLabel}
        </div>
      ) : effectiveOptions.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {emptyLabel}
        </div>
      ) : filteredOptions.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {q ? `${noMatchLabel} for "${search.trim()}"` : emptyLabel}
        </div>
      ) : (
        filteredOptions.map((o) => (
          <button
            key={o.id || '__empty__'}
            type="button"
            role="option"
            aria-selected={o.id === value}
            disabled={o.disabled}
            onClick={() => !o.disabled && pick(o)}
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
        ))
      )}
    </div>,
    document.body,
  ) : null

  return (
    <>
      <div
        ref={triggerRef}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`autocomplete-dropdown-trigger ${className}${disabled ? ' autocomplete-dropdown-trigger--disabled' : ''}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          userSelect: 'none',
          color: hasSelection ? 'var(--text-primary)' : 'var(--text-muted)',
          flexShrink: 0,
          ...style,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {triggerLabel}
        </span>
        {clearable && value && !disabled ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear selection"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: '0 4px',
              marginRight: 2,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        ) : null}
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 6, flexShrink: 0 }}>
          {direction === 'up' || (direction === 'auto' && coords.flipUp) ? '▴' : '▾'}
        </span>
      </div>
      {popover}
    </>
  )
}

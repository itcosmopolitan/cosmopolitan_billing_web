import { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { api, AUTOCOMPLETE_CUSTOMER_URL } from '@/api'

const GAP = 6
const VIEWPORT_PAD = 8
const ROW_H = 34
const DESC_ROW_H = 46
const POPOVER_MAX_H = 280
const DEBOUNCE_MS = 250
const EMPTY_OPTIONS = []
const CUSTOMER_SEARCH_PLACEHOLDER = 'Name or phone…'
const CUSTOMER_LOADING_LABEL = 'Loading customers…'
const CUSTOMER_EMPTY_LABEL = 'No customers found'

function optionDescription(r) {
  return String(r?.description ?? r?.phone ?? '').trim()
}

function normalizeOption(r) {
  const source = r?.raw ?? r ?? {}
  const label = String(r?.text ?? r?.label ?? r?.name ?? '')
  const description = optionDescription(r) || optionDescription(source)
  return {
    id: r?.id,
    label,
    description,
    searchText: [r?.searchText, label, description, source.phone].filter(Boolean).join(' '),
    disabled: Boolean(r?.disabled),
    raw: source,
  }
}

function normalizeAutocompleteRows(data) {
  const rows = Array.isArray(data) ? data : (data?.items || [])
  return rows.map(normalizeOption)
}

function optionRowHeight(opt) {
  return opt?.description ? DESC_ROW_H : ROW_H
}

function LoadingRow({ label }) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: ROW_H,
        padding: '0 10px',
        fontSize: 12,
        color: 'var(--text-muted)',
      }}
    >
      <svg className="spinner" width={12} height={12} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label}
    </div>
  )
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
  options = EMPTY_OPTIONS,
  prependOptions = EMPTY_OPTIONS,
  placeholder = 'Select…',
  selectedLabel,
  isSearchFieldRequired = false,
  searchPlaceholder,
  fetchUrl,
  fetchParams,
  direction = 'auto',
  loading = false,
  loadingLabel,
  emptyLabel,
  noMatchLabel = 'No matches',
  disabled = false,
  clearable = false,
  onClear,
  footerAction = null,
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
  const isCustomerFetch = fetchUrl === AUTOCOMPLETE_CUSTOMER_URL
  const resolvedSearchPlaceholder = searchPlaceholder
    ?? (isCustomerFetch ? CUSTOMER_SEARCH_PLACEHOLDER : 'Search…')
  const resolvedLoadingLabel = loadingLabel
    ?? (isCustomerFetch ? CUSTOMER_LOADING_LABEL : 'Loading…')
  const resolvedEmptyLabel = emptyLabel
    ?? (isCustomerFetch ? CUSTOMER_EMPTY_LABEL : 'No items found')
  const fetchParamsKey = JSON.stringify(fetchParams || {})
  const effectiveOptions = useMemo(
    () => [
      ...prependOptions.map(normalizeOption),
      ...(remote ? apiOptions : options.map(normalizeOption)),
    ],
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
  const triggerTitle = selected?.description
    ? `${triggerLabel} · ${selected.description}`
    : triggerLabel
  const hasSelection = Boolean(selected || (value && selectedLabel))
  const listLoading = effectiveLoading && filteredOptions.length === 0
  const showLoadingRow = effectiveLoading && filteredOptions.length > 0
  const hasDescriptions = filteredOptions.some((o) => o.description)
  const hasFooter = Boolean(footerAction?.label && footerAction?.onClick)
  const rowsHeight = filteredOptions.reduce((sum, o) => sum + optionRowHeight(o), 0)
    + ((listLoading || showLoadingRow) ? ROW_H : 0)

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
      Math.max(rowsHeight, ROW_H)
        + (isSearchFieldRequired ? 44 : 8)
        + (hasFooter ? 40 : 0),
      maxHeight,
    )

    const top = flipUp
      ? Math.max(VIEWPORT_PAD, rect.top - listHeight - GAP)
      : rect.bottom + GAP

    const width = Math.max(rect.width, hasFooter ? 220 : 0, hasDescriptions ? 260 : 0)
    const left = Math.min(
      Math.max(VIEWPORT_PAD, rect.left),
      Math.max(VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD),
    )

    setCoords((prev) => (
      prev.top === top
        && prev.left === left
        && prev.width === width
        && prev.maxHeight === maxHeight
        && prev.flipUp === flipUp
        ? prev
        : { top, left, width, maxHeight, flipUp }
    ))
  }, [direction, rowsHeight, isSearchFieldRequired, hasFooter, hasDescriptions])

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

  useLayoutEffect(() => {
    if (remote && open) setApiLoading(true)
  }, [remote, open])

  useEffect(() => {
    if (!remote || !open) return undefined
    const requestId = ++fetchRequestIdRef.current
    setApiLoading(true)
    const delay = isSearchFieldRequired && search.trim() ? DEBOUNCE_MS : 0
    const timer = setTimeout(async () => {
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
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
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
            placeholder={resolvedSearchPlaceholder}
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
        <LoadingRow label={resolvedLoadingLabel} />
      ) : effectiveOptions.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {resolvedEmptyLabel}
        </div>
      ) : filteredOptions.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
          {q ? `${noMatchLabel} for "${search.trim()}"` : resolvedEmptyLabel}
        </div>
      ) : (
        <>
          {filteredOptions.map((o, idx) => (
            <button
              key={o.id || `__empty_${idx}`}
              type="button"
              role="option"
              aria-selected={o.id === value}
              disabled={o.disabled}
              onClick={() => !o.disabled && pick(o)}
              title={o.description ? `${o.label} · ${o.description}` : o.label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                width: '100%',
                height: optionRowHeight(o),
                padding: o.description ? '4px 10px' : '0 10px',
                border: 'none',
                borderRadius: 6,
                textAlign: 'left',
                fontSize: 12,
                lineHeight: 1.25,
                cursor: o.disabled ? 'not-allowed' : 'pointer',
                color: o.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
                background: o.id === value ? 'var(--accent-bg)' : 'transparent',
                opacity: o.disabled ? 0.55 : 1,
                overflow: 'hidden',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.label}
              </span>
              {o.description ? (
                <span style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {o.description}
                </span>
              ) : null}
            </button>
          ))}
          {showLoadingRow ? <LoadingRow label={resolvedLoadingLabel} /> : null}
        </>
      )}
      {footerAction?.label && footerAction?.onClick && (
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            footerAction.onClick()
          }}
          style={{
            position: 'sticky',
            bottom: -4,
            display: 'block',
            width: '100%',
            height: 36,
            marginTop: 2,
            padding: '0 10px',
            border: 'none',
            borderTop: '1px solid var(--border-subtle)',
            borderRadius: 0,
            textAlign: 'left',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: '36px',
            cursor: 'pointer',
            color: 'var(--accent)',
            background: 'var(--bg-surface)',
          }}
        >
          {footerAction.label}
        </button>
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
        <span
          title={triggerTitle}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
        >
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

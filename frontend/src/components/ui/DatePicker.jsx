import { useState, useRef, useLayoutEffect, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  parseISO,
  isSameMonth,
  isSameDay,
  isToday,
  isBefore,
  isAfter,
  isValid,
  startOfDay,
} from 'date-fns'
import * as Icon from './Icons'

const GAP = 6
const VIEWPORT_PAD = 8
const POPOVER_W = 280

function parseYmd(value) {
  if (!value) return null
  try {
    const d = parseISO(value)
    return isValid(d) ? startOfDay(d) : null
  } catch {
    return null
  }
}

function toYmd(date) {
  return format(date, 'yyyy-MM-dd')
}

function displayLabel(value) {
  const d = parseYmd(value)
  if (!d) return ''
  return format(d, 'dd MMM yyyy')
}

function isDisabledDay(day, minDate, maxDate) {
  if (minDate && isBefore(day, minDate)) return true
  if (maxDate && isAfter(day, maxDate)) return true
  return false
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

/**
 * Date field with a calendar popover. The entire trigger opens the picker —
 * not just a calendar icon.
 */
export default function DatePicker({
  value = '',
  onChange,
  min,
  max,
  placeholder = 'Select date…',
  disabled = false,
  style,
  className = 'form-input',
  title,
  clearable = false,
}) {
  const [open, setOpen] = useState(false)
  const selected = parseYmd(value)
  const minDate = parseYmd(min)
  const maxDate = parseYmd(max)
  const [viewMonth, setViewMonth] = useState(() => selected || startOfDay(new Date()))

  const triggerRef = useRef(null)
  const popoverRef = useRef(null)
  const [coords, setCoords] = useState({ top: 0, left: 0, flipUp: false })

  const reposition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const popoverH = 320
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PAD
    const spaceAbove = rect.top - VIEWPORT_PAD
    const flipUp = spaceBelow < popoverH && spaceAbove > spaceBelow
    const top = flipUp
      ? Math.max(VIEWPORT_PAD, rect.top - popoverH - GAP)
      : rect.bottom + GAP
    const left = Math.min(
      Math.max(VIEWPORT_PAD, rect.left),
      window.innerWidth - POPOVER_W - VIEWPORT_PAD,
    )
    setCoords({ top, left, flipUp })
  }, [])

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

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (selected) setViewMonth(selected)
  }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 1 })
    const end = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end })
  }, [viewMonth])

  const openPicker = () => {
    if (disabled) return
    setViewMonth(selected || startOfDay(new Date()))
    setOpen(true)
  }

  const pickDay = (day) => {
    if (isDisabledDay(day, minDate, maxDate)) return
    onChange?.(toYmd(day))
    setOpen(false)
  }

  const handleClear = (e) => {
    e.stopPropagation()
    onChange?.('')
  }

  const label = displayLabel(value)

  const popover = open ? createPortal(
    <div
      ref={popoverRef}
      className="date-picker-popover"
      role="dialog"
      aria-label="Choose date"
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: POPOVER_W,
        zIndex: 1100,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: coords.flipUp
          ? '0 -4px 20px rgba(15, 23, 42, 0.14)'
          : '0 8px 24px rgba(0,0,0,0.18)',
        padding: 12,
      }}
    >
      <div className="date-picker-header">
        <button
          type="button"
          className="date-picker-nav"
          aria-label="Previous month"
          onClick={() => setViewMonth((m) => subMonths(m, 1))}
        >
          ‹
        </button>
        <span className="date-picker-month">{format(viewMonth, 'MMMM yyyy')}</span>
        <button
          type="button"
          className="date-picker-nav"
          aria-label="Next month"
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
        >
          ›
        </button>
      </div>

      <div className="date-picker-weekdays">
        {WEEKDAYS.map((d) => (
          <span key={d} className="date-picker-weekday">{d}</span>
        ))}
      </div>

      <div className="date-picker-grid">
        {days.map((day) => {
          const outside = !isSameMonth(day, viewMonth)
          const selectedDay = selected && isSameDay(day, selected)
          const today = isToday(day)
          const off = isDisabledDay(day, minDate, maxDate)
          return (
            <button
              key={day.toISOString()}
              type="button"
              className={[
                'date-picker-day',
                outside && 'date-picker-day--outside',
                selectedDay && 'date-picker-day--selected',
                today && 'date-picker-day--today',
                off && 'date-picker-day--disabled',
              ].filter(Boolean).join(' ')}
              disabled={off}
              onClick={() => pickDay(day)}
            >
              {format(day, 'd')}
            </button>
          )
        })}
      </div>

      <div className="date-picker-footer">
        <button
          type="button"
          className="date-picker-today"
          disabled={isDisabledDay(startOfDay(new Date()), minDate, maxDate)}
          onClick={() => pickDay(startOfDay(new Date()))}
        >
          Today
        </button>
        {clearable && value ? (
          <button type="button" className="date-picker-clear" onClick={() => { onChange?.(''); setOpen(false) }}>
            Clear
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <div
        ref={triggerRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        className={`date-picker-trigger ${className}${disabled ? ' date-picker-trigger--disabled' : ''}`}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openPicker()
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          userSelect: 'none',
          ...style,
        }}
      >
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: label ? 'var(--text-primary)' : 'var(--text-muted)',
        }}
        >
          {label || placeholder}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {clearable && value && !disabled ? (
            <button
              type="button"
              aria-label="Clear date"
              onClick={handleClear}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: 0,
                lineHeight: 1,
                fontSize: 14,
              }}
            >
              ×
            </button>
          ) : null}
          <Icon.Calendar size={15} style={{ color: 'var(--text-muted)' }} />
        </span>
      </div>
      {popover}
    </>
  )
}

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AutocompleteDropdown,
  DatePicker,
  Drawer,
  FormGroup,
  SearchBar,
} from '@/components/ui'
import * as Icon from '@/components/ui/Icons'
import type { AuditCriteria, AuditCriteriaJoiner, AuditFilters } from '../../types/audit'
import {
  AUDIT_FILTER_FIELD_OPTIONS,
  AUDIT_DATE_RANGE_OPTIONS,
  AUDIT_JOINER_OPTIONS,
  AUDIT_SELECT_CONDITION_OPTIONS,
  AUDIT_TEXT_CONDITION_OPTIONS,
  auditFieldType,
  auditValueOptionsForField,
  defaultAuditJoiners,
  getAuditDateRangeChipLabel,
  getAuditDateRangeForPreset,
  inferAuditDateRangePreset,
} from '@/utils/dropdownOptions'

interface Props {
  filters: AuditFilters
  onFilter: (patch: Partial<AuditFilters>) => void
  toolbarActions?: ReactNode
}

type FilterRow = {
  id: string
  field: string
  condition: string
  value: string
}

const buildFilterRow = (overrides?: Partial<FilterRow>): FilterRow => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  field: 'module',
  condition: 'is',
  value: '',
  ...overrides,
})

const fieldLabel = (key: string) => AUDIT_FILTER_FIELD_OPTIONS.find((f) => f.id === key)?.label ?? key

const rowChipLabel = (row: { field: string; condition: string; value: string }) => {
  const label = fieldLabel(row.field)
  if (row.condition === 'is empty') return `${label} is empty`
  if (!row.value) return ''
  return `${label} ${row.condition} ${row.value}`
}

const hasActiveCriteriaRows = (rows: FilterRow[]) => (
  rows.some((row) => row.value || row.condition === 'is empty')
)

function stateFromFilters(filters: AuditFilters): { rows: FilterRow[]; joiners: AuditCriteriaJoiner[] } {
  if (filters.criteria?.rows?.length) {
    const rows = filters.criteria.rows.map((row) => buildFilterRow(row))
    const joiners = filters.criteria.joiners?.length
      ? [...filters.criteria.joiners]
      : defaultAuditJoiners(rows.length)
    return { rows, joiners }
  }

  const legacyRows: FilterRow[] = []
  if (filters.module) legacyRows.push(buildFilterRow({ field: 'module', condition: 'is', value: filters.module }))
  if (filters.risk) legacyRows.push(buildFilterRow({ field: 'risk', condition: 'is', value: filters.risk }))
  if (filters.operation_type) {
    legacyRows.push(buildFilterRow({ field: 'action', condition: 'is', value: filters.operation_type }))
  } else if (filters.operation_type_not) {
    legacyRows.push(buildFilterRow({ field: 'action', condition: 'is not', value: filters.operation_type_not }))
  }

  const rows = legacyRows.length > 0 ? legacyRows : [buildFilterRow()]
  return { rows, joiners: defaultAuditJoiners(rows.length) }
}

export function AuditFiltersBar({ filters, onFilter, toolbarActions = null }: Props) {
  const initialState = stateFromFilters(filters)
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState(filters.search ?? '')
  const [filterRows, setFilterRows] = useState<FilterRow[]>(initialState.rows)
  const [joiners, setJoiners] = useState<AuditCriteriaJoiner[]>(initialState.joiners)
  const [draftDatePreset, setDraftDatePreset] = useState(() => inferAuditDateRangePreset(filters.date_from, filters.date_to))
  const [draftDateFrom, setDraftDateFrom] = useState(filters.date_from ?? '')
  const [draftDateTo, setDraftDateTo] = useState(filters.date_to ?? '')

  useEffect(() => {
    setSearchValue(filters.search ?? '')
  }, [filters.search])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if ((filters.search ?? '') !== searchValue) {
        onFilter({ search: searchValue })
      }
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [searchValue, filters.search, onFilter])

  useEffect(() => {
    if (!open) return
    const next = stateFromFilters(filters)
    setFilterRows(next.rows)
    setJoiners(next.joiners)
    setDraftDatePreset(inferAuditDateRangePreset(filters.date_from, filters.date_to))
    setDraftDateFrom(filters.date_from ?? '')
    setDraftDateTo(filters.date_to ?? '')
  }, [open, filters])

  const handleDatePresetChange = (presetId: string) => {
    setDraftDatePreset(presetId)
    if (!presetId) {
      setDraftDateFrom('')
      setDraftDateTo('')
      return
    }
    if (presetId === 'custom') return
    const range = getAuditDateRangeForPreset(presetId)
    setDraftDateFrom(range.from)
    setDraftDateTo(range.to)
  }

  const applyFilters = () => {
    const criteriaRows = filterRows.map(({ field, condition, value }) => ({ field, condition, value }))
    const criteria: AuditCriteria | null = hasActiveCriteriaRows(filterRows)
      ? { rows: criteriaRows, joiners: [...joiners] }
      : null

    onFilter({
      module: '',
      risk: '',
      operation_type: '',
      operation_type_not: '',
      criteria,
      search: searchValue,
      date_from: draftDateFrom || undefined,
      date_to: draftDateTo || undefined,
    })
    setOpen(false)
  }

  const clearDrawerFilters = () => {
    setFilterRows([buildFilterRow()])
    setJoiners([])
    setDraftDatePreset('')
    setDraftDateFrom('')
    setDraftDateTo('')
    onFilter({
      module: '',
      risk: '',
      operation_type: '',
      operation_type_not: '',
      criteria: null,
      date_from: undefined,
      date_to: undefined,
    })
    setOpen(false)
  }

  const clearAllFilters = () => {
    setSearchValue('')
    setFilterRows([buildFilterRow()])
    setJoiners([])
    setDraftDatePreset('')
    setDraftDateFrom('')
    setDraftDateTo('')
    onFilter({
      search: '',
      module: '',
      risk: '',
      operation_type: '',
      operation_type_not: '',
      criteria: null,
      date_from: undefined,
      date_to: undefined,
    })
  }

  const chips = useMemo(() => {
    const items: { key: string; label: string }[] = []
    if (filters.criteria?.rows?.length) {
      filters.criteria.rows.forEach((row, index) => {
        const label = rowChipLabel(row)
        if (label) items.push({ key: `criteria-${index}`, label })
      })
    } else {
      if (filters.module) items.push({ key: 'module', label: `Module is ${filters.module}` })
      if (filters.risk) items.push({ key: 'risk', label: `Risk is ${filters.risk}` })
      if (filters.operation_type) {
        items.push({ key: 'operation_type', label: `Operation is ${filters.operation_type}` })
      }
      if (filters.operation_type_not) {
        items.push({ key: 'operation_type_not', label: `Operation is not ${filters.operation_type_not}` })
      }
    }
    const dateLabel = getAuditDateRangeChipLabel(filters.date_from, filters.date_to)
    if (dateLabel) items.push({ key: 'date', label: dateLabel })
    return items
  }, [filters])

  const filtersActive = chips.length > 0
  const activeCount = chips.length

  const removeChip = (key: string) => {
    if (key.startsWith('criteria-')) {
      const index = Number(key.replace('criteria-', ''))
      if (!filters.criteria || Number.isNaN(index)) return
      const rows = filters.criteria.rows.filter((_, i) => i !== index)
      const joiners = [...(filters.criteria.joiners || [])]
      if (index <= 0) joiners.shift()
      else joiners.splice(index - 1, 1)
      onFilter({
        criteria: rows.length && hasActiveCriteriaRows(rows) ? { rows, joiners } : null,
        module: '',
        risk: '',
        operation_type: '',
        operation_type_not: '',
      })
      return
    }
    if (key === 'module') onFilter({ module: '' })
    else if (key === 'risk') onFilter({ risk: '' })
    else if (key === 'operation_type') onFilter({ operation_type: '' })
    else if (key === 'operation_type_not') onFilter({ operation_type_not: '' })
    else if (key === 'date') onFilter({ date_from: undefined, date_to: undefined })
  }

  const updateRow = (id: string, patch: Partial<FilterRow>) => {
    setFilterRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const updateJoiner = (index: number, value: string) => {
    setJoiners((prev) => {
      const next = [...prev]
      next[index] = (value || 'and') as AuditCriteriaJoiner
      return next
    })
  }

  const addRow = () => {
    setFilterRows((prev) => [...prev, buildFilterRow()])
    setJoiners((prev) => [...prev, 'and'])
  }

  const removeRow = (id: string) => {
    const idx = filterRows.findIndex((row) => row.id === id)
    if (idx === -1) return

    const nextRows = filterRows.filter((row) => row.id !== id)
    if (nextRows.length === 0) {
      setFilterRows([buildFilterRow()])
      setJoiners([])
      return
    }

    setJoiners((prev) => {
      if (idx <= 0) return prev.slice(1)
      return [...prev.slice(0, idx - 1), ...prev.slice(idx)]
    })
    setFilterRows(nextRows)
  }

  return (
    <>
      <div className="filter-toolbar-stack">
        <div className="filter-toolbar">
          <SearchBar
            value={searchValue}
            onChange={setSearchValue}
            placeholder="Search action, detail, reference, user…"
            style={{ flex: 1, minWidth: 200, maxWidth: 420 }}
          />
          <div className="filter-toolbar__actions">
            {toolbarActions}
            <button
              type="button"
              className={`filter-trigger${filtersActive ? ' is-active' : ''}`}
              aria-label="Open filters"
              title="Filters"
              onClick={() => setOpen(true)}
            >
              <Icon.Filter size={18} />
              {filtersActive && (
                <span className="filter-trigger__badge">{activeCount}</span>
              )}
            </button>
          </div>
        </div>

        {filtersActive && (
          <div className="filter-applied-band" role="status" aria-label="Applied filters">
            <span className="filter-applied-band__label">Filter:</span>
            {chips.map((chip) => (
              <span key={chip.key} className="filter-applied-chip">
                <span className="filter-applied-chip__text" title={chip.label}>{chip.label}</span>
                <button
                  type="button"
                  className="filter-applied-chip__remove"
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => removeChip(chip.key)}
                >
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="filter-applied-band__clear" onClick={clearAllFilters}>
              × Clear Filter
            </button>
          </div>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Filter By"
        size="md"
        footerClassName="drawer-footer--filters"
        footer={(
          <>
            <button type="button" className="btn btn-primary" onClick={applyFilters}>
              Apply
            </button>
            <button type="button" className="btn btn-ghost" onClick={clearDrawerFilters} style={{ color: 'var(--red)' }}>
              Clear Filters
            </button>
          </>
        )}
      >
        <div className="filter-sidebar-fields">
          <FormGroup label="Date Range">
            <AutocompleteDropdown
              value={draftDatePreset}
              onChange={handleDatePresetChange}
              options={AUDIT_DATE_RANGE_OPTIONS}
              isSearchFieldRequired={false}
              placeholder="All dates"
              style={{ width: '100%' }}
            />
            {draftDatePreset === 'custom' && (
              <div className="filter-sidebar-dates audit-filter-custom-dates">
                <DatePicker
                  style={{ width: '100%' }}
                  value={draftDateFrom}
                  onChange={setDraftDateFrom}
                  placeholder="From"
                />
                <DatePicker
                  style={{ width: '100%' }}
                  value={draftDateTo}
                  onChange={setDraftDateTo}
                  placeholder="To"
                />
              </div>
            )}
          </FormGroup>

          <div className="audit-filter-conditions">
            <div className="audit-filter-conditions__header">
              <span className="audit-filter-conditions__title">Conditions</span>
            </div>

            <div className="audit-filter-conditions__rows">
              {filterRows.map((row, index) => {
                const fieldType = auditFieldType(row.field)
                const conditionOptions = fieldType === 'select'
                  ? AUDIT_SELECT_CONDITION_OPTIONS
                  : AUDIT_TEXT_CONDITION_OPTIONS
                const valueDisabled = row.condition === 'is empty'
                return (
                  <Fragment key={row.id}>
                    {index > 0 && (
                      <div className="audit-filter-condition-joiner">
                        <AutocompleteDropdown
                          value={joiners[index - 1] || 'and'}
                          onChange={(id) => updateJoiner(index - 1, id)}
                          options={AUDIT_JOINER_OPTIONS}
                          isSearchFieldRequired={false}
                          style={{ width: 88 }}
                        />
                      </div>
                    )}
                    <div className="audit-filter-condition-row">
                      <div className="audit-filter-condition-row__index">{index + 1}</div>
                      <div className="audit-filter-condition-row__field">
                        <AutocompleteDropdown
                          value={row.field}
                          onChange={(id) => {
                            const nextType = auditFieldType(id)
                            updateRow(row.id, {
                              field: id,
                              condition: nextType === 'select' ? 'is' : 'contains',
                              value: '',
                            })
                          }}
                          options={AUDIT_FILTER_FIELD_OPTIONS}
                          isSearchFieldRequired={false}
                          style={{ width: '100%' }}
                        />
                      </div>
                      <div className="audit-filter-condition-row__condition">
                        <AutocompleteDropdown
                          value={row.condition}
                          onChange={(id) => updateRow(row.id, {
                            condition: id,
                            value: id === 'is empty' ? '' : row.value,
                          })}
                          options={conditionOptions}
                          isSearchFieldRequired={false}
                          style={{ width: '100%' }}
                        />
                      </div>
                      <div className="audit-filter-condition-row__value">
                        {fieldType === 'select' ? (
                          <AutocompleteDropdown
                            value={row.value}
                            onChange={(id) => updateRow(row.id, { value: id })}
                            options={auditValueOptionsForField(row.field)}
                            isSearchFieldRequired={false}
                            placeholder={`Select ${fieldLabel(row.field)}`}
                            clearable
                            onClear={() => updateRow(row.id, { value: '' })}
                            disabled={valueDisabled}
                            style={{ width: '100%' }}
                          />
                        ) : (
                          <input
                            type="text"
                            value={row.value}
                            onChange={(e) => updateRow(row.id, { value: e.target.value })}
                            placeholder={valueDisabled ? 'No value needed' : `Enter ${fieldLabel(row.field)}`}
                            className="form-input w-full"
                            disabled={valueDisabled}
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        className="btn btn-secondary btn-xs audit-filter-condition-row__action audit-filter-condition-row__action--remove"
                        aria-label="Delete condition"
                        title="Delete condition"
                      >
                        <Icon.Trash2 size={14} />
                      </button>
                    </div>
                  </Fragment>
                )
              })}
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-sm audit-filter-conditions__add"
              onClick={() => addRow()}
            >
              + Add condition
            </button>
          </div>
        </div>
      </Drawer>
    </>
  )
}

export default AuditFiltersBar

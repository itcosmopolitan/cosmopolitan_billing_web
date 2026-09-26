import { useEffect, useState } from 'react'
import { AlertBar, AutocompleteDropdown, DatePicker, FormGroup, FormRow, Modal } from '@/components/ui'
import {
  MAX_EXPORT_DATE_RANGE_DAYS,
  defaultExportDateRange,
  validateExportDateRange,
} from '@/utils/listExport'

/**
 * Top-aligned export options: status + required finite date range.
 * Callers fetch + map rows in `onExport` using the chosen filters.
 */
export default function ExportListModal({
  open,
  onClose,
  title = 'Export',
  entityLabel = 'entries',
  statusOptions = [],
  initialStatus = '',
  initialDateFrom = '',
  initialDateTo = '',
  maxDays = MAX_EXPORT_DATE_RANGE_DAYS,
  busy = false,
  onExport,
}) {
  const defaults = defaultExportDateRange()
  const [status, setStatus] = useState(initialStatus || '')
  const [dateFrom, setDateFrom] = useState(initialDateFrom || defaults.dateFrom)
  const [dateTo, setDateTo] = useState(initialDateTo || defaults.dateTo)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const fallback = defaultExportDateRange()
    const hasRange = Boolean(initialDateFrom && initialDateTo)
    setStatus(initialStatus || '')
    setDateFrom(hasRange ? initialDateFrom : fallback.dateFrom)
    setDateTo(hasRange ? initialDateTo : fallback.dateTo)
    setError('')
  }, [open, initialStatus, initialDateFrom, initialDateTo])

  const handleExport = async () => {
    const validationError = validateExportDateRange(dateFrom, dateTo, maxDays)
    if (validationError) {
      setError(validationError)
      return
    }
    setError('')
    await onExport?.({ status: status || '', dateFrom, dateTo })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      icon="⬇"
      size="sm"
      align="top"
      busy={busy}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleExport} disabled={busy}>
            {busy ? 'Exporting…' : 'Export CSV'}
          </button>
        </>
      )}
    >
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.45 }}>
        Export {entityLabel} for a date range of at most {maxDays} days. For larger periods,
        export multiple ranges and combine the files.
      </p>

      {error && (
        <div style={{ marginBottom: 12 }}>
          <AlertBar type="red">{error}</AlertBar>
        </div>
      )}

      {statusOptions.length > 0 && (
        <FormGroup label="Status">
          <AutocompleteDropdown
            value={status}
            onChange={(id) => setStatus(id || '')}
            options={statusOptions}
            prependOptions={[{ id: '', label: 'All Status' }]}
            isSearchFieldRequired={false}
            placeholder="All Status"
            clearable
            onClear={() => setStatus('')}
            style={{ width: '100%' }}
          />
        </FormGroup>
      )}

      <FormGroup label="Date range" required>
        <FormRow cols={2}>
          <DatePicker
            style={{ width: '100%' }}
            value={dateFrom}
            onChange={setDateFrom}
            placeholder="From"
            max={dateTo || undefined}
          />
          <DatePicker
            style={{ width: '100%' }}
            value={dateTo}
            onChange={setDateTo}
            placeholder="To"
            min={dateFrom || undefined}
          />
        </FormRow>
      </FormGroup>
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import { FormGroup } from '@/components/ui'
import { settingsAPI } from '@/api'

/**
 * Document number — shows auto-generated preview on create; editable override.
 * On edit/view, displays the existing number read-only.
 */
export default function DocumentNumberField({
  label = 'Document #',
  docType,
  branchId,
  value,
  onChange,
  readOnly = false,
  isEdit = false,
  editingNumber = null,
}) {
  const [preview, setPreview] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (readOnly || isEdit || !docType) return
    let cancelled = false
    setLoading(true)
    settingsAPI
      .previewNumber(docType, branchId)
      .then((res) => {
        if (cancelled) return
        const next = res?.number || res?.data?.number || ''
        setPreview(next)
        if (!value && next && onChange) onChange(next)
      })
      .catch(() => {
        if (!cancelled) setPreview('')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [docType, branchId, readOnly, isEdit])

  if (isEdit || readOnly) {
    return (
      <FormGroup label={label}>
        <input className="form-input" value={editingNumber || value || ''} readOnly disabled />
      </FormGroup>
    )
  }

  return (
    <FormGroup label={label}>
      <input
        className="form-input"
        value={value || ''}
        placeholder={loading ? 'Loading…' : (preview || 'Auto-generated')}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {preview && value !== preview && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Next auto: {preview}
        </div>
      )}
    </FormGroup>
  )
}

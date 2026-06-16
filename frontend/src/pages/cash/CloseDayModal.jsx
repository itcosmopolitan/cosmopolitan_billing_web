import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { cashAPI } from '@/api'
import { FormGroup, Modal } from '@/components/ui'
import { fmt } from '@/utils/helpers'

export default function CloseDayModal({ open, onClose, branchId, summary, date, onClosed, currentUser }) {
  const [physicalCount, setPhysicalCount] = useState('')
  const [varianceReason, setVarianceReason] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setPhysicalCount('')
      setVarianceReason('')
      setNotes('')
    }
  }, [open])

  const expected = summary?.expected_balance ?? summary?.expected ?? 0
  const threshold = 500
  const physical = Number(physicalCount) || 0
  const variance = physical - expected
  const varianceColor = variance === 0 ? 'var(--green)' : Math.abs(variance) <= threshold ? 'var(--amber)' : 'var(--red)'
  const needsReason = physicalCount !== '' && Math.abs(variance) > threshold

  const handleClose = async () => {
    if (!physicalCount || physicalCount === '') { toast.error('Enter the physical cash count'); return }
    if (needsReason && !varianceReason.trim()) {
      toast.error(`Variance of ${fmt(Math.abs(variance))} exceeds threshold. Please explain the variance.`)
      return
    }
    setSaving(true)
    try {
      const result = await cashAPI.close(branchId, {
        date,
        physical_count: physical,
        variance_reason: varianceReason || null,
        notes: notes || null,
        closed_by: currentUser?.name || 'Staff',
      })
      toast.success(result?.message || 'Day closed successfully')
      onClosed?.()
      onClose()
    } catch {
      // Global interceptor handles toast
    } finally {
      setSaving(false)
    }
  }

  const rows = [
    { label: 'Opening Balance', value: fmt(summary?.opening_balance ?? summary?.opening ?? 0) },
    { label: 'Total Cash In', value: fmt(summary?.cash_in ?? 0), color: 'var(--green)' },
    { label: 'Total Cash Out', value: fmt(summary?.cash_out ?? 0), color: 'var(--red)' },
    { label: 'Expected Balance', value: fmt(expected), color: 'var(--accent)' },
  ]

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close Day — Cash Reconciliation"
      icon="🔒"
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleClose} disabled={saving}>
            {saving ? 'Closing…' : 'Confirm & Close Day'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {rows.map((r) => (
          <div key={r.label} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8,
          }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{r.label}</span>
            <span style={{ fontSize: 14, fontWeight: 600, fontFamily: 'DM Mono,monospace', color: r.color || 'var(--text-primary)' }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>

      <FormGroup label="Physical Count (₹)" required>
        <input
          className="form-input"
          type="number"
          min="0"
          step="0.01"
          value={physicalCount}
          onChange={(e) => setPhysicalCount(e.target.value)}
          autoFocus
          placeholder="Actual cash in the drawer"
        />
      </FormGroup>

      {physicalCount !== '' && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', borderRadius: 8, marginBottom: 12,
          background: variance === 0 ? 'var(--bg-raised)' : Math.abs(variance) <= threshold ? '#fff8e6' : '#fff0f0',
          border: `1px solid ${varianceColor}`,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Variance</span>
          <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'DM Mono,monospace', color: varianceColor }}>
            {variance >= 0 ? '+' : ''}{fmt(variance)}
          </span>
        </div>
      )}

      {needsReason && (
        <FormGroup label="Variance Reason" required>
          <textarea
            className="form-input"
            style={{ height: 72 }}
            value={varianceReason}
            onChange={(e) => setVarianceReason(e.target.value)}
            placeholder="Explain the variance (required when above threshold)"
          />
        </FormGroup>
      )}

      <FormGroup label="Notes">
        <textarea
          className="form-input"
          style={{ height: 56 }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional remarks about today's cash"
        />
      </FormGroup>
    </Modal>
  )
}

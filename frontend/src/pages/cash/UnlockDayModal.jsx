import { useState } from 'react'
import toast from 'react-hot-toast'
import { cashAPI } from '@/api'
import { FormGroup, Modal } from '@/components/ui'

export default function UnlockDayModal({ open, onClose, branchId, closeRecord, onUnlocked }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const handleUnlock = async () => {
    if (!reason.trim()) { toast.error('Provide a reason for unlocking'); return }
    setSaving(true)
    try {
      await cashAPI.unlock(branchId, closeRecord.id, { reason })
      toast.success('Day unlocked')
      setReason('')
      onUnlocked?.()
      onClose()
    } catch {
      // Global interceptor handles toast
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Unlock Closed Day"
      icon="🔓"
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={handleUnlock} disabled={saving}>
            {saving ? 'Unlocking…' : 'Unlock Day'}
          </button>
        </>
      }
    >
      <div style={{
        padding: '12px 16px', borderRadius: 8, marginBottom: 16,
        background: '#fff8e6', border: '1px solid var(--amber)',
        fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5,
      }}>
        ⚠️ Unlocking will allow new entries to be added to this closed day. All changes will be logged for audit.
      </div>

      {closeRecord && (
        <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-secondary)' }}>
          <div>Date: <strong>{closeRecord.date}</strong></div>
          <div>Closed by: <strong>{closeRecord.closed_by}</strong></div>
        </div>
      )}

      <FormGroup label="Reason for unlocking" required>
        <textarea
          className="form-input"
          style={{ height: 80 }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
          placeholder="Why is this day being re-opened?"
        />
      </FormGroup>
    </Modal>
  )
}

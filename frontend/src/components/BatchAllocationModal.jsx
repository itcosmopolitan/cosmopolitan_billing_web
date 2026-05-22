import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Modal, AlertBar, EmptyState } from '@/components/ui'
import { fmtDate } from '@/utils/helpers'
import { batchExpiryStatus } from '@/utils/batchExpiry'
import {
  computeAutoAllocation,
  allocationSum,
  isAllocationValid,
} from '@/utils/batchAllocation'

/**
 * Reusable per-line batch allocation editor. Used by:
 *   • POS cart — "✎ Edit batch split" on a tracked cart row.
 *   • New Transfer modal — same affordance per transfer line.
 *
 * The operator sees a table of every active batch for (item, branch), the
 * remaining stock in each, and an editable qty input. A live header bar
 * shows the running total vs. the required qty with the delta highlighted —
 * Save is disabled until they match.
 *
 * Props:
 *   open          — boolean
 *   onClose       — fn
 *   onSave        — fn(allocation: [{id, batchNumber, qty, expiryDate}])
 *   item          — { name, emoji?, expiry_tracking? } for header chrome
 *   qty           — required total to allocate
 *   batches       — array from /items/{id}/batches (in FEFO order)
 *   allocation    — current per-line allocation (rich entries, not API shape)
 *   strategyLabel — 'FIFO' | 'FEFO' (used in copy)
 */
export default function BatchAllocationModal({
  open, onClose, onSave,
  item, qty, batches, allocation,
  strategyLabel = 'FIFO',
}) {
  // Local working copy keyed by batchId → qty. We hydrate from `allocation`
  // every time the modal opens so cancelling drops in-flight edits.
  const [draft, setDraft] = useState({})
  useEffect(() => {
    if (!open) return
    const seed = {}
    for (const e of allocation || []) seed[e.id] = String(e.qty || 0)
    setDraft(seed)
  }, [open, allocation])

  // Convert the editable draft (id → string) back into the rich allocation
  // shape the caller expects. Filters zero/empty entries.
  const draftAllocation = useMemo(() => {
    const out = []
    for (const b of batches || []) {
      const v = Number(draft[b.id])
      if (Number.isFinite(v) && v > 0) {
        out.push({
          id: b.id,
          batchNumber: b.batchNumber || b.id.slice(-6),
          qty: v,
          expiryDate: b.expiryDate || null,
          mfgDate: b.mfgDate || null,
          receivedDate: b.receivedDate || null,
        })
      }
    }
    return out
  }, [draft, batches])

  const allocated = allocationSum(draftAllocation)
  const remaining = qty - allocated
  const valid = isAllocationValid(draftAllocation, qty)

  const patchQty = (batchId, value) => {
    // Allow empty for in-progress typing; ignore non-numeric.
    if (value === '') {
      setDraft((d) => ({ ...d, [batchId]: '' }))
      return
    }
    const n = Math.max(0, Math.floor(Number(value) || 0))
    setDraft((d) => ({ ...d, [batchId]: String(n) }))
  }

  const resetToAuto = () => {
    const auto = computeAutoAllocation(batches, qty)
    const next = {}
    for (const e of auto) next[e.id] = String(e.qty)
    setDraft(next)
  }

  const fillRemaining = (batchId) => {
    // Pour the remaining gap into this batch (capped at its available qty).
    const b = batches.find((x) => x.id === batchId)
    if (!b) return
    const current = Number(draft[batchId] || 0)
    const others = allocated - current
    const need = Math.max(0, qty - others)
    const cap = Math.min(need, Number(b.quantity) || 0)
    setDraft((d) => ({ ...d, [batchId]: String(cap) }))
  }

  const handleSave = () => {
    if (!valid) {
      toast.error(
        remaining > 0
          ? `Allocate ${remaining} more unit${remaining === 1 ? '' : 's'}`
          : `Reduce allocation by ${-remaining}`
      )
      return
    }
    onSave(draftAllocation)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split across batches"
      icon="🧴"
      size="lg"
      footer={<>
        <button className="btn btn-ghost" onClick={resetToAuto}>↺ Reset to {strategyLabel} default</button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!valid}
          title={valid ? '' : `Allocated ${allocated} / ${qty}`}
        >
          Save split
        </button>
      </>}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 24, lineHeight: 1 }}>{item?.emoji || '📦'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{item?.name || 'Item'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
            Picking <strong style={{ color: 'var(--text-primary)' }}>{qty}</strong> unit{qty === 1 ? '' : 's'} ·
            <span style={{ marginLeft: 4 }}>
              default strategy <strong style={{ color: 'var(--accent)' }}>{strategyLabel}</strong>
            </span>
          </div>
        </div>
        <div
          style={{
            padding: '8px 14px', borderRadius: 8, minWidth: 140, textAlign: 'right',
            background: valid ? 'var(--green-bg, rgba(34,201,122,0.12))' : 'var(--accent-bg)',
            border: `1px solid ${valid ? 'rgba(34,201,122,0.4)' : 'var(--accent)'}`,
          }}
        >
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', letterSpacing: 0.5, textTransform: 'uppercase' }}>Allocated</div>
          <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 16, fontWeight: 700, color: valid ? 'var(--green)' : 'var(--accent)' }}>
            {allocated} / {qty}
          </div>
          {!valid && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {remaining > 0 ? `${remaining} more to assign` : `${-remaining} over the limit`}
            </div>
          )}
        </div>
      </div>

      {item?.expiry_tracking && (
        <AlertBar type="amber" icon="📅">
          FEFO item — batches near expiry are listed first. Pulling from a fresher
          lot is allowed but will leave older stock at risk.
        </AlertBar>
      )}

      {(!batches || batches.length === 0) ? (
        <EmptyState icon="🧴" title="No active batches" desc="There are no batches with stock at this branch." />
      ) : (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
          <table className="data-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th>Batch #</th>
                <th>Expiry</th>
                <th className="text-right">In Stock</th>
                <th style={{ width: 180 }}>Take from this batch</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b, idx) => {
                const expInfo = batchExpiryStatus(b)
                const value = draft[b.id] ?? ''
                const taken = Number(value || 0)
                const overCap = taken > (Number(b.quantity) || 0)
                return (
                  <tr key={b.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {idx === 0 && (
                          <span style={{ color: 'var(--accent)', fontSize: 11 }} title="Default FIFO/FEFO winner">★</span>
                        )}
                        <span className="mono" style={{ fontSize: 12, color: 'var(--text-primary)' }}>{b.batchNumber}</span>
                      </div>
                    </td>
                    <td
                      style={{ fontSize: 12, color: expInfo.dateColor, fontWeight: expInfo.expired || expInfo.nearExpiry ? 600 : 400 }}
                      title={expInfo.title}
                    >
                      {b.expiryDate ? fmtDate(b.expiryDate) : '—'}
                      {expInfo.daysLeft != null && expInfo.daysLeft >= 0 && (
                        <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--text-muted)' }}>
                          ({expInfo.statusLabel})
                        </span>
                      )}
                    </td>
                    <td className="text-right mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{b.quantity}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          className="form-input"
                          type="number"
                          min={0}
                          max={b.quantity}
                          step={1}
                          value={value}
                          onChange={(e) => patchQty(b.id, e.target.value)}
                          style={{
                            width: 80, padding: '4px 8px', fontSize: 12,
                            textAlign: 'right', fontFamily: 'DM Mono, monospace',
                            borderColor: overCap ? 'var(--red)' : undefined,
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => fillRemaining(b.id)}
                          title="Pour remaining gap into this batch"
                          disabled={remaining <= 0 && taken === 0}
                          style={{ fontSize: 10.5, padding: '2px 6px' }}
                        >
                          Fill
                        </button>
                        {overCap && (
                          <span style={{ fontSize: 10.5, color: 'var(--red)' }} title="Exceeds available stock">over</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

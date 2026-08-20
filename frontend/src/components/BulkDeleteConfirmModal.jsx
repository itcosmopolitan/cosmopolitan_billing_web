/**
 * Reusable confirmation modal for bulk-delete operations across Sales +
 * Purchases tabs. All-or-nothing semantics — if the backend reports any
 * blocked rows, the danger button stays disabled until the operator
 * deselects them and tries again.
 *
 * Props:
 *   • open          — boolean
 *   • onClose       — fn (closes without deleting)
 *   • onConfirm     — async fn () => apiResponse
 *                     Should throw on failure; on backend 400 the caller
 *                     extracts `error.response.data.detail.blocked` and
 *                     passes it back via the `blocked` prop on next render.
 *   • entityLabel   — singular noun e.g. "invoice", "quotation". Pluralised
 *                     in copy automatically.
 *   • items         — array of { id, number, customerName?, total?, status? }
 *                     to display in the "Items to delete" list.
 *   • blocked       — array of { id, number, reason } returned from a prior
 *                     failed submit. When non-empty, the modal switches to an
 *                     error-only view (hides confirm copy) and shows reasons.
 *   • submitting    — boolean (caller-controlled spinner state)
 *   • reversalLines — optional array of strings to render under "Reversal
 *                     effects". E.g. ["Stock restored: 18 units", ...]
 */
import { Modal, AlertBar } from './ui'
import { fmt } from '@/utils/helpers'

export default function BulkDeleteConfirmModal({
  open,
  onClose,
  onConfirm,
  entityLabel = 'item',
  items = [],
  blocked = [],
  submitting = false,
  reversalLines = [],
}) {
  const count = items.length
  const pluralLabel = count === 1 ? entityLabel : `${entityLabel}s`
  const title = `Delete ${count} ${pluralLabel.charAt(0).toUpperCase() + pluralLabel.slice(1)}?`
  const hasBlocked = blocked.length > 0
  const errorMessage = hasBlocked
    ? [...new Set(blocked.map((b) => b.reason).filter(Boolean))].join(' ')
    : ''

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={hasBlocked ? 'Cannot delete' : title}
      icon="⚠️"
      size="md"
      busy={submitting}
      footer={
        hasBlocked ? (
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Close
          </button>
        ) : (
          <>
            <button
              className="btn btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Keep {pluralLabel}
            </button>
            <button
              className="btn btn-danger"
              onClick={onConfirm}
              disabled={submitting || count === 0}
            >
              {submitting ? 'Deleting…' : `Delete ${count} ${pluralLabel}`}
            </button>
          </>
        )
      }
    >
      {hasBlocked ? (
        <AlertBar type="red" icon="⚠">
          {errorMessage}
        </AlertBar>
      ) : (
        <>
          <AlertBar type="amber" icon="⚠">
            This action is permanent. Stock will be restored and credit
            balances refunded where applicable. Cannot be undone.
          </AlertBar>
          <div style={{ height: 14 }} />

          <div style={sectionHeaderStyle}>
            Items to delete ({count})
          </div>
          <div style={{
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            background: 'var(--bg-raised)',
            maxHeight: 220,
            overflowY: 'auto',
            marginBottom: 14,
          }}>
            {items.length === 0 ? (
              <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
                Nothing selected.
              </div>
            ) : items.map((it, idx) => (
              <div key={it.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px',
                borderTop: idx === 0 ? 'none' : '1px solid var(--border-subtle)',
              }}>
                <span style={{
                  fontFamily: 'monospace', fontSize: 12,
                  color: 'var(--accent)', minWidth: 130,
                }}>
                  {it.number || it.id}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>
                  {it.customerName || it.vendorName || ''}
                </span>
                {typeof it.total === 'number' && (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {fmt(it.total)}
                  </span>
                )}
                {it.status && (
                  <span style={statusPillStyle(it.status)}>
                    {String(it.status).charAt(0).toUpperCase() + String(it.status).slice(1)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {reversalLines.length > 0 && (
            <>
              <div style={sectionHeaderStyle}>Reversal effects</div>
              <ul style={{
                margin: '0 0 14px 0', padding: '0 0 0 20px',
                color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7,
              }}>
                {reversalLines.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

const sectionHeaderStyle = {
  fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
  textTransform: 'uppercase', color: 'var(--text-muted)',
  marginBottom: 6,
}

function statusPillStyle(status) {
  const map = {
    pending:  { bg: 'rgba(245, 166, 35, 0.18)', color: 'var(--amber)' },
    partial:  { bg: 'rgba(79, 142, 247, 0.18)', color: 'var(--accent)' },
    paid:     { bg: 'rgba(46, 184, 92, 0.18)', color: 'var(--green)' },
    overdue:  { bg: 'rgba(229, 72, 77, 0.18)', color: 'var(--red)' },
    cancelled: { bg: 'rgba(160, 160, 160, 0.18)', color: 'var(--text-muted)' },
  }
  const c = map[String(status).toLowerCase()] || { bg: 'var(--bg-surface)', color: 'var(--text-muted)' }
  return {
    fontSize: 10, fontWeight: 600, padding: '2px 8px',
    borderRadius: 10, background: c.bg, color: c.color,
    textTransform: 'capitalize',
  }
}

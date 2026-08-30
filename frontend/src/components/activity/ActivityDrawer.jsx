import { useEffect, useState } from 'react'
import { ConfirmDialog, Drawer, Spinner, Tag } from '@/components/ui'
import * as Icon from '@/components/ui/Icons'
import { activityAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { formatLabel } from '@/utils/helpers'

function parseEventDate(value) {
  if (!value) return null
  try {
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
        return new Date(value + 'Z')
      }
      return new Date(value)
    }
    return new Date(value)
  } catch (_) {
    return null
  }
}

function formatEventTimestamp(value) {
  const date = parseEventDate(value)
  if (!date || Number.isNaN(date.getTime())) return value ? String(value) : 'Unknown'
  return date.toLocaleString()
}

function formatRelativeTimestamp(value) {
  const date = parseEventDate(value)
  if (!date || Number.isNaN(date.getTime())) return value ? String(value) : 'Unknown'

  const diffMs = Date.now() - date.getTime()
  if (diffMs < 0) return 'Just now'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'Just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`

  return date.toLocaleDateString()
}

function renderHistoryDetail(detail) {
  if (detail == null) return 'No detail provided.'
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail, null, 2)
  } catch (_) {
    return String(detail)
  }
}

function getInitials(name) {
  if (!name) return '??'
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

function getEventBadge(event) {
  // Resolve to a canonical key first so prefixed/raw backend strings map
  // to our compact definitions.
  if (event.kind === 'comment') {
    const key = resolveEventKey(event) || event.event_type
    const def = EVENT_DEFINITIONS[key] || EVENT_DEFINITIONS.comment
    return { label: def.label, bg: def.bg, text: def.text }
  }
  const key = resolveEventKey(event) || event.event_type
  const def = EVENT_DEFINITIONS[key]
  if (def) return { label: getCombinedLabel({ ...event, event_type: key }), bg: def.bg, text: def.text }
  // fallback: preserve risk tag as red, otherwise neutral
  if (event.risk) return { label: event.action || 'Activity', bg: 'var(--red-bg)', text: 'var(--red)' }
  return { label: event.action || 'Activity', bg: 'var(--bg-hover)', text: 'var(--text-secondary)' }
}

function getEventBody(event) {
  if (event.kind === 'comment') return event.body || ''
  return renderHistoryDetail(event.detail ?? event.body)
}

function getActorLabel(event) {
  if (event.kind === 'comment') return event.author_name || 'Unknown author'
  return event.user_name ? `By ${event.user_name}` : 'By unknown user'
}

function getEventTitle(event) {
  if (event.kind === 'comment') return 'Comment'
  return getCombinedLabel(event)
}

function getEventDetail(event) {
  if (event.kind === 'comment') return event.body || ''
  const body = getEventBody(event)
  if (!body || body === 'No detail provided.') return ''
  return body
}

function getBadgeClass(event) {
  const key = resolveEventKey(event) || event.event_type || ''
  if (['voided', 'cancelled', 'payment_voided', 'payment_deleted', 'rejected', 'quotation_rejected'].includes(key)) {
    return 'activity-badge--void'
  }
  if (key === 'created') return 'activity-badge--created'
  if (['confirmed', 'verified', 'approved', 'transit', 'sent', 'accepted', 'payment_recorded', 'refund_issued', 'quotation_sent'].includes(key)) {
    return 'activity-badge--positive'
  }
  if (['item_changed', 'amount_changed', 'qty_changed', 'due_date_changed', 'status_changed', 'qty_received_recorded', 'stock_returned', 'expired', 'quotation_expired'].includes(key)) {
    return 'activity-badge--warning'
  }
  return 'activity-badge--neutral'
}

// Single explicit mapping of generic event_type -> label + color tokens + icon
const EVENT_DEFINITIONS = {
  // Creation (GREEN)
  created:           { label: 'Created', bg: 'var(--green-bg)', text: 'var(--green)', icon: '＋' },

  // Confirmation / positive (BLUE)
  confirmed:         { label: 'Confirmed', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  verified:          { label: 'Verified', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  approved:          { label: 'Approved', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  transit:           { label: 'In transit', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },

  // Conversion / linking (PURPLE)
  converted:         { label: 'Converted', bg: 'var(--purple-bg)', text: 'var(--purple)', icon: '⇄' },
  linked_to_source:  { label: 'Linked', bg: 'var(--purple-bg)', text: 'var(--purple)', icon: '⇄' },
  return_linked:     { label: 'Return linked', bg: 'var(--purple-bg)', text: 'var(--purple)', icon: '⇄' },
  grn_linked:        { label: 'GRN linked', bg: 'var(--purple-bg)', text: 'var(--purple)', icon: '⇄' },

  // Void / cancelled / deletion (RED)
  voided:            { label: 'Voided', bg: 'var(--red-bg)', text: 'var(--red)', icon: '✖' },
  cancelled:         { label: 'Cancelled', bg: 'var(--red-bg)', text: 'var(--red)', icon: '✖' },
  payment_voided:    { label: 'Payment voided', bg: 'var(--red-bg)', text: 'var(--red)', icon: '✖' },
  payment_deleted:   { label: 'Payment deleted', bg: 'var(--red-bg)', text: 'var(--red)', icon: '✖' },

  // Edits / adjustments (AMBER)
  item_changed:      { label: 'Item changed', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },
  amount_changed:    { label: 'Amount changed', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },
  qty_changed:       { label: 'Quantity changed', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },
  due_date_changed:  { label: 'Due date changed', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },
  status_changed:    { label: 'Status changed', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },

  // Payment recorded (neutral/blue)
  payment_recorded:  { label: 'Payment recorded', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '💳' },

  // GRN / stock / returns / quotations
  // GRN / stock / returns / quotations
  qty_received_recorded: { label: 'Quantity received', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },
  // Use a short verb so combined labels don't duplicate ("Sales return returned" -> "Sales return")
  stock_returned:        { label: 'Returned', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '↺' },
  refund_issued:         { label: 'Refund issued', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '💳' },

  // Generic quotation events (use generic keys: sent/accepted/rejected/expired)
  sent:                  { label: 'Sent', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  accepted:              { label: 'Accepted', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  rejected:              { label: 'Rejected', bg: 'var(--red-bg)', text: 'var(--red)', icon: '✖' },
  expired:               { label: 'Expired', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },

  // legacy-prefixed quotation labels (kept for compatibility)
  quotation_sent:        { label: 'Sent', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  quotation_rejected:    { label: 'Rejected', bg: 'var(--red-bg)', text: 'var(--red)', icon: '✖' },
  quotation_expired:     { label: 'Expired', bg: 'var(--amber-bg)', text: 'var(--amber)', icon: '✎' },

  // Comments / generic fallback
  comment:            { label: 'Comment', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '💬' },
}

// Human readable record type noun for combining with generic labels
const RECORD_TYPE_LABELS = {
  sales_order: 'Order',
  sales_invoice: 'Invoice',
  invoice: 'Invoice',
  purchase_order: 'Purchase order',
  bill: 'Bill',
  grn: 'GRN',
  quote: 'Quote',
  quotation: 'Quote',
  sales_return: 'Sales return',
  vendor_return: 'Vendor return',
  stock_transfer: 'Transfer',
  stock_adjustment: 'Adjustment',
  item: 'Item',
}

function getCombinedLabel(event) {
  const key = resolveEventKey(event) || event.event_type
  const def = EVENT_DEFINITIONS[key] || EVENT_DEFINITIONS.comment
  const recordLabel = RECORD_TYPE_LABELS[event.record_type] || formatLabel(event.record_type)
  if (!recordLabel) return def.label

  // Build combined label but avoid duplication when the event label already
  // contains the record noun (e.g. avoid "Quote quotation sent").
  const defLabel = def.label
  const defTokens = defLabel.toLowerCase().split(/\W+/).filter(Boolean)
  const recordTokens = recordLabel.toLowerCase().split(/\W+/).filter(Boolean)

  // Remove any tokens from def that overlap with record tokens (or are derived)
  const filtered = defTokens.filter((dt) => {
    return !recordTokens.some((rt) => dt === rt || dt.includes(rt) || rt.includes(dt))
  })

  if (filtered.length === 0) {
    // If the generic label is entirely redundant with the record noun (e.g. "returned"
    // vs record "Sales return"), return just the record label to avoid "Sales return returned".
    return recordLabel
  }

  return `${recordLabel} ${filtered.join(' ')}`
}

// Normalize incoming event_type/action into a canonical key that matches
// entries in EVENT_DEFINITIONS. This handles cases where the backend emits
// prefixed keys like "sales_invoice_status_changed" or space-separated
// "sales invoice status changed". It will strip the record-type noun and
// attempt underscored/lowercase variants.
function resolveEventKey(event) {
  const raw = (event.event_type || event.action || '').toString()
  if (!raw) return null
  // Exact match first
  if (EVENT_DEFINITIONS[raw]) return raw

  const lower = raw.toLowerCase()
  if (EVENT_DEFINITIONS[lower]) return lower

  // Underscore form
  const underscored = lower.replace(/\s+/g, '_')
  if (EVENT_DEFINITIONS[underscored]) return underscored

  // Try stripping record_type prefix (both underscored and spaced forms)
  const record = (event.record_type || '').toString().toLowerCase()
  const recordUnderscore = record.replace(/\s+/g, '_')
  const candidates = [lower, underscored]
  if (record) {
    // remove prefix like 'sales_invoice_' or 'sales invoice '
    candidates.push(lower.replace(new RegExp('^' + record + '\\s+'), ''))
    candidates.push(underscored.replace(new RegExp('^' + recordUnderscore + '_'), ''))
  }

  // For each candidate, try simple normalizations to match keys
  for (const c of candidates) {
    const clean = c.replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').replace(/^_+|_+$/g, '')
    if (!clean) continue
    if (EVENT_DEFINITIONS[clean]) return clean
    // also try removing common nouns like 'sales', 'invoice', 'quotation', 'quote', 'order'
    const stripped = clean.replace(/^(sales_|purchase_|invoice_|quotation_|quote_|order_|salesinvoice_|sales_order_)/, '')
    if (EVENT_DEFINITIONS[stripped]) return stripped
  }

  return null
}

// --- Category mapping and visuals -----------------------------------------
const CATEGORY_MAP = {
  creation: ['create_sales_order', 'create_invoice', 'create_quote', 'create_purchase_order', 'create_item'],
  confirmation: ['confirm_sales_order', 'confirm_purchase_order'],
  edit: ['update_sales_order', 'update_invoice', 'update_item'],
  void: ['void_sales_order', 'void_invoice', 'delete_item'],
  conversion: ['convert_sales_order', 'convert_quote_to_invoice', 'convert_po_to_bill', 'convert_order_to_invoice'],
}

const CATEGORY_COLORS = {
  creation: 'var(--green)',
  confirmation: 'var(--blue)',
  edit: 'var(--amber)',
  void: 'var(--red)',
  conversion: 'var(--purple)',
}

const CATEGORY_ICONS = {
  creation: '＋', // plus
  confirmation: '✓',
  edit: '✎',
  void: '✖',
  conversion: '⇄',
}

function getCategoryForEvent(event_type) {
  if (!event_type) return null
  for (const [cat, list] of Object.entries(CATEGORY_MAP)) {
    if (list.includes(event_type)) return cat
  }
  return null
}

function renderTimelineIcon(event, isLatest) {
  const key = resolveEventKey(event) || event.event_type || event.action
  const def = EVENT_DEFINITIONS[key]
  const color = def?.text || 'var(--text-secondary)'
  const icon = def?.icon || '•'
  return (
    <div
      className={`activity-timeline__icon ${isLatest ? 'activity-timeline__icon--latest' : 'activity-timeline__icon--past'}`}
      style={{
        color,
        background: isLatest ? (def?.bg || 'var(--bg-hover)') : undefined,
      }}
    >
      {icon}
    </div>
  )
}

export default function ActivityDrawer({ open, onClose, recordType, recordId, title }) {
  const [loading, setLoading] = useState(false)
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [commentBody, setCommentBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const can = useCan()
  const canAddComment = can('comments.add')

  useEffect(() => {
    if (!open || !recordType || !recordId) return
    setLoading(true)
    setError(null)
    activityAPI.timeline(recordType, recordId)
      .then((res) => {
        setEvents(res.events || [])
      })
      .catch((err) => {
        const detail = err?.response?.data?.detail
        setError(typeof detail === 'string' ? detail : 'Unable to load activity')
      })
      .finally(() => setLoading(false))
  }, [open, recordType, recordId])

  const reloadTimeline = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await activityAPI.timeline(recordType, recordId)
      setEvents(res.events || [])
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Unable to load activity')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmitComment = async () => {
    if (!commentBody.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await activityAPI.postComment({
        record_type: recordType,
        record_id: recordId,
        body: commentBody.trim(),
      })
      setCommentBody('')
      await reloadTimeline()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Unable to post comment')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteComment = async (commentId) => {
    setDeleteTarget(commentId)
  }

  const confirmDeleteComment = async () => {
    if (!deleteTarget) return
    setSubmitting(true)
    setError(null)
    try {
      await activityAPI.deleteComment(deleteTarget)
      setEvents((prev) => prev.filter((event) => event.id !== deleteTarget))
      setDeleteTarget(null)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Unable to delete comment')
    } finally {
      setSubmitting(false)
    }
  }

  // Single combined chronological feed (comments + history), newest first.
  const feedEvents = [...events].sort((a, b) => {
    const ta = parseEventDate(a.created_at)?.getTime() ?? 0
    const tb = parseEventDate(b.created_at)?.getTime() ?? 0
    return tb - ta
  })

  const renderFeedIcon = (event) => {
    if (event.kind === 'comment') {
      return (
        <div
          className="activity-feed__icon"
          style={{ color: 'var(--blue)', background: 'var(--blue-bg)' }}
        >
          💬
        </div>
      )
    }
    const key = resolveEventKey(event) || event.event_type || event.action
    const def = EVENT_DEFINITIONS[key]
    return (
      <div
        className="activity-feed__icon"
        style={{ color: def?.text || 'var(--text-secondary)', background: def?.bg || 'var(--bg-hover)' }}
      >
        {def?.icon || '•'}
      </div>
    )
  }

  const renderFeedItem = (event, index, total) => {
    const isComment = event.kind === 'comment'
    const name = isComment
      ? (event.author_name || 'Unknown author')
      : (event.user_name || 'System')
    const badge = isComment ? null : getEventBadge(event)
    const body = isComment ? (event.body || '') : getEventDetail(event)

    return (
      <div key={event.id} className="activity-feed__item">
        <div className="activity-feed__rail">
          {renderFeedIcon(event)}
          {index < total - 1 && <div className="activity-feed__line" />}
        </div>
        <div className="activity-feed__content">
          <div className="activity-feed__meta">
            <span className="activity-feed__author">{name}</span>
            <span className="activity-feed__dot">•</span>
            <time title={formatEventTimestamp(event.created_at)}>
              {formatEventTimestamp(event.created_at)}
            </time>
            {badge && (
              <span className={`activity-badge ${getBadgeClass(event)}`}>{badge.label}</span>
            )}
            {isComment && event.is_pinned && <Tag color="var(--blue)">Pinned</Tag>}
          </div>

          {body && (
            <div className={`activity-feed__body ${isComment ? 'activity-feed__body--comment' : ''}`}>
              <div className="activity-feed__body-text">{body}</div>
              {isComment && event.can_delete && (
                <button
                  type="button"
                  className="activity-feed__delete"
                  onClick={() => handleDeleteComment(event.id)}
                  disabled={submitting}
                  aria-label="Delete comment"
                  title="Delete comment"
                >
                  <Icon.Trash2 size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <Drawer open={open} onClose={onClose} title={title || 'Comments & History'} icon="⏱">
      <div className="activity-drawer">
        {loading && (
          <div style={{ padding: 28, display: 'flex', justifyContent: 'center' }}>
            <Spinner size={28} />
          </div>
        )}

        {!loading && error && (
          <div style={{ padding: 24, color: 'var(--red)', fontSize: 13, whiteSpace: 'pre-wrap' }}>
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="activity-drawer__composer">
              <textarea
                className="activity-composer__field"
                rows={3}
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder={canAddComment ? 'Add a note…' : 'You cannot add comments.'}
                disabled={!canAddComment || submitting}
              />
              <div className="activity-composer__footer">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleSubmitComment}
                  disabled={!canAddComment || submitting || !commentBody.trim()}
                >
                  {submitting ? 'Adding…' : 'Add Comment'}
                </button>
              </div>
              {!canAddComment && (
                <div className="activity-composer__hint">
                  You need comments.add permission to post.
                </div>
              )}
            </div>

            <div className="activity-drawer__feed">
              <div className="activity-comments__heading">
                <span>All Comments</span>
                <span className="activity-comments__count">{feedEvents.length}</span>
              </div>

              {feedEvents.length === 0 ? (
                <div className="activity-comments__empty">
                  No activity records were found for this document.
                </div>
              ) : (
                <div className="activity-feed__list">
                  {feedEvents.map((event, index) => renderFeedItem(event, index, feedEvents.length))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteComment}
        title="Delete comment"
        message="Are you sure you want to delete this comment? This action cannot be undone."
        confirmLabel="Delete"
        danger
      />
    </Drawer>
  )
}

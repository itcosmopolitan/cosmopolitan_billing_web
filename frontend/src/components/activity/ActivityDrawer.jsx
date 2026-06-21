import { useEffect, useState } from 'react'
import { Avatar, Drawer, Spinner, Tag } from '@/components/ui'
import { activityAPI } from '@/api'
import { useCan } from '@/auth/permissions'

function formatEventTimestamp(value) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
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
  if (event.kind === 'comment') {
    const def = EVENT_DEFINITIONS[event.event_type] || EVENT_DEFINITIONS.comment
    return { label: def.label, bg: def.bg, text: def.text }
  }
  const def = EVENT_DEFINITIONS[event.event_type]
  if (def) return { label: getCombinedLabel(event), bg: def.bg, text: def.text }
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

function getActorInitials(event) {
  const name = event.kind === 'comment' ? event.author_name : event.user_name || event.author_name
  return getInitials(name)
}

// Single explicit mapping of generic event_type -> label + color tokens + icon
const EVENT_DEFINITIONS = {
  // Creation (GREEN)
  created:           { label: 'Created', bg: 'var(--green-bg)', text: 'var(--green)', icon: '＋' },

  // Confirmation / positive (BLUE)
  confirmed:         { label: 'Confirmed', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  verified:          { label: 'Verified', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },
  approved:          { label: 'Approved', bg: 'var(--blue-bg)', text: 'var(--blue)', icon: '✓' },

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
  invoice: 'Invoice',
  purchase_order: 'Purchase order',
  bill: 'Bill',
  grn: 'GRN',
  quote: 'Quote',
  quotation: 'Quote',
  sales_return: 'Sales return',
  vendor_return: 'Vendor return',
  item: 'Item',
}

function getCombinedLabel(event) {
  const def = EVENT_DEFINITIONS[event.event_type] || EVENT_DEFINITIONS.comment
  const recordLabel = RECORD_TYPE_LABELS[event.record_type] || (event.record_type || '').replace(/_/g, ' ')
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

function renderCategoryIcon(event) {
  const key = event.event_type || event.action
  const def = EVENT_DEFINITIONS[key]
  const bg = def?.bg || 'var(--bg-hover)'
  const color = def?.text || 'var(--text-secondary)'
  const icon = def?.icon || '•'
  return (
    <div style={{
      width: 34,
      height: 34,
      borderRadius: '50%',
      background: bg,
      border: `1px solid ${color}44`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14,
      color,
      flexShrink: 0,
    }}>{icon}</div>
  )
}

export default function ActivityDrawer({ open, onClose, recordType, recordId, title }) {
  const [loading, setLoading] = useState(false)
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [commentBody, setCommentBody] = useState('')
  const [editingCommentId, setEditingCommentId] = useState(null)
  const [editedCommentBody, setEditedCommentBody] = useState('')
  const [submitting, setSubmitting] = useState(false)

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

  const handleStartEdit = (commentId, body) => {
    setEditingCommentId(commentId)
    setEditedCommentBody(body || '')
    setError(null)
  }

  const handleCancelEdit = () => {
    setEditingCommentId(null)
    setEditedCommentBody('')
  }

  const handleSaveEdit = async () => {
    if (!editedCommentBody.trim() || !editingCommentId) return
    setSubmitting(true)
    setError(null)
    try {
      const updated = await activityAPI.patchComment(editingCommentId, {
        body: editedCommentBody.trim(),
      })
      setEvents((prev) => prev.map((event) => (event.id === editingCommentId ? updated : event)))
      setEditingCommentId(null)
      setEditedCommentBody('')
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Unable to save comment')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteComment = async (commentId) => {
    if (!window.confirm('Delete this comment?')) return
    setSubmitting(true)
    setError(null)
    try {
      await activityAPI.deleteComment(commentId)
      setEvents((prev) => prev.filter((event) => event.id !== commentId))
      if (editingCommentId === commentId) {
        handleCancelEdit()
      }
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Unable to delete comment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={title || 'Activity'} icon="⏱">
      <div style={{ minHeight: 260, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }}>
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

        {!loading && !error && events.length === 0 && (
          <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
            No activity records were found for this document.
          </div>
        )}

        {!loading && !error && events.length > 0 && (
          <div style={{ display: 'grid', gap: 14, padding: '8px 0' }}>
            {events.map((event) => {
              const badge = getEventBadge(event)
              return (
                <div
                  key={event.id}
                  style={{
                    padding: 16,
                    borderRadius: 16,
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-strong)',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.04)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                    {renderCategoryIcon(event)}
                    <Avatar initials={getActorInitials(event)} size={38} color={event.kind === 'comment' ? 'var(--blue)' : 'var(--accent)'} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {getEventBody(event)}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="tag" style={{ background: badge.bg, color: badge.text, fontSize: 12, padding: '2px 8px' }}>{badge.label}</span>
                          {event.kind === 'comment' && event.is_pinned && <Tag color="var(--blue)">Pinned</Tag>}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <span>{getActorLabel(event)}</span>
                        <span>{formatEventTimestamp(event.created_at)}</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                        {event.module && <Tag color="var(--accent)">{event.module}</Tag>}
                        {event.risk && <Tag color="var(--red)">{event.risk}</Tag>}
                      </div>
                    </div>
                  </div>

                  {event.kind === 'comment' && editingCommentId === event.id ? (
                    <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                      <textarea
                        className="form-input"
                        value={editedCommentBody}
                        onChange={(e) => setEditedCommentBody(e.target.value)}
                        disabled={submitting}
                        style={{ width: '100%', minHeight: 96, resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                        <button type="button" className="btn btn-secondary" onClick={handleCancelEdit} disabled={submitting}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={handleSaveEdit}
                          disabled={submitting || !editedCommentBody.trim()}
                        >
                          {submitting ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {(event.can_edit || event.can_delete) && (
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, justifyContent: 'flex-end' }}>
                          {event.can_edit && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              onClick={() => handleStartEdit(event.id, event.body)}
                              disabled={submitting}
                              style={{ minWidth: 90 }}
                            >
                              Edit
                            </button>
                          )}
                          {event.can_delete && (
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              onClick={() => handleDeleteComment(event.id)}
                              disabled={submitting}
                              style={{ minWidth: 90 }}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div style={{ padding: 16, borderTop: '1px solid var(--border-default)' }}>
        <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Add a comment</div>
          {!canAddComment && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              You need comments.add permission to post.
            </span>
          )}
        </div>
        <textarea
          className="form-input"
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder={canAddComment ? 'Write a comment...' : 'You cannot add comments.'}
          disabled={!canAddComment || submitting}
          style={{ width: '100%', minHeight: 96, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10, gap: 10 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setCommentBody('')}
            disabled={submitting}
          >
            Clear
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmitComment}
            disabled={!canAddComment || submitting || !commentBody.trim()}
          >
            {submitting ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

import { POS_DRAG_MIME } from './posDrag'

/**
 * The grab handle on the products / cart panel headers. Drag onto the other
 * column to swap which side products vs. cart appear on. State is owned by
 * POSPage; this component only emits dataTransfer events.
 */
export default function PanelDragHandle({ panel, onDragEnd, title }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(POS_DRAG_MIME, panel)
        e.dataTransfer.setData('text/plain', panel)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={onDragEnd}
      title={title}
      aria-label={title}
      style={{
        flexShrink: 0,
        cursor: 'grab',
        padding: '6px 7px',
        borderRadius: 8,
        border: '1px solid var(--border-default)',
        background: 'var(--bg-raised)',
        color: 'var(--text-muted)',
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: -0.5,
        userSelect: 'none',
      }}
    >
      ⋮⋮
    </div>
  )
}

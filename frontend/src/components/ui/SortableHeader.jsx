/**
 * Click-to-sort table header. Renders a <th> with a button child that toggles
 * the sort state on the parent. Stateless — the parent owns sortBy/sortOrder
 * and the onSort handler. Use one per column you want sortable; leave plain
 * <th> for non-sortable columns (e.g. "Actions" trailing column).
 *
 * Pair with the backend `resolve_sort()` helper in `backend/src/pagination.py`
 * so the API and the header agree on the allowed `sortKey` strings.
 */
export function SortableHeader({
  label,
  sortKey,
  sortBy,
  sortOrder,
  onSort,
  className,
  style,
  align = 'left',
}) {
  const active = sortBy === sortKey
  const arrow = active ? (sortOrder === 'asc' ? '↑' : '↓') : ''
  const ariaSort = active ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'

  return (
    <th className={className} style={style} aria-sort={ariaSort}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
          gap: 4,
          width: '100%',
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span>{label}</span>
        {active && <span aria-hidden="true">{arrow}</span>}
      </button>
    </th>
  )
}

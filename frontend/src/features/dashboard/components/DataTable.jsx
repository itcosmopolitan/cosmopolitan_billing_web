import { memo, useMemo, useRef, useState } from 'react'
import SkeletonCard from './SkeletonCard'

function DataTable({ title, columns, rows = [], loading = false, rowHeight = 44, maxHeight = 360, footer }) {
  const [scrollTop, setScrollTop] = useState(0)
  const bodyRef = useRef(null)
  const shouldVirtualize = rows.length > 500
  const visibleCount = Math.ceil(maxHeight / rowHeight) + 8
  const startIndex = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / rowHeight) - 4) : 0
  const endIndex = shouldVirtualize ? Math.min(rows.length, startIndex + visibleCount) : rows.length

  const visibleRows = useMemo(() => rows.slice(startIndex, endIndex), [rows, startIndex, endIndex])
  const topSpacer = shouldVirtualize ? startIndex * rowHeight : 0
  const bottomSpacer = shouldVirtualize ? Math.max(0, (rows.length - endIndex) * rowHeight) : 0

  if (loading) return <SkeletonCard rows={5} height={maxHeight} />

  return (
    <div className="card">
      {title && (
        <div className="card-header" style={{ padding: '12px 16px' }}>
          <h4 style={{ margin: 0, flex: 1 }}>{title}</h4>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{rows.length.toLocaleString('en-MV')} rows</span>
        </div>
      )}
      <div
        ref={bodyRef}
        onScroll={(e) => shouldVirtualize && setScrollTop(e.currentTarget.scrollTop)}
        style={{ maxHeight, overflow: 'auto' }}
      >
        <table className="data-table" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={column.align === 'right' ? 'text-right' : ''}
                  style={{ width: column.width }}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topSpacer > 0 && (
              <tr><td colSpan={columns.length} style={{ height: topSpacer, padding: 0, border: 0 }} /></tr>
            )}
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 24 }}>
                  No records found
                </td>
              </tr>
            ) : visibleRows.map((row, localIndex) => {
              const index = startIndex + localIndex
              return (
                <tr key={row.id || row.product_id || row.invoice_id || row.item_id || index} style={{ height: rowHeight }}>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={column.align === 'right' ? 'text-right' : ''}
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {column.render ? column.render(row, index) : row[column.key]}
                    </td>
                  ))}
                </tr>
              )
            })}
            {bottomSpacer > 0 && (
              <tr><td colSpan={columns.length} style={{ height: bottomSpacer, padding: 0, border: 0 }} /></tr>
            )}
          </tbody>
        </table>
      </div>
      {footer && <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-subtle)' }}>{footer}</div>}
    </div>
  )
}

export default memo(DataTable)

import { PAGE_SIZE_OPTIONS } from '@/utils/pagination'

/**
 * Server list footer: page controls and per-page size (50 / 100 / 200 / 500).
 * When `hasMorePage` is supplied (from API `page_context.has_more_page`), the
 * bar is hidden on a single-page result; it stays visible on page 2+ so Previous
 * remains available even when `has_more_page` is false on the last page.
 */
export function PaginationBar({ total, skip, limit, onSkipChange, onLimitChange, disabled, hasMorePage }) {
  const safeLimit = limit > 0 ? limit : 50
  const from = total === 0 ? 0 : skip + 1
  const to = Math.min(skip + safeLimit, total)
  const totalPages = Math.max(1, Math.ceil(total / safeLimit))
  const page = Math.min(totalPages, Math.floor(skip / safeLimit) + 1)

  const showBar = hasMorePage === undefined
    ? total > safeLimit
    : (hasMorePage || skip > 0)

  if (!showBar) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        padding: '12px 16px',
        borderTop: '1px solid var(--border-default)',
        fontSize: 13,
        color: 'var(--text-muted)',
      }}
    >
      <span>
        Showing <strong style={{ color: 'var(--text-primary)' }}>{from}</strong>–
        <strong style={{ color: 'var(--text-primary)' }}>{to}</strong> of{' '}
        <strong style={{ color: 'var(--text-primary)' }}>{total}</strong>
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || skip <= 0}
          onClick={() => onSkipChange(Math.max(0, skip - safeLimit))}
          aria-label="Previous page"
          title="Previous page"
        >
          &lt;
        </button>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          Page {page} / {totalPages}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || skip + safeLimit >= total}
          onClick={() => onSkipChange(skip + safeLimit)}
          aria-label="Next page"
          title="Next page"
        >
          &gt;
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
          <span style={{ fontSize: 12 }}>Per page</span>
          <select
            className="form-input"
            style={{ width: 100, padding: '6px 8px' }}
            value={safeLimit}
            disabled={disabled}
            onChange={(e) => {
              const next = Number(e.target.value)
              onLimitChange(next)
              onSkipChange(0)
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

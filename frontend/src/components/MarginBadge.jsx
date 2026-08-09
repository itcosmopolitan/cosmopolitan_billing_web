/** Compact ↑/↓ margin % (and optional MVR) for line / document summaries. */
export default function MarginBadge({ margin, showAmount = false, size = 'sm' }) {
  if (!margin || margin.pct == null || Number.isNaN(margin.pct)) {
    return <span style={{ color: 'var(--text-muted)' }}>—</span>
  }
  const positive = margin.pct >= 0
  const fontSize = size === 'lg' ? 13 : 12
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontWeight: 600,
        color: positive ? 'var(--green)' : 'var(--red)',
        fontSize,
        whiteSpace: 'nowrap',
      }}
      title={showAmount ? undefined : `Margin ${margin.amount >= 0 ? '+' : ''}${Number(margin.amount).toFixed(2)} MVR`}
    >
      <span aria-hidden>{positive ? '↑' : '↓'}</span>
      <span className="mono" style={{ fontFamily: 'DM Mono, monospace' }}>
        {margin.pct.toFixed(1)}%
      </span>
      {showAmount && (
        <span className="mono" style={{ fontFamily: 'DM Mono, monospace', fontWeight: 500, opacity: 0.9 }}>
          ({margin.amount >= 0 ? '' : '−'}{Math.abs(margin.amount).toLocaleString('en-MV', { maximumFractionDigits: 0 })})
        </span>
      )}
    </span>
  )
}

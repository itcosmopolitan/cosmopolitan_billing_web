import { fmt } from '@/utils/helpers'

const lineMarginPct = (unitPrice, costPrice) => {
  const p = Number(unitPrice)
  const c = Number(costPrice)
  if (!p || p <= 0) return null
  return ((p - c) / p) * 100
}

/**
 * One row of the POS cart table. Extracted from POSPage to keep that file
 * navigable; the page is still the owner of all state and just hands per-row
 * callbacks down here.
 */
export default function CartRow({
  item,
  onQtyChange,
  onRemove,
  onDiscChange,
  onDiscTypeChange,
  disableDiscount,
}) {
  const marginPct = lineMarginPct(item.price, item.costPrice)
  const marginPositive = marginPct != null && marginPct >= 0
  const hsn = item.hsnCode || '—'
  const hasStock = item.availableStock != null || item.available_stock != null
  const stockQty = hasStock ? Number(item.availableStock ?? item.available_stock) || 0 : null
  const stockExceeded = stockQty != null && item.qty > stockQty
  const discType = item.lineDiscountType === 'flat' ? 'flat' : 'pct'
  const discValue = Number(item.lineDiscountValue ?? item.lineDiscountPct ?? item.lineDiscountFlat ?? 0) || 0

  return (
    <tr
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', minWidth: 230 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>{item.emoji || '📦'}</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35 }}>{item.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>HSN: {hsn}</span>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>Stock: {stockQty ?? '—'}</span>
              {stockExceeded && (
                <span title="Stock exceeded" style={{ color: 'var(--amber)', cursor: 'help', fontSize: 12, lineHeight: 1 }} aria-label="Stock exceeded">⚠️</span>
              )}
            </div>
          </div>
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            className="form-input"
            type="number"
            min={1}
            step={1}
            value={item.qty}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (Number.isFinite(v)) onQtyChange(v)
            }}
            style={{ width: 52, padding: '4px 6px', fontSize: 12, textAlign: 'center', fontFamily: 'DM Mono, monospace' }}
          />
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 600 }}>
        {fmt(item.price)}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>
        {marginPct == null ? (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: marginPositive ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
            <span aria-hidden>{marginPositive ? '↑' : '↓'}</span>
            <span style={{ fontFamily: 'DM Mono, monospace' }}>{marginPct.toFixed(1)}%</span>
          </span>
        )}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: disableDiscount ? 0.6 : 1 }}>
          <input
            className="form-input"
            type="number"
            min={0}
            max={discType === 'pct' ? 100 : undefined}
            step={discType === 'pct' ? 0.5 : 1}
            value={discValue || ''}
            onChange={(e) => onDiscChange(Number(e.target.value) || 0)}
            disabled={disableDiscount}
            style={{ width: 86, padding: '4px 7px', fontSize: 12 }}
          />
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 7, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => onDiscTypeChange('pct')}
              disabled={disableDiscount}
              style={{
                border: 'none',
                borderRight: '1px solid var(--border-default)',
                background: discType === 'pct' ? 'var(--accent-bg)' : 'transparent',
                color: discType === 'pct' ? 'var(--accent)' : 'var(--text-muted)',
                cursor: disableDiscount ? 'not-allowed' : 'pointer',
                fontSize: 11,
                padding: '4px 7px',
                fontWeight: 600,
              }}
            >
              %
            </button>
            <button
              type="button"
              onClick={() => onDiscTypeChange('flat')}
              disabled={disableDiscount}
              style={{
                border: 'none',
                background: discType === 'flat' ? 'var(--accent-bg)' : 'transparent',
                color: discType === 'flat' ? 'var(--accent)' : 'var(--text-muted)',
                cursor: disableDiscount ? 'not-allowed' : 'pointer',
                fontSize: 11,
                padding: '4px 7px',
                fontWeight: 600,
              }}
            >
              ₹
            </button>
          </div>
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}>
        {fmt(item.lineTotal)}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'center' }}>
        <button type="button" onClick={onRemove} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }} aria-label="Remove line">✕</button>
      </td>
    </tr>
  )
}

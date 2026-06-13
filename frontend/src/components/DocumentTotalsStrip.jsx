import { fmt } from '@/utils/helpers'
import { useAppStore } from '@/store'
import {
  computeDocumentTotals,
  hasLineLevelDiscount,
  hasEntityLevelDiscount,
  discountToggleStyle,
  discountToggleBtnStyle,
} from '@/utils/documentFormTotals'

/**
 * POS-style discount + totals block for sales/purchase document forms.
 * Line-item discount OR document-level discount — not both at once.
 */
export default function DocumentTotalsStrip({
  items,
  entityDiscount = 0,
  entityDiscountType = '%',
  onEntityDiscountChange,
  onEntityDiscountTypeChange,
  readOnly = false,
  lineGross,
  showWhenEmpty = false,
  taxPricingMode: taxModeProp,
}) {
  const storeTaxMode = useAppStore((s) => s.taxPricingMode)
  const taxPricingMode = taxModeProp || storeTaxMode || 'inclusive'

  if (!showWhenEmpty && (!items || items.length === 0)) return null

  const hasLineDiscount = hasLineLevelDiscount(items)
  const hasEntityDiscount = hasEntityLevelDiscount(entityDiscount)
  const disableEntity = readOnly || hasLineDiscount
  const disableLine = hasEntityDiscount // parent disables line inputs via this flag

  const totals = computeDocumentTotals(items, {
    entityDiscount,
    entityDiscountType,
    lineGross,
    taxPricingMode,
    enforceExclusive: !readOnly,
  })

  const showTax = totals.taxTotal > 0

  return (
    <div style={{ marginTop: 12, marginBottom: 16 }}>
      {/* Document discount row — mirrors POS bill discount row */}
      {!readOnly && onEntityDiscountChange && (
        <div style={{ padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="form-input"
              style={{
                flex: 1,
                minWidth: 160,
                padding: '7px 10px',
                fontSize: 12,
                opacity: disableEntity ? 0.6 : 1,
                textAlign: 'right',
              }}
              type="number"
              min="0"
              max={entityDiscountType === '%' ? 100 : undefined}
              step={entityDiscountType === '%' ? 0.5 : 0.01}
              placeholder={
                disableEntity
                  ? 'Clear line-item discounts to use document discount'
                  : (entityDiscountType === '%' ? 'Document discount %' : 'Document discount ₹')
              }
              value={entityDiscount || ''}
              onChange={(e) => onEntityDiscountChange(e.target.value)}
              disabled={disableEntity}
            />
            {onEntityDiscountTypeChange && (
              <div style={discountToggleStyle}>
                <button
                  type="button"
                  disabled={disableEntity}
                  onClick={() => onEntityDiscountTypeChange('%')}
                  style={discountToggleBtnStyle(entityDiscountType === '%', disableEntity)}
                >
                  %
                </button>
                <button
                  type="button"
                  disabled={disableEntity}
                  onClick={() => onEntityDiscountTypeChange('₹')}
                  style={{
                    ...discountToggleBtnStyle(entityDiscountType === '₹', disableEntity),
                    borderRight: 'none',
                  }}
                >
                  ₹
                </button>
              </div>
            )}
          </div>
          {(hasLineDiscount || hasEntityDiscount) && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              {hasLineDiscount
                ? 'Using line-item discount mode.'
                : 'Using document-level discount mode.'}
              {disableLine && hasEntityDiscount && ' Line discounts are disabled while document discount is set.'}
            </div>
          )}
        </div>
      )}

      {/* Totals panel — mirrors POS checkout totals */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-raised)',
        borderRadius: 'var(--radius-sm)',
      }}
      >
        {totals.taxMode === 'inclusive' && items.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Item amounts include tax
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 5 }}>
          <span>{showTax ? 'Taxable amount' : 'Subtotal'}</span>
          <span className="mono">{fmt(showTax ? totals.netSubtotal : totals.gross)}</span>
        </div>

        {showTax && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 5 }}>
            <span>Tax amount</span>
            <span className="mono">{fmt(totals.taxTotal)}</span>
          </div>
        )}

        {totals.lineDiscount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5, color: 'var(--green)' }}>
            <span>Line discount</span>
            <span className="mono">−{fmt(totals.lineDiscount)}</span>
          </div>
        )}

        {totals.entityDiscount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5, color: 'var(--green)' }}>
            <span>Document discount</span>
            <span className="mono">−{fmt(totals.entityDiscount)}</span>
          </div>
        )}

        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 18,
          fontWeight: 700,
          paddingTop: 10,
          borderTop: '1px solid var(--border-default)',
        }}
        >
          <span>Total</span>
          <span className="mono" style={{ color: 'var(--accent)' }}>{fmt(totals.total)}</span>
        </div>
      </div>
    </div>
  )
}

/** Whether line-item discount inputs should be disabled (entity discount active). */
export function shouldDisableLineDiscount(entityDiscount) {
  return hasEntityLevelDiscount(entityDiscount)
}

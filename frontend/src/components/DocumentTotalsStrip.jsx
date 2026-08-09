import { fmt } from '@/utils/helpers'
import MarginBadge from '@/components/MarginBadge'
import {
  computeDocumentTotals,
  hasLineLevelDiscount,
  hasEntityLevelDiscount,
  discountToggleStyle,
  discountToggleBtnStyle,
} from '@/utils/documentFormTotals'
import { documentMargin } from '@/utils/marginCalc'

/**
 * Discount + totals footer for sales/purchase document forms.
 * Notes left, summary right. Line-item OR document-level discount — not both.
 * Line prices are always tax-inclusive.
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
  showMargin = true,
  /** Override auto sale-margin (e.g. purchase vs catalog sell). */
  marginOverride = null,
  notes = '',
  onNotesChange,
  notesLabel = 'Notes',
  notesPlaceholder = 'Thanks for your business.',
  notesHint = 'Will be displayed on the invoice',
}) {
  if (!showWhenEmpty && (!items || items.length === 0)) return null

  const hasLineDiscount = hasLineLevelDiscount(items)
  const hasEntityDiscount = hasEntityLevelDiscount(entityDiscount)
  const disableEntity = readOnly || hasLineDiscount

  const totals = computeDocumentTotals(items, {
    entityDiscount,
    entityDiscountType,
    lineGross,
    enforceExclusive: !readOnly,
  })
  const margin = marginOverride !== null && marginOverride !== undefined
    ? marginOverride
    : (showMargin
      ? documentMargin(items, {
        entityDiscount,
        entityDiscountType,
        lineGross,
        enforceExclusive: !readOnly,
      })
      : null)

  const showTax = totals.taxTotal > 0

  const discountInput = !readOnly && onEntityDiscountChange ? (
    <div className="document-summary-discount-input">
      <input
        className="form-input"
        type="number"
        min="0"
        max={entityDiscountType === '%' ? 100 : undefined}
        step={entityDiscountType === '%' ? 0.5 : 0.01}
        placeholder={entityDiscountType === '%' ? '0' : '0.00'}
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
            onClick={() => onEntityDiscountTypeChange('MVR')}
            style={{
              ...discountToggleBtnStyle(entityDiscountType === 'MVR', disableEntity),
              borderRight: 'none',
            }}
          >
            MVR
          </button>
        </div>
      )}
    </div>
  ) : null

  const summaryCard = (
    <div className="document-summary-card">
      {items.length > 0 && (
        <div className="document-summary-card__hint">Item amounts include tax</div>
      )}

      {!readOnly && onEntityDiscountChange && (
        <div className="document-summary-row document-summary-row--discount">
          <span className="document-summary-row__label">Discount</span>
          <div className="document-summary-row__control">{discountInput}</div>
          <span className="document-summary-row__value mono">
            {totals.entityDiscount > 0 ? `−${fmt(totals.entityDiscount)}` : fmt(0)}
          </span>
        </div>
      )}

      {readOnly && totals.entityDiscount > 0 && (
        <div className="document-summary-row">
          <span className="document-summary-row__label">Discount</span>
          <span className="document-summary-row__spacer" />
          <span className="document-summary-row__value mono document-summary-row__value--discount">
            −{fmt(totals.entityDiscount)}
          </span>
        </div>
      )}

      {totals.lineDiscount > 0 && (
        <div className="document-summary-row">
          <span className="document-summary-row__label">Line discount</span>
          <span className="document-summary-row__spacer" />
          <span className="document-summary-row__value mono document-summary-row__value--discount">
            −{fmt(totals.lineDiscount)}
          </span>
        </div>
      )}

      <div className="document-summary-row">
        <span className="document-summary-row__label">Taxable amount</span>
        <span className="document-summary-row__spacer" />
        <span className="document-summary-row__value mono">{fmt(totals.netSubtotal)}</span>
      </div>

      {showTax && (
        <div className="document-summary-row">
          <span className="document-summary-row__label">Tax amount</span>
          <span className="document-summary-row__spacer" />
          <span className="document-summary-row__value mono">{fmt(totals.taxTotal)}</span>
        </div>
      )}

      {(hasLineDiscount || hasEntityDiscount) && !readOnly && (
        <div className="document-summary-card__mode-hint">
          {hasLineDiscount
            ? 'Using line-item discount mode.'
            : 'Using document-level discount mode.'}
        </div>
      )}

      {margin && (
        <div className="document-summary-row">
          <span className="document-summary-row__label">Margin</span>
          <span className="document-summary-row__spacer" />
          <span className="document-summary-row__value">
            <MarginBadge margin={margin} showAmount />
          </span>
        </div>
      )}

      <div className="document-summary-row document-summary-row--total">
        <span className="document-summary-row__label">Total</span>
        <span className="document-summary-row__spacer" />
        <span className="document-summary-row__value mono document-summary-row__value--total">
          {fmt(totals.total)}
        </span>
      </div>
    </div>
  )

  return (
    <div className="document-totals-footer">
      <div className="document-totals-footer__notes">
        <label className="form-label">{notesLabel}</label>
        {onNotesChange ? (
          <textarea
            className="form-input document-totals-footer__notes-input"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder={notesPlaceholder}
            disabled={readOnly}
          />
        ) : (
          <div className="document-totals-footer__notes-readonly">{notes || '—'}</div>
        )}
        {notesHint ? (
          <div className="document-totals-footer__notes-hint">{notesHint}</div>
        ) : null}
      </div>
      <div className="document-totals-footer__gap" aria-hidden="true" />
      <div className="document-totals-footer__summary">
        {summaryCard}
      </div>
    </div>
  )
}

/** Whether line-item discount inputs should be disabled (entity discount active). */
export function shouldDisableLineDiscount(entityDiscount) {
  return hasEntityLevelDiscount(entityDiscount)
}

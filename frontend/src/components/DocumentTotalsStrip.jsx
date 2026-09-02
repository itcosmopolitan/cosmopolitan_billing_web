import { fmt } from '@/utils/helpers'
import MarginBadge from '@/components/MarginBadge'
import { amountInputStep } from '@/utils/decimalPrecision'
import {
  computeDocumentTotals,
  hasLineLevelDiscount,
  hasEntityLevelDiscount,
  discountToggleStyle,
  discountToggleBtnStyle,
} from '@/utils/documentFormTotals'
import { documentMargin } from '@/utils/marginCalc'
import { internalGstReverseSummary } from '@/utils/pricingDiscounts'

/**
 * Discount + totals footer for sales/purchase document forms.
 * Notes left, summary right. Line-item OR document-level discount — not both.
 * Line prices are always tax-inclusive.
 *
 * Optional account-credit preview (invoices/POS): when `accountCreditApplied` > 0,
 * shows credit drawn, credit left on account, and amount still due.
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
  /** Account credit (negative outstanding) applied to this document. */
  accountCreditApplied = 0,
  /** Credit balance left on the customer after this apply. */
  accountCreditRemaining = null,
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
  const gstReverse = internalGstReverseSummary(items)
  const creditApplied = Math.max(0, Number(accountCreditApplied) || 0)
  const amountDue = Math.round(Math.max(0, totals.total - creditApplied) * 100) / 100
  const showCredit = creditApplied > 0.001
  const creditLeft = accountCreditRemaining == null
    ? null
    : Math.max(0, Number(accountCreditRemaining) || 0)

  const discountInput = !readOnly && onEntityDiscountChange ? (
    <div className="document-summary-discount-input">
      <input
        className="form-input"
        type="number"
        min="0"
        max={entityDiscountType === '%' ? 100 : undefined}
        step={entityDiscountType === '%' ? 0.5 : amountInputStep()}
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
          <div className="document-summary-card__hint">
            {gstReverse.gstReversed > 0
              ? 'GST is subtracted from item amounts for this internal customer.'
              : 'Item amounts include tax. Discounts apply before tax.'}
          </div>
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

      {gstReverse.gstReversed > 0 && (
        <>
          <div className="document-summary-row">
            <span className="document-summary-row__label">GST reversed</span>
            <span className="document-summary-row__spacer" />
            <span className="document-summary-row__value mono document-summary-row__value--discount">
              −{fmt(gstReverse.gstReversed)}
            </span>
          </div>
          <div className="document-summary-card__mode-hint">
            {fmt(gstReverse.inclusive)} incl.
            {' − '}
            {fmt(gstReverse.gstReversed)} GST
            {gstReverse.rate != null ? ` (${gstReverse.rate}%)` : ''}
            {' = '}
            {fmt(gstReverse.exclusive)}
          </div>
        </>
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

      <div className={`document-summary-row${showCredit ? '' : ' document-summary-row--total'}`}>
        <span className="document-summary-row__label">{showCredit ? 'Invoice total' : 'Total'}</span>
        <span className="document-summary-row__spacer" />
        <span className={`document-summary-row__value mono${showCredit ? '' : ' document-summary-row__value--total'}`}>
          {fmt(totals.total)}
        </span>
      </div>

      {showCredit && (
        <>
          <div className="document-summary-row">
            <span className="document-summary-row__label" style={{ color: 'var(--green)' }}>
              Account credit applied
            </span>
            <span className="document-summary-row__spacer" />
            <span className="document-summary-row__value mono" style={{ color: 'var(--green)' }}>
              −{fmt(creditApplied)}
            </span>
          </div>
          {creditLeft != null && (
            <div className="document-summary-row">
              <span className="document-summary-row__label" style={{ color: 'var(--text-muted)' }}>
                Credit remaining
              </span>
              <span className="document-summary-row__spacer" />
              <span className="document-summary-row__value mono" style={{ color: 'var(--text-muted)' }}>
                {fmt(creditLeft)}
              </span>
            </div>
          )}
          <div className="document-summary-row document-summary-row--total">
            <span className="document-summary-row__label">Amount due</span>
            <span className="document-summary-row__spacer" />
            <span className="document-summary-row__value mono document-summary-row__value--total">
              {fmt(amountDue)}
            </span>
          </div>
        </>
      )}
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

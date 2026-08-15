import { FormGroup } from '@/components/ui'
import { amountInputStep } from '@/utils/decimalPrecision'
import { priceTaxBreakdown } from '@/utils/taxCalc'
import { fmt } from '@/utils/helpers'

export const GST_TAX_MODE_OPTIONS = [
  { value: 'inclusive', label: 'Incl. GST' },
  { value: 'exclusive', label: 'Excl. GST' },
]

export function normalizeTaxMode(mode) {
  return mode === 'exclusive' ? 'exclusive' : 'inclusive'
}

/** Amount input with excl / GST / incl breakdown. Entry mode comes from the form-level dropdown. */
export default function TaxedPriceInput({
  label,
  required = false,
  value,
  mode,
  taxRate,
  onValueChange,
  placeholder = '0.00',
  disabled = false,
  compact = false,
}) {
  const entryMode = normalizeTaxMode(mode)
  const n = Number(value)
  const breakdown = value !== '' && value != null && Number.isFinite(n) && n > 0
    ? priceTaxBreakdown(n, entryMode, taxRate)
    : null
  const rate = Number(taxRate) || 0

  const breakdownEl = breakdown && (
    <div className={`taxed-price-breakdown${compact ? ' taxed-price-breakdown--compact' : ''}`}>
      <span><em>Excl.</em> <strong>{fmt(breakdown.exclusive)}</strong></span>
      <span><em>GST {rate}%</em> <strong>{fmt(breakdown.tax)}</strong></span>
      <span><em>Incl.</em> <strong>{fmt(breakdown.inclusive)}</strong></span>
    </div>
  )

  const control = (
    <>
      <input
        className="form-input"
        type="number"
        min="0"
        step={amountInputStep()}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder={placeholder}
        style={compact ? { textAlign: 'right' } : undefined}
      />
      {breakdownEl}
    </>
  )

  if (!label) {
    return (
      <div className={`taxed-price-input${compact ? ' taxed-price-input--compact' : ''}`}>
        {control}
      </div>
    )
  }

  return (
    <FormGroup label={label} required={required}>
      {control}
    </FormGroup>
  )
}

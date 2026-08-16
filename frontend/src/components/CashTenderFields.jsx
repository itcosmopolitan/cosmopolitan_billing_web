import { FormGroup } from '@/components/ui'
import { amountInputStep, formatAmountInput } from '@/utils/decimalPrecision'
import { cashTenderSummary } from '@/utils/cashTender'
import { fmt } from '@/utils/helpers'

/** Amount-collected input + live change due when paying by cash. */
export default function CashTenderFields({
  due,
  value,
  onChange,
  compact = false,
  autoFocus = false,
}) {
  const { change, short, collected } = cashTenderSummary(value, due)
  const hasAmount = collected != null
  const input = (
    <input
      className="form-input"
      type="number"
      min="0"
      step={amountInputStep()}
      value={value ?? ''}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      placeholder={formatAmountInput(due)}
      inputMode="decimal"
    />
  )
  const result = hasAmount && (
    short > 0 ? (
      <div className="cash-tender__msg cash-tender__msg--short">
        Short by <strong>{fmt(short)}</strong>
      </div>
    ) : (
      <div className="cash-tender__msg cash-tender__msg--change">
        <span>Change to customer</span>
        <strong>{fmt(change)}</strong>
      </div>
    )
  )

  if (compact) {
    return (
      <div className="cash-tender cash-tender--compact">
        <label className="cash-tender__label">Amount collected</label>
        {input}
        {result}
      </div>
    )
  }

  return (
    <div className="cash-tender">
      <FormGroup label="Amount collected" required>
        {input}
      </FormGroup>
      {result}
    </div>
  )
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import CompactCurrency from './CompactCurrency'
import { formatCompactCurrency, formatCurrency } from '../utils/formatCurrency'

describe('CompactCurrency', () => {
  it('keeps the compact label and exposes the full value in its tooltip', () => {
    const value = 1234567.89
    const html = renderToStaticMarkup(<CompactCurrency value={value} />)

    expect(html).toContain(formatCompactCurrency(value))
    expect(html).toContain(`title="MVR ${formatCurrency(value)}"`)
  })
})

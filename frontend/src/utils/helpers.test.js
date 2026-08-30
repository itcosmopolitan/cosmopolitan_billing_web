import { describe, it, expect } from 'vitest'

import { formatLabel } from './helpers.js'

describe('formatLabel', () => {
  it('converts snake_case to title case', () => {
    expect(formatLabel('bank_transfer')).toBe('Bank Transfer')
    expect(formatLabel('in_progress')).toBe('In Progress')
    expect(formatLabel('pending_approval')).toBe('Pending Approval')
  })

  it('preserves already formatted strings', () => {
    expect(formatLabel('Bank Transfer')).toBe('Bank Transfer')
    expect(formatLabel('In Progress')).toBe('In Progress')
    expect(formatLabel('User Account')).toBe('User Account')
  })

  it('handles numbers and camelCase', () => {
    expect(formatLabel('tier_1')).toBe('Tier 1')
    expect(formatLabel('userAccount')).toBe('User Account')
  })

  it('keeps known acronyms uppercase', () => {
    expect(formatLabel('upi')).toBe('UPI')
    expect(formatLabel('bank_transfer_iban')).toBe('Bank Transfer IBAN')
    expect(formatLabel('gst_inclusive')).toBe('GST Inclusive')
  })

  it('handles empty and nullish values safely', () => {
    expect(formatLabel('')).toBe('')
    expect(formatLabel(null)).toBe('')
    expect(formatLabel(undefined)).toBe('')
    expect(formatLabel('   ')).toBe('')
  })
})

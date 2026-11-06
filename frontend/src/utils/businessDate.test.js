import { describe, expect, it } from 'vitest'
import { businessDateToday } from './businessDate'

describe('businessDateToday', () => {
  it('uses the business date rather than the UTC date', () => {
    expect(businessDateToday(new Date('2026-10-31T20:30:00.000Z'))).toBe('2026-11-01')
  })
})

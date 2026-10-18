import { describe, it, expect } from 'vitest'

import { apiErrorMessage } from './apiErrorMessage'

const errWith = (detail) => ({ response: { data: { detail } } })

describe('apiErrorMessage', () => {
  it('returns a string detail as-is', () => {
    expect(apiErrorMessage(errWith('Branch not found'), 'Failed')).toBe('Branch not found')
  })

  it('uses the message from a structured detail object', () => {
    const detail = {
      code: 'insufficient_transfer_stock',
      message: 'Insufficient stock for Milk: requested 5, available 0',
    }
    expect(apiErrorMessage(errWith(detail), 'Failed')).toBe(detail.message)
  })

  it('joins pydantic validation messages from a list detail', () => {
    const detail = [
      { type: 'greater_than_equal', loc: ['body', 'new_qty'], msg: 'Input should be greater than or equal to 0', input: -2, ctx: { ge: 0 } },
    ]
    expect(apiErrorMessage(errWith(detail), 'Failed')).toBe('Input should be greater than or equal to 0')
  })

  it('falls back when the detail is missing or has no readable message', () => {
    expect(apiErrorMessage({}, 'Failed to save')).toBe('Failed to save')
    expect(apiErrorMessage(errWith({ code: 'x' }), 'Failed to save')).toBe('Failed to save')
    expect(apiErrorMessage(errWith([]), 'Failed to save')).toBe('Failed to save')
  })
})

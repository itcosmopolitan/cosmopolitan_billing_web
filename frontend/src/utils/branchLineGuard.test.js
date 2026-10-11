import { describe, expect, it } from 'vitest'
import { documentHasSelectedLines } from './branchLineGuard.jsx'

describe('documentHasSelectedLines', () => {
  it('ignores blank rows and keeps rows that already point at an item', () => {
    expect(documentHasSelectedLines([{ item_id: null, name: '' }])).toBe(false)
    expect(documentHasSelectedLines([{ item_id: 'item-1', name: 'Rice' }])).toBe(true)
    expect(documentHasSelectedLines([{ item_id: '', name: 'Custom line' }])).toBe(true)
  })
})

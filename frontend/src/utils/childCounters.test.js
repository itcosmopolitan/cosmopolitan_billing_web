import { describe, expect, it } from 'vitest'
import {
  getChildCounterBranch,
  getConfiguredChildCounters,
  shouldFollowActiveBranchForCounters,
} from './childCounters'

describe('shouldFollowActiveBranchForCounters', () => {
  it('tracks the active branch for a new quotation', () => {
    expect(shouldFollowActiveBranchForCounters('/sales/quotations/new')).toBe(true)
  })

  it('tracks the active branch for a standalone new order', () => {
    expect(shouldFollowActiveBranchForCounters('/sales/orders/new')).toBe(true)
  })

  it('keeps the source document branch when creating an order from a quotation', () => {
    expect(shouldFollowActiveBranchForCounters('/sales/orders/new', '?fromQuote=quote-1')).toBe(false)
  })

  it('keeps the saved branch when editing a sales document', () => {
    expect(shouldFollowActiveBranchForCounters('/sales/quotations/quote-1/edit')).toBe(false)
  })
})

describe('getConfiguredChildCounters', () => {
  it('ignores empty or unnamed counter entries', () => {
    expect(getConfiguredChildCounters({
      has_child_counters: true,
      child_counters: [{ name: '' }, { name: '   ' }, { name: 'Shop 01' }],
    })).toEqual([{ name: 'Shop 01' }])
  })

  it('returns no counters when the branch has no counter list', () => {
    expect(getConfiguredChildCounters({ has_child_counters: true })).toEqual([])
  })

  it('ignores stale counter entries when child counters are disabled', () => {
    expect(getConfiguredChildCounters({
      has_child_counters: false,
      child_counters: [{ id: 'old-counter', name: 'Old counter' }],
    })).toEqual([])
  })

  it('does not treat an active branch counter as belonging to another invoice branch', () => {
    const activeBranch = {
      id: 'branch-with-counters',
      has_child_counters: true,
      child_counters: [{ id: 'counter-1', name: 'Shop 01' }],
    }
    const invoiceBranch = getChildCounterBranch(
      [activeBranch],
      'branch-without-counters',
      activeBranch,
    )

    expect(getConfiguredChildCounters(invoiceBranch)).toEqual([])
  })

  it('uses the active branch only when its ID matches the invoice branch', () => {
    const activeBranch = {
      id: 'branch-1',
      has_child_counters: true,
      child_counters: [{ id: 'counter-1', name: 'Shop 01' }],
    }

    expect(getChildCounterBranch([], 'branch-1', activeBranch)).toBe(activeBranch)
    expect(getChildCounterBranch([], 'branch-2', activeBranch)).toBeNull()
  })
})

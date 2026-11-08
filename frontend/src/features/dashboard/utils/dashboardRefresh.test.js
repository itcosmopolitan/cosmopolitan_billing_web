import { describe, expect, it } from 'vitest'
import { dashboardRequestForRefresh } from './dashboardRefresh'

describe('dashboardRequestForRefresh', () => {
  it('adds a one-shot server-cache bypass for a new refresh token', () => {
    expect(dashboardRequestForRefresh({ branch_id: 'branch-1' }, 2, 1)).toEqual({
      bypassCache: true,
      filters: { branch_id: 'branch-1', refresh: true },
    })
  })

  it('does not keep bypassing the server cache after the refresh completes', () => {
    expect(dashboardRequestForRefresh({ branch_id: 'branch-1' }, 2, 2)).toEqual({
      bypassCache: false,
      filters: { branch_id: 'branch-1' },
    })
  })
})

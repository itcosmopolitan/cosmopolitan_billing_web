import { describe, it, expect, vi } from 'vitest'

import { fetchAllPages } from './fetchAllPages.js'

const makeRows = (count, start = 0) =>
  Array.from({ length: count }, (_, i) => ({ id: start + i }))

describe('fetchAllPages', () => {
  it('pages through full pages until a short page is returned', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: makeRows(3, 0) })
      .mockResolvedValueOnce({ items: makeRows(3, 3) })
      .mockResolvedValueOnce({ items: makeRows(1, 6) })

    const result = await fetchAllPages(fetchPage, { customer_id: 'c1' }, 3)

    expect(result.items).toHaveLength(7)
    expect(result.items.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(fetchPage.mock.calls[0][0]).toEqual({ customer_id: 'c1', skip: 0, limit: 3 })
    expect(fetchPage.mock.calls[1][0]).toEqual({ customer_id: 'c1', skip: 3, limit: 3 })
    expect(fetchPage.mock.calls[2][0]).toEqual({ customer_id: 'c1', skip: 6, limit: 3 })
  })

  it('stops after one request when the first page is short', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: makeRows(2) })

    const result = await fetchAllPages(fetchPage, {}, 5)

    expect(result.items).toHaveLength(2)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('returns an empty list when the endpoint returns no items', async () => {
    const fetchPage = vi.fn().mockResolvedValue({})

    const result = await fetchAllPages(fetchPage, {}, 5)

    expect(result.items).toEqual([])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('stops at a full page that is exactly the boundary and requests the next one', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: makeRows(2, 0) })
      .mockResolvedValueOnce({ items: [] })

    const result = await fetchAllPages(fetchPage, {}, 2)

    expect(result.items).toHaveLength(2)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('caps the number of requests at MAX_PAGES', async () => {
    const fetchPage = vi.fn().mockImplementation(async () => ({ items: makeRows(2) }))

    const result = await fetchAllPages(fetchPage, {}, 2)

    expect(fetchPage).toHaveBeenCalledTimes(200)
    expect(result.items).toHaveLength(400)
  })
})

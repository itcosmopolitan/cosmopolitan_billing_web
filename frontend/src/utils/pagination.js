/** Matches backend `ALLOWED_PAGE_SIZES` / default page size. */
export const PAGE_SIZE_OPTIONS = [50, 100, 200, 500]
export const DEFAULT_PAGE_SIZE = 50

/**
 * Normalizes list API responses to { items, total, skip, limit, summary }.
 * Accepts legacy plain arrays for safety.
 */
export function unwrapPaged(data) {
  if (Array.isArray(data)) {
    return {
      items: data,
      total: data.length,
      skip: 0,
      limit: data.length || DEFAULT_PAGE_SIZE,
      summary: null,
    }
  }
  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    skip: data?.skip ?? 0,
    limit: data?.limit ?? DEFAULT_PAGE_SIZE,
    summary: data?.summary ?? null,
  }
}

/** Load all rows by paging with max page size (500). Use for dropdowns / POS catalog. */
export async function fetchAllList(apiListFn, extraParams = {}) {
  let skip = 0
  const limit = 500
  let total = Infinity
  const acc = []
  while (skip < total) {
    const raw = await apiListFn({ ...extraParams, skip, limit })
    const { items, total: t } = unwrapPaged(raw)
    total = t
    acc.push(...items)
    skip += limit
    if (!items.length) break
  }
  return acc
}

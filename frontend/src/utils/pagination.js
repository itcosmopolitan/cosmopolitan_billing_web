/** Matches backend `ALLOWED_PAGE_SIZES` / default page size. */
export const PAGE_SIZE_OPTIONS = [50, 100, 200, 500]
export const DEFAULT_PAGE_SIZE = 50

/**
 * Normalizes list API responses to
 * { items, total, skip, limit, summary, pageNo, perPage, hasMorePage }.
 *
 * `pageNo` / `perPage` / `hasMorePage` come from the backend's `page_context`
 * envelope, which is currently emitted only by POS-mode list endpoints
 * (`pos_mode=true&include_total=false`). For non-paged shapes — including
 * legacy plain arrays — we synthesize `hasMorePage = false` so consumers
 * can use a single code path without null checks.
 */
export function unwrapPaged(data) {
  if (Array.isArray(data)) {
    return {
      items: data,
      total: data.length,
      skip: 0,
      limit: data.length || DEFAULT_PAGE_SIZE,
      summary: null,
      pageNo: 1,
      perPage: data.length || DEFAULT_PAGE_SIZE,
      hasMorePage: false,
    }
  }
  const ctx = data?.page_context ?? {}
  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    skip: data?.skip ?? 0,
    limit: data?.limit ?? DEFAULT_PAGE_SIZE,
    summary: data?.summary ?? null,
    pageNo: ctx.page_no ?? null,
    perPage: ctx.per_page ?? null,
    hasMorePage: Boolean(ctx.has_more_page),
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

import { EXPORT_PAGE_SIZE_SAFE } from '@/utils/listExport'

const MAX_PAGES = 200

/** Fetch every row of a paginated list endpoint. Returns `{ items }`, matching the list response shape. */
export async function fetchAllPages(fetchPage, params = {}, pageSize = EXPORT_PAGE_SIZE_SAFE) {
  const items = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const raw = await fetchPage({ ...params, skip: page * pageSize, limit: pageSize })
    const rows = raw?.items || []
    items.push(...rows)
    if (rows.length < pageSize) break
  }
  return { items }
}

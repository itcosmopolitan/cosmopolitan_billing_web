export function searchReportRows(rows, query) {
  const sourceRows = Array.isArray(rows) ? rows : []
  const needle = String(query || '').trim().toLocaleLowerCase()
  if (!needle) return sourceRows

  return sourceRows.filter((row) => (
    row != null && JSON.stringify(row).toLocaleLowerCase().includes(needle)
  ))
}
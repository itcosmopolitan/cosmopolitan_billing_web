/** Build tab labels with status counts, e.g. "Pending Approval (4)". */
export function tabsWithCounts(tabDefs, summary) {
  return tabDefs.map((t) => {
    const count = t.id === 'all' ? (summary?.total ?? 0) : (summary?.[t.id] ?? 0)
    return { id: t.id, label: `${t.label} (${count})` }
  })
}

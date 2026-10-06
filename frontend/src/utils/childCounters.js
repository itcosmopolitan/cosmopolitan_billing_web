export function getChildCounterBranch(branches, branchId, fallbackBranch) {
  return (Array.isArray(branches) ? branches : []).find((branch) => branch.id === branchId)
    || (fallbackBranch?.id === branchId ? fallbackBranch : null)
}

export function shouldFollowActiveBranchForCounters(pathname, search = '') {
  if (pathname === '/sales/quotations/new') return true
  return pathname === '/sales/orders/new' && !new URLSearchParams(search).has('fromQuote')
}

export function getConfiguredChildCounters(branch) {
  if (branch?.has_child_counters === false || branch?.hasChildCounters === false) {
    return []
  }

  const counters = branch?.child_counters || branch?.childCounters
  if (!Array.isArray(counters)) return []
  return counters.filter((counter) => (
    counter && typeof counter.name === 'string' && counter.name.trim()
  ))
}

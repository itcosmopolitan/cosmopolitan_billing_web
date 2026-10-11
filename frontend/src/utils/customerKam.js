// Returns a customer's per-branch key account managers as {branch, name} pairs,
// in branch order. `names` is {branchId: displayName}; `branches` is the store list.
export function getBranchKamEntries(names, branches) {
  return (branches || [])
    .filter((b) => names?.[b.id])
    .map((b) => ({ branch: b.name || b.code, name: names[b.id] }))
}

// Formats a customer's per-branch key account managers as "Branch: Name" pairs,
// in branch order. `names` is {branchId: displayName}; `branches` is the store list.
export function formatBranchKams(names, branches) {
  return getBranchKamEntries(names, branches)
    .map(({ branch, name }) => `${branch}: ${name}`)
    .join(', ')
}

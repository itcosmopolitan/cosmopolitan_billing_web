// Formats a customer's per-branch key account managers as "Branch: Name" pairs,
// in branch order. `names` is {branchId: displayName}; `branches` is the store list.
export function formatBranchKams(names, branches) {
  return (branches || [])
    .filter((b) => names?.[b.id])
    .map((b) => `${b.name || b.code}: ${names[b.id]}`)
    .join(', ')
}

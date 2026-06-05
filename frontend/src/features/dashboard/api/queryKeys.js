export const dashboardKeys = {
  root: ['dashboard'],
  filters: () => [...dashboardKeys.root, 'filters'],
  summary: (filters) => [...dashboardKeys.root, 'summary', filters],
  sales: (filters) => [...dashboardKeys.root, 'sales', filters],
  inventory: (filters) => [...dashboardKeys.root, 'inventory', filters],
  billing: (filters) => [...dashboardKeys.root, 'billing', filters],
  operations: (filters) => [...dashboardKeys.root, 'operations', filters],
}

/**
 * App boot / post-login hydration — catalog, branches, /auth/me,
 * and server-owned list column tables (defs + user order/hidden).
 */
import { authAPI, branchesAPI, permissionsAPI, settingsAPI } from '@/api'
import { fetchAllList } from '@/utils/pagination'

export async function bootstrapPublicData() {
  const catalog = await permissionsAPI.catalog().catch(() => ({}))
  return { catalog: catalog || {} }
}

export async function bootstrapAuthenticatedData() {
  const token = localStorage.getItem('retailos_token')
  if (!token) {
    return { catalog: {}, branches: [], user: null, permissions: [], columnTables: {} }
  }

  const [catalog, branches, me, columnPrefsRes, organisation] = await Promise.all([
    permissionsAPI.catalog().catch(() => ({})),
    fetchAllList(branchesAPI.list).catch(() => []),
    authAPI.me().catch(() => null),
    settingsAPI.getColumnPrefs().catch(() => null),
    settingsAPI.getOrganisation().catch(() => null),
  ])

  const columnTables = columnPrefsRes?.tables && typeof columnPrefsRes.tables === 'object'
    ? columnPrefsRes.tables
    : {}

  return {
    catalog: catalog || {},
    branches: branches || [],
    user: me,
    permissions: me?.permissions || [],
    columnTables,
    organisation: organisation || null,
  }
}

export function applyBootstrapToStore(
  data,
  {
    setSession,
    setPermCatalog,
    setBranches,
    setDecimalPrecisionPrefs,
    setOrganisationProfile,
    setColumnTables,
  },
) {
  if (data.catalog) setPermCatalog(data.catalog)
  if (Array.isArray(data.branches)) setBranches(data.branches)
  if (data.columnTables != null) setColumnTables?.(data.columnTables)
  if (data.organisation) {
    setOrganisationProfile?.(data.organisation)
  } else if (data.user) {
    setDecimalPrecisionPrefs?.(data.user)
  }
  if (data.user) {
    setSession({
      user: data.user,
      permissions: data.permissions || data.user.permissions || [],
      permCatalog: data.catalog,
    })
  }
}

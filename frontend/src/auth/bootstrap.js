/**
 * App boot / post-login hydration — single place for catalog, branches, /auth/me.
 * Branches require a valid JWT; never fetch them without a token (avoids 401 noise
 * on the login page and stale empty lists after SPA login).
 */
import { authAPI, branchesAPI, permissionsAPI } from '@/api'
import { fetchAllList } from '@/utils/pagination'

export async function bootstrapPublicData() {
  const catalog = await permissionsAPI.catalog().catch(() => ({}))
  return { catalog: catalog || {} }
}

export async function bootstrapAuthenticatedData({ includeBranches = false } = {}) {
  const token = localStorage.getItem('retailos_token')
  if (!token) {
    return { catalog: {}, branches: [], user: null, permissions: [] }
  }

  const requests = [
    permissionsAPI.catalog().catch(() => ({})),
    authAPI.me().catch(() => null),
  ]

  if (includeBranches) {
    requests.push(fetchAllList(branchesAPI.list).catch(() => []))
  }

  const [catalog, me, branches = []] = await Promise.all(requests)

  return {
    catalog: catalog || {},
    branches: branches || [],
    user: me,
    permissions: me?.permissions || [],
  }
}

export function applyBootstrapToStore(
  data,
  { setSession, setPermCatalog, setBranches },
) {
  if (data.catalog) setPermCatalog(data.catalog)
  if (Array.isArray(data.branches)) setBranches(data.branches)
  if (data.user) {
    setSession({
      user: data.user,
      permissions: data.permissions || data.user.permissions || [],
      permCatalog: data.catalog,
    })
  }
}

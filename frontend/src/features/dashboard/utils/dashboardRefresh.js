export function dashboardRequestForRefresh(filters, refreshToken, completedRefreshToken) {
  const bypassCache = Number(refreshToken || 0) > Number(completedRefreshToken || 0)
  return {
    bypassCache,
    filters: {
      ...filters,
      ...(bypassCache ? { refresh: true } : {}),
    },
  }
}

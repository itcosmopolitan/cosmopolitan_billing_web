export const formatCurrency = (value, options = {}) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '₹0'
  return `₹${Number(value).toLocaleString('en-IN', {
    maximumFractionDigits: options.decimals ?? 0,
    minimumFractionDigits: options.decimals ?? 0,
  })}`
}

export const formatCompactCurrency = (value) => {
  const n = Number(value || 0)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(1)}Cr`
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)}L`
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}K`
  return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

export const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN')

export const formatPercent = (value, decimals = 1) =>
  `${Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`

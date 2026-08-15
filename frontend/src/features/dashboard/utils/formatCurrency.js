import { formatAmountNumber, getAmountDecimals } from '@/utils/decimalPrecision'

export const formatCurrency = (value, options = {}) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'MVR 0'
  const decimals = options.decimals ?? getAmountDecimals()
  return `MVR ${formatAmountNumber(value, decimals)}`
}

export const formatCompactCurrency = (value) => {
  const n = Number(value || 0)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
    if (abs >= 1000000000) return `${sign}MVR ${(abs / 1000000000).toFixed(1)}B`
    if (abs >= 1000000) return `${sign}MVR ${(abs / 1000000).toFixed(1)}M`
    if (abs >= 1000) return `${sign}MVR ${(abs / 1000).toFixed(1)}K`
    return `${sign}MVR ${formatAmountNumber(abs)}`
}

export const formatNumber = (value) => Number(value || 0).toLocaleString('en-MV')

export const formatPercent = (value, decimals = 1) =>
  `${Number(value || 0).toLocaleString('en-MV', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`

function roundCurrency(value, decimals) {
  const scale = 10 ** decimals
  const scaled = Math.abs(value) * scale
  const roundedUnits = Math.floor(scaled + (Number.EPSILON * scaled) + 0.5)
  return Math.sign(value) * roundedUnits / scale
}

export function sumCurrencyValues(rows, key, decimals) {
  let sum = 0
  let counted = false
  rows.forEach((row) => {
    const raw = row?.[key]
    if (raw === null || raw === undefined || raw === '') return
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) return
    sum += roundCurrency(value, decimals)
    counted = true
  })
  return counted ? roundCurrency(sum, decimals) : null
}

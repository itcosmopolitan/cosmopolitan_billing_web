export function getPosStockAvailability(item, stockMode = 'branch') {
  const branchStock = Math.max(
    0,
    (Number(item.available_stock) || 0) - (Number(item.reserved_stock) || 0),
  )
  const poolStock = Math.max(
    0,
    Number(item.pool_available_stock
      ?? ((Number(item.pool_stock ?? item.available_stock) || 0)
        - (Number(item.pool_reserved_stock ?? item.reserved_stock) || 0))) || 0,
  )

  return {
    availableStock: stockMode === 'clubbed' ? poolStock : branchStock,
    branchStock,
    poolStock,
  }
}

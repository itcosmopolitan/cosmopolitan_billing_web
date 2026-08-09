import { itemsAPI } from '@/api'

/** Fill missing costPrice (and batch flags) from item master for edit forms. */
export async function enrichSaleLinesWithCosts(items, _branchId) {
  const out = []
  for (const line of items || []) {
    if (!line.item_id) {
      out.push(line)
      continue
    }
    const needsCost = !(Number(line.costPrice) > 0)
    const needsBatch = line.batchTracking == null || line.batchTracking === false
    if (!needsCost && !needsBatch) {
      out.push(line)
      continue
    }
    try {
      const item = await itemsAPI.get(line.item_id)
      out.push({
        ...line,
        costPrice: needsCost
          ? (Number(item?.cost_price ?? item?.costPrice) || 0)
          : line.costPrice,
        batchTracking: line.batchTracking || Boolean(item?.batch_tracking),
        expiryTracking: line.expiryTracking || Boolean(item?.expiry_tracking),
      })
    } catch {
      out.push(line)
    }
  }
  return out
}

/** Fill missing sellingPrice on purchase lines for margin vs catalog sell. */
export async function enrichPurchaseLinesWithSellPrice(items) {
  const out = []
  for (const line of items || []) {
    if (!line.item_id || Number(line.sellingPrice) > 0) {
      out.push(line)
      continue
    }
    try {
      const item = await itemsAPI.get(line.item_id)
      out.push({
        ...line,
        sellingPrice: Number(item?.selling_price ?? item?.sellingPrice) || 0,
      })
    } catch {
      out.push(line)
    }
  }
  return out
}

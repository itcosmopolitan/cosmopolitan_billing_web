import { itemsAPI } from '@/api'

function masterCost(item) {
  return Number(item?.cost_price ?? item?.costPrice) || 0
}

/** Branch-effective cost (same source as InventoryItemPicker / items list). */
function effectiveCostFromBranches(branchData, branchId, fallback) {
  const rows = branchData?.branches || []
  const row = rows.find((b) => b.branch_id === branchId)
  if (!row) return fallback
  const n = Number(row.effective_cost_price ?? row.cost_price)
  return Number.isFinite(n) ? n : fallback
}

/** Fill missing costPrice (and batch flags) for edit forms.
 * Cost uses the branch-effective price when `branchId` is set, matching create. */
export async function enrichSaleLinesWithCosts(items, branchId) {
  const out = []
  for (const line of items || []) {
    if (!line.item_id) {
      out.push(line)
      continue
    }
    const needsCost = !(Number(line.costPrice) > 0)
    try {
      const [item, branchData] = await Promise.all([
        itemsAPI.get(line.item_id),
        needsCost && branchId
          ? itemsAPI.getBranches(line.item_id).catch(() => null)
          : Promise.resolve(null),
      ])
      const fallback = masterCost(item)
      out.push({
        ...line,
        // Catalog identity is the item ID. Refresh the label so documents
        // created from an older quote/order survive Item Master renames.
        name: item?.name || line.name,
        costPrice: needsCost
          ? (branchId ? effectiveCostFromBranches(branchData, branchId, fallback) : fallback)
          : line.costPrice,
        masterTaxRate: Number(item?.tax_rate ?? item?.taxRate) || 0,
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

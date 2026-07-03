export const EMPTY_ITEM = {
  name: '', sku: '', barcode: '', categoryId: '', brand: '',
  unit: 'Pcs', cost_price: '', selling_price: '', tax_rate: '8',
  hsn_code: '', reorder_level: '10', active: true,
  batch_tracking: false, expiry_tracking: false, emoji: '📦',
}

let rowSeq = 0

export const retailBranches = (branches) =>
  (branches || []).filter((b) => b.code !== 'WH')

/** One editable branch row on create / edit pages. */
export const createBranchRow = (branch = null, overrides = {}) => {
  rowSeq += 1
  return {
    _rowId: `br-row-${rowSeq}-${Date.now()}`,
    branch_id: branch?.id || '',
    branch_name: branch?.name || '',
    is_available: true,
    cost_price: '',
    selling_price: '',
    opening_stock: '',
    reorder_level: '',
    available_stock: 0,
    ...overrides,
  }
}

/** Map GET /items/{id}/branches row → form row (edit, listed only). */
export const branchRowFromApi = (br) => createBranchRow(
  { id: br.branch_id, name: br.branch_name },
  {
    is_available: true,
    cost_price: br.cost_price ?? '',
    selling_price: br.selling_price ?? '',
    opening_stock: '',
    reorder_level: br.reorder_level ?? '',
    available_stock: br.available_stock ?? 0,
  },
)

export function formFromItem(item) {
  return {
    name: item.name || '',
    sku: item.sku || '',
    barcode: item.barcode || '',
    categoryId: item.categoryId || '',
    brand: item.brand || '',
    unit: item.unit || 'Pcs',
    cost_price: item.default_cost_price ?? item.cost_price ?? '',
    selling_price: item.default_selling_price ?? item.selling_price ?? '',
    tax_rate: item.tax_rate ?? '8',
    hsn_code: item.hsn_code || '',
    reorder_level: item.default_reorder_level ?? item.reorder_level ?? '10',
    emoji: item.emoji || '📦',
    batch_tracking: Boolean(item.batch_tracking),
    expiry_tracking: Boolean(item.expiry_tracking),
    active: item.active !== false,
  }
}

export function validateItemForm(form, branchConfigs) {
  if (!form.name) return { ok: false, error: 'Item name is required' }
  if (!form.selling_price) return { ok: false, error: 'Selling price is required' }

  const listed = branchConfigs.filter((bc) => bc.branch_id)
  if (listed.length === 0) {
    return { ok: false, error: 'Add at least one branch where this item is sold' }
  }

  if (branchConfigs.some((bc) => !bc.branch_id)) {
    return { ok: false, error: 'Select a branch for each row, or remove empty rows' }
  }

  const ids = listed.map((bc) => bc.branch_id)
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: 'Each branch can only be added once' }
  }

  return { ok: true }
}

function branchConfigFields(bc, { includeOpeningStock = false } = {}) {
  const out = {
    branch_id: bc.branch_id,
    is_available: true,
    cost_price: bc.cost_price === '' || bc.cost_price == null ? null : Number(bc.cost_price),
    selling_price: bc.selling_price === '' || bc.selling_price == null ? null : Number(bc.selling_price),
    reorder_level: bc.reorder_level === '' || bc.reorder_level == null ? null : Number(bc.reorder_level),
  }
  if (includeOpeningStock) {
    out.opening_stock = bc.opening_stock === '' || bc.opening_stock == null
      ? 0
      : Number(bc.opening_stock)
  }
  return out
}

export function buildCatalogPayload(form, branchFilter) {
  return {
    name: form.name,
    sku: form.sku,
    barcode: form.barcode,
    category_id: form.categoryId,
    brand: form.brand,
    unit: form.unit,
    cost_price: Number(form.cost_price),
    selling_price: Number(form.selling_price),
    tax_rate: Number(form.tax_rate),
    hsn_code: form.hsn_code,
    reorder_level: Number(form.reorder_level),
    emoji: form.emoji || '📦',
    batch_tracking: form.batch_tracking,
    expiry_tracking: form.expiry_tracking,
    opening_stock: 0,
    branch_id: branchFilter,
  }
}

export function buildCreatePayload(form, branchConfigs, branchFilter) {
  const payload = buildCatalogPayload(form, branchFilter)
  const listed = branchConfigs.filter((bc) => bc.branch_id)
  if (listed.length > 0) {
    payload.branch_configs = listed.map((bc) => branchConfigFields(
      bc,
      { includeOpeningStock: !form.batch_tracking },
    ))
  }
  return payload
}

/** Branch matrix for PUT /items/{id}/branches — includes unlisted branches removed from the grid. */
export function buildBranchUpdatePayload(branchConfigs, previouslyListedIds = []) {
  const previouslyListed = new Set(previouslyListedIds)
  const currentIds = new Set(branchConfigs.filter((bc) => bc.branch_id).map((bc) => bc.branch_id))
  const branches = branchConfigs
    .filter((bc) => bc.branch_id)
    .map((bc) => branchConfigFields(
      bc,
      { includeOpeningStock: !previouslyListed.has(bc.branch_id) },
    ))

  for (const id of previouslyListedIds) {
    if (!currentIds.has(id)) {
      branches.push({
        branch_id: id,
        is_available: false,
        cost_price: null,
        selling_price: null,
        reorder_level: null,
      })
    }
  }

  return { branches }
}

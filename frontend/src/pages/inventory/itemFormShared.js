import { catalogInclusiveAmount } from '@/utils/taxCalc'

/** Normalize GST rate for form/dropdown ids (``8`` not ``8.0``). */
export function normalizeTaxRateValue(rate, fallback = '8') {
  if (rate === null || rate === undefined || rate === '') return fallback
  const n = Number(rate)
  if (!Number.isFinite(n)) return String(rate)
  return Number.isInteger(n) ? String(n) : String(n)
}

export const EMPTY_ITEM = {
  name: '', sku: '', barcode: '', country_of_origin: '', categoryId: '', categoryName: '', brand: '',
  unit: '', cost_price: '', selling_price: '',
  categoryPricingMode: 'pct',
  wholesale_discount_pct: '', wholesale_price: '',
  staff_discount_pct: '', staff_price: '',
  tax_rate: '8',
  priceTaxMode: 'inclusive',
  hsn_code: '', reorder_level: '10', active: true,
  is_packaging: false, packaging_quantity: '',
  batch_tracking: false, expiry_tracking: false, emoji: '📦',
}

let rowSeq = 0

export const retailBranches = (branches) =>
  (branches || []).filter((b) => b.code !== 'WH')

/** GP% from inclusive cost/sell; null when not computable. */
export function profitPercentage(cost, price) {
  const c = Number(cost)
  const p = Number(price)
  if (!Number.isFinite(c) || !Number.isFinite(p) || c === 0) return null
  return ((p - c) / c) * 100
}

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
    // Empty mode → inherit catalog wholesale/staff.
    wholesale_pricing_mode: '',
    wholesale_discount_pct: '',
    wholesale_price: '',
    staff_pricing_mode: '',
    staff_discount_pct: '',
    staff_price: '',
    categoryPricingMode: 'pct',
    ...overrides,
  }
}

/** Map GET /items/{id}/branches row → form row (edit, listed only). */
export const branchRowFromApi = (br) => {
  const wholesaleMode = br.wholesale_pricing_mode || ''
  const staffMode = br.staff_pricing_mode || ''
  const categoryMode =
    wholesaleMode === 'price' || staffMode === 'price'
      ? 'price'
      : 'pct'
  return createBranchRow(
    { id: br.branch_id, name: br.branch_name },
    {
      is_available: true,
      cost_price: br.cost_price ?? '',
      selling_price: br.selling_price ?? '',
      opening_stock: '',
      reorder_level: br.reorder_level ?? '',
      available_stock: br.available_stock ?? 0,
      wholesale_pricing_mode: wholesaleMode,
      wholesale_discount_pct: br.wholesale_discount_pct ?? '',
      wholesale_price: br.wholesale_price ?? '',
      staff_pricing_mode: staffMode,
      staff_discount_pct: br.staff_discount_pct ?? '',
      staff_price: br.staff_price ?? '',
      categoryPricingMode: categoryMode,
    },
  )
}

export function formFromItem(item) {
  return {
    name: item.name || '',
    sku: item.sku || '',
    barcode: item.barcode || '',
    country_of_origin: item.country_of_origin || '',
    categoryId: item.categoryId || '',
    categoryName: item.categoryName || item.category?.name || '',
    brand: item.brand || '',
    unit: item.unit || '',
    cost_price: item.default_cost_price ?? item.cost_price ?? '',
    selling_price: item.default_selling_price ?? item.selling_price ?? '',
    categoryPricingMode:
      item.wholesale_pricing_mode === 'price' || item.staff_pricing_mode === 'price'
        ? 'price'
        : 'pct',
    wholesale_discount_pct: item.wholesale_discount_pct ?? '',
    wholesale_price: item.wholesale_price ?? '',
    staff_discount_pct: item.staff_discount_pct ?? '',
    staff_price: item.staff_price ?? '',
    tax_rate: normalizeTaxRateValue(item.tax_rate),
    priceTaxMode: 'inclusive',
    hsn_code: item.hsn_code || '',
    reorder_level: item.default_reorder_level ?? item.reorder_level ?? '10',
    is_packaging: Boolean(item.is_packaging),
    packaging_quantity: item.packaging_quantity ?? '',
    emoji: item.emoji || '📦',
    batch_tracking: Boolean(item.batch_tracking),
    expiry_tracking: Boolean(item.expiry_tracking),
    active: item.active !== false,
  }
}

export function validateItemForm(form, branchConfigs) {
  if (!form.name) return { ok: false, error: 'Item name is required' }
  if (!form.categoryId) return { ok: false, error: 'Category is required' }
  if (!form.unit) return { ok: false, error: 'Unit is required' }
  if (!form.cost_price && form.cost_price !== 0) return { ok: false, error: 'Default cost price is required' }
  if (form.is_packaging && (!form.packaging_quantity && form.packaging_quantity !== 0)) {
    return { ok: false, error: 'Quantity per pack/set is required when packaging is enabled' }
  }
  if (!form.selling_price) return { ok: false, error: 'Selling price is required' }
  const categoryMode = form.categoryPricingMode === 'price' ? 'price' : 'pct'
  const wholesaleDisc = Number(form.wholesale_discount_pct || 0)
  const staffDisc = Number(form.staff_discount_pct || 0)
  const wholesalePrice = Number(form.wholesale_price || 0)
  const staffPrice = Number(form.staff_price || 0)
  if (categoryMode === 'pct' && (wholesaleDisc < 0 || wholesaleDisc > 100)) {
    return { ok: false, error: 'Wholesale discount must be between 0 and 100%' }
  }
  if (categoryMode === 'pct' && (staffDisc < 0 || staffDisc > 100)) {
    return { ok: false, error: 'Staff discount must be between 0 and 100%' }
  }
  if (categoryMode === 'price' && wholesalePrice < 0) {
    return { ok: false, error: 'Wholesale price cannot be negative' }
  }
  if (categoryMode === 'price' && staffPrice < 0) {
    return { ok: false, error: 'Staff price cannot be negative' }
  }

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

  for (const bc of listed) {
    if (bc.wholesale_pricing_mode) {
      const mode = bc.wholesale_pricing_mode === 'price' ? 'price' : 'pct'
      if (mode === 'pct') {
        const d = Number(bc.wholesale_discount_pct || 0)
        if (d < 0 || d > 100) return { ok: false, error: 'Branch wholesale discount must be between 0 and 100%' }
      } else if (Number(bc.wholesale_price || 0) < 0) {
        return { ok: false, error: 'Branch wholesale price cannot be negative' }
      }
    }
    if (bc.staff_pricing_mode) {
      const mode = bc.staff_pricing_mode === 'price' ? 'price' : 'pct'
      if (mode === 'pct') {
        const d = Number(bc.staff_discount_pct || 0)
        if (d < 0 || d > 100) return { ok: false, error: 'Branch staff discount must be between 0 and 100%' }
      } else if (Number(bc.staff_price || 0) < 0) {
        return { ok: false, error: 'Branch staff price cannot be negative' }
      }
    }
  }

  return { ok: true }
}

function branchCategoryPayload(bc, { taxRate, priceTaxMode } = {}) {
  const wholesaleMode = bc.wholesale_pricing_mode
  const staffMode = bc.staff_pricing_mode
  const out = {
    wholesale_pricing_mode: null,
    wholesale_discount_pct: null,
    wholesale_price: null,
    staff_pricing_mode: null,
    staff_discount_pct: null,
    staff_price: null,
  }
  if (wholesaleMode === 'pct' || wholesaleMode === 'price') {
    out.wholesale_pricing_mode = wholesaleMode
    if (wholesaleMode === 'price') {
      out.wholesale_price = catalogInclusiveAmount(bc.wholesale_price || 0, priceTaxMode, taxRate)
      out.wholesale_discount_pct = 0
    } else {
      out.wholesale_discount_pct = Number(bc.wholesale_discount_pct || 0)
      out.wholesale_price = 0
    }
  }
  if (staffMode === 'pct' || staffMode === 'price') {
    out.staff_pricing_mode = staffMode
    if (staffMode === 'price') {
      out.staff_price = catalogInclusiveAmount(bc.staff_price || 0, priceTaxMode, taxRate)
      out.staff_discount_pct = 0
    } else {
      out.staff_discount_pct = Number(bc.staff_discount_pct || 0)
      out.staff_price = 0
    }
  }
  return out
}

function branchConfigFields(bc, { includeOpeningStock = false, taxRate, priceTaxMode } = {}) {
  const out = {
    branch_id: bc.branch_id,
    is_available: true,
    cost_price: catalogInclusiveAmount(bc.cost_price, priceTaxMode, taxRate),
    selling_price: catalogInclusiveAmount(bc.selling_price, priceTaxMode, taxRate),
    reorder_level: bc.reorder_level === '' || bc.reorder_level == null ? null : Number(bc.reorder_level),
    ...branchCategoryPayload(bc, { taxRate, priceTaxMode }),
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
    country_of_origin: form.country_of_origin,
    category_id: form.categoryId,
    brand: form.brand,
    unit: form.unit,
    cost_price: catalogInclusiveAmount(form.cost_price, form.priceTaxMode, form.tax_rate),
    selling_price: catalogInclusiveAmount(form.selling_price, form.priceTaxMode, form.tax_rate),
    wholesale_pricing_mode: form.categoryPricingMode === 'price' ? 'price' : 'pct',
    wholesale_discount_pct: form.categoryPricingMode === 'price' ? 0 : Number(form.wholesale_discount_pct || 0),
    wholesale_price: form.categoryPricingMode === 'price'
      ? catalogInclusiveAmount(form.wholesale_price || 0, form.priceTaxMode, form.tax_rate)
      : 0,
    staff_pricing_mode: form.categoryPricingMode === 'price' ? 'price' : 'pct',
    staff_discount_pct: form.categoryPricingMode === 'price' ? 0 : Number(form.staff_discount_pct || 0),
    staff_price: form.categoryPricingMode === 'price'
      ? catalogInclusiveAmount(form.staff_price || 0, form.priceTaxMode, form.tax_rate)
      : 0,
    tax_rate: Number(form.tax_rate),
    hsn_code: form.hsn_code,
    reorder_level: Number(form.reorder_level),
    is_packaging: Boolean(form.is_packaging),
    packaging_quantity: form.is_packaging ? Number(form.packaging_quantity) : null,
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
      {
        includeOpeningStock: !form.batch_tracking,
        taxRate: form.tax_rate,
        priceTaxMode: form.priceTaxMode,
      },
    ))
  }
  return payload
}

/** Branch matrix for PUT /items/{id}/branches — includes unlisted branches removed from the grid. */
export function buildBranchUpdatePayload(branchConfigs, previouslyListedIds = [], form = {}) {
  const previouslyListed = new Set(previouslyListedIds)
  const currentIds = new Set(branchConfigs.filter((bc) => bc.branch_id).map((bc) => bc.branch_id))
  const taxOpts = {
    taxRate: form.tax_rate,
    priceTaxMode: form.priceTaxMode,
  }
  const branches = branchConfigs
    .filter((bc) => bc.branch_id)
    .map((bc) => branchConfigFields(
      bc,
      {
        includeOpeningStock: !previouslyListed.has(bc.branch_id),
        ...taxOpts,
      },
    ))

  for (const id of previouslyListedIds) {
    if (!currentIds.has(id)) {
      branches.push({
        branch_id: id,
        is_available: false,
        cost_price: null,
        selling_price: null,
        reorder_level: null,
        wholesale_pricing_mode: null,
        wholesale_discount_pct: null,
        wholesale_price: null,
        staff_pricing_mode: null,
        staff_discount_pct: null,
        staff_price: null,
      })
    }
  }

  return { branches }
}

/** Format wholesale/staff for summary chips. */
export function formatCategoryPriceLabel(mode, pct, price, fmtFn) {
  if (mode === 'price') {
    const n = Number(price)
    return Number.isFinite(n) && n > 0 ? fmtFn(n) : '—'
  }
  const d = Number(pct)
  if (!Number.isFinite(d) || d === 0) return '0% off'
  return `${d}% off`
}

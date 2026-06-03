import { validateBatchDates } from '@/utils/batchDates'

export const EMPTY_ITEM = {
  name: '', sku: '', barcode: '', categoryId: '', brand: '',
  unit: 'Pcs', cost_price: '', selling_price: '', tax_rate: '8',
  hsn_code: '', reorder_level: '10', opening_stock: '0', active: true,
  batch_tracking: false, expiry_tracking: false, emoji: '📦',
  opening_batch_number: '', opening_mfg_date: '', opening_expiry_date: '',
}

let rowSeq = 0

export const retailBranches = (branches) =>
  (branches || []).filter((b) => b.code !== 'WH')

/** One editable branch row on the New Item page. */
export const createBranchRow = (branch = null) => {
  rowSeq += 1
  return {
    _rowId: `br-row-${rowSeq}-${Date.now()}`,
    branch_id: branch?.id || '',
    branch_name: branch?.name || '',
    is_available: true,
    cost_price: '',
    selling_price: '',
    opening_stock: '',
    opening_batch_number: '',
    opening_mfg_date: '',
    opening_expiry_date: '',
  }
}

export function validateNewItem(form, branchConfigs) {
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

  for (const bc of listed) {
    const qty = Number(bc.opening_stock) || 0
    if (qty > 0 && form.batch_tracking) {
      const { ok, errors } = validateBatchDates(
        { mfgDate: bc.opening_mfg_date, expiryDate: bc.opening_expiry_date },
        { requireExpiry: Boolean(form.expiry_tracking) },
      )
      if (!ok) return { ok: false, error: `${bc.branch_name}: ${errors[0]}` }
    }
  }

  return { ok: true }
}

export function buildCreatePayload(form, branchConfigs, branchFilter) {
  const payload = {
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

  const listed = branchConfigs.filter((bc) => bc.branch_id)
  if (listed.length > 0) {
    payload.branch_configs = listed.map((bc) => ({
      branch_id: bc.branch_id,
      is_available: true,
      cost_price: bc.cost_price === '' || bc.cost_price == null
        ? null
        : Number(bc.cost_price),
      selling_price: bc.selling_price === '' || bc.selling_price == null
        ? null
        : Number(bc.selling_price),
      opening_stock: Number(bc.opening_stock) || 0,
      opening_batch_number: bc.opening_batch_number || undefined,
      opening_mfg_date: bc.opening_mfg_date || undefined,
      opening_expiry_date: bc.opening_expiry_date || undefined,
    }))
  }

  return payload
}

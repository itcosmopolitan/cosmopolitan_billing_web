import {
  allocationSum,
  isAllocationValid,
  toApiPayload,
} from '@/utils/batchAllocation'
import {
  formatAmountInput,
  formatQtyInput,
  roundAmount,
  roundQty,
} from '@/utils/decimalPrecision'

export const EMPTY_LINE = {
  item_id: '',
  qty: '',
  cost_price: '',
  batchAllocation: [],
  batchAllocationCustom: false,
}

export function emptyTransfer(defaultFromId = '', defaultToId = '') {
  return {
    from_branch_id: defaultFromId || '',
    to_branch_id: defaultToId || '',
    child_counter_id: '',
    child_counter_name: '',
    priority: 'Normal',
    expected_date: '',
    notes: '',
    items: [{ ...EMPTY_LINE }],
  }
}

/** Map GET /transfers/{id} → form state (batch splits hydrated separately). */
export function formFromTransfer(transfer) {
  const lines = transfer.items?.length
    ? transfer.items
    : [{ item_id: '', qty: 0, requested_allocation: [] }]
  return {
    from_branch_id: transfer.from_branch_id,
    to_branch_id: transfer.to_branch_id,
    child_counter_id: transfer.child_counter_id || '',
    child_counter_name: transfer.child_counter_name || '',
    priority: transfer.priority || 'Normal',
    expected_date: transfer.expected_date || transfer.request_date || '',
    notes: transfer.notes || '',
    items: lines.map((line) => ({
      item_id: line.item_id || '',
      qty: line.qty != null ? formatQtyInput(line.qty) : '',
      cost_price: line.cost_price != null ? formatAmountInput(line.cost_price) : '',
      batchAllocation: [],
      batchAllocationCustom: Boolean(line.requested_allocation?.length),
      _requestedAllocation: line.requested_allocation || [],
    })),
  }
}

export function validateTransferForm(form, items, batchOptions) {
  if (!form.from_branch_id || !form.to_branch_id) {
    return { ok: false, error: 'Select source and destination branches' }
  }
  if (form.from_branch_id === form.to_branch_id) {
    return { ok: false, error: 'From and To branches must differ' }
  }
  const filled = form.items.filter((row) => row.item_id)
  if (filled.length === 0) {
    return { ok: false, error: 'Add at least one item' }
  }
  for (const row of filled) {
    const qty = Number(row.qty)
    if (!qty || qty <= 0) {
      const picked = items.find((x) => x.id === row.item_id)
      return { ok: false, error: `Enter a valid quantity for ${picked?.name || 'item'}` }
    }
    const costPrice = Number(row.cost_price)
    if (row.cost_price === '' || !Number.isFinite(costPrice) || costPrice < 0) {
      const picked = items.find((x) => x.id === row.item_id)
      return { ok: false, error: `Enter a valid cost price for ${picked?.name || 'item'}` }
    }
    const picked = items.find((x) => x.id === row.item_id)
    if (!picked?.batch_tracking) continue
    if (!isAllocationValid(row.batchAllocation || [], qty)) {
      return {
        ok: false,
        error: `Fix batch split for ${picked.name} — ${allocationSum(row.batchAllocation || [])}/${qty} allocated`,
      }
    }
    const key = `${row.item_id}|${form.from_branch_id}`
    const known = new Set((batchOptions[key] || []).map((b) => b.id))
    if (known.size === 0) {
      return { ok: false, error: `Loading batches for ${picked.name}, please retry in a moment` }
    }
    for (const entry of row.batchAllocation || []) {
      if (!known.has(entry.id)) {
        return { ok: false, error: `Stale batch in ${picked.name} — re-select the item to refresh` }
      }
    }
  }
  return { ok: true }
}

export function buildTransferPayload(form, items, { requestedBy, refNumber } = {}) {
  const payload = {
    from_branch_id: form.from_branch_id,
    to_branch_id: form.to_branch_id,
    child_counter_id: form.child_counter_id || null,
    child_counter_name: form.child_counter_name || null,
    priority: form.priority || 'Normal',
    notes: form.notes || undefined,
    expected_date: form.expected_date || undefined,
    items: form.items.filter((i) => i.item_id).map((row) => {
      const itm = items.find((x) => x.id === row.item_id)
      return {
        item_id: row.item_id,
        item_name: itm?.name || 'Unknown',
        qty: roundQty(Number(row.qty) || 0),
        cost_price: roundAmount(Number(row.cost_price ?? itm?.cost_price ?? itm?.default_cost_price ?? 0)),
        batch_allocation: toApiPayload(row.batchAllocation),
      }
    }),
  }
  if (requestedBy) payload.requested_by = requestedBy
  if (refNumber) payload.ref_number = refNumber
  return payload
}

import {
  allocationSum,
  isAllocationValid,
  toApiPayload,
} from '@/utils/batchAllocation'

export const EMPTY_LINE = {
  item_id: '',
  qty: '',
  batchAllocation: [],
  batchAllocationCustom: false,
}

export function emptyTransfer(defaultFromId = 'br-001', defaultToId = 'br-002') {
  return {
    from_branch_id: defaultFromId,
    to_branch_id: defaultToId,
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
    priority: transfer.priority || 'Normal',
    expected_date: transfer.expected_date || transfer.request_date || '',
    notes: transfer.notes || '',
    items: lines.map((line) => ({
      item_id: line.item_id || '',
      qty: line.qty != null ? String(line.qty) : '',
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
    priority: form.priority || 'Normal',
    notes: form.notes || undefined,
    expected_date: form.expected_date || undefined,
    items: form.items.filter((i) => i.item_id).map((row) => {
      const itm = items.find((x) => x.id === row.item_id)
      return {
        item_id: row.item_id,
        item_name: itm?.name || 'Unknown',
        qty: Number(row.qty),
        batch_allocation: toApiPayload(row.batchAllocation),
      }
    }),
  }
  if (requestedBy) payload.requested_by = requestedBy
  if (refNumber) payload.ref_number = refNumber
  return payload
}

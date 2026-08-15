/**
 * Per-line batch allocation helpers shared by the POS cart, transfer create
 * modal and the (read-only) inline summary widgets.
 *
 * Shape of an allocation entry:
 *   { id: <batchId>, batchNumber: string, qty: number, expiryDate: string|null }
 *
 * The API contract is `[{ batch_id, qty }]` (snake_case) — `toApiPayload`
 * converts the rich entries to that shape, and `fromApiPayload` converts the
 * other way for hydration (e.g. when resuming a held bill).
 */

import { formatQtyNumber } from '@/utils/decimalPrecision'

/**
 * Greedy FIFO/FEFO fill across `batches` (already sorted by the API in the
 * desired order — backend returns FEFO-first, which collapses to oldest-
 * received first for non-expiry items so this works for both strategies).
 *
 * Returns at most `batches.length` entries; if `qty` exceeds total batch
 * stock, the last batch is filled to its remaining qty and the shortfall is
 * silently dropped — the caller's UI is expected to surface that elsewhere
 * (e.g. the existing "Stock exceeded ⚠️" hint on the cart row).
 */
/** Batches eligible for sale / transfer allocation (active lots with stock). */
export function allocatableBatches(batches) {
  if (!Array.isArray(batches)) return []
  return batches.filter(
    (b) => b && b.active !== false && Math.max(0, Number(b.quantity) || 0) > 0,
  )
}

export function computeAutoAllocation(batches, qty) {
  const need = Math.max(0, Number(qty) || 0)
  const eligible = allocatableBatches(batches)
  if (need <= 0 || eligible.length === 0) return []
  const out = []
  let remaining = need
  for (const b of eligible) {
    if (remaining <= 0) break
    const avail = Math.max(0, Number(b.quantity) || 0)
    if (avail <= 0) continue
    const take = Math.min(avail, remaining)
    out.push({
      id: b.id,
      batchNumber: b.batchNumber || b.batch_number || b.id.slice(-6),
      qty: take,
      expiryDate: b.expiryDate || b.expiry_date || null,
      mfgDate: b.mfgDate || b.mfg_date || null,
      receivedDate: b.receivedDate || b.received_date || null,
    })
    remaining -= take
  }
  return out
}

/**
 * Sum the allocated qty. Cheap helper used in many places — kept here so the
 * cart components don't reach for `reduce` inline.
 */
export function allocationSum(allocation) {
  if (!Array.isArray(allocation)) return 0
  return allocation.reduce((s, e) => s + (Number(e.qty) || 0), 0)
}

/**
 * True when the allocation is non-empty and exactly matches the target qty.
 * Anything else (over, under, empty when qty > 0) is invalid — callers use
 * this to disable Save buttons and show inline warnings.
 */
export function isAllocationValid(allocation, qty) {
  const need = Math.max(0, Number(qty) || 0)
  if (need <= 0) return Array.isArray(allocation) && allocation.length === 0
  return allocationSum(allocation) === need
}

/**
 * Convert the rich client-side allocation to the snake_case payload the API
 * expects. Drops zero-qty entries so the backend never sees noise.
 */
export function toApiPayload(allocation) {
  if (!Array.isArray(allocation)) return undefined
  const cleaned = allocation
    .filter((e) => e && e.id && Number(e.qty) > 0)
    .map((e) => ({ batch_id: e.id, qty: Number(e.qty) }))
  return cleaned.length ? cleaned : undefined
}

/**
 * Inverse of `toApiPayload`. Hydrates a held bill where the persisted form
 * only has `{batch_id, qty}` pairs, by looking each entry up in the current
 * batches list to recover batchNumber + expiry.
 */
export function fromApiPayload(payload, batches) {
  if (!Array.isArray(payload)) return []
  const byId = new Map((batches || []).map((b) => [b.id, b]))
  return payload
    .filter((e) => e && e.batch_id && Number(e.qty) > 0)
    .map((e) => {
      const b = byId.get(e.batch_id)
      return {
        id: e.batch_id,
        batchNumber: b?.batchNumber || b?.batch_number || e.batch_id.slice(-6),
        qty: Number(e.qty),
        expiryDate: b?.expiryDate || b?.expiry_date || null,
        mfgDate: b?.mfgDate || b?.mfg_date || null,
        receivedDate: b?.receivedDate || b?.received_date || null,
      }
    })
}

/**
 * Short label like "GR-A (10) + GR-B (3)" for the cart's inline summary. We
 * cap at three batch names then collapse the rest into "+N more" — that
 * keeps the cart line tight even when a sale spans many lots.
 */
export function formatAllocationSummary(allocation, max = 3) {
  if (!Array.isArray(allocation) || allocation.length === 0) return ''
  const head = allocation.slice(0, max).map((e) => `${e.batchNumber} (${formatQtyNumber(e.qty)})`)
  const tail = allocation.length - max
  return tail > 0 ? `${head.join(' + ')} +${tail} more` : head.join(' + ')
}

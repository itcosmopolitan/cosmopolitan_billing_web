import { useEffect, useRef, useState } from 'react'
import { itemsAPI } from '@/api'
import {
  allocatableBatches,
  computeAutoAllocation,
  allocationSum,
  isAllocationValid,
  formatAllocationSummary,
} from '@/utils/batchAllocation'

/**
 * Inline batch split widget for sales invoice lines (consumption).
 * Mirrors POS CartRow + TransferFormFields — auto FIFO/FEFO until the
 * operator clicks "Edit split".
 */
export default function LineBatchAllocationField({
  itemId,
  branchId,
  qty,
  batchTracking,
  expiryTracking,
  allocation = [],
  allocationCustom = false,
  onChange,
  onEdit,
  disabled = false,
}) {
  const tracked = Boolean(batchTracking)
  const expiryTracked = Boolean(expiryTracking)
  const strategy = expiryTracked ? 'FEFO' : 'FIFO'
  const need = Math.max(0, Number(qty) || 0)

  const [batches, setBatches] = useState([])
  const [loading, setLoading] = useState(false)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const allocationRef = useRef(allocation)
  allocationRef.current = allocation

  useEffect(() => {
    if (!tracked || !itemId || !branchId) {
      setBatches([])
      return
    }
    let cancelled = false
    setLoading(true)
    itemsAPI.batches.list(itemId, { branch_id: branchId, include_empty: false })
      .then((data) => {
        if (cancelled) return
        setBatches(allocatableBatches(data?.items || []))
      })
      .catch(() => { if (!cancelled) setBatches([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [itemId, branchId, tracked])

  useEffect(() => {
    if (!tracked || allocationCustom || batches.length === 0 || need <= 0) return
    const auto = computeAutoAllocation(batches, need)
    const same = JSON.stringify(auto) === JSON.stringify(allocationRef.current || [])
    if (!same) onChangeRef.current?.(auto, false)
  }, [batches, need, allocationCustom, tracked])

  if (!tracked || !itemId) {
    return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
  }

  const valid = isAllocationValid(allocation, need)
  const allocated = allocationSum(allocation)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '1px 6px',
          borderRadius: 3,
          background: expiryTracked ? 'rgba(245,158,11,0.15)' : 'var(--accent-bg)',
          color: expiryTracked ? 'var(--amber)' : 'var(--accent)',
        }}>
          {strategy}
        </span>
        {allocationCustom && (
          <span style={{
            fontSize: 9.5,
            padding: '1px 5px',
            borderRadius: 3,
            background: 'var(--bg-raised)',
            color: 'var(--text-secondary)',
          }}>
            CUSTOM
          </span>
        )}
      </div>
      {loading ? (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading lots…</span>
      ) : batches.length === 0 ? (
        <span style={{ fontSize: 11, color: 'var(--amber)' }}>No batches in stock</span>
      ) : need <= 0 ? (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Enter qty…</span>
      ) : allocation.length === 0 ? (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Allocating…</span>
      ) : (
        <span style={{
          fontSize: 11,
          fontFamily: 'DM Mono, monospace',
          color: valid ? 'var(--text-secondary)' : 'var(--red)',
        }}>
          {formatAllocationSummary(allocation)}
        </span>
      )}
      {!valid && allocation.length > 0 && need > 0 && (
        <span style={{ fontSize: 10.5, color: 'var(--red)' }}>
          {allocated} / {need} allocated
        </span>
      )}
      {batches.length > 0 && need > 0 && !disabled && (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => onEdit?.({ batches, expiryTracked })}
        >
          ✎ Edit split
        </button>
      )}
    </div>
  )
}

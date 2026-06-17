import { useEffect, useRef, useState } from 'react'
import { fmt } from '@/utils/helpers'
import { itemsAPI } from '@/api'
import {
  allocatableBatches,
  computeAutoAllocation,
  isAllocationValid,
  allocationSum,
} from '@/utils/batchAllocation'
import { batchExpiryStatus } from '@/utils/batchExpiry'

const lineMarginPct = (unitPrice, costPrice) => {
  const p = Number(unitPrice)
  const c = Number(costPrice)
  if (!p || p <= 0) return null
  return ((p - c) / p) * 100
}

/**
 * One row of the POS cart table. Extracted from POSPage to keep that file
 * navigable; the page is still the owner of all state and just hands per-row
 * callbacks down here.
 *
 * For batch-tracked items the row owns the lazy fetch of the active batch
 * list for (item, branch), auto-derives the per-line allocation when not
 * locked by the operator (`batchAllocationCustom: false`), and renders the
 * resulting split as inline metadata below HSN/Stock. A single ✎ button
 * delegates editing back to the parent (POSPage opens the shared
 * BatchAllocationModal).
 */
export default function CartRow({
  item,
  branchId,
  onQtyChange,
  onRemove,
  onDiscChange,
  onDiscTypeChange,
  onAllocationChange,
  onEditAllocation,
  onBatchesLoaded,
  disableDiscount,
}) {
  const marginPct = lineMarginPct(item.price, item.costPrice)
  const marginPositive = marginPct != null && marginPct >= 0
  const hsn = item.hsnCode || '—'
  const hasStock = item.availableStock != null || item.available_stock != null
  const stockQty = hasStock ? Number(item.availableStock ?? item.available_stock) || 0 : null
  const stockExceeded = stockQty != null && item.qty > stockQty
  const discType = item.lineDiscountType === 'flat' ? 'flat' : 'pct'
  const discValue = Number(item.lineDiscountValue ?? item.lineDiscountPct ?? item.lineDiscountFlat ?? 0) || 0

  const tracked = Boolean(item.batchTracking || item.batch_tracking)
  const expiryTracked = Boolean(item.expiryTracking || item.expiry_tracking)
  const [batches, setBatches] = useState([])
  const [loadingBatches, setLoadingBatches] = useState(false)

  // Stash the callbacks in refs so their identity (recreated on every
  // POSPage render as inline arrows) doesn't retrigger the effects below.
  // Without this the fetch effect would re-run every render → fire a new
  // /items/{id}/batches request → setState → POSPage re-renders → fresh
  // callback identity → effect runs again → infinite loop.
  const onBatchesLoadedRef = useRef(onBatchesLoaded)
  const onAllocationChangeRef = useRef(onAllocationChange)
  useEffect(() => { onBatchesLoadedRef.current = onBatchesLoaded }, [onBatchesLoaded])
  useEffect(() => { onAllocationChangeRef.current = onAllocationChange }, [onAllocationChange])

  // Lazy-load the active batches the first time we see a tracked line at
  // this (item, branch). Backend serializes camelCase via _batch_dict —
  // batchNumber, expiryDate, quantity. Default order is FEFO-friendly which
  // collapses to oldest-received-first for non-expiry items.
  useEffect(() => {
    if (!tracked || !item.id || !branchId) return
    let cancelled = false
    setLoadingBatches(true)
    itemsAPI.batches.list(item.id, { branch_id: branchId })
      .then((data) => {
        if (cancelled) return
        const rows = allocatableBatches(data?.items || [])
        setBatches(rows)
        onBatchesLoadedRef.current?.(item.id, rows)
      })
      .catch(() => { if (!cancelled) setBatches([]) })
      .finally(() => { if (!cancelled) setLoadingBatches(false) })
    return () => { cancelled = true }
  }, [item.id, branchId, tracked])

  // Whenever batches finish loading OR qty changes (and the operator hasn't
  // hand-edited via the modal), recompute the auto FIFO/FEFO allocation.
  // We compare against the latest allocation via a ref-style read so it's
  // not a dep — the effect only needs to fire when the *inputs* change.
  const allocationRef = useRef(item.batchAllocation)
  allocationRef.current = item.batchAllocation
  useEffect(() => {
    if (!tracked) return
    if (item.batchAllocationCustom) return
    if (batches.length === 0) return
    const auto = computeAutoAllocation(batches, item.qty)
    const same = JSON.stringify(auto) === JSON.stringify(allocationRef.current || [])
    if (!same) onAllocationChangeRef.current?.(auto, /* custom */ false)
  }, [batches, item.qty, item.batchAllocationCustom, tracked])

  const strategyLabel = expiryTracked ? 'FEFO' : 'FIFO'
  const allocation = Array.isArray(item.batchAllocation) ? item.batchAllocation : []
  const allocValid = isAllocationValid(allocation, item.qty)
  const allocated = allocationSum(allocation)

  return (
    <tr
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', minWidth: 240, verticalAlign: 'top' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 18, lineHeight: 1.3 }}>{item.emoji || '📦'}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35 }}>{item.name}</span>
              {tracked && (
                <span style={{
                  fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                  background: expiryTracked ? 'rgba(245, 158, 11, 0.15)' : 'rgba(99, 102, 241, 0.15)',
                  color: expiryTracked ? 'var(--amber)' : 'var(--accent)',
                  letterSpacing: 0.3,
                }}>
                  {strategyLabel}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>HSN: {hsn}</span>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>Stock: {stockQty ?? '—'}</span>
              {stockExceeded && (
                <span title="Stock exceeded" style={{ color: 'var(--amber)', cursor: 'help', fontSize: 12, lineHeight: 1 }} aria-label="Stock exceeded">⚠️</span>
              )}
            </div>
            {tracked && (
              <div style={{ marginTop: 4 }}>
                {loadingBatches ? (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Batch: loading…</span>
                ) : batches.length === 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--amber)' }}>Batch: none available</span>
                ) : (
                  <BatchSummary
                    allocation={allocation}
                    expiryTracked={expiryTracked}
                    valid={allocValid}
                    allocated={allocated}
                    qtyNeeded={item.qty}
                    custom={!!item.batchAllocationCustom}
                    onEdit={() => onEditAllocation && onEditAllocation({ item, batches, allocation })}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
        <input
          className="form-input"
          type="number"
          min={1}
          step={1}
          value={item.qty}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            if (Number.isFinite(v)) onQtyChange(v)
          }}
          style={{ width: 56, padding: '4px 6px', fontSize: 12, textAlign: 'center', fontFamily: 'DM Mono, monospace' }}
        />
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 600, verticalAlign: 'top' }}>
        {fmt(item.price)}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
        {marginPct == null ? (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, color: marginPositive ? 'var(--green)' : 'var(--red)', fontSize: 12 }}>
            <span aria-hidden>{marginPositive ? '↑' : '↓'}</span>
            <span style={{ fontFamily: 'DM Mono, monospace' }}>{marginPct.toFixed(1)}%</span>
          </span>
        )}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: disableDiscount ? 0.6 : 1 }}>
          <input
            className="form-input"
            type="number"
            min={0}
            max={discType === 'pct' ? 100 : undefined}
            step={discType === 'pct' ? 0.5 : 1}
            value={discValue || ''}
            onChange={(e) => onDiscChange(Number(e.target.value) || 0)}
            disabled={disableDiscount}
            style={{ width: 86, padding: '4px 7px', fontSize: 12 }}
          />
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 7, overflow: 'hidden' }}>
            <button type="button" onClick={() => onDiscTypeChange('pct')} disabled={disableDiscount}
              style={{ border: 'none', borderRight: '1px solid var(--border-default)', background: discType === 'pct' ? 'var(--accent-bg)' : 'transparent', color: discType === 'pct' ? 'var(--accent)' : 'var(--text-muted)', cursor: disableDiscount ? 'not-allowed' : 'pointer', fontSize: 11, padding: '4px 7px', fontWeight: 600 }}>%</button>
            <button type="button" onClick={() => onDiscTypeChange('flat')} disabled={disableDiscount}
              style={{ border: 'none', background: discType === 'flat' ? 'var(--accent-bg)' : 'transparent', color: discType === 'flat' ? 'var(--accent)' : 'var(--text-muted)', cursor: disableDiscount ? 'not-allowed' : 'pointer', fontSize: 11, padding: '4px 7px', fontWeight: 600 }}>Rf</button>
          </div>
        </div>
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', verticalAlign: 'top' }}>
        {fmt(item.lineTotal)}
      </td>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'center', verticalAlign: 'top' }}>
        <button type="button" onClick={onRemove} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }} aria-label="Remove line">✕</button>
      </td>
    </tr>
  )
}

/**
 * Inline batch breakdown that lives below HSN/Stock. Renders every batch the
 * line will draw from (`GR-A (10), GR-B (3)`) as small lot pills, with a
 * single ✎ button that delegates to POSPage to open the allocation modal.
 *
 * Pills are color-coded by expiry urgency when the item is FEFO-tracked so
 * the cashier can spot an expired lot in the split at a glance. A "Custom"
 * tag and a mismatch warning appear when relevant — the latter only when an
 * operator-saved split fell out of sync (qty bumped before they re-edited).
 */
function BatchSummary({ allocation, expiryTracked, valid, allocated, qtyNeeded, custom, onEdit }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
      <span style={{ fontFamily: 'DM Sans, sans-serif' }}>Batch:</span>
      {allocation.length === 0 ? (
        <span style={{ color: 'var(--amber)' }}>nothing allocated</span>
      ) : (
        allocation.map((e) => {
          const expInfo = batchExpiryStatus({
            expiryDate: e.expiryDate,
            mfgDate: e.mfgDate,
            receivedDate: e.receivedDate,
            quantity: e.qty,
          })
          const tone = expInfo.expired ? 'var(--red)' : expInfo.nearExpiry ? 'var(--amber)' : 'var(--accent)'
          const bg = expInfo.expired
            ? 'rgba(245,72,92,0.10)'
            : expInfo.nearExpiry ? 'rgba(245,158,11,0.12)' : 'var(--accent-bg)'
          const title = e.expiryDate
            ? `Take ${e.qty} from ${e.batchNumber} · ${expInfo.title}`
            : `Take ${e.qty} from ${e.batchNumber}`
          return (
            <span
              key={e.id}
              title={title}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '1px 6px', borderRadius: 999, background: bg, color: tone,
                fontFamily: 'DM Mono, monospace', fontSize: 10.5, fontWeight: 500,
              }}
            >
              <span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.batchNumber}
              </span>
              <span style={{ color: tone, fontWeight: 700 }}>({e.qty})</span>
              {expiryTracked && expInfo.showUrgentIcon && (
                <span aria-hidden style={{ fontSize: 10 }} title={expInfo.title}>{expInfo.expired ? '⚠️' : '📅'}</span>
              )}
            </span>
          )
        })
      )}
      {custom && (
        <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--text-secondary)', letterSpacing: 0.4 }}>
          CUSTOM
        </span>
      )}
      {!valid && allocation.length > 0 && (
        <span title={`Allocated ${allocated} of ${qtyNeeded}`} style={{ fontSize: 10.5, color: 'var(--red)' }}>
          ⚠ {allocated} / {qtyNeeded}
        </span>
      )}
      <button
        type="button"
        onClick={onEdit}
        title="Edit batch split"
        aria-label="Edit batch split"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, borderRadius: 4, border: 'none', background: 'transparent',
          color: 'var(--text-muted)', cursor: 'pointer', padding: 0,
          transition: 'background 0.12s, color 0.12s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-bg)'; e.currentTarget.style.color = 'var(--accent)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
          <path d="M10 3l3 3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </div>
  )
}

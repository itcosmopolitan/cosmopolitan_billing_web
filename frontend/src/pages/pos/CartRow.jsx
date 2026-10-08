import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtQty } from '@/utils/helpers'
import { itemsAPI } from '@/api'
import MarginBadge from '@/components/MarginBadge'
import {
  amountInputStep,
  ENTRY_DECIMALS,
  entryInputStep,
  formatAmountFieldValue,
  formatAmountNumber,
  formatQtyFieldValue,
  getAmountDecimals,
  hasExtraAmountPrecision,
  roundAmount,
  roundEntry,
} from '@/utils/decimalPrecision'
import {
  allocatableBatches,
  computeAutoAllocation,
  isAllocationValid,
  allocationSum,
} from '@/utils/batchAllocation'
import { batchExpiryStatus } from '@/utils/batchExpiry'
import { posLineMargin } from '@/utils/marginCalc'
import { getInvoiceItemMetadata } from '@/utils/invoiceItemMetadata'
import {
  displayExclusiveUnitRate,
  storeInclusiveUnitRate,
  lineTaxAmount,
  lineTaxableAmount,
} from '@/utils/taxCalc'

/** Qty/rate keep entry precision in the UI; settings rounding happens on save. */
const entryStep = entryInputStep

/** Move focus to the same column on the previous/next cart line (↑/↓). */
function handleCartFieldArrowNav(e, field, cartIndex) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const delta = e.key === 'ArrowDown' ? 1 : -1
  let next = cartIndex + delta
  while (next >= 0) {
    const el = document.querySelector(
      `[data-pos-cart-field="${field}"][data-pos-cart-index="${next}"]`,
    )
    if (!el) return
    if (el.disabled) {
      next += delta
      continue
    }
    el.focus()
    if (typeof el.select === 'function') {
      try { el.select() } catch { /* text selection not always available */ }
    }
    return
  }
}

/**
 * One row of the POS cart table. Extracted from POSPage to keep that file
 * navigable; the page is still the owner of all state and just hands per-row
 * callbacks down here.
 *
 * For batch-tracked items the row owns the lazy fetch of the active batch
 * list for (item, branch), auto-derives the per-line allocation when not
 * locked by the operator (`batchAllocationCustom: false`), and renders the
 * resulting split on a second meta line under the item name (with HSN /
 * UOM / stock). A single ✎ button delegates editing back to the parent
 * (POSPage opens the shared BatchAllocationModal).
 */
export default function CartRow({
  item,
  cartIndex = 0,
  branchId,
  onQtyChange,
  onPriceChange,
  onNameChange,
  onPackagingChange,
  onRemove,
  onDiscChange,
  onDiscTypeChange,
  onAllocationChange,
  onEditAllocation,
  onBatchesLoaded,
  disableDiscount,
  allowPriceEditing = false,
  entityDiscountShare = 0,
  stockMode = 'branch',
}) {
  const margin = posLineMargin(item, entityDiscountShare)
  // Loaded rates use settings decimals; typed multi-decimal drafts keep entry precision.
  const exclRate = displayExclusiveUnitRate(
    item.price,
    item.taxRate,
    hasExtraAmountPrecision(item.price) ? ENTRY_DECIMALS : getAmountDecimals(),
  )
  const afterEntity = Math.max(0, roundAmount((Number(item.lineTotal) || 0) - (Number(entityDiscountShare) || 0)))
  const lineTax = lineTaxAmount(afterEntity, item.taxRate)
  const lineTotalExcl = lineTaxableAmount(afterEntity, item.taxRate)
  const hsn = item.hsnCode || '—'
  const metadata = getInvoiceItemMetadata(item)
  const uom = metadata.units === '' ? '—' : metadata.units
  const [batches, setBatches] = useState([])
  const [loadingBatches, setLoadingBatches] = useState(false)
  const hasStock = item.availableStock != null || item.available_stock != null
  const stockQty = hasStock ? Number(item.availableStock ?? item.available_stock) || 0 : null
  const branchStockQty = Math.max(0, Number(item.branchStock ?? stockQty ?? 0) || 0)
  const tracked = Boolean(item.batchTracking || item.batch_tracking)
  const expiryTracked = Boolean(item.expiryTracking || item.expiry_tracking)
  const sellableBatches = useMemo(
    () => stockMode === 'clubbed' && expiryTracked
      ? batches.filter((batch) => !batchExpiryStatus(batch).expired)
      : batches,
    [batches, stockMode, expiryTracked],
  )
  const localBatchStock = sellableBatches.reduce((total, batch) => (
    total + Math.max(0, Number(batch.quantity ?? batch.remaining) || 0)
  ), 0)
  const localBatchQtyNeeded = stockMode === 'clubbed'
    ? Math.min(item.qty, tracked ? localBatchStock : branchStockQty)
    : item.qty
  const stockExceeded = stockQty != null && item.qty > stockQty
  const discType = item.lineDiscountType === 'flat' ? 'flat' : 'pct'
  const discValue = Number(item.lineDiscountValue ?? item.lineDiscountPct ?? item.lineDiscountFlat ?? 0) || 0
  const lastNonEmptyNameRef = useRef(item.name || '')
  if (String(item.name || '').trim()) lastNonEmptyNameRef.current = String(item.name).trim()
  const lastPositiveQtyRef = useRef(item.qty)
  if (Number(item.qty) > 0) lastPositiveQtyRef.current = item.qty
  const [qtyText, setQtyText] = useState(null)
  const [priceText, setPriceText] = useState(null)
  const qtyEditing = qtyText !== null
  const priceEditing = priceText !== null

  const commitQty = (raw) => {
    const v = Number(raw)
    if (Number.isFinite(v) && v > 0) {
      onQtyChange(roundEntry(v))
      return
    }
    onQtyChange(roundEntry(lastPositiveQtyRef.current || 1))
  }

  const commitPrice = (raw) => {
    const v = Number(raw)
    if (Number.isFinite(v) && v >= 0) {
      onPriceChange?.(storeInclusiveUnitRate(v, item.taxRate, ENTRY_DECIMALS))
      return
    }
    onPriceChange?.(storeInclusiveUnitRate(exclRate, item.taxRate, ENTRY_DECIMALS))
  }

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
    if (sellableBatches.length === 0) return
    const auto = computeAutoAllocation(sellableBatches, localBatchQtyNeeded)
    const same = JSON.stringify(auto) === JSON.stringify(allocationRef.current || [])
    if (!same) onAllocationChangeRef.current?.(auto, /* custom */ false)
  }, [sellableBatches, item.qty, localBatchQtyNeeded, item.batchAllocationCustom, tracked])

  const strategyLabel = expiryTracked ? 'FEFO' : 'FIFO'
  const allocation = Array.isArray(item.batchAllocation) ? item.batchAllocation : []
  const allocValid = isAllocationValid(allocation, localBatchQtyNeeded)
  const allocated = allocationSum(allocation)

  return (
    <tr
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-raised)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = tracked ? 'var(--accent-bg)' : 'transparent' }}
      style={{
        background: tracked ? 'var(--accent-bg)' : 'transparent',
        boxShadow: tracked ? 'inset 3px 0 0 var(--accent)' : 'none',
      }}
      title={tracked ? `${strategyLabel} batch-tracked item` : undefined}
    >
      <td style={{ padding: '4px 8px 5px', borderBottom: '1px solid var(--border-subtle)', minWidth: 320, width: '32%', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 15, lineHeight: '26px', flexShrink: 0 }}>{item.emoji || '📦'}</span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <input
              className="form-input"
              type="text"
              data-pos-cart-field="name"
              data-pos-cart-index={cartIndex}
              value={item.name ?? ''}
              onChange={(e) => onNameChange?.(e.target.value)}
              onBlur={() => {
                const trimmed = String(item.name || '').trim()
                if (!trimmed) onNameChange?.(lastNonEmptyNameRef.current)
                else if (trimmed !== item.name) onNameChange?.(trimmed)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                else handleCartFieldArrowNav(e, 'name', cartIndex)
              }}
              aria-label={`Item name for this bill: ${item.name || ''}`}
              title="Edit name for this bill only. Item master is unchanged."
              style={{
                width: '100%',
                minWidth: 0,
                padding: '2px 6px',
                fontSize: 12.5,
                fontWeight: 600,
                lineHeight: 1.25,
                color: 'var(--text-primary)',
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'nowrap',
                gap: 5,
                minWidth: 0,
                overflow: 'hidden',
                paddingLeft: 2,
                fontSize: 10,
                color: 'var(--text-muted)',
                fontFamily: 'DM Mono, monospace',
                lineHeight: 1.3,
                whiteSpace: 'nowrap',
              }}
              title={[
                tracked ? strategyLabel : null,
                `HSN ${hsn}`,
                `UOM ${uom}`,
                stockMode === 'clubbed'
                  ? `Pool ${stockQty != null ? fmtQty(stockQty) : '—'} · Here ${fmtQty(branchStockQty)}`
                  : `Stock: ${stockQty != null ? fmtQty(stockQty) : '—'}`,
              ].filter(Boolean).join(' · ')}
              aria-label={`Details for ${item.name || 'item'}: HSN, unit, stock${tracked ? ', batches' : ''}`}
            >
              {tracked && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '0 4px', borderRadius: 3, flexShrink: 0,
                  background: expiryTracked ? 'rgba(245, 158, 11, 0.18)' : 'rgba(99, 102, 241, 0.18)',
                  color: expiryTracked ? 'var(--amber)' : 'var(--accent)',
                  letterSpacing: 0.3,
                }}>
                  {strategyLabel}
                </span>
              )}
              <span title="HSN" style={{ flexShrink: 0 }}>HSN {hsn}</span>
              <span aria-hidden style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
              <span title="Unit of measure" style={{ flexShrink: 0 }}>{uom}</span>
              <span aria-hidden style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
              <span title="Available stock" style={{ color: stockExceeded ? 'var(--amber)' : undefined, flexShrink: 0 }}>
                {stockMode === 'clubbed'
                  ? `Pool ${stockQty != null ? fmtQty(stockQty) : '—'} · Here ${fmtQty(branchStockQty)}`
                  : `Stock: ${stockQty != null ? fmtQty(stockQty) : '—'}`}
                {stockExceeded ? ' ⚠' : ''}
              </span>
              {tracked && (
                <>
                  <span aria-hidden style={{ opacity: 0.4, flexShrink: 0 }}>·</span>
                  {loadingBatches ? (
                    <span style={{ fontStyle: 'italic', flexShrink: 0 }}>lots…</span>
                  ) : batches.length === 0 ? (
                    <span style={{ color: 'var(--amber)', flexShrink: 0 }}>no lots</span>
                  ) : (
                    <BatchSummary
                      allocation={allocation}
                      expiryTracked={expiryTracked}
                      valid={allocValid}
                      allocated={allocated}
                      qtyNeeded={localBatchQtyNeeded}
                      custom={!!item.batchAllocationCustom}
                      onEdit={() => onEditAllocation && onEditAllocation({ item, batches: sellableBatches, allocation, qty: localBatchQtyNeeded })}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'middle' }}>
        <input
          className="form-input"
          type="text"
          data-pos-cart-field="packaging"
          data-pos-cart-index={cartIndex}
          value={item.packaging ?? ''}
          onChange={(e) => onPackagingChange?.(e.target.value)}
          onBlur={(e) => onPackagingChange?.(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else handleCartFieldArrowNav(e, 'packaging', cartIndex)
          }}
          aria-label={`Packaging for ${item.name || 'item'}`}
          placeholder="—"
          style={{ width: 120, padding: '4px 7px', fontSize: 12 }}
        />
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'middle' }}>
        <input
          className="form-input"
          type="number"
          data-pos-cart-field="qty"
          data-pos-cart-index={cartIndex}
          min={entryStep()}
          step={entryStep()}
          value={qtyEditing ? qtyText : formatQtyFieldValue(item.qty)}
          onFocus={(e) => {
            setQtyText(String(item.qty ?? ''))
            e.target.select()
          }}
          onChange={(e) => {
            const raw = e.target.value
            setQtyText(raw)
            if (raw.trim() === '' || raw === '.' || raw.endsWith('.')) return
            const v = Number(raw)
            if (!Number.isFinite(v) || v <= 0) return
            onQtyChange(roundEntry(v))
          }}
          onBlur={() => {
            commitQty(qtyText)
            setQtyText(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else handleCartFieldArrowNav(e, 'qty', cartIndex)
          }}
          aria-label={`Quantity for ${item.name || 'item'}`}
          title="Multi-decimal while editing; settings precision when loaded; rounded on save"
          style={{ width: 72, padding: '4px 6px', fontSize: 12, textAlign: 'center', fontFamily: 'DM Mono, monospace' }}
        />
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'middle' }}>
        {allowPriceEditing ? (
          <input
            className="form-input"
            type="number"
            data-pos-cart-field="price"
            data-pos-cart-index={cartIndex}
            min={0}
            step={entryStep()}
            value={priceEditing ? priceText : formatAmountFieldValue(exclRate)}
            onFocus={(e) => {
              setPriceText(String(exclRate ?? ''))
              e.target.select()
            }}
            onChange={(e) => {
              const raw = e.target.value
              setPriceText(raw)
              if (raw.trim() === '' || raw === '.' || raw.endsWith('.')) return
              const v = Number(raw)
              if (!Number.isFinite(v) || v < 0) return
              onPriceChange?.(storeInclusiveUnitRate(v, item.taxRate, ENTRY_DECIMALS))
            }}
            onBlur={() => {
              commitPrice(priceText)
              setPriceText(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              else handleCartFieldArrowNav(e, 'price', cartIndex)
            }}
            style={{ width: 96, padding: '4px 7px', fontSize: 12, fontFamily: 'DM Mono, monospace' }}
            aria-label={`Rate excl. GST for ${item.name}`}
            title="Rate excl. GST — multi-decimal while editing; settings precision when loaded; rounded on save"
          />
        ) : (
          <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 600 }} title="Rate excl. GST">
            {formatAmountNumber(exclRate)}
          </span>
        )}
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'middle' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: disableDiscount ? 0.6 : 1 }}>
          <input
            className="form-input"
            type="number"
            data-pos-cart-field="discount"
            data-pos-cart-index={cartIndex}
            min={0}
            max={discType === 'pct' ? 100 : undefined}
            step={discType === 'pct' ? 0.5 : amountInputStep()}
            value={discValue || ''}
            onChange={(e) => onDiscChange(
              discType === 'pct'
                ? (Number(e.target.value) || 0)
                : roundAmount(Number(e.target.value) || 0),
            )}
            onKeyDown={(e) => handleCartFieldArrowNav(e, 'discount', cartIndex)}
            disabled={disableDiscount}
            style={{ width: 86, padding: '4px 7px', fontSize: 12 }}
          />
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 7, overflow: 'hidden' }}>
            <button type="button" onClick={() => onDiscTypeChange('pct')} disabled={disableDiscount}
              style={{ border: 'none', borderRight: '1px solid var(--border-default)', background: discType === 'pct' ? 'var(--accent-bg)' : 'transparent', color: discType === 'pct' ? 'var(--accent)' : 'var(--text-muted)', cursor: disableDiscount ? 'not-allowed' : 'pointer', fontSize: 11, padding: '4px 7px', fontWeight: 600 }}>%</button>
            <button type="button" onClick={() => onDiscTypeChange('flat')} disabled={disableDiscount}
                    style={{ border: 'none', background: discType === 'flat' ? 'var(--accent-bg)' : 'transparent', color: discType === 'flat' ? 'var(--accent)' : 'var(--text-muted)', cursor: disableDiscount ? 'not-allowed' : 'pointer', fontSize: 11, padding: '4px 7px', fontWeight: 600 }}>MVR</button>
          </div>
        </div>
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', verticalAlign: 'middle', whiteSpace: 'nowrap' }} title="GST on discounted amount (settings rounding)">
        {formatAmountNumber(lineTax)}
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
        <MarginBadge margin={margin} />
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', fontFamily: 'DM Mono, monospace', fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', verticalAlign: 'middle', whiteSpace: 'nowrap' }} title="Line total excl. GST (settings rounding)">
        {formatAmountNumber(lineTotalExcl)}
      </td>
      <td style={{ padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)', textAlign: 'center', verticalAlign: 'middle' }}>
        <button type="button" onClick={onRemove} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: '0 2px' }} aria-label="Remove line">✕</button>
      </td>
    </tr>
  )
}

/**
 * Inline batch breakdown on the cart meta line. Renders every batch the
 * line will draw from (`GR-A (10), GR-B (3)`) as small lot pills, with a
 * single ✎ button that delegates to POSPage to open the allocation modal.
 *
 * Pills are color-coded by expiry urgency when the item is FEFO-tracked so
 * the cashier can spot an expired lot in the split at a glance. A "Custom"
 * tag and a mismatch warning appear when relevant — the latter only when an
 * operator-saved split fell out of sync (qty bumped before they re-edited).
 */
function BatchSummary({ allocation, expiryTracked, valid, allocated, qtyNeeded, custom, onEdit }) {
  const primary = allocation[0]
  const extraCount = Math.max(0, allocation.length - 1)
  const fullTitle = allocation.length === 0
    ? 'No lot allocated'
    : allocation.map((e) => `${e.batchNumber} (${e.qty})`).join(', ')
  const expInfo = primary
    ? batchExpiryStatus({
      expiryDate: primary.expiryDate,
      mfgDate: primary.mfgDate,
      receivedDate: primary.receivedDate,
      quantity: primary.qty,
    })
    : null
  const tone = !expInfo
    ? 'var(--accent)'
    : expInfo.expired ? 'var(--red)' : expInfo.nearExpiry ? 'var(--amber)' : 'var(--accent)'

  return (
    <div
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--text-muted)', flexWrap: 'nowrap', minWidth: 0, overflow: 'hidden' }}
      title={fullTitle}
    >
      {allocation.length === 0 ? (
        <span style={{ color: 'var(--amber)', whiteSpace: 'nowrap', flexShrink: 0 }}>no lot</span>
      ) : (
        <>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 2,
              padding: '0 5px', borderRadius: 999, color: tone,
              fontFamily: 'DM Mono, monospace', fontSize: 10, fontWeight: 500,
              border: `1px solid ${tone}`,
              whiteSpace: 'nowrap', maxWidth: 110, overflow: 'hidden',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {primary.batchNumber}
            </span>
            <span style={{ fontWeight: 700, flexShrink: 0 }}>({primary.qty})</span>
            {expiryTracked && expInfo?.showUrgentIcon && (
              <span aria-hidden style={{ fontSize: 9, flexShrink: 0 }}>{expInfo.expired ? '⚠' : '📅'}</span>
            )}
          </span>
          {extraCount > 0 && (
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>
              +{extraCount}
            </span>
          )}
        </>
      )}
      {custom && (
        <span style={{ fontSize: 9, padding: '0 3px', borderRadius: 3, background: 'var(--bg-raised)', color: 'var(--text-secondary)', letterSpacing: 0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>
          CUSTOM
        </span>
      )}
      {!valid && allocation.length > 0 && (
        <span title={`Allocated ${allocated} of ${qtyNeeded}`} style={{ fontSize: 10, color: 'var(--red)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          ⚠
        </span>
      )}
      <button
        type="button"
        onClick={onEdit}
        title={`Edit batch split${fullTitle ? `: ${fullTitle}` : ''}`}
        aria-label="Edit batch split"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: 4, border: 'none', background: 'transparent',
          color: 'var(--text-muted)', cursor: 'pointer', padding: 0, flexShrink: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface)'; e.currentTarget.style.color = 'var(--accent)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
          <path d="M10 3l3 3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </div>
  )
}

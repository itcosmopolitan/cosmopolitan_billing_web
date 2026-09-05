import { useState } from 'react'
import { itemsAPI } from '@/api'
import { EmptyState, Modal } from '@/components/ui'
import {
  createBranchRow,
  formatCategoryPriceLabel,
  profitPercentage,
  retailBranches,
} from './itemFormShared'
import BranchPricingModal from './BranchPricingModal'
import { catalogInclusiveAmount } from '@/utils/taxCalc'
import { fmt, fmtQty } from '@/utils/helpers'

/**
 * Branch listing on Item Master create/edit.
 * Add / edit opens a top-aligned modal with full branch pricing (incl. wholesale & staff + GP%).
 */
export default function BranchPricingSection({
  mode = 'create',
  branches,
  branchConfigs,
  initialListedIds = [],
  defaultCost,
  defaultPrice,
  priceTaxMode = 'inclusive',
  defaultReorder,
  defaultCategoryMode = 'pct',
  defaultWholesalePct = '',
  defaultWholesalePrice = '',
  defaultStaffPct = '',
  defaultStaffPrice = '',
  taxRate,
  batchTracking = false,
  onChange,
  itemId = null,
}) {
  const isEdit = mode === 'edit'
  const showCreateOpeningStock = !isEdit && !batchTracking
  const showEditOpeningStock = isEdit && !batchTracking
  const showOpeningStock = showCreateOpeningStock || showEditOpeningStock
  const initiallyListed = new Set(initialListedIds)
  const options = retailBranches(branches)

  const [checkingBatches, setCheckingBatches] = useState(false)
  const [batchWarningData, setBatchWarningData] = useState(null)
  const [pendingRemoveRowId, setPendingRemoveRowId] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingRow, setEditingRow] = useState(null)

  const usedBranchIds = new Set(
    branchConfigs.map((r) => r.branch_id).filter(Boolean),
  )

  const openAdd = () => {
    setEditingRow(null)
    setModalOpen(true)
  }

  const openEdit = (row) => {
    setEditingRow(row)
    setModalOpen(true)
  }

  const handleModalSave = (saved) => {
    if (editingRow) {
      onChange(branchConfigs.map((r) => (
        r._rowId === editingRow._rowId ? { ...r, ...saved, _rowId: r._rowId } : r
      )))
      return
    }
    const { _rowId: _ignored, ...fields } = saved
    onChange([
      ...branchConfigs,
      createBranchRow(
        { id: fields.branch_id, name: fields.branch_name },
        fields,
      ),
    ])
  }

  const removeRow = (rowId) => {
    onChange(branchConfigs.filter((r) => r._rowId !== rowId))
  }

  const handleRemoveBranchClick = async (rowId) => {
    const row = branchConfigs.find((r) => r._rowId === rowId)
    if (!row || !row.branch_id) {
      removeRow(rowId)
      return
    }

    if (!isEdit || !itemId) {
      removeRow(rowId)
      return
    }

    setCheckingBatches(true)
    setPendingRemoveRowId(rowId)
    try {
      const info = await itemsAPI.getBranchBatchInfo(itemId, row.branch_id)
      if (info.batch_count > 0 || info.stock_qty > 0) {
        setBatchWarningData({
          rowId,
          branchName: row.branch_name,
          ...info,
        })
      } else {
        removeRow(rowId)
      }
    } catch (err) {
      console.error('Failed to check batch info:', err)
      removeRow(rowId)
    } finally {
      setCheckingBatches(false)
      setPendingRemoveRowId(null)
    }
  }

  const handleConfirmRemoval = () => {
    if (batchWarningData?.rowId) {
      removeRow(batchWarningData.rowId)
    }
    setBatchWarningData(null)
  }

  const handleCancelRemoval = () => {
    setBatchWarningData(null)
  }

  const canAddMore = branchConfigs.length < options.length

  const resolveAmounts = (row) => {
    const cost = catalogInclusiveAmount(
      row.cost_price === '' || row.cost_price == null ? defaultCost : row.cost_price,
      priceTaxMode,
      taxRate,
    )
    const price = catalogInclusiveAmount(
      row.selling_price === '' || row.selling_price == null ? defaultPrice : row.selling_price,
      priceTaxMode,
      taxRate,
    )
    return { cost, price, gp: profitPercentage(cost, price) }
  }

  const categorySummary = (row) => {
    const wMode = row.wholesale_pricing_mode || defaultCategoryMode
    const sMode = row.staff_pricing_mode || defaultCategoryMode
    const wholesale = row.wholesale_pricing_mode
      ? formatCategoryPriceLabel(wMode, row.wholesale_discount_pct, row.wholesale_price, fmt)
      : formatCategoryPriceLabel(
        defaultCategoryMode,
        defaultWholesalePct,
        defaultWholesalePrice,
        fmt,
      )
    const staff = row.staff_pricing_mode
      ? formatCategoryPriceLabel(sMode, row.staff_discount_pct, row.staff_price, fmt)
      : formatCategoryPriceLabel(
        defaultCategoryMode,
        defaultStaffPct,
        defaultStaffPrice,
        fmt,
      )
    return { wholesale, staff, wholesaleOverride: Boolean(row.wholesale_pricing_mode), staffOverride: Boolean(row.staff_pricing_mode) }
  }

  const removalSummary = (() => {
    if (!batchWarningData) return ''
    const parts = []
    if (batchWarningData.batch_count > 0) parts.push(`${batchWarningData.batch_count} batch(es)`)
    if (batchWarningData.stock_qty > 0) parts.push(`${batchWarningData.stock_qty} unit(s) on hand`)
    return parts.join(' and ')
  })()

  if (!options.length) return null

  return (
    <section className="item-form-section item-form-section--branches">
      <div className="item-form-section__head">
        <div>
          <h3>Branches</h3>
          <p className="item-form-section__hint item-form-section__hint--inline">
            List where this item is sold. Add each branch to set cost, sell, wholesale &amp; staff.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={openAdd}
          disabled={!canAddMore}
          title={canAddMore ? undefined : 'All branches have been added'}
        >
          + Add branch
        </button>
      </div>

      {branchConfigs.length === 0 ? (
        <div className="branch-price-empty">
          <EmptyState
            icon="🏪"
            title="No branches listed"
            desc="Add each retail location where this item should appear."
            action={(
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={openAdd}
                disabled={!canAddMore}
              >
                + Add branch
              </button>
            )}
          />
        </div>
      ) : (
        <ul className="branch-price-cards">
          {branchConfigs.map((r) => {
            const { cost, price, gp } = resolveAmounts(r)
            const cat = categorySummary(r)
            const removing = checkingBatches && pendingRemoveRowId === r._rowId
            const canEditOpeningInEdit = isEdit && r.branch_id && !initiallyListed.has(r.branch_id)
            return (
              <li key={r._rowId} className="branch-price-card">
                <div className="branch-price-card__top">
                  <div>
                    <div className="branch-price-card__name">{r.branch_name || 'Select branch…'}</div>
                    {isEdit && (
                      <div className="branch-price-card__meta">
                        Stock {fmtQty(r.available_stock ?? 0)}
                        {showOpeningStock && canEditOpeningInEdit && r.opening_stock
                          ? ` · Opening ${fmtQty(r.opening_stock)}`
                          : ''}
                      </div>
                    )}
                  </div>
                  <div className="branch-price-card__actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => openEdit(r)}
                      title="Edit branch pricing"
                      aria-label="Edit branch pricing"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs branch-price-table__remove"
                      onClick={() => handleRemoveBranchClick(r._rowId)}
                      disabled={removing}
                      title={removing ? 'Checking…' : 'Remove branch'}
                      aria-label="Remove branch"
                    >
                      {removing ? '…' : '✕'}
                    </button>
                  </div>
                </div>
                <dl className="branch-price-card__grid">
                  <div>
                    <dt>Cost</dt>
                    <dd className="mono">{fmt(cost)}{r.cost_price === '' || r.cost_price == null ? <span className="branch-price-card__inherit"> default</span> : null}</dd>
                  </div>
                  <div>
                    <dt>Selling</dt>
                    <dd className="mono">{fmt(price)}{r.selling_price === '' || r.selling_price == null ? <span className="branch-price-card__inherit"> default</span> : null}</dd>
                  </div>
                  <div>
                    <dt>GP%</dt>
                    <dd>
                      <span className={`branch-price-table__gp${gp != null && gp < 0 ? ' is-neg' : ''}`}>
                        {gp == null ? '—' : `${gp.toFixed(1)}%`}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Wholesale</dt>
                    <dd>
                      {cat.wholesale}
                      {!cat.wholesaleOverride && <span className="branch-price-card__inherit"> default</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Staff</dt>
                    <dd>
                      {cat.staff}
                      {!cat.staffOverride && <span className="branch-price-card__inherit"> default</span>}
                    </dd>
                  </div>
                  <div>
                    <dt>Reorder</dt>
                    <dd className="mono">
                      {r.reorder_level === '' || r.reorder_level == null
                        ? <>{defaultReorder || 10}<span className="branch-price-card__inherit"> default</span></>
                        : fmtQty(r.reorder_level)}
                    </dd>
                  </div>
                  {showOpeningStock && !isEdit && (
                    <div>
                      <dt>Opening</dt>
                      <dd className="mono">{fmtQty(r.opening_stock || 0)}</dd>
                    </div>
                  )}
                </dl>
              </li>
            )
          })}
        </ul>
      )}

      {!isEdit && (
        <p className="item-form-section__hint" style={{ marginTop: 10, marginBottom: 0 }}>
          Default reorder: {defaultReorder || 10}. Blank branch reorder uses this default.
        </p>
      )}

      <BranchPricingModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditingRow(null) }}
        onSave={handleModalSave}
        editingRow={editingRow}
        branches={branches}
        usedBranchIds={usedBranchIds}
        defaultCost={defaultCost}
        defaultPrice={defaultPrice}
        defaultReorder={defaultReorder}
        defaultCategoryMode={defaultCategoryMode}
        defaultWholesalePct={defaultWholesalePct}
        defaultWholesalePrice={defaultWholesalePrice}
        defaultStaffPct={defaultStaffPct}
        defaultStaffPrice={defaultStaffPrice}
        priceTaxMode={priceTaxMode}
        taxRate={taxRate}
        showOpeningStock={showOpeningStock}
        canEditOpening={
          !isEdit
          || (editingRow
            && editingRow.branch_id
            && !initiallyListed.has(editingRow.branch_id))
          || !editingRow
        }
      />

      <Modal
        open={Boolean(batchWarningData)}
        onClose={handleCancelRemoval}
        title="Remove branch?"
        icon="⚠️"
        size="sm"
        footer={(
          <>
            <button type="button" className="btn btn-secondary" onClick={handleCancelRemoval}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={handleConfirmRemoval}>
              Remove branch
            </button>
          </>
        )}
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
          <strong>{batchWarningData?.branchName}</strong>
          {removalSummary ? <> has {removalSummary}</> : null}.
          Removing it permanently deletes batches and stock for this item at that branch.
        </p>
      </Modal>
    </section>
  )
}

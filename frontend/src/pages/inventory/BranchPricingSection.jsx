import { useState } from 'react'
import { itemsAPI } from '@/api'
import { EmptyState, AutocompleteDropdown, Modal } from '@/components/ui'
import { createBranchRow, retailBranches } from './itemFormShared'
import TaxedPriceInput from './TaxedPriceInput'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { catalogInclusiveAmount } from '@/utils/taxCalc'
import { fmtQty } from '@/utils/helpers'

/**
 * Branch listing and price overrides on Item Master create/edit.
 * Stock and batches are added per branch from Items & Stock.
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

  const usedBranchIds = new Set(
    branchConfigs.map((r) => r.branch_id).filter(Boolean),
  )

  const patchRow = (rowId, field, value) => {
    const patch = typeof field === 'object' && field !== null && value === undefined
      ? field
      : { [field]: value }
    onChange(branchConfigs.map((r) => {
      if (r._rowId !== rowId) return r
      if (patch.branch_id !== undefined) {
        const br = options.find((b) => b.id === patch.branch_id)
        return { ...r, ...patch, branch_name: br?.name || r.branch_name }
      }
      return { ...r, ...patch }
    }))
  }

  const addRow = () => {
    const taken = new Set(branchConfigs.map((r) => r.branch_id).filter(Boolean))
    const next = options.find((b) => !taken.has(b.id))
    onChange([...branchConfigs, createBranchRow(next || null)])
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
  const costPlaceholder = `Default ${defaultCost || 0}`
  const pricePlaceholder = `Default ${defaultPrice || 0}`
  const reorderPlaceholder = String(defaultReorder || 10)

  const getProfitPercentage = (row) => {
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

    if (!Number.isFinite(cost) || !Number.isFinite(price) || cost === 0) {
      return null
    }

    return ((price - cost) / cost) * 100
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
            List where this item is sold. Blank cost/sell uses catalog defaults.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={addRow}
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
                onClick={addRow}
                disabled={!canAddMore}
              >
                + Add branch
              </button>
            )}
          />
        </div>
      ) : (
        <div className="branch-price-table-wrap">
          <table className="data-table branch-price-table">
            <thead>
              <tr>
                <th>Branch</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Selling</th>
                <th className="text-right">GP %</th>
                {showOpeningStock && <th className="text-right">Opening</th>}
                <th className="text-right">Reorder</th>
                {isEdit && <th className="text-right">Stock</th>}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {branchConfigs.map((r) => {
                const canEditOpeningInEdit = isEdit && r.branch_id && !initiallyListed.has(r.branch_id)
                const profit = getProfitPercentage(r)
                const removing = checkingBatches && pendingRemoveRowId === r._rowId
                return (
                  <tr key={r._rowId}>
                    <td className="branch-price-table__branch">
                      <AutocompleteDropdown
                        value={r.branch_id || ''}
                        onSelectOption={(opt) => patchRow(r._rowId, 'branch_id', opt?.id || '')}
                        options={options.map((b) => ({
                          id: b.id,
                          label: b.name,
                          disabled: usedBranchIds.has(b.id) && b.id !== r.branch_id,
                        }))}
                        isSearchFieldRequired={false}
                        selectedLabel={r.branch_name || undefined}
                        placeholder="Select branch…"
                        searchPlaceholder="Search branches…"
                        emptyLabel="No branches found"
                      />
                    </td>
                    <td className="text-right branch-price-table__price">
                      <TaxedPriceInput
                        dense
                        disabled={!r.branch_id}
                        value={r.cost_price ?? ''}
                        mode={priceTaxMode}
                        taxRate={taxRate}
                        placeholder={costPlaceholder}
                        onValueChange={(v) => patchRow(r._rowId, 'cost_price', v)}
                      />
                    </td>
                    <td className="text-right branch-price-table__price">
                      <TaxedPriceInput
                        dense
                        disabled={!r.branch_id}
                        value={r.selling_price ?? ''}
                        mode={priceTaxMode}
                        taxRate={taxRate}
                        placeholder={pricePlaceholder}
                        onValueChange={(v) => patchRow(r._rowId, 'selling_price', v)}
                      />
                    </td>
                    <td className="text-right">
                      <span className={`branch-price-table__gp${profit != null && profit < 0 ? ' is-neg' : ''}`}>
                        {profit == null ? '—' : `${profit.toFixed(1)}%`}
                      </span>
                    </td>
                    {showOpeningStock && (
                      <td className="text-right">
                        {isEdit && !canEditOpeningInEdit ? (
                          <input
                            className="form-input branch-price-table__num"
                            type="number"
                            disabled
                            value={r.available_stock ?? 0}
                            title="Opening qty can be set only for newly added branches"
                          />
                        ) : (
                          <input
                            className="form-input branch-price-table__num"
                            type="number"
                            min="0"
                            step={qtyInputStep()}
                            disabled={!r.branch_id}
                            placeholder="0"
                            value={r.opening_stock ?? ''}
                            onChange={(e) => patchRow(r._rowId, 'opening_stock', e.target.value)}
                          />
                        )}
                      </td>
                    )}
                    <td className="text-right">
                      <input
                        className="form-input branch-price-table__num"
                        type="number"
                        min="0"
                        step={qtyInputStep()}
                        disabled={!r.branch_id}
                        placeholder={reorderPlaceholder}
                        value={r.reorder_level ?? ''}
                        onChange={(e) => patchRow(r._rowId, 'reorder_level', e.target.value)}
                      />
                    </td>
                    {isEdit && (
                      <td className="text-right">
                        <span className="branch-price-table__stock">{fmtQty(r.available_stock ?? 0)}</span>
                      </td>
                    )}
                    <td className="branch-price-table__actions">
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
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isEdit && (
        <p className="item-form-section__hint" style={{ marginTop: 10, marginBottom: 0 }}>
          Default reorder: {defaultReorder || 10}. Blank branch reorder uses this default.
        </p>
      )}

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

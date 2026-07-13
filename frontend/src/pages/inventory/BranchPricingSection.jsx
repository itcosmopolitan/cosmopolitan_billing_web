import { useState } from 'react'
import toast from 'react-hot-toast'
import { itemsAPI } from '@/api'
import { AlertBar, EmptyState, AutocompleteDropdown } from '@/components/ui'
import { createBranchRow, retailBranches } from './itemFormShared'

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
  defaultReorder,
  batchTracking = false,
  onChange,
  itemId = null,
}) {
  const isEdit = mode === 'edit'
  const showCreateOpeningStock = !isEdit && !batchTracking
  const showEditOpeningStock = isEdit && !batchTracking
  const initiallyListed = new Set(initialListedIds)
  const options = retailBranches(branches)

  const [checkingBatches, setCheckingBatches] = useState(false)
  const [batchWarningData, setBatchWarningData] = useState(null)
  const [pendingRemoveRowId, setPendingRemoveRowId] = useState(null)

  const usedBranchIds = new Set(
    branchConfigs.map((r) => r.branch_id).filter(Boolean),
  )

  const patchRow = (rowId, field, value) => {
    onChange(branchConfigs.map((r) => {
      if (r._rowId !== rowId) return r
      if (field === 'branch_id') {
        const br = options.find((b) => b.id === value)
        return { ...r, branch_id: value, branch_name: br?.name || '' }
      }
      return { ...r, [field]: value }
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
      // Empty row, just remove it
      removeRow(rowId)
      return
    }
    
    // Only check for batches in edit mode with an item ID
    if (!isEdit || !itemId) {
      removeRow(rowId)
      return
    }
    
    setCheckingBatches(true)
    setPendingRemoveRowId(rowId)
    try {
      const info = await itemsAPI.getBranchBatchInfo(itemId, row.branch_id)
      if (info.batch_count > 0 || info.stock_qty > 0) {
        // Show warning
        setBatchWarningData({
          rowId,
          branchName: row.branch_name,
          ...info,
        })
      } else {
        // No batches/stock, safe to remove
        removeRow(rowId)
      }
    } catch (err) {
      // If API fails, allow removal anyway (safer to fail open)
      console.error('Failed to check batch info:', err)
      removeRow(rowId)
    } finally {
      setCheckingBatches(false)
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
  const costPlaceholder = (v) => (v === '' || v == null ? `Default ${defaultCost || 0}` : undefined)
  const pricePlaceholder = (v) => (v === '' || v == null ? `Default ${defaultPrice || 0}` : undefined)
  const openingStockPlaceholder = '0'
  const reorderPlaceholder = String(defaultReorder || 10)

  if (!options.length) return null

  return (
    <div style={{
      marginTop: 12, padding: '12px 14px', background: 'var(--bg-raised)',
      borderRadius: 8, border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="form-label" style={{ marginBottom: 0 }}>
          Branch listing &amp; pricing
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-xs"
          onClick={addRow}
          disabled={!canAddMore}
          title={canAddMore ? undefined : 'All branches have been added'}
        >
          + Add branch
        </button>
      </div>
      <AlertBar type="blue" icon="ℹ️">
        Add each branch where this item is sold. Leave cost or sell price blank to use item defaults.
        {isEdit && ' Removing a branch row unlists the item there.'}
        {' '}Stock and batches are added per branch from <strong>Items &amp; Stock</strong>.
      </AlertBar>

      {branchConfigs.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <EmptyState
            icon="🏪"
            title="No branches added"
            desc='Click "Add branch" to list this item at one or more retail branches.'
          />
        </div>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="data-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th>Branch</th>
                <th className="text-right">Cost Price (MVR)</th>
                <th className="text-right">Selling Price (MVR)</th>
                {(showCreateOpeningStock || showEditOpeningStock) && <th className="text-right">Opening Qty</th>}
                <th className="text-right">Reorder</th>
                {isEdit && <th className="text-right">Stock</th>}
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {branchConfigs.map((r) => {
                const canEditOpeningInEdit = isEdit && r.branch_id && !initiallyListed.has(r.branch_id)
                return (
                <tr key={r._rowId}>
                  <td>
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
                      style={{ minWidth: 140, width: '100%' }}
                    />
                  </td>
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      style={{ width: 88, marginLeft: 'auto', textAlign: 'right' }}
                      disabled={!r.branch_id}
                      placeholder={costPlaceholder(r.cost_price)}
                      value={r.cost_price ?? ''}
                      onChange={(e) => patchRow(r._rowId, 'cost_price', e.target.value)}
                    />
                  </td>
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      style={{ width: 88, marginLeft: 'auto', textAlign: 'right' }}
                      disabled={!r.branch_id}
                      placeholder={pricePlaceholder(r.selling_price)}
                      value={r.selling_price}
                      onChange={(e) => patchRow(r._rowId, 'selling_price', e.target.value)}
                    />
                  </td>
                  {(showCreateOpeningStock || showEditOpeningStock) && (
                    <td className="text-right">
                      {isEdit && !canEditOpeningInEdit ? (
                        <input
                          className="form-input"
                          type="number"
                          style={{ width: 80, marginLeft: 'auto', textAlign: 'right', opacity: 0.6, cursor: 'not-allowed' }}
                          disabled
                          value={r.available_stock ?? 0}
                          title="Opening Qty can be set only for newly added branches"
                        />
                      ) : (
                        <input
                          className="form-input"
                          type="number"
                          style={{ width: 80, marginLeft: 'auto', textAlign: 'right' }}
                          disabled={!r.branch_id}
                          placeholder={openingStockPlaceholder}
                          value={r.opening_stock ?? ''}
                          onChange={(e) => patchRow(r._rowId, 'opening_stock', e.target.value)}
                        />
                      )}
                    </td>
                  )}
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      style={{ width: 72, marginLeft: 'auto', textAlign: 'right' }}
                      disabled={!r.branch_id}
                      placeholder={reorderPlaceholder}
                      value={r.reorder_level ?? ''}
                      onChange={(e) => patchRow(r._rowId, 'reorder_level', e.target.value)}
                    />
                  </td>
                  {isEdit && (
                    <td className="text-right">
                      <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        {r.available_stock ?? 0}
                      </span>
                    </td>
                  )}
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => handleRemoveBranchClick(r._rowId)}
                      disabled={checkingBatches && pendingRemoveRowId === r._rowId}
                      title={checkingBatches && pendingRemoveRowId === r._rowId ? 'Checking…' : 'Remove branch'}
                      aria-label="Remove branch"
                    >
                      {checkingBatches && pendingRemoveRowId === r._rowId ? '⏳' : '✕'}
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
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
          Default reorder level: {defaultReorder || 10}. Leave branch reorder blank to use the default.
        </div>
      )}

      {/* Batch removal warning modal */}
      {batchWarningData && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            background: '#fff',
            borderRadius: 8,
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.3)',
            maxWidth: 380,
            width: '90%',
            textAlign: 'center',
            padding: '32px 24px 24px',
          }}>
            {/* Icon */}
            <div style={{
              fontSize: 32,
              marginBottom: 16,
            }}>
              ⚠️
            </div>

            {/* Title */}
            <div style={{
              fontSize: 16,
              fontWeight: 600,
              color: '#000',
              marginBottom: 12,
            }}>
              Remove "{batchWarningData.branchName}" branch?
            </div>

            {/* Description */}
            <div style={{
              fontSize: 13,
              color: '#666',
              lineHeight: 1.6,
              marginBottom: 24,
            }}>
              This branch has <strong>{batchWarningData.batch_count > 0 ? `${batchWarningData.batch_count} batch(es)` : ''}{batchWarningData.batch_count > 0 && batchWarningData.stock_qty > 0 ? ' and ' : ''}{batchWarningData.stock_qty > 0 ? `${batchWarningData.stock_qty} units` : ''}</strong>. Removing this branch will permanently delete all batches and stock data for this item at this branch.
            </div>

            {/* Buttons */}
            <div style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'center',
            }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCancelRemoval}
                style={{ minWidth: 100 }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirmRemoval}
                style={{ minWidth: 100 }}
              >
                Yes, Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

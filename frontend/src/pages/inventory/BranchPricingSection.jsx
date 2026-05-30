import { AlertBar, EmptyState } from '@/components/ui'
import { fmt } from '@/utils/helpers'
import { todayISO } from '@/utils/batchDates'
import { createBranchRow, retailBranches } from './itemFormShared'

/**
 * Add-branch rows for Item Master create: pick branch, cost/sell overrides, opening stock.
 */
export default function BranchPricingSection({
  branches,
  branchConfigs,
  defaultCost,
  defaultPrice,
  defaultReorder,
  batchTracking = false,
  expiryTracking = false,
  onChange,
}) {
  const today = todayISO()
  const options = retailBranches(branches)

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

  const resolvedCost = (row) => {
    if (row.cost_price !== '' && row.cost_price != null) return Number(row.cost_price)
    return Number(defaultCost) || 0
  }

  const rowsWithOpening = branchConfigs.filter(
    (r) => r.branch_id && Number(r.opening_stock) > 0,
  )

  const canAddMore = branchConfigs.length < options.length

  if (!options.length) return null

  return (
    <div style={{
      marginTop: 12, padding: '12px 14px', background: 'var(--bg-raised)',
      borderRadius: 8, border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="form-label" style={{ marginBottom: 0 }}>Branch listing &amp; opening stock</div>
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
        Add each branch where this item is sold. Leave cost or sell price blank to use the item defaults.
        Set an <strong>opening qty</strong> to seed initial stock — otherwise add stock later from{' '}
        <strong>Items &amp; Stock</strong>.
        {batchTracking && ' Batch-tracked items need lot details for each branch with opening qty.'}
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
                <th className="text-right">Branch Cost (₹)</th>
                <th className="text-right">Branch Price (₹)</th>
                <th className="text-right">Opening Qty</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {branchConfigs.map((r) => (
                <tr key={r._rowId}>
                  <td>
                    <select
                      className="form-input"
                      style={{ minWidth: 140 }}
                      value={r.branch_id}
                      onChange={(e) => patchRow(r._rowId, 'branch_id', e.target.value)}
                    >
                      <option value="">Select branch…</option>
                      {options.map((b) => (
                        <option
                          key={b.id}
                          value={b.id}
                          disabled={usedBranchIds.has(b.id) && b.id !== r.branch_id}
                        >
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      style={{ width: 88, marginLeft: 'auto', textAlign: 'right' }}
                      disabled={!r.branch_id}
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
                      value={r.selling_price}
                      onChange={(e) => patchRow(r._rowId, 'selling_price', e.target.value)}
                    />
                  </td>
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      style={{ width: 72, marginLeft: 'auto', textAlign: 'right' }}
                      placeholder="0"
                      disabled={!r.branch_id}
                      value={r.opening_stock ?? ''}
                      onChange={(e) => patchRow(r._rowId, 'opening_stock', e.target.value)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => removeRow(r._rowId)}
                      title="Remove branch"
                      aria-label="Remove branch"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {batchTracking && rowsWithOpening.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="form-label" style={{ marginBottom: 8 }}>
            Opening batch / lot details {expiryTracking ? '(FEFO)' : '(FIFO)'}
          </div>
          {rowsWithOpening.map((r) => (
            <div
              key={r._rowId}
              style={{
                padding: '10px 12px', marginBottom: 8,
                background: 'var(--bg-base)', borderRadius: 8,
                border: '1px solid var(--border-subtle, var(--border))',
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>
                {r.branch_name} · {r.opening_stock} units · cost {fmt(resolvedCost(r))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Batch / Lot #
                  <input
                    className="form-input"
                    style={{ marginTop: 4 }}
                    placeholder="Auto if blank"
                    value={r.opening_batch_number ?? ''}
                    onChange={(e) => patchRow(r._rowId, 'opening_batch_number', e.target.value)}
                  />
                </label>
                <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  Mfg. date
                  <input
                    className="form-input"
                    type="date"
                    max={today}
                    style={{ marginTop: 4 }}
                    value={r.opening_mfg_date ?? ''}
                    onChange={(e) => patchRow(r._rowId, 'opening_mfg_date', e.target.value)}
                  />
                </label>
                {expiryTracking && (
                  <label style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    Expiry date *
                    <input
                      className="form-input"
                      type="date"
                      min={today}
                      style={{ marginTop: 4 }}
                      value={r.opening_expiry_date ?? ''}
                      onChange={(e) => patchRow(r._rowId, 'opening_expiry_date', e.target.value)}
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
        Default reorder level: {defaultReorder || 10} (override per branch after save via ⋮ menu)
      </div>
    </div>
  )
}

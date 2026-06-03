import { AlertBar, EmptyState } from '@/components/ui'
import { createBranchRow, retailBranches } from './itemFormShared'

/**
 * Branch listing and price overrides on Item Master create/edit.
 * Stock and batches are added per branch from Items & Stock.
 */
export default function BranchPricingSection({
  mode = 'create',
  branches,
  branchConfigs,
  defaultCost,
  defaultPrice,
  defaultReorder,
  onChange,
}) {
  const isEdit = mode === 'edit'
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

  const canAddMore = branchConfigs.length < options.length
  const costPlaceholder = (v) => (v === '' || v == null ? `Default ${defaultCost || 0}` : undefined)
  const pricePlaceholder = (v) => (v === '' || v == null ? `Default ${defaultPrice || 0}` : undefined)
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
                <th className="text-right">Branch Cost (₹)</th>
                <th className="text-right">Branch Price (₹)</th>
                {isEdit && <th className="text-right">Reorder</th>}
                {isEdit && <th className="text-right">Stock</th>}
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
                  {isEdit && (
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
                  )}
                  {isEdit && (
                    <td className="text-right mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {r.available_stock ?? 0}
                    </td>
                  )}
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

      {!isEdit && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
          Default reorder level: {defaultReorder || 10} (override per branch on the edit page)
        </div>
      )}
    </div>
  )
}

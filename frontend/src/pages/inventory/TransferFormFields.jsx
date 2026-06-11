import { FormGroup, FormRow, AlertBar, SearchSelect } from '@/components/ui'
import {
  allocationSum,
  formatAllocationSummary,
  isAllocationValid,
} from '@/utils/batchAllocation'

export default function TransferFormFields({
  form,
  patchForm,
  branches = [],
  items = [],
  itemOptions = [],
  itemsLoading = false,
  batchOptions = {},
  loadBatchesForRow,
  onOpenAllocEditor,
  patchItem,
  addItemRow,
  removeItemRow,
  disabled = false,
  refNumber = null,
}) {
  return (
    <>
      {refNumber && (
        <div style={{
          marginBottom: 20,
          padding: '12px 16px',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}>
            Transfer #
          </span>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)', marginTop: 4 }}>
            {refNumber}
          </div>
        </div>
      )}

      <FormRow>
        <FormGroup label="From Branch" required>
          <select
            className="form-input"
            value={form.from_branch_id}
            onChange={(e) => patchForm('from_branch_id', e.target.value)}
            disabled={disabled}
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </FormGroup>
        <FormGroup label="To Branch" required>
          <select
            className="form-input"
            value={form.to_branch_id}
            onChange={(e) => patchForm('to_branch_id', e.target.value)}
            disabled={disabled}
          >
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </FormGroup>
      </FormRow>

      <div style={{ marginTop: 8 }}>
        <div className="form-label" style={{ marginBottom: 8 }}>Items to transfer</div>
        <AlertBar type="blue" icon="🧴" style={{ marginBottom: 12 }}>
          Tracked items auto-split by <strong>FIFO/FEFO</strong>. Click <strong>Edit split</strong> to
          override the batch allocation — the receiving branch inherits the exact lot metadata.
        </AlertBar>

        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}>
          <table className="data-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 280 }}>Item</th>
                <th style={{ width: 110 }}>Qty</th>
                <th>Batch allocation</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {form.items.map((row, i) => {
                const picked = items.find((x) => x.id === row.item_id)
                const tracked = Boolean(picked?.batch_tracking)
                const expiryTracked = Boolean(picked?.expiry_tracking)
                const strategy = expiryTracked ? 'FEFO' : 'FIFO'
                const key = row.item_id ? `${row.item_id}|${form.from_branch_id}` : null
                const batches = key ? (batchOptions[key] || []) : []
                const allocation = row.batchAllocation || []
                const need = Number(row.qty) || 0
                const valid = isAllocationValid(allocation, need)
                return (
                  <tr key={i} style={{ verticalAlign: 'top' }}>
                    <td>
                      <SearchSelect
                        value={row.item_id}
                        options={itemOptions}
                        loading={itemsLoading}
                        loadingLabel="Loading items…"
                        placeholder="Select item…"
                        searchPlaceholder="Search by name, SKU, or barcode…"
                        emptyLabel="No items at source branch"
                        onChange={(itemId) => {
                          patchItem(i, 'item_id', itemId)
                          if (itemId) loadBatchesForRow(itemId)
                        }}
                        disabled={disabled}
                      />
                    </td>
                    <td>
                      <input
                        className="form-input"
                        type="number"
                        min="1"
                        placeholder="Qty"
                        value={row.qty}
                        onChange={(e) => patchItem(i, 'qty', e.target.value)}
                        disabled={disabled}
                      />
                    </td>
                    <td>
                      {!tracked || !row.item_id ? (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {row.item_id ? 'Untracked item' : '—'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
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
                            {row.batchAllocationCustom && (
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
                          {batches.length === 0 ? (
                            <span style={{ fontSize: 11, color: 'var(--amber)' }}>No batches at source</span>
                          ) : allocation.length === 0 ? (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                              Enter quantity…
                            </span>
                          ) : (
                            <span style={{
                              fontSize: 11,
                              fontFamily: 'DM Mono, monospace',
                              color: valid ? 'var(--text-secondary)' : 'var(--red)',
                            }}>
                              {formatAllocationSummary(allocation)}
                            </span>
                          )}
                          {!valid && allocation.length > 0 && (
                            <span style={{ fontSize: 10.5, color: 'var(--red)' }}>
                              {allocationSum(allocation)} / {need} allocated
                            </span>
                          )}
                          {batches.length > 0 && need > 0 && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs"
                              style={{ alignSelf: 'flex-start' }}
                              onClick={async () => {
                                const rows = await loadBatchesForRow(row.item_id)
                                onOpenAllocEditor({
                                  index: i,
                                  batches: rows || batches,
                                  itemName: picked?.name || 'Item',
                                  expiryTracking: expiryTracked,
                                })
                              }}
                              disabled={disabled}
                            >
                              ✎ Edit split
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      {form.items.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => removeItemRow(i)}
                          disabled={disabled}
                          aria-label="Remove line"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 10 }}
          onClick={addItemRow}
          disabled={disabled}
        >
          + Add item
        </button>
      </div>

      <FormRow style={{ marginTop: 20 }}>
        <FormGroup label="Priority">
          <select
            className="form-input"
            value={form.priority}
            onChange={(e) => patchForm('priority', e.target.value)}
            disabled={disabled}
          >
            {['Normal', 'Urgent', 'Planned'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </FormGroup>
        <FormGroup label="Expected dispatch date">
          <input
            className="form-input"
            type="date"
            value={form.expected_date}
            onChange={(e) => patchForm('expected_date', e.target.value)}
            disabled={disabled}
          />
        </FormGroup>
      </FormRow>

      <FormGroup label="Notes">
        <textarea
          className="form-input"
          placeholder="Reason for transfer, special instructions…"
          value={form.notes}
          onChange={(e) => patchForm('notes', e.target.value)}
          style={{ height: 88, marginTop: 4 }}
          disabled={disabled}
        />
      </FormGroup>
    </>
  )
}

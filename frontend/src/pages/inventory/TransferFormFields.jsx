import { FormGroup, AutocompleteDropdown, DatePicker } from '@/components/ui'
import { TRANSFER_PRIORITY_OPTIONS } from '@/utils/dropdownOptions'
import { AUTOCOMPLETE_BRANCH_URL } from '@/api'
import InventoryItemPicker from '@/pages/sales/InventoryItemPicker'
import {
  allocationSum,
  formatAllocationSummary,
  isAllocationValid,
} from '@/utils/batchAllocation'
import { entryInputStep, roundAmount } from '@/utils/decimalPrecision'
import { fmt } from '@/utils/helpers'

export default function TransferFormFields({
  form,
  patchForm,
  branches = [],
  branchLabels = new Map(),
  items = [],
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
  const fromLabel = branchLabels.get(form.from_branch_id)?.name
  const toLabel = branchLabels.get(form.to_branch_id)?.name
  const totalCostPrice = form.items.reduce((sum, row) => {
    const item = items.find((entry) => entry.id === row.item_id)
    const costPrice = Number(row.cost_price ?? item?.cost_price ?? item?.default_cost_price ?? 0)
    return sum + roundAmount((Number(row.qty) || 0) * costPrice)
  }, 0)

  return (
    <div className="transfer-form">
      {refNumber && (
        <div className="transfer-form__ref">
          <span className="transfer-form__eyebrow">Transfer request</span>
          <div className="transfer-form__ref-row">
            <div>
              <div className="transfer-form__ref-label">Reference</div>
              <div className="transfer-form__ref-value mono">{refNumber}</div>
            </div>
            <div className="transfer-form__ref-pill">Pending approval</div>
          </div>
        </div>
      )}

      <div className="transfer-form__route-grid-shell">
        <div className="transfer-form__route-card-panel">
          <div className="transfer-form__section-label">Route</div>
          <div className="transfer-form__route-grid transfer-form__route-grid--inputs">
            <FormGroup label="From Branch" required>
              <AutocompleteDropdown
                value={form.from_branch_id || ''}
                onSelectOption={(opt) => patchForm('from_branch_id', opt?.id || '')}
                fetchUrl={AUTOCOMPLETE_BRANCH_URL}
                fetchParams={{ retail_only: true }}
                isSearchFieldRequired
                searchPlaceholder="Search branch…"
                selectedLabel={fromLabel}
                placeholder="Select source branch"
                disabled={disabled}
                style={{ width: '100%' }}
              />
            </FormGroup>

            <div className="transfer-form__route-arrow transfer-form__route-arrow--inputs" aria-hidden>→</div>

            <FormGroup label="To Branch" required>
              <AutocompleteDropdown
                value={form.to_branch_id || ''}
                onSelectOption={(opt) => patchForm('to_branch_id', opt?.id || '')}
                fetchUrl={AUTOCOMPLETE_BRANCH_URL}
                fetchParams={{ retail_only: true, exclude_id: form.from_branch_id || undefined }}
                isSearchFieldRequired
                searchPlaceholder="Search branch…"
                selectedLabel={toLabel}
                placeholder="Select destination branch"
                disabled={disabled}
                style={{ width: '100%' }}
              />
            </FormGroup>
          </div>
        </div>

        <div className="transfer-form__meta-card-panel">
          <div className="transfer-form__section-label">Dispatch</div>
          <div className="transfer-form__meta-grid">
            <FormGroup label="Priority">
              <AutocompleteDropdown
                value={form.priority || ''}
                onSelectOption={(opt) => patchForm('priority', opt?.id || '')}
                options={TRANSFER_PRIORITY_OPTIONS}
                isSearchFieldRequired={false}
                selectedLabel={form.priority || undefined}
                placeholder="Select priority…"
                disabled={disabled}
              />
            </FormGroup>
            <FormGroup label="Expected dispatch date">
              <DatePicker
                value={form.expected_date}
                onChange={(v) => patchForm('expected_date', v)}
                disabled={disabled}
              />
            </FormGroup>
          </div>
        </div>
      </div>

      <div className="transfer-form__items">
        <div className="transfer-form__items-head">
          <div>
            <div className="transfer-form__section-label">Items to transfer</div>
            <div className="transfer-form__section-subtitle">
              Tracked items auto-split by FIFO or FEFO. Edit the split only when lot control matters.
            </div>
          </div>
        </div>

        <div className="transfer-form__table-wrap">
          <table className="data-table transfer-form__table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th style={{ width: '34%' }}>Item</th>
                <th style={{ width: 90 }}>Qty</th>
                <th style={{ width: 120 }}>Cost Price</th>
                <th style={{ width: 145 }}>Total Cost Price</th>
                <th style={{ width: 280 }}>Batch allocation</th>
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
                const costPrice = Number(row.cost_price ?? picked?.cost_price ?? picked?.default_cost_price ?? 0)
                const valid = isAllocationValid(allocation, need)
                return (
                  <tr key={i} style={{ verticalAlign: 'top' }}>
                    <td>
                      <div className="transfer-form__line-index">{String(i + 1).padStart(2, '0')}</div>
                    </td>
                    <td>
                      <div style={{ maxWidth: 520 }}>
                        <InventoryItemPicker
                          branchId={form.from_branch_id}
                          value={row.item_id
                            ? { id: row.item_id, name: picked?.name || `Item ${row.item_id}` }
                            : null}
                          onPick={(inv) => {
                            patchItem(i, 'item_id', inv.id, inv.cost_price ?? inv.default_cost_price)
                            loadBatchesForRow(inv.id)
                          }}
                          onClear={() => patchItem(i, 'item_id', null)}
                          disabled={disabled || itemsLoading}
                          portalDropdown
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        className="form-input"
                        type="number"
                        min={entryInputStep()}
                        step={entryInputStep()}
                        placeholder="Qty"
                        title="Enter any decimals; shown as entered until save"
                        value={row.qty}
                        onChange={(e) => patchItem(i, 'qty', e.target.value)}
                        disabled={disabled}
                      />
                    </td>
                    <td>
                      <input
                        className="form-input"
                        type="number"
                        min="0"
                        step={entryInputStep()}
                        placeholder="Cost price"
                        title="Enter any decimals; shown as entered until save"
                        value={row.cost_price ?? (row.item_id ? costPrice : '')}
                        onChange={(e) => patchItem(i, 'cost_price', e.target.value)}
                        disabled={disabled || !row.item_id}
                        aria-label={`Cost price for ${picked?.name || `item ${i + 1}`}`}
                      />
                    </td>
                    <td className="mono">{fmt(roundAmount(need * costPrice))}</td>
                    <td>
                      {!tracked || !row.item_id ? (
                        <div className="transfer-form__allocation-empty">
                          <span className="transfer-form__allocation-pill">
                            {row.item_id ? 'Untracked item' : 'Choose item'}
                          </span>
                          <span className="transfer-form__allocation-hint">
                            {row.item_id
                              ? 'Batch split is not needed for this item'
                              : 'Auto split appears here for tracked items'}
                          </span>
                        </div>
                      ) : (
                        <div className="transfer-form__allocation-stack">
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10, fontSize: 13, fontWeight: 700 }}>
          Total Cost Price: <span className="mono" style={{ marginLeft: 8 }}>{fmt(totalCostPrice)}</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 12 }}
          onClick={addItemRow}
          disabled={disabled}
        >
          + Add item
        </button>
      </div>

      <div className="transfer-form__notes-card">
        <div className="transfer-form__section-label">Notes</div>
        <textarea
          className="form-input"
          placeholder="Reason for transfer, special instructions…"
          value={form.notes}
          onChange={(e) => patchForm('notes', e.target.value)}
          style={{ height: 96, marginTop: 8 }}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

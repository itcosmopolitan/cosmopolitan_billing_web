import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { itemsAPI } from '@/api'
import { fmt } from '@/utils/helpers'
import { qtyInputStep } from '@/utils/decimalPrecision'
import { catalogInclusiveAmount, convertEnteredTaxAmount } from '@/utils/taxCalc'
import { Modal, AlertBar } from '@/components/ui'
import TaxedPriceInput, { GST_TAX_MODE_OPTIONS, normalizeTaxMode } from './TaxedPriceInput'

const emptyRow = (branch) => ({
  branch_id: branch.id,
  branch_name: branch.name,
  branch_code: branch.code,
  is_available: false,
  cost_price: '',
  selling_price: '',
  reorder_level: '',
  effective_cost_price: 0,
  effective_selling_price: 0,
  available_stock: 0,
})

export default function BranchConfigModal({ item, branches, open, onClose, onSaved }) {
  const [rows, setRows] = useState([])
  const [defaultCost, setDefaultCost] = useState(0)
  const [defaultPrice, setDefaultPrice] = useState(0)
  const [defaultReorder, setDefaultReorder] = useState(10)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [priceTaxMode, setPriceTaxMode] = useState('inclusive')

  useEffect(() => {
    if (!open || !item?.id) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const data = await itemsAPI.getBranches(item.id)
        if (cancelled) return
        setDefaultCost(data.default_cost_price ?? item.cost_price ?? 0)
        setDefaultPrice(data.default_selling_price ?? item.selling_price ?? 0)
        setDefaultReorder(data.default_reorder_level ?? item.reorder_level ?? 10)
        const byId = new Map((data.branches || []).map((r) => [r.branch_id, r]))
        const merged = (branches || []).map((b) => {
          const existing = byId.get(b.id)
          if (existing) {
            return {
              ...existing,
              cost_price: existing.cost_price ?? '',
              selling_price: existing.selling_price ?? '',
              reorder_level: existing.reorder_level ?? '',
            }
          }
          return emptyRow(b)
        })
        setRows(merged)
        setPriceTaxMode('inclusive')
      } catch (err) {
        console.error('Failed to load branch config:', err)
        toast.error('Failed to load branch configuration')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, item?.id, branches, item?.selling_price, item?.reorder_level])

  const patchRow = (branchId, patch) => {
    setRows((prev) => prev.map((r) => (r.branch_id === branchId ? { ...r, ...patch } : r)))
  }

  const enableAll = () => {
    setRows((prev) => prev.map((r) => ({ ...r, is_available: true })))
  }

  const applyDefaults = () => {
    setRows((prev) => prev.map((r) => (
      r.is_available ? { ...r, cost_price: '', selling_price: '' } : r
    )))
  }

  const changePriceTaxMode = (next) => {
    const normalized = normalizeTaxMode(next)
    const current = normalizeTaxMode(priceTaxMode)
    if (normalized === current) return
    // Keep typed amounts as-is; only reinterpret Incl. ↔ Excl.
    setPriceTaxMode(normalized)
  }

  const shownDefaultCost = convertEnteredTaxAmount(defaultCost, 'inclusive', priceTaxMode, item?.tax_rate)
  const shownDefaultPrice = convertEnteredTaxAmount(defaultPrice, 'inclusive', priceTaxMode, item?.tax_rate)

  const save = async () => {
    try {
      setSaving(true)
      await itemsAPI.updateBranches(item.id, {
        branches: rows.map((r) => ({
          branch_id: r.branch_id,
          is_available: Boolean(r.is_available),
          cost_price: catalogInclusiveAmount(r.cost_price, priceTaxMode, item?.tax_rate),
          selling_price: catalogInclusiveAmount(r.selling_price, priceTaxMode, item?.tax_rate),
          reorder_level: r.reorder_level === '' || r.reorder_level == null
            ? null
            : Number(r.reorder_level),
        })),
      })
      toast.success('Branch configuration saved')
      onSaved?.()
      onClose()
    } catch (err) {
      console.error('Failed to save branch config:', err)
      toast.error('Failed to save branch configuration')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Branch Availability — ${item?.name || ''}`}
      icon="🏪"
      size="lg"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={loading || saving}>
            {saving ? 'Saving…' : 'Save Branch Config'}
          </button>
        </>
      }
    >
      <AlertBar type="blue" icon="ℹ️">
        Default cost: <strong>{fmt(defaultCost)}</strong>
        {' · '}Default selling price: <strong>{fmt(defaultPrice)}</strong>
        {' · '}Leave branch fields blank to use defaults.
        {' · '}Uncheck a branch to hide this item there (POS & branch inventory).
      </AlertBar>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          Price entry
          <select
            className="form-input"
            value={normalizeTaxMode(priceTaxMode)}
            onChange={(e) => changePriceTaxMode(e.target.value)}
            style={{ width: 140 }}
          >
            {GST_TAX_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary btn-xs" onClick={enableAll}>Enable all branches</button>
        <button type="button" className="btn btn-secondary btn-xs" onClick={applyDefaults}>Reset cost &amp; price to defaults</button>
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table className="data-table branch-pricing-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 44 }}>Listed</th>
                <th>Branch</th>
                <th className="text-right" style={{ width: 176 }}>Branch Cost (MVR)</th>
                <th className="text-right" style={{ width: 176 }}>Branch Price (MVR)</th>
                <th className="text-right">Reorder</th>
                <th className="text-right">Stock</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.branch_id} style={{ opacity: r.is_available ? 1 : 0.55 }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(r.is_available)}
                      onChange={(e) => patchRow(r.branch_id, { is_available: e.target.checked })}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{r.branch_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.branch_code}</div>
                  </td>
                  <td className="text-right">
                    <TaxedPriceInput
                      compact
                      disabled={!r.is_available}
                      value={r.cost_price}
                      mode={priceTaxMode}
                      taxRate={item?.tax_rate}
                      placeholder={`Default ${shownDefaultCost}`}
                      onValueChange={(v) => patchRow(r.branch_id, { cost_price: v })}
                    />
                  </td>
                  <td className="text-right">
                    <TaxedPriceInput
                      compact
                      disabled={!r.is_available}
                      value={r.selling_price}
                      mode={priceTaxMode}
                      taxRate={item?.tax_rate}
                      placeholder={`Default ${shownDefaultPrice}`}
                      onValueChange={(v) => patchRow(r.branch_id, { selling_price: v })}
                    />
                  </td>
                  <td className="text-right">
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      step={qtyInputStep()}
                      style={{ width: 72, marginLeft: 'auto', textAlign: 'right' }}
                      placeholder={String(defaultReorder)}
                      disabled={!r.is_available}
                      value={r.reorder_level}
                      onChange={(e) => patchRow(r.branch_id, { reorder_level: e.target.value })}
                    />
                  </td>
                  <td className="text-right mono">{r.available_stock ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { transfersAPI, itemsAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fetchAllList } from '@/utils/pagination'
import { SectionHeader, Card } from '@/components/ui'
import BatchAllocationModal from '@/components/BatchAllocationModal'
import TransferFormFields from './TransferFormFields'
import {
  allocatableBatches,
  computeAutoAllocation,
  fromApiPayload,
} from '@/utils/batchAllocation'
import {
  emptyTransfer,
  formFromTransfer,
  validateTransferForm,
  buildTransferPayload,
  EMPTY_LINE,
} from './transferFormShared'

const SIDEBAR_W = 244
const SIDEBAR_W_COLLAPSED = 68

export default function TransferFormPage({ mode = 'create' }) {
  const { transferId } = useParams()
  const isEdit = mode === 'edit'
  const navigate = useNavigate()
  const can = useCan()
  const user = useAppStore((s) => s.user)
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const footerLeft = sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W

  const defaultFromId = activeBranch?.id || branches.find((b) => b.code !== 'WH')?.id || 'br-001'
  const defaultToId = branches.find((b) => b.id !== defaultFromId)?.id || 'br-002'
  const branchById = useMemo(() => new Map(branches.map((b) => [b.id, b])), [branches])

  const [form, setForm] = useState(() => emptyTransfer(defaultFromId, defaultToId))
  const [refNumber, setRefNumber] = useState(null)
  const [items, setItems] = useState([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [batchOptions, setBatchOptions] = useState({})
  const [allocEditor, setAllocEditor] = useState(null)
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  const patchForm = (k, v) => {
    if (k === 'from_branch_id' && v !== form.from_branch_id) {
      setBatchOptions({})
      setForm((f) => ({
        ...f,
        from_branch_id: v,
        items: f.items.map((row) => (
          row.item_id
            ? { ...row, batchAllocation: [], batchAllocationCustom: false }
            : row
        )),
      }))
      return
    }
    setForm((f) => ({ ...f, [k]: v }))
  }

  useEffect(() => {
    if (isEdit && !can('transfers.create')) {
      navigate('/transfers', { replace: true })
    } else if (!isEdit && !can('transfers.create')) {
      navigate('/transfers', { replace: true })
    }
  }, [can, navigate, isEdit])

  const loadItems = useCallback(async (branchId) => {
    setItemsLoading(true)
    setItems([])
    try {
      const rows = await fetchAllList(itemsAPI.list, { branch_id: branchId, listed_only: true })
      setItems(rows || [])
    } catch {
      setItems([])
      toast.error('Failed to load items')
    } finally {
      setItemsLoading(false)
    }
  }, [])
  const lastLoadedFromBranchRef = useRef(null)
  useEffect(() => {
    const branchId = form.from_branch_id
    if (lastLoadedFromBranchRef.current === branchId) return
    lastLoadedFromBranchRef.current = branchId
    loadItems(branchId)
  }, [form.from_branch_id, loadItems])

  useEffect(() => {
    if (!isEdit || !transferId) return
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const transfer = await transfersAPI.get(transferId)
        if (cancelled) return
        if (transfer.status !== 'pending') {
          toast.error('Only pending transfers can be edited')
          navigate('/transfers', { replace: true })
          return
        }
        setRefNumber(transfer.ref_number)
        const nextForm = formFromTransfer(transfer)
        setForm(nextForm)

        const batchCache = {}
        for (const row of nextForm.items) {
          if (!row.item_id || !row._requestedAllocation?.length) continue
          try {
            const data = await itemsAPI.batches.list(row.item_id, { branch_id: nextForm.from_branch_id })
            const batches = allocatableBatches(data?.items || [])
            const key = `${row.item_id}|${nextForm.from_branch_id}`
            batchCache[key] = batches
          } catch {
            /* batches load failure handled per-row in validation */
          }
        }
        if (cancelled) return
        setBatchOptions(batchCache)
        setForm((f) => ({
          ...f,
          items: f.items.map((row) => {
            if (!row._requestedAllocation?.length) return row
            const key = `${row.item_id}|${f.from_branch_id}`
            const batches = batchCache[key] || []
            return {
              ...row,
              batchAllocation: fromApiPayload(row._requestedAllocation, batches),
              batchAllocationCustom: true,
              _requestedAllocation: undefined,
            }
          }),
        }))
      } catch (err) {
        console.error('Failed to load transfer:', err)
        toast.error('Failed to load transfer')
        navigate('/transfers', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [isEdit, transferId, navigate])

  const transferSummary = useMemo(() => {
    const lines = form.items.filter((row) => row.item_id)
    const qty = lines.reduce((sum, row) => sum + (Number(row.qty) || 0), 0)
    const tracked = lines.filter((row) => items.find((item) => item.id === row.item_id)?.batch_tracking).length
    const fromBranch = branchById.get(form.from_branch_id)
    const toBranch = branchById.get(form.to_branch_id)
    return {
      lines: lines.length,
      qty,
      tracked,
      fromBranch,
      toBranch,
    }
  }, [form.items, form.from_branch_id, form.to_branch_id, items, branchById])

  const loadBatchesForRow = useCallback(async (itemId) => {
    if (!itemId) return null
    const key = `${itemId}|${form.from_branch_id}`
    if (batchOptions[key]) return batchOptions[key]
    try {
      const data = await itemsAPI.batches.list(itemId, { branch_id: form.from_branch_id })
      const rows = allocatableBatches(data?.items || [])
      setBatchOptions((prev) => ({ ...prev, [key]: rows }))
      return rows
    } catch {
      setBatchOptions((prev) => ({ ...prev, [key]: [] }))
      return []
    }
  }, [batchOptions, form.from_branch_id])

  useEffect(() => {
    let mutated = false
    const next = form.items.map((row) => {
      if (!row.item_id || row.batchAllocationCustom) return row
      const picked = items.find((x) => x.id === row.item_id)
      if (!picked?.batch_tracking) return row
      const key = `${row.item_id}|${form.from_branch_id}`
      const batches = batchOptions[key]
      if (batches === undefined) {
        loadBatchesForRow(row.item_id)
        return row
      }
      if (batches.length === 0) return row
      const auto = computeAutoAllocation(batches, Number(row.qty) || 0)
      const same = JSON.stringify(auto) === JSON.stringify(row.batchAllocation || [])
      if (same) return row
      mutated = true
      return { ...row, batchAllocation: auto }
    })
    if (mutated) setForm((f) => ({ ...f, items: next }))
  }, [form.items, form.from_branch_id, batchOptions, items, loadBatchesForRow])

  const addItemRow = () => setForm((f) => ({
    ...f,
    items: [...f.items, { ...EMPTY_LINE }],
  }))

  const removeItemRow = (i) => setForm((f) => ({
    ...f,
    items: f.items.filter((_, idx) => idx !== i),
  }))

  const patchItem = (i, k, v) => setForm((f) => ({
    ...f,
    items: f.items.map((it, idx) => {
      if (idx !== i) return it
      if (k === 'item_id') return { ...it, item_id: v, batchAllocation: [], batchAllocationCustom: false }
      if (k === 'qty') return { ...it, qty: v, batchAllocationCustom: false }
      return { ...it, [k]: v }
    }),
  }))

  const goBack = () => navigate('/transfers')

  const saveTransfer = async () => {
    const validation = validateTransferForm(form, items, batchOptions)
    if (!validation.ok) {
      toast.error(validation.error)
      return
    }
    setSaving(true)
    try {
      if (isEdit) {
        const payload = buildTransferPayload(form, items, { refNumber })
        await transfersAPI.update(transferId, payload)
        toast.success(`${refNumber} updated`)
      } else {
        const payload = buildTransferPayload(form, items, { requestedBy: user?.name || 'Staff' })
        const res = await transfersAPI.create(payload)
        toast.success(
          res.status === 'transit'
            ? `Transfer ${res.ref_number} approved and dispatched`
            : `Transfer ${res.ref_number} submitted for approval`,
        )
      }
      navigate('/transfers')
    } catch (err) {
      console.error('Failed to save transfer:', err)
      toast.error(err?.response?.data?.detail || `Failed to ${isEdit ? 'update' : 'create'} transfer`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>Loading transfer…</div>
      </div>
    )
  }

  return (
    <>
      <div className="page-container page-container--with-footer transfer-page-shell">
        <div className="transfer-hero">
          <div className="transfer-hero__copy">
            <div className="transfer-hero__eyebrow">Inventory movement</div>
            <h1>{isEdit ? 'Refine a transfer before approval' : 'Create a sharp transfer request'}</h1>
            <p>
              Move stock between branches with batch-aware allocation, clear routing, and a more focused workspace.
            </p>
          </div>
          <div className="transfer-hero__stats">
            <div className="transfer-stat">
              <span>Lines</span>
              <strong>{transferSummary.lines}</strong>
            </div>
            <div className="transfer-stat">
              <span>Total qty</span>
              <strong>{transferSummary.qty}</strong>
            </div>
            <div className="transfer-stat">
              <span>Tracked</span>
              <strong>{transferSummary.tracked}</strong>
            </div>
          </div>
        </div>

        <div className="transfer-page-grid">
          <div className="transfer-page-main">
            <Card title="Transfer details">
              <TransferFormFields
                form={form}
                patchForm={patchForm}
                branches={branches}
                items={items}
                itemsLoading={itemsLoading}
                batchOptions={batchOptions}
                loadBatchesForRow={loadBatchesForRow}
                onOpenAllocEditor={setAllocEditor}
                patchItem={patchItem}
                addItemRow={addItemRow}
                removeItemRow={removeItemRow}
                disabled={saving}
                refNumber={isEdit ? refNumber : null}
              />
            </Card>
          </div>
        </div>
      </div>

      <BatchAllocationModal
        open={!!allocEditor}
        onClose={() => setAllocEditor(null)}
        item={allocEditor ? { name: allocEditor.itemName, emoji: '🧴', expiry_tracking: allocEditor.expiryTracking } : null}
        qty={allocEditor ? Number(form.items[allocEditor.index]?.qty || 0) : 0}
        batches={allocEditor?.batches || []}
        allocation={allocEditor ? (form.items[allocEditor.index]?.batchAllocation || []) : []}
        strategyLabel={allocEditor?.expiryTracking ? 'FEFO' : 'FIFO'}
        onSave={(next) => {
          if (!allocEditor) return
          setForm((f) => ({
            ...f,
            items: f.items.map((it, idx) => idx === allocEditor.index
              ? { ...it, batchAllocation: next, batchAllocationCustom: true }
              : it),
          }))
          setAllocEditor(null)
          toast.success('Batch split saved')
        }}
      />

      <div className="page-footer-bar" style={{ left: footerLeft }}>
        <button type="button" className="btn btn-secondary" onClick={goBack} disabled={saving}>
          ← Back to Transfers
        </button>
        <button type="button" className="btn btn-primary" onClick={saveTransfer} disabled={saving || itemsLoading}>
          {saving ? 'Saving…' : (isEdit ? 'Update Transfer' : 'Submit Request')}
        </button>
      </div>
    </>
  )
}

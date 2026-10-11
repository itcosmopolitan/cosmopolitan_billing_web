import { useEffect, useRef } from 'react'
import { Modal } from '@/components/ui'

let branchLineGuard = null

export function documentHasSelectedLines(items) {
  return (items || []).some((line) => line?.item_id || String(line?.name || '').trim())
}

export function applyDocumentBranch(setForm, branchId, { resetCounter = false, emptyItems = null } = {}) {
  setForm((current) => {
    if (!current || !branchId) return current
    if (current.branchId === branchId && !emptyItems) return current
    return {
      ...current,
      branchId,
      ...(resetCounter ? { childCounterId: '', childCounterName: '' } : {}),
      ...(emptyItems ? { items: emptyItems() } : {}),
    }
  })
}

/** Register the open transaction so a branch switch can ask before clearing lines. */
export function useTransactionBranchGuard({
  enabled = true,
  hasLines = false,
  activeBranchId,
  onConfirm,
  onSync,
}) {
  const confirmRef = useRef(onConfirm)
  const syncRef = useRef(onSync)
  confirmRef.current = onConfirm
  syncRef.current = onSync

  useEffect(() => {
    if (!enabled || !hasLines) return undefined
    const guard = {
      confirm: (branch) => confirmRef.current?.(branch),
    }
    branchLineGuard = guard
    return () => {
      if (branchLineGuard === guard) branchLineGuard = null
    }
  }, [enabled, hasLines])

  useEffect(() => {
    if (!enabled || hasLines || !activeBranchId) return
    syncRef.current?.(activeBranchId)
  }, [enabled, hasLines, activeBranchId])
}

export function hasBranchLineGuard() {
  return Boolean(branchLineGuard)
}

export function confirmBranchLineChange(branch) {
  branchLineGuard?.confirm?.(branch)
}

export function BranchLineConfirmModal({ open, branchName, onCancel, onConfirm }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      align="top"
      title="Change branch?"
      icon="🏢"
      size="sm"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>Confirm</button>
        </>
      )}
    >
      <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        The current line items will be removed. This transaction will load items for{' '}
        <strong>{branchName || 'the selected branch'}</strong>.
      </div>
    </Modal>
  )
}

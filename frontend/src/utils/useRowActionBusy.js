import { useCallback, useState } from 'react'

/** Track one in-flight row action so menus/buttons stay disabled until the API resolves. */
export function useRowActionBusy() {
  const [actionBusy, setActionBusy] = useState(null)
  const [actionKind, setActionKind] = useState(null)

  const isBusy = !!actionBusy
  const isRowBusy = useCallback((id) => actionBusy === id, [actionBusy])

  const runRowAction = useCallback(async (id, kind, fn) => {
    if (actionBusy) return
    setActionBusy(id)
    setActionKind(kind)
    try {
      return await fn()
    } finally {
      setActionBusy(null)
      setActionKind(null)
    }
  }, [actionBusy])

  return { actionBusy, actionKind, isBusy, isRowBusy, runRowAction }
}

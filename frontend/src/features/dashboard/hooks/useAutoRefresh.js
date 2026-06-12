import { useCallback, useState } from 'react'

export function useAutoRefresh(initial = false) {
  const [autoRefresh, setAutoRefresh] = useState(initial)
  const toggleAutoRefresh = useCallback(() => setAutoRefresh((v) => !v), [])
  return { autoRefresh, setAutoRefresh, toggleAutoRefresh }
}

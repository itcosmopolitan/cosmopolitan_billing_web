import { useEffect, useState } from 'react'

export function useDebouncedFilters(filters, delay = 400) {
  const [debounced, setDebounced] = useState(filters)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(filters), delay)
    return () => window.clearTimeout(timer)
  }, [filters, delay])

  return debounced
}

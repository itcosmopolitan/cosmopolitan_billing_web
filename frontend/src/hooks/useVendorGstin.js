import { useEffect, useState } from 'react'
import { vendorsAPI } from '@/api'

/** GSTIN of the selected vendor, or '' while it is unknown or still loading. */
export function useVendorGstin(vendorId) {
  const [state, setState] = useState({ vendorId: null, gstin: '' })

  useEffect(() => {
    if (!vendorId) return undefined
    let cancelled = false
    vendorsAPI.get(vendorId)
      .then((v) => { if (!cancelled) setState({ vendorId, gstin: v?.gstin || '' }) })
      .catch(() => { if (!cancelled) setState({ vendorId, gstin: '' }) })
    return () => { cancelled = true }
  }, [vendorId])

  if (!vendorId) return ''
  return state.vendorId === vendorId ? state.gstin : ''
}

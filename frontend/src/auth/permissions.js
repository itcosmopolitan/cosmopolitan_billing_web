/**
 * Frontend permission helper.
 *
 * Server is the source of truth (see docs/USERS_AND_ROLES.md §2.3) — useCan()
 * is only for hiding UI. Don't use it for security checks.
 *
 * Usage:
 *   const can = useCan()
 *   {can('items.create') && <Button>+ Add Item</Button>}
 *   {can('items.edit', 'item_master.delete') && <RowActions />}   // prefer master-level delete
 */
import { useCallback } from 'react'
import { useAppStore } from '@/store'

const expand = (granted = [], catalog = {}) => {
  const out = new Set()
  if (granted.includes('*')) {
    Object.entries(catalog).forEach(([m, acts]) =>
      acts.forEach((a) => out.add(`${m}.${a}`))
    )
    // Also mark the wildcard itself so callers can short-circuit
    // (perm catalog may not be available yet during early renders).
    out.add('*')
    return out
  }
  granted.forEach((p) => {
    if (typeof p !== 'string') return
    if (p.endsWith('.*')) {
      const mod = p.slice(0, -2)
      ;(catalog[mod] || []).forEach((a) => out.add(`${mod}.${a}`))
    } else {
      out.add(p)
    }
  })
  return out
}

/**
 * Returns a stable `can(...needed)` that is true if the current user has any
 * one of the requested permissions. Memoized on permissions/catalog so it is
 * safe in useEffect dependency arrays (a new function every render caused
 * infinite fetch loops on edit pages).
 */
export const useCan = () => {
  const permissions = useAppStore((s) => s.permissions)
  const permCatalog = useAppStore((s) => s.permCatalog)
  return useCallback((...needed) => {
    const set = expand(permissions, permCatalog)
    if (set.has('*')) return true
    return needed.some((p) => set.has(p))
  }, [permissions, permCatalog])
}

export const expandPermissions = expand

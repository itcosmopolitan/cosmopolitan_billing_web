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
 * Returns a function `can(...needed)` that returns true if the current user
 * has any one of the requested permissions. Re-derives on every store change.
 */
export const useCan = () => {
  const permissions = useAppStore((s) => s.permissions)
  const permCatalog = useAppStore((s) => s.permCatalog)
  const set = expand(permissions, permCatalog)
  return (...needed) => {
    if (set.has('*')) return true
    return needed.some((p) => set.has(p))
  }
}

export const expandPermissions = expand

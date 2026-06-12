import { useCan } from '@/auth/permissions'

export default function PermissionGate({ permission, permissions, fallback = null, children }) {
  const can = useCan()
  const needed = permissions || (permission ? [permission] : [])
  if (!needed.length || can(...needed)) return children
  return fallback
}

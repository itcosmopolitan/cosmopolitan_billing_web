/**
 * Route guards. Wired into App.jsx since Phase 1.5 (RequireAuth around the
 * AppShell) and Phase 2/3 (RequirePerm around individual routes).
 *
 * See docs/USERS_AND_ROLES.md §8.4.
 */
import { Navigate } from 'react-router-dom'
import { useAppStore } from '@/store'
import { useCan } from './permissions'

export function RequireAuth({ children }) {
  const user = useAppStore((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  return children
}

/**
 * Force the user to /change-password if the backend says they must — i.e.
 * an admin just created their account with a temp password and they haven't
 * picked their own yet. Wrap around AppShell AFTER RequireAuth so this only
 * fires for logged-in users.
 *
 * The /change-password route itself does NOT use this guard (would loop).
 * It uses RequireAuth alone so the user can land there with a valid JWT
 * and complete the change. After success, ChangePasswordPage refetches
 * /auth/me to clear the flag in the store and lets the user proceed.
 */
export function RequirePasswordSet({ children }) {
  const user = useAppStore((s) => s.user)
  if (user && user.must_change_password) {
    return <Navigate to="/change-password" replace />
  }
  return children
}

export function RequirePerm({ perm, perms, children, fallback }) {
  const can = useCan()
  const needed = perms || (perm ? [perm] : [])
  // Deny by default. A bare <RequirePerm><Page /></RequirePerm> with no
  // perm/perms prop is almost certainly a bug; render Forbidden rather than
  // silently letting the page through.
  if (needed.length === 0) {
    return fallback || <Forbidden requiredPerm="(none specified)" />
  }
  if (can(...needed)) return children
  return fallback || <Forbidden requiredPerm={needed.join(' or ')} />
}

export function Forbidden({ requiredPerm }) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🔒</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
        You don&apos;t have access to this page
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        Missing permission: <code>{requiredPerm}</code>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 18 }}>
        Ask your administrator to grant it from Settings &rarr; Users &amp; Roles.
      </div>
    </div>
  )
}

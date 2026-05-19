/**
 * Forced + voluntary password change. Standalone page (no AppShell / sidebar)
 * because the forced-change flow blocks all navigation until done — the bare
 * layout makes that obvious.
 *
 * Two ways the user lands here:
 *   1. Admin just created their account with a temp password
 *      → /auth/login → user.must_change_password === true → LoginPage
 *      navigates here, OR App.jsx's RequirePasswordSet guard catches them
 *      on any other route.
 *   2. Voluntary "change my password" from the user menu (future). Same form
 *      either way; the only difference is whether they had a meaningful
 *      previous password vs the temp one they were given.
 */
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'

import { authAPI } from '@/api'
import { useAppStore } from '@/store'

const MIN_LENGTH = 8

export default function ChangePasswordPage() {
  const navigate = useNavigate()
  const user = useAppStore((s) => s.user)
  const setUser = useAppStore((s) => s.setUser)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // No user in the store → bounce to login. RequireAuth would do this for
  // wrapped routes, but ChangePasswordPage is reachable without that wrap.
  if (!user) return <Navigate to="/login" replace />

  const forced = !!user.must_change_password

  const validate = () => {
    if (!oldPassword) return 'Current password is required.'
    if (newPassword.length < MIN_LENGTH) {
      return `New password must be at least ${MIN_LENGTH} characters.`
    }
    if (newPassword === oldPassword) {
      return 'New password must be different from the current one.'
    }
    if (newPassword !== confirm) return "New passwords don't match."
    return null
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (submitting) return
    const err = validate()
    if (err) { toast.error(err); return }

    setSubmitting(true)
    try {
      await authAPI.changePassword(oldPassword, newPassword)
      // Refresh user from /auth/me so must_change_password flips to false
      // in the store. Falls back to a local patch if /me fails for any reason.
      try {
        const fresh = await authAPI.me()
        setUser(fresh)
      } catch {
        setUser({ ...user, must_change_password: false })
      }
      toast.success('Password updated')
      navigate('/dashboard', { replace: true })
    } catch (err) {
      // Toast already fired by the global axios interceptor.
      console.error(err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-base)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderRadius: 14, padding: 28,
      }}>
        <div style={{ marginBottom: 6, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
          {forced ? 'Set your password' : 'Change password'}
        </div>
        <div style={{ marginBottom: 22, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {forced ? (
            <>
              Your administrator created this account with a temporary password.
              Pick a new one to continue. Minimum {MIN_LENGTH} characters.
            </>
          ) : (
            <>Enter your current password and a new one of at least {MIN_LENGTH} characters.</>
          )}
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="form-label">
              {forced ? 'Temporary password' : 'Current password'}
            </label>
            <input
              className="form-input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">New password</label>
            <input
              className="form-input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">Confirm new password</label>
            <input
              className="form-input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{ marginTop: 6 }}
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>

        {!forced && (
          <div style={{ marginTop: 18, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => navigate(-1)}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        )}

        <div style={{
          marginTop: 22, paddingTop: 16,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center',
        }}>
          Signed in as <strong>{user.email}</strong>
        </div>
      </div>
    </div>
  )
}

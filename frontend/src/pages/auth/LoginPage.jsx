import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAppStore } from '@/store'
import { authAPI, permissionsAPI } from '@/api'

// Demo accounts shown on the login screen. Email + password MUST match what
// `backend/src/seed.py` writes — these are passed straight to the real
// /auth/login endpoint (Phase 1.5 — fixes ISS-002).
const DEMO_USERS = [
  { email: 'suresh@srimurugan.com',  password: 'admin123',   name: 'Suresh Anand', role: 'super_admin',       avatar: 'SA' },
  { email: 'kavitha@srimurugan.com', password: 'kavitha123', name: 'Kavitha R.',   role: 'branch_manager',    avatar: 'KR' },
  { email: 'arjun@srimurugan.com',   password: 'arjun123',   name: 'Arjun M.',     role: 'cashier',           avatar: 'AM' },
  { email: 'deepa@srimurugan.com',   password: 'deepa123',   name: 'Deepa S.',     role: 'inventory_manager', avatar: 'DS' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const [email, setEmail] = useState('suresh@srimurugan.com')
  const [password, setPassword] = useState('admin123')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    try {
      const { token, user } = await authAPI.login(email.trim().toLowerCase(), password)
      if (!token || !user) throw new Error('Malformed login response')
      localStorage.setItem('retailos_token', token)
      // Refresh the catalog in case the boot fetch failed (catalog is open
      // access — this is a cheap call).
      const catalog = await permissionsAPI.catalog().catch(() => undefined)
      setSession({ user, permissions: user.permissions || [], permCatalog: catalog })
      // Admin-created accounts (or admin-reset ones) land here with a temp
      // password and must change it before doing anything else. The
      // RequirePasswordSet guard would also catch this on any other route,
      // but routing directly here is friendlier than a redirect flash.
      if (user.must_change_password) {
        toast('Please set a new password to continue', { icon: '🔐' })
        navigate('/change-password', { replace: true })
        return
      }
      toast.success(`Welcome back, ${user.name}!`)
      navigate('/dashboard')
    } catch (err) {
      // Toast already fired by global axios interceptor; nothing else to do.
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-base)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 420 }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ width: 54, height: 54, borderRadius: 16, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, margin: '0 auto 16px' }}>R</div>
          <h1 style={{ fontSize: 26, letterSpacing: '-0.5px', marginBottom: 6 }}>Cosmopolitan Pro</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Multi-branch retail management platform</p>
        </div>

        {/* Login Card */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 20, padding: 32, marginBottom: 20 }}>
          <h3 style={{ marginBottom: 24, fontSize: 18 }}>Sign in to your account</h3>

          <form onSubmit={handleLogin}>
            <div className="form-group">
              <label className="form-label">Email address</label>
              <input
                className="form-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoFocus
              />
            </div>
            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Password</label>
              <input
                className="form-input"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <button className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} type="submit" disabled={loading}>
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg className="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="white" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Signing in…
                </span>
              ) : 'Sign In →'}
            </button>
          </form>
        </div>

        {/* Demo Accounts */}
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 16, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Demo Accounts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DEMO_USERS.map(u => (
              <button key={u.email} onClick={() => { setEmail(u.email); setPassword(u.password) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', background: 'var(--bg-raised)',
                  border: `1px solid ${email === u.email ? 'var(--accent)' : 'var(--border-default)'}`,
                  borderRadius: 10, cursor: 'pointer', textAlign: 'left', width: '100%',
                  transition: 'all 0.12s',
                }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{u.avatar}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.role.replace('_', ' ')} · {u.email}</div>
                </div>
                {email === u.email && <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 14 }}>✓</span>}
              </button>
            ))}
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 20 }}>
          Sri Murugan Traders Pvt Ltd · Maldives operations
        </p>
      </div>
    </div>
  )
}

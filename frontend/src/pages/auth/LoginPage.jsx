import { useState } from 'react'
import '@/styles/login.css'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAppStore } from '@/store'
import { authAPI } from '@/api'
import { resetSessionExpiryGuard } from '@/api/index'
import {
  applyBootstrapToStore,
  bootstrapAuthenticatedData,
} from '@/auth/bootstrap'
import BrandLogo from '@/components/BrandLogo'
import { Eye, EyeOff } from '@/components/ui/Icons'

const MailIcon = (props) => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
    <rect x="2" y="4" width="20" height="16" rx="2.5" />
    <path d="M2.5 6.5L12 13l9.5-6.5" />
  </svg>
)
const LockIcon = (props) => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
    <rect x="4" y="11" width="16" height="9" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)
const ArrowRightIcon = (props) => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
)
const CheckIcon = (props) => (
  <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const ClockIcon = (props) => (
  <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

const LEDGER_BADGES = ['Live audit trail', 'Branch secure']

const LEDGER_ROWS = [
  { name: 'Invoice reconciliation', id: 'INV-2026-1048', amount: '₹42,860', status: 'ok', label: 'Matched' },
  { name: 'Supplier settlement', id: 'VEN-8841', amount: '₹18,420', status: 'pending', label: 'Pending' },
  { name: 'Cash drawer close', id: 'BR-MDU-03', amount: '₹67,900', status: 'ok', label: 'Verified' },
  { name: 'Stock adjustment', id: 'ADJ-5172', amount: '12 units', status: 'ok', label: 'Posted' },
]

const LEDGER_STATS = [
  { value: '24/7', label: 'Audit logging' },
  { value: 'Real-time', label: 'Inventory sync' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const setPermCatalog = useAppStore((s) => s.setPermCatalog)
  const setBranches = useAppStore((s) => s.setBranches)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [recoveryLoading, setRecoveryLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    try {
      const { token, user } = await authAPI.login(email.trim().toLowerCase(), password)
      if (!token || !user) throw new Error('Malformed login response')
      localStorage.setItem('retailos_token', token)
      resetSessionExpiryGuard()
      // Set session immediately so route guards pass, then load branches + fresh /me.
      setSession({ user, permissions: user.permissions || [] })
      const boot = await bootstrapAuthenticatedData()
      applyBootstrapToStore(boot, { setSession, setPermCatalog, setBranches })
      if (user.must_change_password) {
        toast('Please set a new password to continue', { icon: '🔐' })
        navigate('/change-password', { replace: true })
        return
      }
      toast.success(`Welcome back, ${user.name}!`)
      navigate('/dashboard')
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = async (e) => {
    e.preventDefault()
    if (recoveryLoading) return
    const emailToRecover = recoveryEmail.trim().toLowerCase()
    if (!emailToRecover) {
      toast.error('Enter your work email to receive a temporary password')
      return
    }
    setRecoveryLoading(true)
    try {
      const result = await authAPI.forgotPassword(emailToRecover)
      toast.success(result?.message || 'If an account exists for that email, a temporary password will be sent.')
      setRecoveryMode(false)
      setEmail(emailToRecover)
      setPassword('')
    } catch (err) {
      console.error(err)
    } finally {
      setRecoveryLoading(false)
    }
  }

  return (
    <div className="page-wrapper login-shell">
      <div className="login-card login-grid">
        <section className="login-panel login-panel--form">
          <div className="login-panel-inner">
            <div className="login-brand-row">
              <BrandLogo className="login-logo-img" height={26} maxWidth={200} />
            </div>
            <div className="login-eyebrow">Billing &amp; audit workspace</div>

            <div className="login-heading">
              <h1>Sign in to your workspace</h1>
              <p>Access invoices, reconciliations, and audit trails for your organization.</p>
            </div>

            {recoveryMode ? (
              <form onSubmit={handleForgotPassword} className="login-form">
                <div className="form-group">
                  <label className="form-label">Work email</label>
                  <div className="login-input-wrap">
                    <MailIcon className="login-input-icon" />
                    <input
                      className="form-input"
                      type="email"
                      value={recoveryEmail}
                      onChange={(e) => setRecoveryEmail(e.target.value)}
                      placeholder="sellostore@company.com"
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <div className="login-form-footer">
                  <button type="button" className="login-forgot" onClick={() => setRecoveryMode(false)}>
                    Back to sign in
                  </button>
                </div>

                <button className="btn btn-primary btn-lg login-submit" type="submit" disabled={recoveryLoading}>
                  {recoveryLoading ? 'Generating temp password…' : 'Generate temporary password'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleLogin} className="login-form">
                <div className="form-group">
                  <label className="form-label">Work email</label>
                  <div className="login-input-wrap">
                    <MailIcon className="login-input-icon" />
                    <input
                      className="form-input"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="sellostore@company.com"
                      required
                      autoFocus
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Password</label>
                  <div className="login-input-wrap">
                    <LockIcon className="login-input-icon" />
                    <input
                      className="form-input"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      required
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div className="login-form-footer">
                  <button type="button" className="login-forgot" onClick={() => {
                    setRecoveryEmail(email)
                    setRecoveryMode(true)
                  }}>
                    Forgot password?
                  </button>
                </div>

                <button className="btn btn-primary btn-lg login-submit" type="submit" disabled={loading}>
                  {loading ? (
                    <span className="login-submit-loading">Signing in…</span>
                  ) : (
                    <>
                      <span className="login-submit-label">Sign in to workspace</span>
                      <ArrowRightIcon className="login-submit-icon" />
                    </>
                  )}
                </button>
              </form>
            )}

            <p className="login-footnote">
              <LockIcon width={12} height={12} />
              Sessions are encrypted end-to-end
            </p>
          </div>
        </section>

        <section className="login-panel login-panel--hero">
          <img className="login-hero-photo" src="/assets/login-hero.jpg" alt="" aria-hidden="true" />
          <div className="login-hero-scrim" />
          <div className="login-hero-grid" />

          <div className="login-hero-badges" aria-label="Security features">
            {LEDGER_BADGES.map((badge) => (
              <span className="login-hero-badge" key={badge}>
                <CheckIcon aria-hidden="true" />
                {badge}
              </span>
            ))}
          </div>

          <div className="hero-copy">
            <h2>Close books faster and <span>verified.</span></h2>
            <p>Track invoices, purchases, branch cash, and stock changes with a clear record of every approval.</p>
          </div>

          <div className="login-ledger-card" aria-label="Recent ledger activity">
            <div className="login-ledger-head">
              <span>Ledger activity</span>
              <span className="login-ledger-live">Live</span>
            </div>
            <div className="login-ledger-body">
              {LEDGER_ROWS.map((row) => (
                <div className="login-ledger-row" key={row.id}>
                  <div>
                    <span className="login-ledger-name">{row.name}</span>
                    <span className="login-ledger-id">{row.id}</span>
                  </div>
                  <span className="login-ledger-amount">{row.amount}</span>
                  <span className={`login-ledger-status login-ledger-status--${row.status}`}>
                    {row.status === 'ok' ? <CheckIcon aria-hidden="true" /> : <ClockIcon aria-hidden="true" />}
                    {row.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="login-stat-strip" aria-label="Workspace stats">
            {LEDGER_STATS.map((stat) => (
              <div className="login-stat" key={stat.label}>
                <div className="login-stat-value">{stat.value}</div>
                <div className="login-stat-label">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

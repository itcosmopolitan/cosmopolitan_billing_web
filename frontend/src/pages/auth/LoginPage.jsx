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

const DEMO_USERS = [
  { email: 'suresh@srimurugan.com',  password: 'admin123',   name: 'Suresh Anand', role: 'Super Admin',       avatar: 'SA' },
  { email: 'kavitha@srimurugan.com', password: 'kavitha123', name: 'Kavitha R.',   role: 'Branch Manager',    avatar: 'KR' },
  { email: 'arjun@srimurugan.com',   password: 'arjun123',   name: 'Arjun M.',     role: 'Cashier',           avatar: 'AM' },
]

const FEATURES = [
  { icon: '🏢', label: 'Multi-Branch Management' },
  { icon: '📦', label: 'Real-Time Inventory Tracking' },
  { icon: '📊', label: 'Sales & Revenue Analytics' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const setPermCatalog = useAppStore((s) => s.setPermCatalog)
  const setBranches = useAppStore((s) => s.setBranches)
  const [selectedRole, setSelectedRole] = useState('Super Admin')
  const [email, setEmail] = useState('suresh@srimurugan.com')
  const [password, setPassword] = useState('admin123')
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)

  const selectRole = (user) => {
    setSelectedRole(user.role)
    setEmail(user.email)
    setPassword(user.password)
  }

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

  return (
    <div className="page-wrapper login-shell">
      <div className="login-card login-grid">
          <section className="login-panel login-panel--form">
          <div className="login-panel-inner">
            <div className="login-logo">
              <span className="login-logo-mark">C</span>
              <span className="login-logo-text">Cosmopolitan</span>
            </div>

            <div className="login-heading">
              <h1>Welcome Back</h1>
              <p>Enter your email and password to access your account.</p>
            </div>

            <form onSubmit={handleLogin} className="login-form">
              <div className="form-group">
                <label className="form-label">Email</label>
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

              <div className="form-group">
                <label className="form-label">Password</label>
                <input
                  className="form-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                />
              </div>

              <div className="login-form-footer">
                <label className="login-remember">
                  <input type="checkbox" checked={rememberMe} onChange={() => setRememberMe(!rememberMe)} />
                  Remember Me
                </label>
                <button type="button" className="login-forgot" onClick={() => toast('Forgot password flow coming soon')}>Forgot Your Password?</button>
              </div>

              <button className="btn btn-primary btn-lg login-submit" type="submit" disabled={loading}>
                {loading ? (
                  <span className="login-submit-loading">Signing in…</span>
                ) : (
                  <>
                    <span className="login-submit-label">Log In</span>
                    <span className="login-submit-icon">→</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </section>

        <section className="login-panel login-panel--hero">
          <div className="shape-1" />
          <div className="shape-2" />
          <div className="shape-3" />
          <div className="shape-4" />
          <div className="hero-copy">
            <span className="hero-tag">DASHBOARD PREVIEW</span>
            <h2>Effortlessly manage your team and operations.</h2>
            <p>Log in to access your CRM dashboard and oversee sales, stock, and retail performance in one place.</p>
          </div>

          <div className="hero-visual">
            <div className="dashboard-showcase">
              <img className="dashboard-image" src="/assets/dashboard-screenshot.png" alt="Dashboard preview" />
{/* 
              <div className="dashboard-card dashboard-card--analytics">
                <div className="card-title">Total Sales</div>
                <div className="card-value">$189,374</div>
                <div className="card-note">+18.3% this month</div>
              </div> */}

              <div className="dashboard-card dashboard-card--orders">
                <div className="card-title">Orders</div>
                <div className="card-value">1,248</div>
              </div>

              {/* <div className="dashboard-card dashboard-card--category">
                <div className="card-title">Top Category</div>
                <div className="card-value">Electronics</div>
              </div> */}
            </div>
          </div>
          </section>
        </div>
    </div>
  )
}
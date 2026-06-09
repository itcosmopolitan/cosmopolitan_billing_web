import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAppStore } from '@/store'
import { authAPI, permissionsAPI } from '@/api'

const DEMO_USERS = [
  { email: 'suresh@srimurugan.com',  password: 'admin123',   name: 'Suresh Anand', role: 'Super Admin',       avatar: 'SA' },
  { email: 'kavitha@srimurugan.com', password: 'kavitha123', name: 'Kavitha R.',   role: 'Branch Manager',    avatar: 'KR' },
  { email: 'arjun@srimurugan.com',   password: 'arjun123',   name: 'Arjun M.',     role: 'Cashier',           avatar: 'AM' },
  { email: 'deepa@srimurugan.com',   password: 'deepa123',   name: 'Deepa S.',     role: 'Inventory Manager', avatar: 'DS' },
]

const FEATURES = [
  { icon: '🏢', label: 'Multi-Branch Management' },
  { icon: '📦', label: 'Real-Time Inventory Tracking' },
  { icon: '📊', label: 'Sales & Revenue Analytics' },
  { icon: '💳', label: 'Billing & POS Operations' },
  { icon: '👥', label: 'Customer Management' },
  { icon: '🚚', label: 'Supplier Management' },
]

const SECURE_ITEMS = [
  { icon: '🧲', label: 'Protected Login Flow' },
  { icon: '⚙️', label: 'Adaptive Access Controls' },
  { icon: '✅', label: 'Verified Role Enforcement' },
  { icon: '📡', label: 'Encrypted Data Transit' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((s) => s.setSession)
  const [email, setEmail] = useState('suresh@srimurugan.com')
  const [password, setPassword] = useState('admin123')
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    try {
      const { token, user } = await authAPI.login(email.trim().toLowerCase(), password)
      if (!token || !user) throw new Error('Malformed login response')
      localStorage.setItem('retailos_token', token)
      const catalog = await permissionsAPI.catalog().catch(() => undefined)
      setSession({ user, permissions: user.permissions || [], permCatalog: catalog })
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
    <div className="login-shell">
      <div className="login-grid">
        <section className="login-hero">
          <div className="login-brand">
            <span className="login-brand-label">Complete Retail Management Platform</span>
            <h1>Manage your retail business from one powerful platform</h1>
            <p>Manage branches, inventory, sales, billing, customers, suppliers, and analytics from one unified platform.</p>
          </div>

          <div className="login-feature-list">
            {FEATURES.map((feature) => (
              <div key={feature.label} className="login-feature">
                <div className="login-feature-icon">{feature.icon}</div>
                <div className="login-feature-copy">{feature.label}</div>
              </div>
            ))}
          </div>

          <div className="login-hero-visual">
            <div className="login-visual-glow" />
            <div className="login-visual-inner">
              <div className="login-visual-stats">
                <div className="login-visual-stat">
                  <span>Today’s Sales</span>
                  <strong>$12,450.00</strong>
                  <small>+12.5% vs yesterday</small>
                </div>
                <div className="login-visual-stat">
                  <span>Total Orders</span>
                  <strong>156</strong>
                  <small>+8.2% vs yesterday</small>
                </div>
                <div className="login-visual-stat">
                  <span>Inventory Items</span>
                  <strong>2,847</strong>
                  <small>+5.7% vs yesterday</small>
                </div>
              </div>

              <div className="login-visual-body">
                <div className="login-visual-chart">
                  <div className="login-visual-chart-labels">
                    <span>Sales Overview</span>
                    <span>This Week</span>
                  </div>
                  <div className="login-chart-bars">
                    <div className="login-chart-bar bar-1" />
                    <div className="login-chart-bar bar-2" />
                    <div className="login-chart-bar bar-3" />
                    <div className="login-chart-bar bar-4" />
                    <div className="login-chart-bar bar-5" />
                    <div className="login-chart-bar bar-6" />
                    <div className="login-chart-bar bar-7" />
                  </div>
                </div>

                <div className="login-visual-products">
                  <div className="login-visual-products-header">
                    <span>Top Products</span>
                  </div>
                  <div className="login-product-row"><span>Product A</span><strong>$2,450</strong></div>
                  <div className="login-product-row"><span>Product B</span><strong>$1,850</strong></div>
                  <div className="login-product-row"><span>Product C</span><strong>$1,250</strong></div>
                  <div className="login-product-row"><span>Product D</span><strong>$980</strong></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="login-auth">
          <div className="login-card">
            <div className="login-card-header">
              <div>
                <p className="login-subtitle">Welcome Back!</p>
                <h2>Sign in to access your retail dashboard</h2>
              </div>
            </div>

            <form onSubmit={handleLogin} className="login-form">
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input
                  className="form-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email address"
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
                  placeholder="Enter your password"
                  required
                />
              </div>

              <div className="login-form-footer">
                <label className="login-remember">
                  <input type="checkbox" checked={rememberMe} onChange={() => setRememberMe(!rememberMe)} />
                  Remember me
                </label>
                <button type="button" className="login-forgot" onClick={() => toast('Forgot password flow coming soon')}>Forgot password?</button>
              </div>

              <button className="btn btn-primary btn-lg login-submit" type="submit" disabled={loading}>
                {loading ? (
                  <span className="login-submit-loading">Signing in…</span>
                ) : (
                  'Sign In →'
                )}
              </button>
            </form>
          </div>

          <div className="login-demo-card">
            <div className="login-demo-header">
              <div>
                <p className="login-demo-label">Demo Accounts</p>
                <p className="login-demo-note">Click any account to auto-fill credentials</p>
              </div>
            </div>
            <div className="login-demo-grid">
              {DEMO_USERS.map((u) => (
                <button
                  key={u.email}
                  type="button"
                  onClick={() => {
                    setEmail(u.email)
                    setPassword(u.password)
                  }}
                  className={`login-demo-user ${email === u.email ? 'active' : ''}`}
                >
                  <div className="login-demo-avatar">{u.avatar}</div>
                  <div className="login-demo-copy">
                    <div className="login-demo-name">{u.name}</div>
                    <div className="login-demo-role">{u.role} · {u.email}</div>
                  </div>
                  {email === u.email && <span className="login-demo-check">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

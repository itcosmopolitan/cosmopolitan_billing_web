import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAppStore } from '@/store'
import { authAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { Avatar } from '@/components/ui'
import { roleLabels } from '@/utils/helpers'

// Phase 2: each nav item declares the permission required to *see* it.
// Items without `perm` (or with perm: null) are visible to everyone (e.g. a
// future "Help" link). The `useCan` filter applied below hides anything the
// current user can't access — same source-of-truth strings as the backend
// route guards in src/security.py require_perm().
const navItems = [
  { section: null,        path: '/dashboard', icon: '▦',  label: 'Dashboard',       perm: 'dashboard.view' },
  { section: null,        path: '/pos',        icon: '🧾', label: 'POS Billing',     perm: 'pos.use' },
  { section: 'Inventory', path: '/items',      icon: '📦', label: 'Items & Stock',   perm: 'items.view',     badge: 4 },
  { section: null,        path: '/transfers',  icon: '↔',  label: 'Stock Transfers', perm: 'transfers.view', badge: 1 },
  { section: 'Commerce',  path: '/sales',      icon: '🛒', label: 'Sales',           perm: 'invoices.view' },
  { section: null,        path: '/purchases',  icon: '📋', label: 'Purchases',       perm: 'purchases.view', badge: 5 },
  { section: null,        path: '/customers',  icon: '👥', label: 'Customers',       perm: 'customers.view' },
  { section: null,        path: '/vendors',    icon: '🏭', label: 'Vendors',         perm: 'vendors.view' },
  { section: 'Finance',   path: '/cash',       icon: '💰', label: 'Cash Control',    perm: 'cash.view' },
  { section: null,        path: '/reports',    icon: '📊', label: 'Reports',         perm: 'reports.view' },
  { section: 'Admin',     path: '/settings',   icon: '⚙', label: 'Settings',        perm: 'settings.view' },
  { section: null,        path: '/audit',      icon: '🔍', label: 'Audit Trail',     perm: 'audit.view' },
]

export default function Sidebar() {
  const navigate = useNavigate()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const { user, activeBranch, branches, setActiveBranch, sidebarCollapsed, roles, clearSession } = useAppStore()
  const can = useCan()

  // Resolve the role label dynamically. Prefer the live `roles` list (covers
  // custom roles) and fall back to the static `roleLabels` map for the system
  // roles that ship with the app, then to the raw role string.
  const userRole = roles.find((r) => r.id === user?.role_id) || roles.find((r) => r.key === user?.role)
  const userRoleLabel = userRole?.label || roleLabels[user?.role] || user?.role || ''

  // Phase 2: hide nav items the current user can't access. Items without a
  // `perm` are always visible.
  const visibleNav = navItems.filter((item) => !item.perm || can(item.perm))

  let lastSection = null

  return (
    <aside style={{
      width: sidebarCollapsed ? 56 : 220,
      minWidth: sidebarCollapsed ? 56 : 220,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-default)',
      display: 'flex',
      flexDirection: 'column',
      position: 'fixed',
      top: 0, left: 0, bottom: 0,
      zIndex: 100,
      transition: 'width 0.2s ease',
      overflow: 'hidden',
    }}>

      {/* Logo */}
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>R</div>
          {!sidebarCollapsed && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}>Cosmopolitan</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>v2.4 · Multi-branch</div>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {visibleNav.map((item) => {
          const showSection = item.section && item.section !== lastSection
          if (item.section) lastSection = item.section
          return (
            <div key={item.path}>
              {showSection && !sidebarCollapsed && (
                <div style={{ padding: '10px 16px 4px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.09em', textTransform: 'uppercase' }}>
                  {item.section}
                </div>
              )}
              <NavLink
                to={item.path}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: sidebarCollapsed ? '10px' : '9px 16px',
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  cursor: 'pointer',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-bg)' : 'transparent',
                  fontSize: 13.5,
                  textDecoration: 'none',
                  transition: 'all 0.12s',
                  position: 'relative',
                  borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                })}
              >
                <span style={{ fontSize: 16, flexShrink: 0, width: 18, textAlign: 'center' }}>{item.icon}</span>
                {!sidebarCollapsed && (
                  <>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {item.badge && (
                      <span style={{ background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10 }}>
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </div>
          )
        })}
      </nav>

      {/* Branch selector */}
      {!sidebarCollapsed && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Active Branch</div>
          <select
            className="form-input"
            style={{ padding: '6px 10px', fontSize: 12 }}
            value={activeBranch?.id || ''}
            onChange={(e) => {
              const b = branches.find((x) => x.id === e.target.value)
              if (b) setActiveBranch(b)
            }}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* User */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-subtle)', position: 'relative' }}>
        <button
          onClick={() => setShowUserMenu(!showUserMenu)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            borderRadius: 8,
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <Avatar initials={user?.avatar || '?'} size={30} />
          {!sidebarCollapsed && (
            <div style={{ overflow: 'hidden', textAlign: 'left' }}>
              <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.name || '—'}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{userRoleLabel}</div>
            </div>
          )}
        </button>

        {/* User Menu Dropdown */}
        {showUserMenu && !sidebarCollapsed && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 14,
            right: 14,
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            marginBottom: 8,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            zIndex: 1000,
            overflow: 'hidden',
          }}>
            {/* Profile Info */}
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{user?.name || '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{user?.email || ''}</div>
            </div>

            {/* Menu Items */}
            <div>
              <button
                onClick={() => {
                  navigate('/settings')
                  setShowUserMenu(false)
                }}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  transition: 'all 0.2s',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-hover)'
                  e.currentTarget.style.color = 'var(--text-primary)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--text-secondary)'
                }}
              >
                ⚙ Profile Settings
              </button>

              <button
                onClick={() => {
                  navigate('/audit')
                  setShowUserMenu(false)
                }}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  transition: 'all 0.2s',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--bg-hover)'
                  e.currentTarget.style.color = 'var(--text-primary)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--text-secondary)'
                }}
              >
                🔍 Audit Trail
              </button>

              <button
                onClick={async () => {
                  setShowUserMenu(false)
                  // Best-effort server notification (no-op today, kept for
                  // symmetry / future audit logging).
                  authAPI.logout().catch(() => {})
                  localStorage.removeItem('retailos_token')
                  clearSession()
                  toast.success('Logged out successfully')
                  navigate('/login')
                }}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  background: 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: 'var(--red)',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--red-bg)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                🚪 Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

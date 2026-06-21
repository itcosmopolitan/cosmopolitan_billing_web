import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAppStore } from '@/store'
import { authAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { Avatar } from '@/components/ui'
import BrandLogo from '@/components/BrandLogo'
import * as Icon from '@/components/ui/Icons'
import { roleLabels } from '@/utils/helpers'

// Phase 2: each nav item declares the permission required to *see* it.
// Items without `perm` (or with perm: null) are visible to everyone (e.g. a
// future "Help" link). The `useCan` filter applied below hides anything the
// current user can't access — same source-of-truth strings as the backend
// route guards in src/security.py require_perm().
const navItems = [
  { section: 'Main',      path: '/dashboard',  Icon: Icon.Dashboard,   label: 'Dashboard',       perm: 'dashboard.view' },
  { section: null,        path: '/pos',        Icon: Icon.Receipt,     label: 'POS Billing',     perm: 'pos.use' },
  { section: 'Inventory', path: '/item-master', Icon: Icon.List,     label: 'Item Master',     perm: 'item_master.view' },
  { section: null,        path: '/items',      Icon: Icon.Package,  label: 'Items & Stock',   perm: 'items.view',     badge: 4 },
  { section: null,        path: '/transfers',  Icon: Icon.Transfer,    label: 'Stock Transfers', perm: 'transfers.view', badge: 1 },
  { section: null,        path: '/adjustments', Icon: Icon.Scale,     label: 'Stock Adjustments', perm: 'adjustments.view' },
  { section: 'Commerce',  path: '/sales',      Icon: Icon.ShoppingBag, label: 'Sales',           perm: 'invoices.view' },
  { section: null,        path: '/purchases',  Icon: Icon.Clipboard,   label: 'Purchases',       perm: 'purchases.view', badge: 5 },
  { section: null,        path: '/customers',  Icon: Icon.Users,       label: 'Customers',       perm: 'customers.view' },
  { section: null,        path: '/vendors',    Icon: Icon.Factory,     label: 'Vendors',         perm: 'vendors.view' },
  { section: 'Finance',   path: '/cash',       Icon: Icon.Wallet,      label: 'Cash Control',    perm: 'cash.view' },
  { section: null,        path: '/reports',    Icon: Icon.BarChart,    label: 'Reports',         perm: 'reports.view' },
  { section: 'Admin',     path: '/settings',   Icon: Icon.Settings,    label: 'Settings',        perm: 'settings.view' },
  { section: null,        path: '/audit',      Icon: Icon.Search,      label: 'Audit Trail',     perm: 'audit.view' },
]

const SIDEBAR_W          = 244
const SIDEBAR_W_COLLAPSED = 68

export default function Sidebar() {
  const navigate = useNavigate()
  const userMenuRef = useRef(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const { user, sidebarCollapsed, toggleSidebar, roles, clearSession } = useAppStore()
  const can = useCan()

  // Resolve the role label dynamically. Prefer the live `roles` list (covers
  // custom roles) and fall back to the static `roleLabels` map for the system
  // roles that ship with the app, then to the raw role string.
  const userRole = roles.find((r) => r.id === user?.role_id) || roles.find((r) => r.key === user?.role)
  const userRoleLabel = userRole?.label || roleLabels[user?.role] || user?.role || ''

  // Phase 2: hide nav items the current user can't access. Items without a
  // `perm` are always visible.
  const visibleNav = navItems.filter((item) => !item.perm || can(item.perm))

  // Click-outside dismissal for the profile dropdown — feels broken without it.
  useEffect(() => {
    if (!showUserMenu) return
    const onClick = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showUserMenu])

  let lastSection = null

  return (
    /* The aside intentionally has NO `overflow: hidden`. In collapsed mode
       the user-profile dropdown flies out to the right of the sidebar via
       `left: calc(100% + 6px)`, putting it at viewport x ≈ 74px — well
       outside the 68px-wide aside. Clipping here silently hides the
       dropdown and makes Profile / Audit / Sign out unreachable. Inner
       text (brand, nav labels, user name) already truncates via its own
       `overflow: hidden` + `text-overflow: ellipsis`, and the nav scroller
       sets `overflowX: hidden`, so removing it here is safe. */
    <aside style={{
      width: sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W,
      minWidth: sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W,
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-default)',
      display: 'flex',
      flexDirection: 'column',
      position: 'fixed',
      top: 0, left: 0, bottom: 0,
      zIndex: 100,
      transition: 'width 0.2s ease',
    }}>

      {/* Brand */}
      <div style={{
        height: 60,
        padding: sidebarCollapsed ? '0' : '0 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
        gap: 11,
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}>
        {sidebarCollapsed ? (
          <span className="brand-logo-wrap">
            <BrandLogo collapsed height={28} />
          </span>
        ) : (
          <div style={{ overflow: 'hidden', minWidth: 0, flex: 1 }}>
            <span className="brand-logo-wrap">
              <BrandLogo height={35} maxWidth={168} />
            </span>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        padding: sidebarCollapsed ? '10px 8px' : '12px 10px',
      }}>
        {visibleNav.map((item) => {
          const showSection = item.section && item.section !== lastSection
          if (item.section) lastSection = item.section
          return (
            <div key={item.path}>
              {showSection && !sidebarCollapsed && (
                <div style={{
                  padding: '14px 10px 6px',
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}>
                  {item.section}
                </div>
              )}
              {showSection && sidebarCollapsed && (
                <div style={{
                  height: 1, background: 'var(--border-subtle)',
                  margin: '10px 6px 8px',
                }} />
              )}
              <NavLink
                to={item.path}
                title={sidebarCollapsed ? item.label : undefined}
                style={({ isActive }) => ({
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: sidebarCollapsed ? '9px' : '8px 10px',
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  borderRadius: 8,
                  marginBottom: 2,
                  cursor: 'pointer',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  background: isActive ? 'var(--accent-bg)' : 'transparent',
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 500,
                  textDecoration: 'none',
                  transition: 'background 120ms ease, color 120ms ease',
                })}
                onMouseEnter={(e) => {
                  // Hover without breaking the active style: only apply when not active.
                  if (!e.currentTarget.classList.contains('active')) {
                    e.currentTarget.style.background = 'var(--bg-hover)'
                    e.currentTarget.style.color = 'var(--text-primary)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!e.currentTarget.classList.contains('active')) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = 'var(--text-secondary)'
                  }
                }}
              >
                {({ isActive }) => (
                  <>
                    {/* Subtle left accent bar in expanded mode. */}
                    {isActive && !sidebarCollapsed && (
                      <span style={{
                        position: 'absolute', left: -10, top: 6, bottom: 6, width: 3,
                        background: 'var(--accent)', borderRadius: '0 3px 3px 0',
                      }} />
                    )}
                    <item.Icon size={18} strokeWidth={isActive ? 2 : 1.75} />
                    {!sidebarCollapsed && (
                      <>
                        <span style={{
                          flex: 1, whiteSpace: 'nowrap',
                          overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {item.label}
                        </span>
                        {item.badge && (
                          <span style={{
                            background: isActive ? 'var(--accent)' : 'var(--red)',
                            color: '#fff',
                            fontSize: 10, fontWeight: 700,
                            minWidth: 18, height: 18,
                            padding: '0 6px',
                            borderRadius: 9,
                            display: 'inline-flex',
                            alignItems: 'center', justifyContent: 'center',
                            lineHeight: 1,
                          }}>
                            {item.badge}
                          </span>
                        )}
                      </>
                    )}
                    {sidebarCollapsed && item.badge && (
                      <span style={{
                        position: 'absolute', top: 4, right: 4,
                        width: 8, height: 8, borderRadius: '50%',
                        background: 'var(--red)',
                        boxShadow: '0 0 0 2px var(--bg-surface)',
                      }} />
                    )}
                  </>
                )}
              </NavLink>
            </div>
          )
        })}
      </nav>

      {/* User profile + collapse toggle */}
      <div style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: sidebarCollapsed ? 8 : 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        position: 'relative',
      }} ref={userMenuRef}>
        <button
          onClick={() => setShowUserMenu((v) => !v)}
          title={sidebarCollapsed ? (user?.name || 'Account') : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: sidebarCollapsed ? 4 : '8px 10px',
            justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
            background: showUserMenu ? 'var(--bg-hover)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            borderRadius: 8,
            transition: 'background 120ms ease',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => { if (!showUserMenu) e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={(e) => { if (!showUserMenu) e.currentTarget.style.background = 'transparent' }}
        >
          <Avatar initials={user?.avatar || (user?.name?.[0]?.toUpperCase() ?? '?')} size={32} />
          {!sidebarCollapsed && (
            <div style={{ overflow: 'hidden', flex: 1 }}>
              <div style={{
                fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                lineHeight: 1.2,
              }}>
                {user?.name || '—'}
              </div>
              <div style={{
                fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {userRoleLabel || 'Signed in'}
              </div>
            </div>
          )}
          {!sidebarCollapsed && (
            <Icon.ChevronDown size={14} style={{
              color: 'var(--text-muted)', flexShrink: 0,
              transform: showUserMenu ? 'rotate(180deg)' : 'none',
              transition: 'transform 150ms ease',
            }} />
          )}
        </button>

        {/* Collapse toggle (expanded mode only — topbar hamburger handles
            collapsed mode). Keeps the affordance discoverable. */}
        {!sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            title="Collapse sidebar"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '6px 10px',
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              cursor: 'pointer',
              color: 'var(--text-muted)',
              fontSize: 11.5,
              fontWeight: 500,
              transition: 'all 120ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-secondary)'
              e.currentTarget.style.background = 'var(--bg-raised)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-muted)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Icon.ChevronLeft size={14} />
            Collapse
          </button>
        )}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            title="Expand sidebar"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 6,
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              cursor: 'pointer',
              color: 'var(--text-muted)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-secondary)'
              e.currentTarget.style.background = 'var(--bg-raised)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-muted)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Icon.ChevronRight size={14} />
          </button>
        )}

        {/* User menu dropdown */}
        {showUserMenu && (
          <div style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: sidebarCollapsed ? 'calc(100% + 6px)' : 10,
            right: sidebarCollapsed ? 'auto' : 10,
            width: sidebarCollapsed ? 232 : 'auto',
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-md)',
            zIndex: 1000,
            overflow: 'hidden',
          }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                {user?.name || '—'}
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {user?.email || ''}
              </div>
            </div>

            <MenuItem
              icon={<Icon.UserCog size={15} />}
              label="Profile & Settings"
              onClick={() => { navigate('/settings'); setShowUserMenu(false) }}
            />
            <MenuItem
              icon={<Icon.Search size={15} />}
              label="Audit Trail"
              onClick={() => { navigate('/audit'); setShowUserMenu(false) }}
            />
            <div style={{ height: 1, background: 'var(--border-subtle)' }} />
            <MenuItem
              icon={<Icon.LogOut size={15} />}
              label="Sign out"
              danger
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
            />
          </div>
        )}
      </div>
    </aside>
  )
}

function MenuItem({ icon, label, onClick, danger }) {
  const baseColor = danger ? 'var(--red)' : 'var(--text-secondary)'
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '10px 14px',
        background: 'transparent', border: 'none',
        cursor: 'pointer', textAlign: 'left',
        color: baseColor,
        fontSize: 12.5, fontWeight: 500,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? 'var(--red-bg)' : 'var(--bg-hover)'
        if (!danger) e.currentTarget.style.color = 'var(--text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = baseColor
      }}
    >
      <span style={{ display: 'inline-flex', color: 'inherit' }}>{icon}</span>
      {label}
    </button>
  )
}

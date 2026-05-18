import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppStore } from '@/store'

const pageTitles = {
  '/dashboard': 'Dashboard',
  '/pos': 'POS Billing',
  '/items': 'Items & Inventory',
  '/transfers': 'Stock Transfers',
  '/sales': 'Sales Management',
  '/purchases': 'Purchase Management',
  '/customers': 'Customer Master',
  '/vendors': 'Vendor Master',
  '/cash': 'Cash Control',
  '/reports': 'Reports & Analytics',
  '/settings': 'Settings',
  '/audit': 'Audit Trail',
}

export default function Topbar() {
  const { activeBranch, toggleSidebar, theme, setTheme } = useAppStore()
  const location = useLocation()
  const navigate = useNavigate()
  const [notifOpen, setNotifOpen] = useState(false)

  const title = pageTitles[location.pathname] || 'Cosmopolitan Pro'

  const notifications = [
    { id: 1, type: 'warning', text: 'Basmati Rice critical stock at T.Nagar', time: '10 min ago' },
    { id: 2, type: 'danger', text: 'INV-2024-1840 overdue by 12 days', time: '1 hr ago' },
    { id: 3, type: 'info', text: 'TRF-041 stock transfer pending approval', time: '2 hr ago' },
  ]

  return (
    <header style={{
      height: 56, background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border-default)',
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 14,
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      {/* Menu toggle */}
      <button className="btn btn-ghost btn-sm" onClick={toggleSidebar} style={{ padding: '6px 8px' }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {/* Title */}
      <h3 style={{ flex: 1, margin: 0, fontSize: 15.5, fontWeight: 600, letterSpacing: '-0.2px' }}>{title}</h3>

      {/* Quick actions */}
      <button className="btn btn-primary btn-sm" onClick={() => navigate('/pos')}>
        <span>+</span> New Sale
      </button>

      {/* Branch pill — bound to activeBranch from the store. */}
      <div
        title={activeBranch?.name || 'No branch selected'}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px',
          background: 'var(--bg-raised)', border: '1px solid var(--border-default)',
          borderRadius: 8, cursor: 'default', fontSize: 12.5, color: 'var(--text-secondary)',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
        {activeBranch?.name || '—'}
      </div>

      {/* Notifications */}
      <div style={{ position: 'relative' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setNotifOpen(!notifOpen)} style={{ padding: '6px 8px', position: 'relative' }}>
          <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
            <path d="M8.5 2C6.3 2 4.5 3.8 4.5 6v3.5l-1.5 2h11L12.5 9.5V6c0-2.2-1.8-4-4-4zM7 14a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span style={{ position: 'absolute', top: -2, right: -2, width: 14, height: 14, background: 'var(--red)', color: '#fff', fontSize: 8, fontWeight: 800, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--bg-surface)' }}>3</span>
        </button>

        {notifOpen && (
          <div style={{
            position: 'absolute', right: 0, top: 'calc(100% + 8px)',
            width: 300, background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            borderRadius: 12, boxShadow: 'var(--shadow-md)', zIndex: 200, overflow: 'hidden',
          }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', fontSize: 13, fontWeight: 600 }}>Notifications</div>
            {notifications.map((n) => (
              <div key={n.id} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 10, cursor: 'pointer' }}
                onClick={() => setNotifOpen(false)}>
                <span style={{ fontSize: 14 }}>{n.type === 'danger' ? '🔴' : n.type === 'warning' ? '🟡' : '🔵'}</span>
                <div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{n.text}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{n.time}</div>
                </div>
              </div>
            ))}
            <div style={{ padding: '10px 16px', textAlign: 'center' }}>
              <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}>View all alerts</button>
            </div>
          </div>
        )}
      </div>

      {/* Help */}
      <button
        className="btn btn-ghost btn-sm"
        style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-muted)' }}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
      </button>
      <button className="btn btn-ghost btn-sm" style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-muted)' }}>?</button>
    </header>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAppStore, usePOSStore } from '@/store'
import { notificationsAPI } from '@/api'
import { useNotificationSocket } from '@/hooks/useNotificationSocket'
import * as Icon from '@/components/ui/Icons'
import { Modal } from '@/components/ui'

// Topbar is intentionally chrome-only: it carries global context (active
// branch) and global actions (new sale, notifications, theme, help). The
// per-page <SectionHeader> already owns the title + subtitle — repeating it
// here just produced the duplicated "Sales Management" label users noticed.

const NOTIF_TYPE = {
  danger:  { color: 'var(--red)',   bg: 'var(--red-bg)',   label: 'Critical' },
  warning: { color: 'var(--amber)', bg: 'var(--amber-bg)', label: 'Warning'  },
  info:    { color: 'var(--blue)',  bg: 'var(--blue-bg)',  label: 'Info'     },
}

const POLL_MS = 60_000

function formatRelativeTime(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return 'Just now'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default function Topbar() {
  const { user, activeBranch, branches, setActiveBranch, toggleSidebar, theme, setTheme } = useAppStore()
  const { cart, holdBill, clearCart } = usePOSStore()
  const navigate = useNavigate()
  const location = useLocation()

  const [notifOpen, setNotifOpen]   = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [pendingBranch, setPendingBranch] = useState(null)
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const notifRef  = useRef(null)
  const branchRef = useRef(null)
  const tabVisibleRef = useRef(typeof document !== 'undefined' ? !document.hidden : true)

  const branchParams = useMemo(
    () => (activeBranch?.id ? { branch_id: activeBranch.id } : undefined),
    [activeBranch?.id],
  )

  const fetchBadge = useCallback(async () => {
    if (!user?.id || !tabVisibleRef.current) return
    try {
      const res = await notificationsAPI.count(branchParams)
      setUnreadCount(res?.unread_count ?? res?.total ?? 0)
    } catch {
      // Silent — bell is non-critical.
    }
  }, [user?.id, branchParams])

  const fetchNotifications = useCallback(async () => {
    if (!user?.id) return
    try {
      const res = await notificationsAPI.list(branchParams)
      const items = res?.items || []
      setNotifications(items)
      setUnreadCount(res?.unread_count ?? items.filter((n) => !n.read).length)
    } catch {
      // Silent — bell is non-critical.
    }
  }, [user?.id, branchParams])

  useNotificationSocket(fetchBadge)

  // Poll badge only while tab is visible; pause in background tabs.
  useEffect(() => {
    const onVisibility = () => {
      tabVisibleRef.current = !document.hidden
      if (tabVisibleRef.current) fetchBadge()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [fetchBadge])

  useEffect(() => {
    fetchBadge()
    const id = setInterval(fetchBadge, POLL_MS)
    return () => clearInterval(id)
  }, [fetchBadge])

  // Refresh full list when the panel opens.
  useEffect(() => {
    if (notifOpen) fetchNotifications()
  }, [notifOpen, fetchNotifications])

  const visibleNotifications = useMemo(
    () => notifications.map((n) => ({
      ...n,
      type: n.severity || 'info',
      text: n.title,
      time: formatRelativeTime(n.created_at),
    })),
    [notifications],
  )

  const markRead = useCallback(async (id) => {
    try {
      await notificationsAPI.read(id)
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
      setUnreadCount((c) => Math.max(0, c - 1))
    } catch {
      // ignore
    }
  }, [])

  const markAllRead = useCallback(async () => {
    try {
      await notificationsAPI.readAll(branchParams)
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch {
      // ignore
    }
  }, [branchParams])

  const handleNotifClick = (n) => {
    if (!n.read) markRead(n.id)
    setNotifOpen(false)
    if (n.href) navigate(n.href)
  }

  const handleBranchSelect = (branch) => {
    setBranchOpen(false)
    const hasCartItems = (cart?.length || 0) > 0
    if (location.pathname === '/pos' && hasCartItems && branch.id !== activeBranch?.id) {
      setPendingBranch(branch)
      return
    }
    setActiveBranch(branch)
  }

  const switchBranchWithCartAction = (hold) => {
    if (!pendingBranch) return
    if (hold) holdBill(activeBranch?.id)
    else clearCart()
    const branch = pendingBranch
    setPendingBranch(null)
    setActiveBranch(branch)
  }

  // Branch picker filtered to the user's assigned branches. Users with
  // all_branches=true or no branch_ids list (legacy super-admin records) see
  // every branch. Multi-branch users get a switcher over their allowed
  // subset only. Cosmetic UI gate — backend enforcement of branch_id query
  // params is still tracked under USERS_AND_ROLES.md §10 Phase 4.
  const allowedBranches = user?.all_branches || !user?.branch_ids?.length
    ? branches
    : branches.filter((b) => user.branch_ids.includes(b.id))

  const activeAllowed = allowedBranches.some((b) => b.id === activeBranch?.id)
  const hideBranchSwitcher = location.pathname.startsWith('/item-master')

  useEffect(() => {
    if (!allowedBranches.length) return
    if (!activeAllowed && allowedBranches[0]) {
      setActiveBranch(allowedBranches[0])
    }
  }, [activeAllowed, allowedBranches, setActiveBranch])

  // Single click-outside handler that closes whichever menu is open.
  useEffect(() => {
    if (!notifOpen && !branchOpen) return
    const onClick = (e) => {
      if (notifRef.current  && !notifRef.current.contains(e.target))  setNotifOpen(false)
      if (branchRef.current && !branchRef.current.contains(e.target)) setBranchOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [notifOpen, branchOpen])

  return (
    <header style={{
      height: 56, background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border-default)',
      display: 'flex', alignItems: 'center',
      padding: '0 18px', gap: 10,
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      {/* Sidebar toggle */}
      <IconButton onClick={toggleSidebar} title="Toggle navigation">
        <Icon.Menu size={18} />
      </IconButton>

      {/* Branch picker — the only persistent context the topbar carries.
          Hidden entirely on Item Master pages and if the user has no branches.
          The seed always gives every active user at least one branch. */}
      {!hideBranchSwitcher && allowedBranches.length > 0 && (
      <div style={{ position: 'relative' }} ref={branchRef}>
        <button
          onClick={() => setBranchOpen((v) => !v)}
          title="Switch active branch"
          style={{
            display: 'flex', alignItems: 'center', gap: 9,
            height: 34, padding: '0 12px',
            background: branchOpen ? 'var(--bg-hover)' : 'var(--bg-raised)',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 12.5, fontWeight: 500,
            color: 'var(--text-secondary)',
            transition: 'background 120ms ease',
          }}
          onMouseEnter={(e) => { if (!branchOpen) e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={(e) => { if (!branchOpen) e.currentTarget.style.background = 'var(--bg-raised)' }}
        >
          <span style={{
            display: 'inline-flex', color: 'var(--text-muted)',
          }}>
            <Icon.Branch size={15} />
          </span>
          <span style={{
            display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
            lineHeight: 1.15,
          }}>
            <span style={{
              fontSize: 9.5, fontWeight: 600,
              color: 'var(--text-muted)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>
              Branch
            </span>
            <span style={{
              maxWidth: 160, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
              color: 'var(--text-primary)', fontWeight: 600, fontSize: 12.5,
            }}>
              {activeBranch?.name || 'No branch'}
            </span>
          </span>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'var(--green)',
            boxShadow: '0 0 0 2px rgba(34,201,122,0.18)',
            marginLeft: 2,
          }} />
          <Icon.ChevronDown size={13} style={{
            color: 'var(--text-muted)',
            transform: branchOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 150ms ease',
          }} />
        </button>

        {branchOpen && (
          <div style={{
            position: 'absolute', left: 0, top: 'calc(100% + 8px)',
            minWidth: 260,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-md)',
            zIndex: 200, overflow: 'hidden',
          }}>
            <div style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 10.5, fontWeight: 600,
              color: 'var(--text-muted)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
            }}>
              Switch branch
            </div>
            {allowedBranches.length === 0 && (
              <div style={{ padding: '14px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                No branches configured.
              </div>
            )}
            {allowedBranches.map((b) => {
              const active = b.id === activeBranch?.id
              return (
                <button
                  key={b.id}
                  onClick={() => handleBranchSelect(b)}
                  style={{
                    width: '100%', padding: '10px 14px',
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: active ? 'var(--accent-bg)' : 'transparent',
                    border: 'none', cursor: 'pointer',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    fontSize: 12.5, fontWeight: active ? 600 : 500,
                    textAlign: 'left',
                    transition: 'background 120ms ease',
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  <Icon.Branch size={15} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {b.name}
                  </span>
                  {active && (
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      padding: '2px 7px', borderRadius: 10,
                      background: 'var(--accent)', color: '#fff',
                      letterSpacing: '0.04em',
                    }}>
                      ACTIVE
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Primary action */}
      <button className="btn btn-primary btn-sm" onClick={() => navigate('/pos')} style={{ gap: 5 }}>
        <Icon.Plus size={14} strokeWidth={2.25} />
        New Sale
      </button>

      <div style={{ width: 1, height: 22, background: 'var(--border-subtle)', margin: '0 4px' }} />

      {/* Notifications */}
      <div style={{ position: 'relative' }} ref={notifRef}>
        <IconButton
          onClick={() => setNotifOpen((v) => !v)}
          title="Notifications"
          active={notifOpen}
        >
          <Icon.Bell size={17} />
          {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 5, right: 5,
            minWidth: 15, height: 15, padding: '0 4px',
            background: 'var(--red)', color: '#fff',
            fontSize: 9.5, fontWeight: 700,
            borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid var(--bg-surface)',
            lineHeight: 1,
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
          )}
        </IconButton>

        {notifOpen && (
          <div style={{
            position: 'absolute', right: 0, top: 'calc(100% + 8px)',
            width: 340,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-md)',
            zIndex: 200, overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex', alignItems: 'center',
            }}>
              <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>Notifications</div>
              <button
                onClick={markAllRead}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--text-muted)', fontSize: 11.5,
                  cursor: 'pointer', padding: '2px 6px',
                  fontWeight: 500,
                }}
              >
                Mark all read
              </button>
            </div>

            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {visibleNotifications.length === 0 && (
                <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)' }}>
                  No alerts for this branch
                </div>
              )}
              {visibleNotifications.map((n) => {
                const t = NOTIF_TYPE[n.type] || NOTIF_TYPE.info
                return (
                  <button
                    key={n.id}
                    onClick={() => handleNotifClick(n)}
                    style={{
                      width: '100%', padding: '12px 16px',
                      display: 'flex', gap: 12,
                      background: n.read ? 'transparent' : 'var(--bg-raised)',
                      border: 'none',
                      borderBottom: '1px solid var(--border-subtle)',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 120ms ease',
                      opacity: n.read ? 0.72 : 1,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-raised)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = n.read ? 'transparent' : 'var(--bg-raised)'}
                  >
                    <span style={{
                      width: 30, height: 30, borderRadius: 8,
                      background: t.bg, color: t.color,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Icon.Bell size={14} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12.5, color: 'var(--text-primary)',
                        fontWeight: n.read ? 500 : 600, lineHeight: 1.45,
                      }}>
                        {n.text}
                      </div>
                      {n.body && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                          {n.body}
                        </div>
                      )}
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        marginTop: 4,
                      }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700,
                          padding: '1px 6px', borderRadius: 10,
                          background: t.bg, color: t.color,
                          letterSpacing: '0.04em', textTransform: 'uppercase',
                        }}>
                          {t.label}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{n.time}</span>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>

            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border-subtle)',
              textAlign: 'center',
            }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ fontSize: 12 }}
                onClick={() => { setNotifOpen(false); navigate('/items') }}
              >
                View inventory
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Theme toggle */}
      <IconButton
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? <Icon.Sun size={17} /> : <Icon.Moon size={17} />}
      </IconButton>

      {/* Help */}
      <IconButton title="Help & shortcuts">
        <Icon.HelpCircle size={17} />
      </IconButton>

      <Modal
        open={!!pendingBranch}
        onClose={() => setPendingBranch(null)}
        title="Switch branch with items in cart?"
        icon="🛒"
        size="sm"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setPendingBranch(null)}>Stay</button>
            <button className="btn btn-ghost" onClick={() => switchBranchWithCartAction(true)}>Hold &amp; Switch</button>
            <button className="btn btn-danger" onClick={() => switchBranchWithCartAction(false)}>Discard &amp; Switch</button>
          </>
        )}
      >
        <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          You have <strong>{cart?.length || 0} item{(cart?.length || 0) === 1 ? '' : 's'}</strong> in the current POS transaction.
          Choose <strong>Hold &amp; Switch</strong> to save it for later, or discard it and start fresh at{' '}
          <strong>{pendingBranch?.name}</strong>.
        </div>
      </Modal>
    </header>
  )
}

// ─── Internal: round icon-only button used across the topbar ─────────────────
function IconButton({ children, onClick, title, active, style }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        position: 'relative',
        width: 36, height: 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        borderRadius: 8,
        cursor: 'pointer',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        transition: 'background 120ms ease, color 120ms ease',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--bg-raised)'
          e.currentTarget.style.color = 'var(--text-primary)'
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--text-secondary)'
        }
      }}
    >
      {children}
    </button>
  )
}

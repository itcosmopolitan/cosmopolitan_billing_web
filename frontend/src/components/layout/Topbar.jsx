import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '@/store'
import * as Icon from '@/components/ui/Icons'

// Topbar is intentionally chrome-only: it carries global context (active
// branch) and global actions (new sale, notifications, theme, help). The
// per-page <SectionHeader> already owns the title + subtitle — repeating it
// here just produced the duplicated "Sales Management" label users noticed.

const NOTIF_TYPE = {
  danger:  { color: 'var(--red)',   bg: 'var(--red-bg)',   label: 'Critical' },
  warning: { color: 'var(--amber)', bg: 'var(--amber-bg)', label: 'Warning'  },
  info:    { color: 'var(--blue)',  bg: 'var(--blue-bg)',  label: 'Info'     },
}

export default function Topbar() {
  const { user, activeBranch, branches, setActiveBranch, toggleSidebar, theme, setTheme } = useAppStore()
  const navigate = useNavigate()

  const [notifOpen, setNotifOpen]   = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const notifRef  = useRef(null)
  const branchRef = useRef(null)

  // Branch picker filtered to the user's assigned branches. Users with
  // all_branches=true or no branch_ids list (legacy super-admin records) see
  // every branch. Multi-branch users get a switcher over their allowed
  // subset only. Cosmetic UI gate — backend enforcement of branch_id query
  // params is still tracked under USERS_AND_ROLES.md §10 Phase 4.
  const allowedBranches = user?.all_branches || !user?.branch_ids?.length
    ? branches
    : branches.filter((b) => user.branch_ids.includes(b.id))

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

  const notifications = [
    { id: 1, type: 'warning', text: 'Basmati Rice critical stock at T.Nagar', time: '10 min ago' },
    { id: 2, type: 'danger',  text: 'INV-2024-1840 overdue by 12 days',       time: '1 hr ago'   },
    { id: 3, type: 'info',    text: 'TRF-041 stock transfer pending approval', time: '2 hr ago'   },
  ]

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
          Hidden entirely if the user has no branches at all (defensive — the
          seed always gives every active user at least one branch). */}
      {allowedBranches.length > 0 && (
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
                  onClick={() => { setActiveBranch(b); setBranchOpen(false) }}
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
            {notifications.length}
          </span>
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
                onClick={() => setNotifOpen(false)}
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
              {notifications.map((n) => {
                const t = NOTIF_TYPE[n.type] || NOTIF_TYPE.info
                return (
                  <button
                    key={n.id}
                    onClick={() => setNotifOpen(false)}
                    style={{
                      width: '100%', padding: '12px 16px',
                      display: 'flex', gap: 12,
                      background: 'transparent', border: 'none',
                      borderBottom: '1px solid var(--border-subtle)',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 120ms ease',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-raised)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
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
                        fontWeight: 500, lineHeight: 1.45,
                      }}>
                        {n.text}
                      </div>
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
              <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}>
                View all alerts
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

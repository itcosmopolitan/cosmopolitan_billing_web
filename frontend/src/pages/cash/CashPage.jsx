import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { cashAPI, AUTOCOMPLETE_BRANCH_URL } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt } from '@/utils/helpers'
import { unwrapPaged } from '@/utils/pagination'
import { AlertBar, BarList, Card, Chip, EmptyState, Modal, RowActionsMenu, SectionHeader, Tabs, AutocompleteDropdown, DatePicker, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'
import CashEntryModal from './CashEntryModal'
import CloseDayModal from './CloseDayModal'
import UnlockDayModal from './UnlockDayModal'

const TABS = ['Entries', 'Breakdown', 'Day History']

export default function CashPage() {
  const can = useCan()
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const currentUser = useAppStore((s) => s.user)

  const [branchId, setBranchId] = useState(() => activeBranch?.id || '')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [tab, setTab] = useState('Entries')
  const [version, setVersion] = useState(0)

  const [entries, setEntries] = useState([])
  const [summary, setSummary] = useState({})
  const [history, setHistory] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)

  const [showEntry, setShowEntry] = useState(false)
  const [editEntry, setEditEntry] = useState(null)
  const [showClose, setShowClose] = useState(false)
  const [showUnlock, setShowUnlock] = useState(false)
  const [voidTarget, setVoidTarget] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [entryBusy, setEntryBusy] = useState(false)
  const [voidSaving, setVoidSaving] = useState(false)

  useEffect(() => {
    if (!branchId && activeBranch?.id) setBranchId(activeBranch.id)
  }, [activeBranch, branchId])

  // Fetch categories once
  useEffect(() => {
    cashAPI.categories.list().then((cats) => setCategories(cats || [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!branchId) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const [entriesRaw, sum] = await Promise.all([
          cashAPI.entries(branchId, { date }).catch(() => ({ items: [] })),
          cashAPI.summary(branchId, date).catch(() => ({})),
        ])
        if (cancelled) return
        const { items } = unwrapPaged(entriesRaw)
        setEntries(items || [])
        setSummary(sum)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [branchId, date, version])

  useEffect(() => {
    if (tab !== 'Day History' || !branchId) return
    cashAPI.history(branchId, {}).then((r) => setHistory(unwrapPaged(r).items || [])).catch(() => {})
  }, [tab, branchId, version])

  const refresh = () => setVersion((v) => v + 1)

  const dayStatus = summary.day_status || 'open'
  const isLocked = dayStatus === 'closed'
  const closeRecord = summary.close_details || null

  const handleDelete = async (entry) => {
    if (entryBusy || voidSaving) return
    if (!window.confirm('Delete this entry?')) return
    setEntryBusy(true)
    try {
      await cashAPI.delete(branchId, entry.id)
      toast.success('Entry deleted')
      refresh()
    } catch { /* interceptor */ }
    finally {
      setEntryBusy(false)
    }
  }

  const handleVoid = async () => {
    if (voidSaving || entryBusy) return
    if (!voidReason.trim()) { toast.error('Enter void reason'); return }
    setVoidSaving(true)
    try {
      await cashAPI.void(branchId, voidTarget.id, { reason: voidReason })
      toast.success('Entry voided')
      setVoidTarget(null)
      setVoidReason('')
      refresh()
    } catch { /* interceptor */ }
    finally {
      setVoidSaving(false)
    }
  }

  const selectedBranch = useMemo(() => branches.find((b) => b.id === branchId), [branches, branchId])

  const variance = summary.variance ?? 0
  const threshold = 500
  const breakdownIn = summary.breakdown_in || []
  const breakdownOut = summary.breakdown_out || []

  return (
    <div className="page-container">
      {/* ── Header ── */}
      <SectionHeader
        title="Cash Control"
        subtitle="Daily petty cash register, entries, and day-close reconciliation"
      >
        <AutocompleteDropdown
          value={branchId}
          onChange={setBranchId}
          fetchUrl={AUTOCOMPLETE_BRANCH_URL}
          fetchParams={{ retail_only: true }}
          isSearchFieldRequired={false}
          style={{ width: 160 }}
        />

        <DatePicker
          value={date}
          onChange={setDate}
          style={{ width: 148 }}
        />

        {/* Day status chip — clickable to unlock if admin */}
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
            background: isLocked ? 'var(--bg-raised)' : 'var(--green-bg, #e6f9ee)',
            color: isLocked ? 'var(--text-muted)' : 'var(--green)',
            border: `1px solid ${isLocked ? 'var(--border-default)' : 'var(--green)'}`,
            cursor: isLocked && can('cash.unlock') ? 'pointer' : 'default',
          }}
          onClick={() => isLocked && can('cash.unlock') && setShowUnlock(true)}
          title={isLocked && can('cash.unlock') ? 'Click to unlock' : undefined}
        >
          {isLocked ? '🔒 CLOSED' : '✅ OPEN'}
        </span>

        {can('cash.entry') && !isLocked && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setEditEntry(null); setShowEntry(true) }}>
            + Cash Entry
          </button>
        )}
        {can('cash.close') && !isLocked && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowClose(true)}>
            Close Day
          </button>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          hideExport: true,
          onRefresh: () => {
            refresh()
            toast.success('List refreshed')
          },
        })} />
      </SectionHeader>

      {/* ── Variance alert ── */}
      {!isLocked && variance !== 0 && (
        <AlertBar
          type={Math.abs(variance) > threshold ? 'red' : 'amber'}
          icon="⚠️"
          style={{ marginBottom: 16 }}
        >
          Cash variance detected: <strong>{fmt(Math.abs(variance))}</strong>{' '}
          {variance < 0 ? 'shortage' : 'excess'}. Recount and close the day to record it.
        </AlertBar>
      )}

      {/* ── Summary tiles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Opening Balance', value: fmt(summary.opening_balance ?? summary.opening ?? 0), color: 'var(--teal)' },
          { label: 'Cash In', value: fmt(summary.cash_in ?? 0), sub: `${entries.filter((e) => !e.is_voided && e.type === 'in' && e.category !== 'Opening Balance').length} entries`, color: 'var(--green)' },
          { label: 'Cash Out', value: fmt(summary.cash_out ?? 0), sub: `${entries.filter((e) => !e.is_voided && e.type === 'out').length} entries`, color: 'var(--red)' },
          { label: 'Expected', value: fmt(summary.expected_balance ?? summary.expected ?? 0), color: 'var(--text-primary)' },
          {
            label: 'Actual',
            value: isLocked ? fmt(summary.physical_count ?? 0) : '— pending',
            color: isLocked ? 'var(--green)' : 'var(--text-muted)',
            sub: isLocked ? 'at close' : 'close to record',
          },
          {
            label: 'Variance',
            value: isLocked ? (variance >= 0 ? '+' : '') + fmt(variance) : '—',
            color: variance === 0 ? 'var(--green)' : Math.abs(variance) <= threshold ? 'var(--amber)' : 'var(--red)',
          },
        ].map((c) => (
          <div key={c.label} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
            borderRadius: 10, padding: '14px 16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: c.color, fontFamily: 'DM Mono,monospace' }}>{c.value}</div>
            {c.sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* ── Tabs ── */}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {/* ─── Tab: Entries ─── */}
      {tab === 'Entries' && (
        <Card
          title={`Entries — ${selectedBranch?.name || '—'} / ${date}`}
          bodyPadding={false}
        >
          {loading ? (
            <TableLoadingPanel label="Loading…" />
          ) : entries.length === 0 ? (
            <EmptyState icon="💰" title="No entries for this date" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th><th>Time</th><th>Type</th><th>Category</th>
                  <th>Description</th><th>Ref</th><th>By</th>
                  <th className="text-right">Amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.id}
                    style={{ opacity: e.is_voided ? 0.45 : 1, textDecoration: e.is_voided ? 'line-through' : 'none' }}
                  >
                    <td style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Mono,monospace' }}>
                      {e.entry_number || '—'}
                    </td>
                    <td style={{ fontSize: 12, fontFamily: 'DM Mono,monospace', color: 'var(--text-muted)' }}>{e.time}</td>
                    <td>
                      <Chip status={e.type === 'in' ? 'paid' : 'overdue'} label={e.type === 'in' ? 'IN' : 'OUT'} />
                      {e.is_system && <span title="Auto-generated" style={{ marginLeft: 4, fontSize: 10 }}>🔒</span>}
                      {e.is_voided && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--text-muted)' }}>VOIDED</span>}
                    </td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.category}</td>
                    <td style={{ fontSize: 12.5 }}>{e.description}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.ref}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.by}</td>
                    <td className="text-right mono" style={{ fontWeight: 600, color: e.type === 'in' ? 'var(--green)' : 'var(--red)' }}>
                      {e.type === 'in' ? '+' : '-'}{fmt(e.amount)}
                    </td>
                    <td>
                      <RowActionsMenu
                        busy={entryBusy || voidSaving}
                        ariaLabel={`Actions for ${e.entry_number || e.id}`}
                        actions={[
                          {
                            label: 'Edit',
                            hidden: e.is_voided || isLocked || e.is_system || !can('cash.edit'),
                            onClick: () => { setEditEntry(e); setShowEntry(true) },
                          },
                          {
                            label: 'Void',
                            hidden: e.is_voided || isLocked || !can('cash.edit'),
                            onClick: () => setVoidTarget(e),
                          },
                          {
                            label: 'Delete',
                            hidden: e.is_voided || isLocked || e.is_system || !can('cash.edit'),
                            danger: true,
                            onClick: () => handleDelete(e),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{entries.filter((e) => !e.is_voided).length} active entries</span>
            <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
              <span>In: <strong style={{ color: 'var(--green)' }}>{fmt(summary.cash_in ?? 0)}</strong></span>
              <span>Out: <strong style={{ color: 'var(--red)' }}>{fmt(summary.cash_out ?? 0)}</strong></span>
              <span>Balance: <strong style={{ color: 'var(--accent)' }}>{fmt(summary.expected_balance ?? summary.expected ?? 0)}</strong></span>
            </div>
          </div>
        </Card>
      )}

      {/* ─── Tab: Breakdown ─── */}
      {tab === 'Breakdown' && (
        <div className="grid-2">
          <Card title="Cash In — by Category">
            {breakdownIn.length === 0 ? (
              <EmptyState icon="📊" title="No cash-in entries" />
            ) : (
              <BarList
                items={breakdownIn.map((r, i) => ({
                  label: r.category,
                  value: r.amount,
                  color: ['var(--green)', 'var(--teal)', 'var(--blue)', 'var(--accent)'][i % 4],
                }))}
                valueFormatter={(v) => fmt(v)}
              />
            )}
          </Card>
          <Card title="Cash Out — by Category">
            {breakdownOut.length === 0 ? (
              <EmptyState icon="📊" title="No cash-out entries" />
            ) : (
              <BarList
                items={breakdownOut.map((r, i) => ({
                  label: r.category,
                  value: r.amount,
                  color: ['var(--red)', 'var(--amber)', 'var(--purple)', 'var(--coral)'][i % 4],
                }))}
                valueFormatter={(v) => fmt(v)}
              />
            )}
          </Card>
        </div>
      )}

      {/* ─── Tab: Day History ─── */}
      {tab === 'Day History' && (
        <Card title="Day History" bodyPadding={false}>
          {history.length === 0 ? (
            <EmptyState icon="📅" title="No closed days yet" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th><th>Opening</th><th>Cash In</th><th>Cash Out</th>
                  <th>Expected</th><th>Physical</th><th>Variance</th>
                  <th>Closed By</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const v = h.variance || 0
                  const vColor = v === 0 ? 'var(--green)' : Math.abs(v) <= threshold ? 'var(--amber)' : 'var(--red)'
                  return (
                    <tr
                      key={h.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setDate(h.date)}
                      title="Click to view this day's entries"
                    >
                      <td style={{ fontFamily: 'DM Mono,monospace', fontSize: 12 }}>{h.date}</td>
                      <td className="text-right mono">{fmt(h.opening_balance)}</td>
                      <td className="text-right mono" style={{ color: 'var(--green)' }}>{fmt(h.total_cash_in)}</td>
                      <td className="text-right mono" style={{ color: 'var(--red)' }}>{fmt(h.total_cash_out)}</td>
                      <td className="text-right mono">{fmt(h.expected_balance)}</td>
                      <td className="text-right mono">{fmt(h.physical_count)}</td>
                      <td className="text-right mono" style={{ color: vColor, fontWeight: 600 }}>
                        {v >= 0 ? '+' : ''}{fmt(v)}
                      </td>
                      <td style={{ fontSize: 12 }}>{h.closed_by}</td>
                      <td>
                        <Chip
                          status={h.is_locked ? 'paid' : 'pending'}
                          label={h.is_locked ? 'Closed' : 'Unlocked'}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* ── Modals ── */}
      <CashEntryModal
        open={showEntry}
        onClose={() => { setShowEntry(false); setEditEntry(null) }}
        branchId={branchId}
        onSaved={refresh}
        editEntry={editEntry}
        categories={categories}
      />

      <CloseDayModal
        open={showClose}
        onClose={() => setShowClose(false)}
        branchId={branchId}
        summary={summary}
        date={date}
        onClosed={refresh}
        currentUser={currentUser}
      />

      {closeRecord && (
        <UnlockDayModal
          open={showUnlock}
          onClose={() => setShowUnlock(false)}
          branchId={branchId}
          closeRecord={closeRecord}
          onUnlocked={refresh}
        />
      )}

      {/* Void confirm modal */}
      <Modal
        open={!!voidTarget}
        onClose={() => { setVoidTarget(null); setVoidReason('') }}
        title="Void Entry"
        icon="🚫"
        size="sm"
        busy={voidSaving}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setVoidTarget(null); setVoidReason('') }} disabled={voidSaving}>Cancel</button>
            <button className="btn btn-danger" onClick={handleVoid} disabled={voidSaving}>
              {voidSaving ? 'Voiding…' : 'Void Entry'}
            </button>
          </>
        }
      >
        {voidTarget && (
          <>
            <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
              Void <strong>{voidTarget.entry_number || voidTarget.id}</strong> — {voidTarget.description} ({fmt(voidTarget.amount)})?
              A reversal entry will be created.
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Reason *</label>
              <textarea
                className="form-input"
                style={{ height: 72 }}
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                autoFocus
                placeholder="Why is this entry being voided?"
              />
            </div>
          </>
        )}
      </Modal>
    </div>
  )
}

import toast from 'react-hot-toast'
import { auditApi } from '../api/auditApi'
import { AuditDetailPanel } from '../components/audit/AuditDetailPanel'
import { AuditFiltersBar } from '../components/audit/AuditFilters'
import { AuditTable } from '../components/audit/AuditTable'
import { PageActionsMenu, SectionHeader, buildListPageMenuActions } from '../components/ui'
import { PaginationBar } from '../components/ui/PaginationBar'
import { useAuditTrail } from '../hooks/useAuditTrail'

export default function AuditTrailPage() {
  const { data, filters, loading, error, selected, setSelected, updateFilter, goToPage, refresh } = useAuditTrail()

  const handleExport = async () => {
    try {
      await auditApi.exportCsv({
        criteria: filters.criteria,
        date_from: filters.date_from,
        date_to: filters.date_to,
        search: filters.search,
      })
      toast.success('List exported')
    } catch {
      toast.error('Failed to export audit log')
    }
  }

  const handleRefresh = async () => {
    await refresh()
    toast.success('List refreshed')
  }

  const listMenuActions = buildListPageMenuActions({
    onExport: handleExport,
    onRefresh: handleRefresh,
  })

  const total = data?.total ?? 0
  const rows = data?.results ?? []

  const clearFilters = () => {
    updateFilter({
      search: '',
      module: '',
      risk: '',
      operation_type: '',
      operation_type_not: '',
      criteria: null,
      date_from: undefined,
      date_to: undefined,
    })
  }

  return (
    <div className="page-container page-container--list">
      <SectionHeader
        title="Audit Trail"
        subtitle="Complete log of all sensitive actions, edits, and role-sensitive operations"
      />

      <AuditFiltersBar
        filters={filters}
        onFilter={updateFilter}
        toolbarActions={<PageActionsMenu actions={listMenuActions} />}
      />

      {error && (
        <div className="mb-4 rounded-lg border border-[var(--red)]/20 bg-[var(--red-bg)] px-3 py-2 text-sm text-[var(--red)]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-6 py-10 text-sm text-[var(--text-muted)]">
          Loading audit events...
        </div>
      ) : (
        <AuditTable logs={rows} selected={selected} onSelect={setSelected} onClearFilters={clearFilters} />
      )}

      <div className="mt-4">
        <PaginationBar
          total={total}
          skip={(filters.page - 1) * (filters.limit || 50)}
          limit={filters.limit || 50}
          onSkipChange={(skip) => {
            const nextPage = Math.floor(skip / (filters.limit || 50)) + 1
            goToPage(nextPage)
          }}
          onLimitChange={(limit) => updateFilter({ limit })}
          disabled={loading}
        />
      </div>

      <AuditDetailPanel log={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

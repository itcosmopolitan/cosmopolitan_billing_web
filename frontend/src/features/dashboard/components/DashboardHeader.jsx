import * as Icon from '@/components/ui/Icons'
import { AutocompleteDropdown } from '@/components/ui'
import { AUTOCOMPLETE_CATEGORY_URL } from '@/api'

export default function DashboardHeader({
  filters,
  filterOptions,
  onFilterChange,
  onReset,
  onRefresh,
  isFetching,
  updatedAt,
}) {
  return (
    <div className="card" style={{ marginBottom: 16, overflow: 'visible' }}>
      <div className="card-body" style={{ padding: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
            <FilterField label="Date range">
              <AutocompleteDropdown
                value={filters.range}
                onChange={(v) => onFilterChange('range', v)}
                options={(filterOptions.rangeOptions || []).map((option) => ({
                  id: option.value,
                  label: option.label,
                }))}
                isSearchFieldRequired={false}
              />
            </FilterField>
            <FilterField label="Staff / KAM">
              <AutocompleteDropdown
                value={filters.staff_id}
                onChange={(v) => onFilterChange('staff_id', v)}
                options={(filterOptions.staff || []).map((option) => ({
                  id: option.id,
                  label: option.name,
                }))}
                prependOptions={[{ id: '', label: 'All KAMs' }]}
                isSearchFieldRequired
                placeholder="All KAMs"
                searchPlaceholder="Search KAMs…"
              />
            </FilterField>
            <FilterField label="Category">
              <AutocompleteDropdown
                value={filters.category_id}
                onChange={(v) => onFilterChange('category_id', v)}
                fetchUrl={AUTOCOMPLETE_CATEGORY_URL}
                prependOptions={[{ id: '', label: 'All categories' }]}
                isSearchFieldRequired
                placeholder="All categories"
                searchPlaceholder="Search categories…"
              />
            </FilterField>
            <button type="button" className="btn btn-ghost" onClick={onReset} title="Reset filters" style={{ height: 42 }}>
              Reset
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {updatedAt ? (
              <span
                title={new Date(updatedAt).toLocaleString('en-MV', { timeZone: 'Indian/Maldives' })}
                style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}
              >
                Updated at {new Date(updatedAt).toLocaleTimeString('en-MV', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'Indian/Maldives',
                })}
              </span>
            ) : null}
            {isFetching ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
                <Icon.RefreshCw size={14} className="spinner" />
                Updating dashboard…
              </div>
            ) : null}
            {/* <ExportMenu onExport={onExport} disabled={isFetching} /> */}
            <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={isFetching} title="Refresh dashboard data" style={{ height: 42 }}>
              <Icon.RefreshCw size={15} className={isFetching ? 'spinner' : undefined} />
              Refresh
            </button>
            {/* <button
              type="button"
              className={`btn ${autoRefresh ? 'btn-primary' : 'btn-secondary'}`}
              onClick={onToggleAutoRefresh}
              title="Toggle one minute auto-refresh"
              style={{ height: 42 }}
            >
              <Icon.Clock size={15} />
              Auto
            </button> */}
          </div>
        </div>
      </div>
    </div>
  )
}

function FilterField({ label, children }) {
  return (
    <label style={{ width: 168, minWidth: 148, margin: 0 }}>
      <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, marginBottom: 4 }}>
        {label}
      </span>
      {children}
    </label>
  )
}

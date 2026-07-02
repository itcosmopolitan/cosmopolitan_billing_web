import * as Icon from '@/components/ui/Icons'
import { AutocompleteDropdown } from '@/components/ui'
import ExportMenu from './ExportMenu'

export default function DashboardHeader({
  filters,
  filterOptions,
  onFilterChange,
  onReset,
  onRefresh,
  isFetching,
  autoRefresh,
  onToggleAutoRefresh,
  onExport,
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
                style={{ height: 42 }}
              />
            </FilterField>
            <FilterField label="Staff">
              <AutocompleteDropdown
                value={filters.staff_id}
                onChange={(v) => onFilterChange('staff_id', v)}
                options={(filterOptions.staff || []).map((staff) => ({
                  id: staff.id,
                  label: staff.name,
                }))}
                prependOptions={[{ id: '', label: 'All staff' }]}
                isSearchFieldRequired
                placeholder="All staff"
                searchPlaceholder="Search staff…"
                style={{ height: 42 }}
              />
            </FilterField>
            <FilterField label="Category">
              <AutocompleteDropdown
                value={filters.category_id}
                onChange={(v) => onFilterChange('category_id', v)}
                options={(filterOptions.categories || []).map((category) => ({
                  id: category.id,
                  label: category.name,
                }))}
                prependOptions={[{ id: '', label: 'All categories' }]}
                isSearchFieldRequired
                placeholder="All categories"
                searchPlaceholder="Search categories…"
                style={{ height: 42 }}
              />
            </FilterField>
            <button type="button" className="btn btn-ghost" onClick={onReset} title="Reset filters" style={{ height: 42 }}>
              Reset
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
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

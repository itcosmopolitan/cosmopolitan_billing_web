import * as Icon from '@/components/ui/Icons'
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
    <div className="card" style={{ marginBottom: 16 }}>
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
            <FilterField label="From">
              <input
                className="form-input"
                type="date"
                value={filters.from}
                onChange={(e) => onFilterChange('from', e.target.value)}
                style={{ height: 42 }}
              />
            </FilterField>
            <FilterField label="To">
              <input
                className="form-input"
                type="date"
                value={filters.to}
                onChange={(e) => onFilterChange('to', e.target.value)}
                style={{ height: 42 }}
              />
            </FilterField>
            <FilterField label="Staff">
              <select className="form-input" value={filters.staff_id} onChange={(e) => onFilterChange('staff_id', e.target.value)} style={{ height: 42 }}>
                <option value="">All staff</option>
                {(filterOptions.staff || []).map((staff) => (
                  <option key={staff.id} value={staff.id}>{staff.name}</option>
                ))}
              </select>
            </FilterField>
            <FilterField label="Category">
              <select className="form-input" value={filters.category_id} onChange={(e) => onFilterChange('category_id', e.target.value)} style={{ height: 42 }}>
                <option value="">All categories</option>
                {(filterOptions.categories || []).map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </FilterField>
            <button type="button" className="btn btn-ghost" onClick={onReset} title="Reset filters" style={{ height: 42 }}>
              Reset
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
            <ExportMenu onExport={onExport} disabled={isFetching} />
            <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={isFetching} title="Refresh dashboard data" style={{ height: 42 }}>
              <Icon.RefreshCw size={15} className={isFetching ? 'spinner' : undefined} />
              Refresh
            </button>
            <button
              type="button"
              className={`btn ${autoRefresh ? 'btn-primary' : 'btn-secondary'}`}
              onClick={onToggleAutoRefresh}
              title="Toggle one minute auto-refresh"
              style={{ height: 42 }}
            >
              <Icon.Clock size={15} />
              Auto
            </button>
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

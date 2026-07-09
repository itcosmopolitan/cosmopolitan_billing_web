import { auditApi } from "../api/auditApi";
import { AuditDetailPanel } from "../components/audit/AuditDetailPanel";
import { AuditFiltersBar } from "../components/audit/AuditFilters";
import { AuditTable } from "../components/audit/AuditTable";
import { useAuditTrail } from "../hooks/useAuditTrail";
import { PaginationBar } from "../components/ui/PaginationBar";

export default function AuditTrailPage() {
  const { data, filters, loading, error, selected, setSelected, updateFilter, goToPage } = useAuditTrail();

  const handleExport = () =>
    auditApi.exportCsv({
      module: filters.module,
      risk: filters.risk,
      date_from: filters.date_from,
      date_to: filters.date_to,
      search: filters.search,
    });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (filters.limit || 1)));
  const page = filters.page;
  const rows = data?.results ?? [];
  const highCount = rows.filter((log) => log.risk === "HIGH").length;
  const mediumCount = rows.filter((log) => log.risk === "MEDIUM").length;
  const clearFilters = () => {
    updateFilter({
      search: "",
      module: "",
      risk: "",
      date_from: undefined,
      date_to: undefined,
    });
  };

  return (
    <div className="p-6 bg-slate-50/50 min-h-full">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Audit Trail</h1>
          <p className="text-sm text-slate-500 mt-1">
            Complete log of all sensitive actions, edits, and role-sensitive operations
          </p>
        </div>
        <button
          onClick={handleExport}
          className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Export CSV
        </button>
      </div>

      <AuditFiltersBar filters={filters} onFilter={updateFilter} />

      {error && <p className="text-red-500 text-sm mb-3">{error}</p>}

      {loading ? (
        <p className="text-gray-400 text-sm">Loading...</p>
      ) : (
        <AuditTable logs={rows} selected={selected} onSelect={setSelected} onClearFilters={clearFilters} />
      )}

      <div className="mt-4">
        <PaginationBar
          total={total}
          skip={(filters.page - 1) * (filters.limit || 50)}
          limit={filters.limit || 50}
          onSkipChange={(skip) => {
            const nextPage = Math.floor(skip / (filters.limit || 50)) + 1;
            goToPage(nextPage);
          }}
          onLimitChange={(limit) => updateFilter({ limit })}
          disabled={loading}
        />
      </div>

      <AuditDetailPanel log={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

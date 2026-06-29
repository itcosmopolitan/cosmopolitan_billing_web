import { useEffect, useState } from "react";
import type { AuditFilters, ModuleType, RiskLevel } from "../../types/audit";

const MODULES: ModuleType[] = ["Sales", "Inventory", "Finance", "Cash", "Purchases", "Auth"];
const RISKS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH"];

interface Props {
  filters: AuditFilters;
  onFilter: (patch: Partial<AuditFilters>) => void;
}

export function AuditFiltersBar({ filters, onFilter }: Props) {
  const [searchValue, setSearchValue] = useState(filters.search ?? "");

  useEffect(() => {
    setSearchValue(filters.search ?? "");
  }, [filters.search]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if ((filters.search ?? "") !== searchValue) {
        onFilter({ search: searchValue });
      }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchValue, filters.search, onFilter]);

  return (
    <div className="mb-4 space-y-3">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </span>
        <input
          type="text"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search action, detail, reference, user..."
          className="w-full border rounded-md pl-10 pr-10 py-2.5 text-sm"
        />
        {searchValue && (
          <button
            type="button"
            onClick={() => {
              setSearchValue("");
              onFilter({ search: "" });
            }}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-600"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      <div className="py-3 border-b border-gray-200 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-16 shrink-0 text-xs text-gray-400 font-semibold uppercase tracking-wide">Module</div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onFilter({ module: "" })}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${!filters.module ? "bg-indigo-600 text-white font-medium" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-100 hover:text-gray-800"}`}
            >
              All Modules
            </button>
            {MODULES.map((module) => (
              <button
                key={module}
                type="button"
                onClick={() => onFilter({ module })}
                className={`rounded-full px-4 py-1.5 text-sm transition-colors ${filters.module === module ? "bg-indigo-600 text-white font-medium" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-100 hover:text-gray-800"}`}
              >
                {module}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="w-16 shrink-0 text-xs text-gray-400 font-semibold uppercase tracking-wide">Risk</div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onFilter({ risk: "" })}
              className={`rounded-full px-4 py-1.5 text-sm transition-colors ${!filters.risk ? "bg-indigo-600 text-white font-medium" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-100 hover:text-gray-800"}`}
            >
              All Risk
            </button>
            {RISKS.map((risk) => (
              <button
                key={risk}
                type="button"
                onClick={() => onFilter({ risk })}
                className={`rounded-full px-4 py-1.5 text-sm transition-colors ${filters.risk === risk ? "bg-indigo-600 text-white font-medium" : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-100 hover:text-gray-800"}`}
              >
                {risk}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={filters.date_from ?? ""}
            onChange={(e) => onFilter({ date_from: e.target.value || undefined })}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            value={filters.date_to ?? ""}
            onChange={(e) => onFilter({ date_to: e.target.value || undefined })}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>
      </div>
    </div>
  );
}

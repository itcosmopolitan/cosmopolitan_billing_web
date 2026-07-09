import { useEffect, useMemo, useRef, useState } from "react";
import Portal from "../ui/Portal";
import type { AuditFilters } from "../../types/audit";

interface Props {
  filters: AuditFilters;
  onFilter: (patch: Partial<AuditFilters>) => void;
}

type FilterFieldType = "select" | "text";

type FilterRow = {
  id: string;
  field: string;
  condition: string;
  value: string;
};

const FILTER_FIELDS: { label: string; key: string; type: FilterFieldType; options?: string[] }[] = [
  { label: "Module", key: "module", type: "select", options: ["Sales", "Inventory", "Finance", "Cash", "Purchases", "Auth"] },
  { label: "Risk Level", key: "risk", type: "select", options: ["LOW", "MEDIUM", "HIGH"] },
  { label: "User", key: "user_name", type: "text" },
  { label: "Operation Type", key: "action", type: "select", options: ["Created", "Deleted", "Updated"] },
  { label: "Customer Name", key: "customer_name", type: "text" },
  { label: "Vendor Name", key: "vendor_name", type: "text" },
];

const SELECT_CONDITIONS = ["is", "is not"];
const TEXT_CONDITIONS = ["contains", "is", "starts with", "is empty"];

const buildFilterRow = (overrides?: Partial<FilterRow>): FilterRow => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  field: "module",
  condition: "is",
  value: "",
  ...overrides,
});

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

const getPresetRange = (preset: string): { from: string; to: string } => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (preset === "Today") {
    const value = formatDate(today);
    return { from: value, to: value };
  }

  if (preset === "This Week") {
    const day = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((day + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from: formatDate(monday), to: formatDate(sunday) };
  }

  if (preset === "This Month") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { from: formatDate(first), to: formatDate(last) };
  }

  if (preset === "Last Month") {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const last = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: formatDate(first), to: formatDate(last) };
  }

  return { from: "", to: "" };
};

const getPresetLabel = (from?: string, to?: string) => {
  if (!from || !to) return "This Month";
  const today = formatDate(new Date());
  if (from === today && to === today) return "Today";
  const weekRange = getPresetRange("This Week");
  if (from === weekRange.from && to === weekRange.to) return "This Week";
  const monthRange = getPresetRange("This Month");
  if (from === monthRange.from && to === monthRange.to) return "This Month";
  const lastMonthRange = getPresetRange("Last Month");
  if (from === lastMonthRange.from && to === lastMonthRange.to) return "Last Month";
  return "Custom Range";
};

export function AuditFiltersBar({ filters, onFilter }: Props) {
  const [searchValue, setSearchValue] = useState(filters.search ?? "");
  const [filterRows, setFilterRows] = useState<FilterRow[]>(() => {
    const rows: FilterRow[] = [];
    if (filters.module) rows.push(buildFilterRow({ field: "module", condition: "is", value: filters.module }));
    if (filters.risk) rows.push(buildFilterRow({ field: "risk", condition: "is", value: filters.risk }));
    return rows;
  });
  const [openDateDropdown, setOpenDateDropdown] = useState(false);
  const [openFieldDropdownId, setOpenFieldDropdownId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("audit_filters_collapsed") === "true";
  });

  useEffect(() => {
    setSearchValue(filters.search ?? "");
  }, [filters.search]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if ((filters.search ?? "") !== searchValue) {
        onFilter({ search: searchValue });
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchValue, filters.search, onFilter]);

  useEffect(() => {
    window.localStorage.setItem("audit_filters_collapsed", String(collapsed));
  }, [collapsed]);

  const normalizeActionValue = (value: string) => {
    const lower = value.trim().toLowerCase();
    if (lower === "created") return "created";
    if (lower === "deleted") return "deleted";
    if (lower === "edited" || lower === "updated") return "updated";
    return value;
  };

  const applyFilters = () => {
    const patch: Partial<AuditFilters> = {
      module: "",
      risk: "",
      operation_type: "",
      operation_type_not: "",
      search: filters.search ?? "",
      date_from: filters.date_from,
      date_to: filters.date_to,
    };
    const searchTerms: string[] = [];

    filterRows.forEach((row) => {
      if (!row.value && row.condition !== "is empty") return;
      if (row.field === "module") {
        patch.module = row.value;
        return;
      }
      if (row.field === "risk") {
        patch.risk = row.value;
        return;
      }
      if (row.field === "action") {
        if (row.condition === "is empty" || !row.value) return;
        const term = normalizeActionValue(row.value);
        if (row.condition === "is") {
          patch.operation_type = term as "Created" | "Deleted" | "Updated";
        } else if (row.condition === "is not") {
          patch.operation_type_not = term as "Created" | "Deleted" | "Updated";
        }
        return;
      }
      if (["user_name", "customer_name", "vendor_name"].includes(row.field)) {
        if (row.condition === "is empty") {
          return;
        }
        if (row.value) searchTerms.push(row.value);
      }
    });

    patch.search = searchTerms.length > 0 ? searchTerms.join(" ") : filters.search ?? "";
    onFilter(patch);
  };

  const handlePresetSelect = (preset: string) => {
    const range = getPresetRange(preset);
    setOpenDateDropdown(false);
    onFilter({ date_from: range.from, date_to: range.to });
  };

  const summaryFilters = useMemo(() => {
    const pills: { label: string; onRemove: () => void }[] = [];
    if (filters.module) {
      pills.push({ label: `Module: ${filters.module}`, onRemove: () => onFilter({ module: "" }) });
    }
    if (filters.risk) {
      pills.push({ label: `Risk: ${filters.risk}`, onRemove: () => onFilter({ risk: "" }) });
    }
    if (filters.operation_type) {
      pills.push({ label: `Operation: ${filters.operation_type}`, onRemove: () => onFilter({ operation_type: "" }) });
    }
    if (filters.operation_type_not) {
      pills.push({ label: `Not: ${filters.operation_type_not}`, onRemove: () => onFilter({ operation_type_not: "" }) });
    }
    if (filters.search) {
      pills.push({ label: `Search: ${filters.search}`, onRemove: () => onFilter({ search: "" }) });
    }
    if (filters.date_from || filters.date_to) {
      pills.push({ label: getPresetLabel(filters.date_from, filters.date_to), onRemove: () => onFilter({ date_from: undefined, date_to: undefined }) });
    }
    return pills;
  }, [filters, onFilter]);

  const fieldOptions = FILTER_FIELDS;

  const updateRow = (id: string, patch: Partial<FilterRow>) => {
    setFilterRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addRow = (from?: FilterRow) => {
    setFilterRows((prev) => [...prev, buildFilterRow(from ? { ...from } : undefined)]);
  };

  const removeRow = (id: string) => {
    setFilterRows((prev) => prev.filter((row) => row.id !== id));
  };

  const toggleFieldDropdown = (id: string) => {
    setOpenFieldDropdownId((current) => (current === id ? null : id));
  };

  const dropdownAnchorRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [openValueDropdownId, setOpenValueDropdownId] = useState<string | null>(null);
  const valueAnchorRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const valueDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openFieldDropdownId && !openValueDropdownId) return;

    const handleDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const fAnchor = openFieldDropdownId ? dropdownAnchorRefs.current[openFieldDropdownId] : null;
      const vAnchor = openValueDropdownId ? valueAnchorRefs.current[openValueDropdownId] : null;
      if (fAnchor && fAnchor.contains(target)) return;
      if (vAnchor && vAnchor.contains(target)) return;
      if (dropdownRef.current && dropdownRef.current.contains(target)) return;
      if (valueDropdownRef.current && valueDropdownRef.current.contains(target)) return;
      setOpenFieldDropdownId(null);
      setOpenValueDropdownId(null);
    };

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenFieldDropdownId(null);
        setOpenValueDropdownId(null);
      }
    };

    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [openFieldDropdownId, openValueDropdownId]);

  const dateLabel = getPresetLabel(filters.date_from, filters.date_to);

  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm"
        >
          <span className={`ti ${collapsed ? "ti-chevron-right" : "ti-chevron-down"} text-base`} />
          <span className="font-medium text-gray-500">Filters:</span>
        </button>

        <div className="flex flex-wrap items-center gap-2 flex-1">
          {summaryFilters.length > 0 ? (
            summaryFilters.map((filter) => (
              <span
                key={filter.label}
                className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-gray-100 px-3 py-1 text-xs text-gray-600"
              >
                {filter.label}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    filter.onRemove();
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="text-sm text-gray-400">No filters applied</span>
          )}
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-200 ease-in-out ${collapsed ? "max-h-0 opacity-0" : "max-h-[900px] opacity-100"}`}
        style={{ transitionProperty: "max-height, opacity" }}
      >
        <div className={collapsed ? "pointer-events-none opacity-0" : "opacity-100"}>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenDateDropdown((current) => !current)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm"
              >
                Date Range: {dateLabel}
              </button>
              {openDateDropdown && (
                <div className="absolute left-0 z-20 mt-2 w-72 rounded-2xl border border-gray-200 bg-white p-4 shadow-lg">
                  <div className="space-y-2">
                    {(["Today", "This Week", "This Month", "Last Month", "Custom Range"] as const).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handlePresetSelect(preset)}
                        className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                  {(dateLabel === "Custom Range" || filters.date_from || filters.date_to) && (
                    <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
                      <label className="block text-xs font-semibold uppercase text-gray-400">From</label>
                      <input
                        type="date"
                        value={filters.date_from ?? ""}
                        onChange={(e) => onFilter({ date_from: e.target.value || undefined })}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700"
                      />
                      <label className="block text-xs font-semibold uppercase text-gray-400">To</label>
                      <input
                        type="date"
                        value={filters.date_to ?? ""}
                        onChange={(e) => onFilter({ date_to: e.target.value || undefined })}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => addRow()}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
            >
              <span className="text-base">+</span>
              More Filters
            </button>
          </div>

          {filterRows.length > 0 && (
            <div className="mt-4 space-y-3">
              {filterRows.map((row, index) => {
                const field = FILTER_FIELDS.find((item) => item.key === row.field) ?? FILTER_FIELDS[0];
                const conditionOptions = field.type === "select" ? SELECT_CONDITIONS : TEXT_CONDITIONS;
                return (
                  <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 p-3">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-500">
                      {index + 1}
                    </div>
                    <div className="relative min-w-[180px] flex-1">
                      <button
                        ref={(el) => (dropdownAnchorRefs.current[row.id] = el)}
                        type="button"
                        onClick={() => toggleFieldDropdown(row.id)}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 text-left"
                      >
                        {field.label}
                      </button>
                      {openFieldDropdownId === row.id && (
                        <Portal>
                          <div
                            ref={dropdownRef}
                            className="z-50 rounded-2xl border border-gray-200 bg-white shadow-lg"
                            style={{ width: dropdownAnchorRefs.current[row.id]?.getBoundingClientRect().width ?? 260, position: "absolute", left: dropdownAnchorRefs.current[row.id]?.getBoundingClientRect().left ?? 0, top: (dropdownAnchorRefs.current[row.id]?.getBoundingClientRect().bottom ?? 0) + 8 }}
                          >
                            <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Fields</div>
                            <div className="max-h-56 overflow-y-auto px-2 pb-2">
                              {fieldOptions.map((option) => (
                                <button
                                  key={option.key}
                                  type="button"
                                  onClick={() => {
                                    updateRow(row.id, { field: option.key, condition: option.type === "select" ? "is" : "contains", value: "" });
                                    setOpenFieldDropdownId(null);
                                  }}
                                  className="mb-1 w-full rounded-xl px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                                >
                                  <div className="flex justify-between">
                                    <span>{option.label}</span>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        </Portal>
                      )}
                    </div>
                    <div className="min-w-[130px]">
                      <select
                        value={row.condition}
                        onChange={(e) => updateRow(row.id, { condition: e.target.value })}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700"
                      >
                        {conditionOptions.map((condition) => (
                          <option key={condition} value={condition}>
                            {condition}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex-1 min-w-[180px]">
                      {field.type === "select" ? (
                        <div className="relative">
                          <button
                            ref={(el) => (valueAnchorRefs.current[row.id] = el)}
                            type="button"
                            onClick={() => {
                              setOpenValueDropdownId((current) => (current === row.id ? null : row.id));
                              setValueSearch("");
                            }}
                            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 text-left"
                          >
                            {row.value || `Select ${field.label}`}
                          </button>
                          {openValueDropdownId === row.id && (
                            <Portal>
                              <div
                                ref={valueDropdownRef}
                                className="z-50 rounded-2xl border border-gray-200 bg-white shadow-lg"
                                style={{ width: valueAnchorRefs.current[row.id]?.getBoundingClientRect().width ?? 260, position: "absolute", left: valueAnchorRefs.current[row.id]?.getBoundingClientRect().left ?? 0, top: (valueAnchorRefs.current[row.id]?.getBoundingClientRect().bottom ?? 0) + 8 }}
                              >
                                <div className="max-h-56 overflow-y-auto px-2 pb-2">
                                  {field.options && field.options.length ? (
                                    field.options.map((option) => (
                                      <button
                                        key={option}
                                        type="button"
                                        onClick={() => {
                                          updateRow(row.id, { value: option });
                                          setOpenValueDropdownId(null);
                                        }}
                                        className="mb-1 w-full rounded-xl px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                                      >
                                        {option}
                                      </button>
                                    ))
                                  ) : (
                                    <div className="px-3 py-2 text-sm text-gray-500">No options</div>
                                  )}
                                </div>
                              </div>
                            </Portal>
                          )}
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={row.value}
                          onChange={(e) => updateRow(row.id, { value: e.target.value })}
                          placeholder={`Enter ${field.label}`}
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700"
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => addRow(row)}
                      className="rounded-lg px-2 py-1 text-gray-400 transition hover:text-gray-600"
                      aria-label="Duplicate filter row"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="rounded-lg px-2 py-1 text-gray-400 transition hover:text-red-500"
                      aria-label="Remove filter row"
                    >
                      🗑
                    </button>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button type="button" onClick={() => addRow()} className="text-indigo-600 text-sm font-medium">
                  + Add condition
                </button>
                <button
                  type="button"
                  onClick={applyFilters}
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Apply Filters
                </button>
              </div>
            </div>
          )}

          <div className="relative mt-4">
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
        </div>
      </div>
    </div>
  );
}

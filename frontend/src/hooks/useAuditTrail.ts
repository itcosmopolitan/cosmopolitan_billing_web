import { useCallback, useEffect, useState } from "react";
import { auditApi } from "../api/auditApi";
import type { AuditFilters, AuditLog, AuditLogListResponse } from "../types/audit";

const DEFAULT_FILTERS: AuditFilters = { page: 1, limit: 50 };

export function useAuditTrail() {
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [data, setData] = useState<AuditLogListResponse | null>(null);
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await auditApi.list(filters);
      setData(res);
    } catch {
      setError("Failed to load audit logs.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const updateFilter = useCallback((patch: Partial<AuditFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch, page: 1 };
      const same =
        prev.module === next.module &&
        prev.risk === next.risk &&
        prev.operation_type === next.operation_type &&
        prev.operation_type_not === next.operation_type_not &&
        JSON.stringify(prev.criteria ?? null) === JSON.stringify(next.criteria ?? null) &&
        prev.search === next.search &&
        prev.date_from === next.date_from &&
        prev.date_to === next.date_to &&
        prev.page === next.page &&
        prev.limit === next.limit;
      return same ? prev : next;
    });
  }, []);

  const goToPage = useCallback((page: number) => {
    setFilters((prev) => (prev.page === page ? prev : { ...prev, page }));
  }, []);

  return { data, filters, loading, error, selected, setSelected, updateFilter, goToPage, refresh: fetchLogs };
}

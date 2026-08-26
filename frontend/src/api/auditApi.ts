import { api } from "./index";
import type { AuditFilters, AuditLog, AuditLogListResponse } from "../types/audit";

const serializeFilters = (filters: AuditFilters): Record<string, unknown> => {
  const params: Record<string, unknown> = { ...filters };
  if (filters.criteria) {
    params.criteria = JSON.stringify(filters.criteria);
  } else {
    delete params.criteria;
  }
  return params;
};

export const auditApi = {
  list: async (filters: AuditFilters): Promise<AuditLogListResponse> => {
    return api.get("/audit/", { params: serializeFilters(filters), noBranchScope: true });
  },

  get: async (id: number | string): Promise<AuditLog> => {
    return api.get(`/audit/${id}`);
  },

  exportCsv: async (filters: Omit<AuditFilters, "page" | "limit">): Promise<void> => {
    const blob = await api.get("/audit/export/csv", {
      params: serializeFilters(filters as AuditFilters),
      noBranchScope: true,
      responseType: "blob",
    });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "audit_log.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
  },
};

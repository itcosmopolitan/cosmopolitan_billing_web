import { api } from "./index";
import type { AuditFilters, AuditLog, AuditLogListResponse } from "../types/audit";

const toParams = (filters: Record<string, unknown>): URLSearchParams => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });
  return params;
};

export const auditApi = {
  list: async (filters: AuditFilters): Promise<AuditLogListResponse> => {
    return api.get("/audit/", { params: toParams(filters) });
  },

  get: async (id: number | string): Promise<AuditLog> => {
    return api.get(`/audit/${id}`);
  },

  exportCsv: async (filters: Omit<AuditFilters, "page" | "limit">): Promise<void> => {
    const params = toParams(filters);
    const blob = await api.get("/audit/export/csv", {
      params,
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

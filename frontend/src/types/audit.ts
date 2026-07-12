export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type ModuleType = "Sales" | "Inventory" | "Finance" | "Cash" | "Purchases" | "Auth";

export interface AuditLog {
  id: number | string;
  action: string;
  user_id: string | null;
  user_name: string;
  user_role: string;
  module: ModuleType;
  reference_id: string;
  detail: string;
  risk: RiskLevel;
  ip_address: string | null;
  device_info: string | null;
  branch_id: string | null;
  branch_name?: string;
  event_metadata: Record<string, unknown> | null;
  metadata_: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditLogListResponse {
  total: number;
  page: number;
  limit: number;
  results: AuditLog[];
}

export interface AuditFilters {
  module?: ModuleType | "";
  risk?: RiskLevel | "";
  operation_type?: "Created" | "Deleted" | "Updated" | "";
  operation_type_not?: "Created" | "Deleted" | "Updated" | "";
  search?: string;
  date_from?: string;
  date_to?: string;
  page: number;
  limit: number;
}

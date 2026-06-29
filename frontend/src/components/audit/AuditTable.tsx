import type { AuditLog } from "../../types/audit";
import { ModuleTag } from "./ModuleTag";
import { RiskBadge } from "./RiskBadge";
import { useAppStore } from "../../store";

interface Props {
  logs: AuditLog[];
  selected: AuditLog | null;
  onSelect: (log: AuditLog) => void;
  onClearFilters?: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  create_invoice: "Invoice Created",
  delete_invoice: "Invoice Deleted",
  record_invoice_payment: "Payment Recorded",
  update_invoice_status: "Invoice Status Updated",
  delete_payment: "Payment Deleted",
  delete_customer_payment: "Customer Payment Deleted",
};

const toTitleCase = (value: string) =>
  value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const toDisplayAction = (action: string) => {
  const key = (action || "").trim().toLowerCase();
  if (!key) return "-";
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  return toTitleCase(key.replace(/[_-]+/g, " "));
};

const parseUtcToLocal = (value: string) => {
  const raw = (value || "").trim();
  if (!raw) return null;
  const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const date = new Date(hasTz ? raw : `${raw}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const formatTimeParts = (value: string) => {
  const date = parseUtcToLocal(value);
  if (!date) return { date: "-", time: "-" };
  const datePart = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(date);
  const timePart = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
  return { date: datePart, time: timePart };
};

const isJsonLike = (value: string | null | undefined) => {
  const text = (value || "").trim();
  return text.startsWith("{") || text.startsWith("[");
};

const riskAccent: Record<string, string> = {
  LOW: "border-l-4 border-l-green-400/30 hover:border-l-green-400",
  MEDIUM: "border-l-4 border-l-amber-400/30 hover:border-l-amber-400",
  HIGH: "border-l-4 border-l-red-500/30 hover:border-l-red-500",
};

function EmptyIcon() {
  return (
    <svg viewBox="0 0 64 64" className="h-12 w-12 text-slate-300" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="27" cy="27" r="14" />
      <path d="m39 39 11 11" />
      <path d="M20 27h14" />
    </svg>
  );
}

export function AuditTable({ logs, selected, onSelect, onClearFilters }: Props) {
  const branches = useAppStore((s) => s.branches);

  if (logs.length === 0) {
    return (
      <div className="border rounded-xl py-14 px-6 text-center bg-white">
        <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-slate-50">
          <EmptyIcon />
        </div>
        <h3 className="text-base font-semibold text-slate-800">No events found</h3>
        <p className="mt-1 text-sm text-slate-500">Try adjusting your filters or date range</p>
        <button
          type="button"
          onClick={() => onClearFilters?.()}
          className="mt-4 inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Clear filters
        </button>
      </div>
    );
  }

  const branchLabel = (log: AuditLog) => {
    const apiBranchName = (log as AuditLog & { branch_name?: string | null }).branch_name;
    if (apiBranchName) return apiBranchName;
    if (log.branch_id) {
      const branch = branches.find((b: { id: string; name?: string }) => b.id === log.branch_id);
      if (branch?.name) return branch.name;
    }
    return "—";
  };

  return (
    <div className="border rounded-xl overflow-x-auto bg-white">
      <table className="w-full min-w-[1080px] text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-left px-4 py-3">Action</th>
            <th className="text-left px-4 py-3">User</th>
            <th className="text-left px-4 py-3">Branch</th>
            <th className="text-left px-4 py-3">Module</th>
            <th className="text-left px-4 py-3">Reference</th>
            <th className="text-left px-4 py-3">Detail</th>
            <th className="text-left px-4 py-3">Risk</th>
            <th className="text-left px-4 py-3">Time</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log, index) => {
            const active = selected?.id === log.id;
            const detailIsJson = isJsonLike(log.detail);
            const timeParts = formatTimeParts(log.created_at);
            const riskKey = (log.risk || "LOW").toUpperCase();
            return (
              <tr
                key={String(log.id)}
                onClick={() => onSelect(log)}
                className={[
                  "cursor-pointer border-t transition-colors",
                  riskAccent[riskKey] || "border-l-4 border-l-slate-300/30 hover:border-l-slate-300",
                  active ? "bg-slate-100" : "hover:bg-slate-50",
                  index % 2 === 1 && !active ? "bg-slate-50/30" : "",
                ].join(" ")}
                title={log.detail}
              >
                <td className="px-4 py-3 font-medium text-slate-800" style={{ padding: "12px 16px" }}>{toDisplayAction(log.action)}</td>
                <td className="px-4 py-3" style={{ padding: "12px 16px" }}>{log.user_name || "-"}</td>
                <td className="px-4 py-3" style={{ padding: "12px 16px" }}>{branchLabel(log)}</td>
                <td className="px-4 py-3" style={{ padding: "12px 16px" }}>{log.module ? <ModuleTag module={log.module} /> : "-"}</td>
                <td className="px-4 py-3" style={{ padding: "12px 16px" }}>
                  <span className="font-mono text-xs text-blue-700">{log.reference_id || "-"}</span>
                </td>
                <td className="px-4 py-3 max-w-[360px] truncate" style={{ padding: "12px 16px" }}>
                  {detailIsJson ? <span className="text-slate-400">See full detail ↓</span> : (log.detail || "-")}
                </td>
                <td className="px-4 py-3" style={{ padding: "12px 16px" }}><RiskBadge risk={log.risk} /></td>
                <td className="px-4 py-3 whitespace-nowrap" style={{ padding: "12px 16px" }}>
                  <div className="text-[11px] leading-4 text-slate-500">{timeParts.date}</div>
                  <div className="text-sm font-medium text-slate-700">{timeParts.time}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

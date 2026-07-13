import type { AuditLog } from "../../types/audit";
import { useAppStore } from "../../store";
import { ModuleTag } from "./ModuleTag";
import { RiskBadge } from "./RiskBadge";

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

function EmptyIcon() {
  return (
    <svg viewBox="0 0 64 64" className="h-12 w-12 text-[var(--text-muted)]" fill="none" stroke="currentColor" strokeWidth="2">
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
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-6 py-14 text-center shadow-sm">
        <div className="mx-auto mb-3 grid h-16 w-16 place-items-center rounded-full bg-[var(--bg-raised)]">
          <EmptyIcon />
        </div>
        <h3 className="text-base font-semibold text-[var(--text-primary)]">No events found</h3>
        <p className="mt-1 text-sm text-[var(--text-muted)]">Try adjusting your filters or date range</p>
        <button type="button" onClick={() => onClearFilters?.()} className="btn btn-secondary btn-sm mt-4">
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
    <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-sm">
      <table className="data-table min-w-[1080px]">
        <thead>
          <tr>
            <th>Action</th>
            <th>User</th>
            <th>Branch</th>
            <th>Module</th>
            <th>Reference</th>
            <th>Detail</th>
            <th>Risk</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log, index) => {
            const active = selected?.id === log.id;
            const detailIsJson = isJsonLike(log.detail);
            const timeParts = formatTimeParts(log.created_at);
            return (
              <tr
                key={String(log.id)}
                onClick={() => onSelect(log)}
                className={[
                  "cursor-pointer transition-colors",
                  active ? "bg-[var(--bg-hover)]" : index % 2 === 0 ? "bg-[var(--bg-surface)]" : "bg-[var(--bg-raised)]",
                ].join(" ")}
                title={log.detail}
              >
                <td className="font-semibold text-[var(--text-primary)]">{toDisplayAction(log.action)}</td>
                <td className="text-[var(--text-secondary)]">{log.user_name || "-"}</td>
                <td className="text-[var(--text-secondary)]">{branchLabel(log)}</td>
                <td>{log.module ? <ModuleTag module={log.module} /> : "-"}</td>
                <td>
                  <span className="font-mono text-[11px] font-semibold text-[var(--accent)]">{log.reference_id || "-"}</span>
                </td>
                <td className="max-w-[360px] truncate text-[var(--text-secondary)]">
                  {detailIsJson ? <span className="text-[var(--text-muted)]">See full detail ↓</span> : log.detail || "-"}
                </td>
                <td>
                  <RiskBadge risk={log.risk} />
                </td>
                <td className="whitespace-nowrap">
                  <div className="text-[11px] leading-4 text-[var(--text-muted)]">{timeParts.date}</div>
                  <div className="text-sm font-semibold text-[var(--text-primary)]">{timeParts.time}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

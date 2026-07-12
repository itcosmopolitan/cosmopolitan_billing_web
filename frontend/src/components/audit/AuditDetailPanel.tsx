import { format } from "date-fns";
import { useEffect } from "react";
import type { AuditLog } from "../../types/audit";
import { RiskBadge } from "./RiskBadge";
import { useAppStore } from "../../store";

interface Props {
  log: AuditLog | null;
  onClose: () => void;
}

export function AuditDetailPanel({ log, onClose }: Props) {
  const branches = useAppStore((s) => s.branches);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (log) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [log, onClose]);

  if (!log) return null;

  const formatLocalTimestamp = (value: string) => {
    const raw = (value || "").trim();
    if (!raw) return "-";
    const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
    const date = new Date(hasTz ? raw : `${raw}Z`);
    if (Number.isNaN(date.getTime())) return value || "-";

    return format(date, "d MMM yyyy, h:mm a");
  };

  const parseDevice = (userAgent: string | null | undefined) => {
    const ua = (userAgent || "").trim();
    if (!ua) return "-";

    let browser = "";
    const edge = ua.match(/Edg\/(\d+)/i);
    const chrome = ua.match(/Chrome\/(\d+)/i);
    const firefox = ua.match(/Firefox\/(\d+)/i);
    const safari = ua.match(/Version\/(\d+).+Safari\//i);

    if (edge) browser = `Edge ${edge[1]}`;
    else if (chrome && !/Edg\//i.test(ua)) browser = `Chrome ${chrome[1]}`;
    else if (firefox) browser = `Firefox ${firefox[1]}`;
    else if (safari && !/Chrome\//i.test(ua)) browser = `Safari ${safari[1]}`;
    else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Safari";

    let os = "";
    if (/Windows NT/i.test(ua)) os = "Windows";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    else if (/Android/i.test(ua)) os = "Android";
    else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
    else if (/Linux/i.test(ua)) os = "Linux";

    if (browser && os) return `${browser} / ${os}`;
    if (browser) return browser;
    if (os) return os;

    const shortened = ua.slice(0, 40);
    return `${shortened}...`;
  };

  const toTitleCase = (value: string) =>
    value
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");

  const formatSimpleValue = (value: unknown): string => {
    if (value === null || value === undefined || value === "") return "-";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const items = value.map(formatSimpleValue);
      if (value.every((item) => item === null || item === undefined || typeof item !== "object")) {
        return items.join(", ");
      }
      return `[${items.join(", ")}]`;
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };

  const resolveBranchName = (branchId: unknown) => {
    if (branchId === null || branchId === undefined || branchId === "") return "—";
    const id = String(branchId);
    const branch = branches.find((b: { id: string; name?: string }) => b.id === id);
    return branch?.name || id;
  };

  const labelForMetadataKey = (key: string) => {
    switch (key) {
      case "from_branch_id":
        return "From Branch";
      case "to_branch_id":
        return "To Branch";
      case "transfer_id":
        return "Transfer ID";
      case "qty_total":
        return "Total Quantity";
      case "stock_value":
        return "Stock Value";
      case "approver_id":
        return "Approver ID";
      case "requester_id":
        return "Requester ID";
      default:
        return toTitleCase(key);
    }
  };

  const renderMetadataRows = (metadata: Record<string, unknown>, excludeKeys: string[] = []) =>
    Object.entries(metadata)
      .filter(([key]) => !excludeKeys.includes(key))
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => {
        const label = labelForMetadataKey(key);
        if (key === "from_branch_id" || key === "to_branch_id") {
          return {
            label,
            value: resolveBranchName(value),
          };
        }
        return {
          label,
          value: formatSimpleValue(value),
        };
      });

  const formatChangeSummary = (metadata: Record<string, unknown>) => {
    const updatedFields = metadata.updated_fields;
    if (Array.isArray(updatedFields) && updatedFields.length > 0) {
      return `Updated fields: ${updatedFields.map((item) => toTitleCase(String(item))).join(", ")}`;
    }

    const beforeQty = metadata.before_qty ?? metadata.old_qty ?? metadata.prev_qty;
    const newQty = metadata.new_qty ?? metadata.qty ?? metadata.quantity;
    if (beforeQty !== undefined && newQty !== undefined) {
      return `Quantity changed from ${formatSimpleValue(beforeQty)} to ${formatSimpleValue(newQty)}`;
    }

    if (metadata.before_value !== undefined && metadata.after_value !== undefined) {
      return `Value changed from ${formatSimpleValue(metadata.before_value)} to ${formatSimpleValue(metadata.after_value)}`;
    }

    return null;
  };

  const renderChangeRows = (metadata: Record<string, unknown>) => {
    const changes = metadata.changes;
    if (!changes) return [];

    if (Array.isArray(changes)) {
      return changes
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
        .map((change, index) => {
          const fieldName = change.field ? toTitleCase(String(change.field)) : `Change ${index + 1}`;
          const itemName = typeof change.item_name === "string" ? `${change.item_name}: ` : "";
          const before = formatSimpleValue(change.before ?? change.old);
          const after = formatSimpleValue(change.after ?? change.new);
          const value = before !== "-" || after !== "-"
            ? `${before} → ${after}`
            : formatSimpleValue(change.detail ?? change);
          return {
            label: `${itemName}${fieldName}`,
            value,
          };
        });
    }

    if (typeof changes !== "object") return [];
    return Object.entries(changes as Record<string, unknown>)
      .map(([field, rawValue]) => {
        if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return null;
        const value = rawValue as Record<string, unknown>;
        return {
          label: toTitleCase(field),
          value: `${formatSimpleValue(value.before)} → ${formatSimpleValue(value.after)}`,
        };
      })
      .filter((item): item is { label: string; value: string } => item !== null);
  };

  const getSimpleSummary = () => {
    const actionLabel = toTitleCase(log.action || "Event");
    const reference = log.reference_id ? ` for ${log.reference_id}` : "";
    const user = log.user_name ? ` by ${log.user_name}` : "";
    return `${actionLabel}${reference}${user}`;
  };

  const eventMetadata = log.event_metadata && typeof log.event_metadata === "object" ? log.event_metadata : null;
  const eventMetadataRows = eventMetadata
    ? renderMetadataRows(eventMetadata, ["updated_fields", "changes", "item_id"])
    : [];
  const metadataRowsFiltered = log.metadata_
    ? renderMetadataRows(log.metadata_, ["updated_fields", "changes", "item_id"])
    : [];
  const changeRows = [
    ...(eventMetadata ? renderChangeRows(eventMetadata) : []),
    ...(log.metadata_ ? renderChangeRows(log.metadata_) : []),
  ];
  const changeSummary = formatChangeSummary(eventMetadata ?? log.metadata_ ?? {});
  const branchLabel = (() => {
    const apiBranchName = (log as AuditLog & { branch_name?: string | null }).branch_name;
    if (apiBranchName) return apiBranchName;
    if (log.branch_id) {
      const branch = branches.find((b: { id: string; name?: string }) => b.id === log.branch_id);
      if (branch?.name) return branch.name;
      return String(log.branch_id);
    }
    return "—";
  })();

  const roleLabel = ((): string => {
    const r = log.user_role ?? '';
    const s = String(r).trim();
    if (!s) return '—';
    if (s.toLowerCase() === 'unknown') return '—';
    return toTitleCase(s);
  })();

  const moduleLabel = ((): string => {
    const m = log.module ?? '';
    const s = String(m).trim();
    if (!s) return '—';
    return s.charAt(0).toUpperCase() + s.slice(1);
  })();

  const actionName = toTitleCase(log.action || 'Event');
  const detailString = getSimpleSummary();

  const riskColor = (risk: string | null | undefined) => {
    const r = (risk || '').toString().toLowerCase();
    if (r === 'high') return '#dc2626';
    if (r === 'medium') return '#f59e0b';
    return '#16a34a';
  };

  const combinedMetadata = [...eventMetadataRows, ...metadataRowsFiltered];
  const metadataDisplayRows = [...combinedMetadata, ...changeRows];
  const rawMetadata = eventMetadata ?? log.metadata_ ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ borderTop: `4px solid ${riskColor(log.risk)}`, width: 760, maxWidth: 'calc(100% - 32px)' }}
        className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-2xl"
      >
        {/* HEADER */}
        <div className="mb-4 flex items-start justify-between border-b border-[var(--border-subtle)] pb-4">
          <div>
            <div className="text-base font-semibold text-[var(--text-primary)]">{actionName}</div>
            <div className="text-sm text-[var(--text-muted)]">{detailString}</div>
          </div>
          <div>
            <button type="button" onClick={onClose} className="btn btn-ghost btn-sm text-[var(--text-secondary)]">×</button>
          </div>
        </div>

        {/* KEY FIELDS GRID */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">User</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{log.user_name || '—'}</div>
          </div>
          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Role</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{roleLabel}</div>
          </div>

          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">IP Address</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{log.ip_address || '—'}</div>
          </div>
          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Device</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{parseDevice(log.device_info)}</div>
          </div>

          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Module</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{moduleLabel}</div>
          </div>
          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Branch</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{branchLabel || '—'}</div>
          </div>

          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Risk</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]"><RiskBadge risk={log.risk} /></div>
          </div>
          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Timestamp</div>
            <div className="text-sm font-medium text-[var(--text-secondary)]">{formatLocalTimestamp(log.created_at)}</div>
          </div>
        </div>

        {/* REFERENCE CHIP */}
        <div className="mb-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Reference</div>
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2 font-mono text-sm text-[var(--accent)]">{log.reference_id || '—'}</div>
        </div>

        <div className="mb-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Description</div>
          <div className="whitespace-pre-wrap break-words rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-4 text-sm text-[var(--text-secondary)]">
            {log.detail || '—'}
          </div>
        </div>

        {changeSummary && (
          <div className="mb-4 rounded-2xl border border-[var(--amber)]/20 bg-[var(--amber-bg)] p-4 text-sm text-[var(--amber)]">
            {changeSummary}
          </div>
        )}

        {metadataDisplayRows.length > 0 ? (
          <div className="mb-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Metadata</div>
            <div className="grid grid-cols-2 gap-2">
              {metadataDisplayRows.map((row, index) => {
                const val = String(row.value ?? '');
                const isLong = val.length > 24;
                const displayVal = isLong ? `${val.slice(0, 8)}...` : val || '-';
                return (
                  <div key={`${row.label}-${index}`} className="rounded-lg bg-[var(--bg-raised)] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-widest text-[var(--text-muted)]">{row.label}</div>
                    <div className="truncate text-sm font-medium text-[var(--text-secondary)]" title={isLong ? val : undefined}>{displayVal}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : rawMetadata ? (
          <div className="mb-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">Raw Metadata</div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-raised)] p-4 text-sm text-[var(--text-secondary)]">
              {JSON.stringify(rawMetadata, null, 2)}
            </pre>
          </div>
        ) : null}

      </div>
    </div>
  );
}

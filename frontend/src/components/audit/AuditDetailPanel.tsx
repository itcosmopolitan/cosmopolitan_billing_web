import { format } from "date-fns";
import type { AuditLog } from "../../types/audit";
import { RiskBadge } from "./RiskBadge";
import { useAppStore } from "../../store";

interface Props {
  log: AuditLog | null;
  onClose: () => void;
}

export function AuditDetailPanel({ log, onClose }: Props) {
  const branches = useAppStore((s) => s.branches);

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
    if (Array.isArray(value)) return value.map(formatSimpleValue).join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  const renderMetadataRows = (metadata: Record<string, unknown>, excludeKeys: string[] = []) =>
    Object.entries(metadata)
      .filter(([key]) => !excludeKeys.includes(key))
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => ({
        label: toTitleCase(key),
        value: formatSimpleValue(value),
      }));

  const formatChangeSummary = (metadata: Record<string, unknown>) => {
    const updatedFields = metadata.updated_fields;
    if (Array.isArray(updatedFields) && updatedFields.length > 0) {
      return `Updated fields: ${updatedFields.map((item) => toTitleCase(String(item))).join(", ")}`;
    }

    if (metadata.before_qty !== undefined && metadata.new_qty !== undefined) {
      return `Quantity changed from ${formatSimpleValue(metadata.before_qty)} to ${formatSimpleValue(metadata.new_qty)}`;
    }

    if (metadata.before_value !== undefined && metadata.after_value !== undefined) {
      return `Value changed from ${formatSimpleValue(metadata.before_value)} to ${formatSimpleValue(metadata.after_value)}`;
    }

    return null;
  };

  const renderChangeRows = (metadata: Record<string, unknown>) => {
    const changes = metadata.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];

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
    ? renderMetadataRows(log.metadata_, ["item_id"])
    : [];
  const changeRows = eventMetadata ? renderChangeRows(eventMetadata) : [];
  const changeSummary = eventMetadata ? formatChangeSummary(eventMetadata) : null;
  const metadataBranchName =
    log.metadata_ && typeof log.metadata_.branch_name === "string" ? String(log.metadata_.branch_name) : "";
  const eventBranchName =
    eventMetadata && typeof eventMetadata.branch_name === "string" ? String(eventMetadata.branch_name) : "";
  const resolvedBranchName = branches.find((b: { id: string; name?: string }) => b.id === log.branch_id)?.name;
  const branchLabel = eventBranchName || metadataBranchName || resolvedBranchName || log.branch_id || "-";

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close detail panel"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside className="absolute top-0 right-0 h-screen w-[400px] bg-white border-l shadow-[-8px_0_24px_rgba(15,23,42,0.12)] overflow-y-auto">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="text-base font-semibold">Audit Detail</h2>
        <button type="button" onClick={onClose} className="text-xl leading-none text-slate-500 hover:text-slate-800">
          ×
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-400 font-medium mb-1">What happened</div>
          <div className="text-sm font-medium text-slate-800">{getSimpleSummary()}</div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-slate-500">User:</span> {log.user_name || "-"}</div>
          <div><span className="text-slate-500">Role:</span> {log.user_role || "-"}</div>
          <div><span className="text-slate-500">IP Address:</span> {log.ip_address || "-"}</div>
          <div><span className="text-slate-500">Device:</span> {parseDevice(log.device_info)}</div>
          <div><span className="text-slate-500">Module:</span> {log.module || "-"}</div>
          <div><span className="text-slate-500">Branch:</span> {branchLabel}</div>
          <div className="flex items-center gap-2"><span className="text-slate-500">Risk:</span> <RiskBadge risk={log.risk} /></div>
        </div>

        <div className="text-sm">
          <div className="text-slate-500 mb-1">Reference</div>
          <div className="font-mono text-xs bg-slate-50 border rounded p-2">{log.reference_id || "-"}</div>
        </div>

        <div className="text-sm">
          <div className="text-slate-500 mb-1">Timestamp</div>
          <div>{formatLocalTimestamp(log.created_at)}</div>
        </div>

        {eventMetadataRows.length > 0 && (
          <div className="text-sm">
            <div className="text-slate-500 mb-1">What changed</div>
            {changeSummary && (
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2 text-sm text-slate-700 mb-2">
                {changeSummary}
              </div>
            )}
            {changeRows.length > 0 && (
              <div className="space-y-2 mb-2">
                {changeRows.map((row) => (
                  <div key={row.label} className="rounded-lg border border-indigo-100 bg-white px-3 py-2">
                    <div className="text-xs uppercase tracking-wide text-slate-400 font-medium">{row.label}</div>
                    <div className="text-sm text-slate-700 mt-0.5 break-words">{row.value}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {eventMetadataRows.map((row) => (
                <div key={row.label} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-slate-400 font-medium">{row.label}</div>
                  <div className="text-sm text-slate-700 mt-0.5 break-words">{row.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {metadataRowsFiltered.length > 0 && (
          <div className="text-sm">
            <div className="text-slate-500 mb-1">Metadata</div>
            <div className="space-y-2">
              {metadataRowsFiltered.map((row) => (
                <div key={row.label} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-slate-400 font-medium">{row.label}</div>
                  <div className="text-sm text-slate-700 mt-0.5 break-words">{row.value}</div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
      </aside>
    </div>
  );
}

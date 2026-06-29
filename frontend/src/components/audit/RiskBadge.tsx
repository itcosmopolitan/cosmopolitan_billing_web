import type { RiskLevel } from "../../types/audit";

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  if (risk === "LOW") {
    return <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">LOW</span>;
  }

  if (risk === "MEDIUM") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
        <span aria-hidden="true">⚠</span>
        MEDIUM
      </span>
    );
  }

  return (
    <>
      <style>{`@keyframes auditPulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,0.35)}70%{box-shadow:0 0 0 7px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}`}</style>
      <span
        className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700"
        style={{ animation: "auditPulse 1.8s ease-in-out infinite" }}
      >
        <span aria-hidden="true">!</span>
        HIGH
      </span>
    </>
  );
}

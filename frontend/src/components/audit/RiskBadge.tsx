import type { RiskLevel } from "../../types/audit";

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const tone =
    risk === "LOW"
      ? { background: "var(--green-bg)", color: "var(--green)" }
      : risk === "MEDIUM"
        ? { background: "var(--amber-bg)", color: "var(--amber)" }
        : { background: "var(--red-bg)", color: "var(--red)" };

  return (
    <span className="chip" style={tone}>
      {risk ?? "LOW"}
    </span>
  );
}

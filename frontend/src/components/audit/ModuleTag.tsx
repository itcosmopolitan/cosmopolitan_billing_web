import { formatLabel } from "@/utils/helpers";

const styles: Record<string, { background: string; color: string }> = {
  sales: { background: "var(--blue-bg)", color: "var(--blue)" },
  inventory: { background: "var(--green-bg)", color: "var(--green)" },
  finance: { background: "var(--amber-bg)", color: "var(--amber)" },
  cash: { background: "var(--purple-bg)", color: "var(--purple)" },
  purchases: { background: "var(--red-bg)", color: "var(--red)" },
  auth: { background: "var(--teal-bg)", color: "var(--teal)" },
};

const toDisplayModule = (module: string) => {
  const value = (module || "").trim();
  if (!value) return "-";
  return formatLabel(value) || "-";
};

export function ModuleTag({ module }: { module: string }) {
  const key = (module || "").trim().toLowerCase();
  const tone = styles[key] || { background: "var(--bg-raised)", color: "var(--text-secondary)" };
  return (
    <span className="chip" style={{ background: tone.background, color: tone.color }}>
      {toDisplayModule(module)}
    </span>
  );
}

const styles: Record<string, string> = {
  sales: "bg-blue-100 text-blue-700",
  inventory: "bg-emerald-100 text-emerald-700",
  finance: "bg-amber-100 text-amber-700",
  cash: "bg-orange-100 text-orange-700",
  purchases: "bg-pink-100 text-pink-700",
  auth: "bg-violet-100 text-violet-700",
};

const toDisplayModule = (module: string) => {
  const value = (module || "").trim();
  if (!value) return "-";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
};

export function ModuleTag({ module }: { module: string }) {
  const key = (module || "").trim().toLowerCase();
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[key] || "bg-slate-100 text-slate-700"}`}>
      {toDisplayModule(module)}
    </span>
  );
}

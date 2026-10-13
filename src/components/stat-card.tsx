import type { LucideIcon } from "lucide-react";

export function StatCard({ label, value, detail, tone = "default", icon: Icon }: {
  label: string; value: string; detail?: string; tone?: "default" | "green" | "amber" | "blue"; icon?: LucideIcon;
}) {
  return <article className={`stat-card tone-${tone}`}>
    <div className="stat-label">{Icon && <Icon size={18} />}<span>{label}</span></div>
    <strong>{value}</strong>
    {detail && <small>{detail}</small>}
  </article>;
}

import type { LucideIcon } from "lucide-react";

/** Compact KPI Card（spec §6.4）：收入/支出/结余/储蓄率。
 *  - min-height 88px, padding 16-18px
 *  - icon circle 36px / 18px icon
 *  - value 19-21px, tabular-nums
 *  - 不使用彩色卡片背景
 */
export function KpiCard({
  label,
  value,
  delta,
  icon: Icon,
  tone,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  icon: LucideIcon;
  tone?: "default" | "success" | "danger" | "warning";
  className?: string;
}) {
  const hasDelta = delta !== undefined && delta !== null;
  const iconCls = ["kpi-card-icon", tone && tone !== "default" ? `is-${tone}` : ""]
    .filter(Boolean)
    .join(" ");
  const cls = ["kpi-card", "summary-card", className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <span className={iconCls} aria-hidden="true">
        <Icon size={18} />
      </span>
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="kpi-card-label [font:var(--type-label)] text-[var(--text-muted)]">{label}</div>
        <div className="kpi-card-value [font:var(--type-kpi-value)] text-[var(--text-strong)] [font-variant-numeric:tabular-nums]">{value}</div>
        <div className="kpi-card-delta min-h-[var(--space-5)] [font:var(--type-caption)] font-medium" aria-hidden={hasDelta ? undefined : true}>
          {hasDelta ? delta : null}
        </div>
      </div>
    </div>
  );
}

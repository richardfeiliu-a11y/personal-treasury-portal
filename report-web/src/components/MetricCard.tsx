import type { LucideIcon } from "lucide-react";

/** Metric Card（spec §6.3）：总资产/总负债/净资产等中等密度数据卡。
 *  - min-height 160px, padding 20px
 *  - 36x36 icon container, 18px icon
 *  - label 13px, value 20-22px / 700
 */
export function MetricCard({
  label,
  value,
  delta,
  icon: Icon,
  tone,
  ariaLabel,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  icon: LucideIcon;
  tone?: "default" | "danger" | "warning";
  ariaLabel?: string;
  className?: string;
}) {
  const hasDelta = delta !== undefined && delta !== null;
  const iconCls = ["metric-card-icon", tone && tone !== "default" ? `is-${tone}` : ""]
    .filter(Boolean)
    .join(" ");
  const cls = ["metric-card", "summary-card", className].filter(Boolean).join(" ");
  return (
    <div className={cls} role="group" aria-label={ariaLabel}>
      <div className="flex items-start justify-between gap-[var(--space-3)]">
        <div className="[font:var(--type-label)] text-[var(--text-muted)]">{label}</div>
        <span className={iconCls} aria-hidden="true">
          <Icon size={18} />
        </span>
      </div>
      <div className="metric-card-value [font:var(--type-card-value)] text-[var(--text-strong)] [font-variant-numeric:tabular-nums]">{value}</div>
      <div className="metric-card-delta min-h-[var(--space-5)] [font:var(--type-caption)] font-medium" aria-hidden={hasDelta ? undefined : true}>
        {hasDelta ? delta : null}
      </div>
    </div>
  );
}

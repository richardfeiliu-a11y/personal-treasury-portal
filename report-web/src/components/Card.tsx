import type { ReactNode } from "react";

export type CardVariant = "chart" | "data" | "flat";

export type CardSurface = "solid" | "glass";

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  variant?: CardVariant;
  /**
   * 表面风格兼容原语：
   * - undefined（默认）→ 不输出 data-surface，保持既有玻璃视觉完全不变；
   * - "solid" → data-surface="solid"，不透明高对比（var(--card)）；
   * - "glass" → data-surface="glass"，玻璃拟态（backdrop-filter + 玻璃 token）。
   */
  surface?: CardSurface;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  noPadding?: boolean;
  ariaLabel?: string;
}

/** 通用 Card（spec §6.1）：白底、12px radius、20px padding、shadow-card。 */
export function Card({
  title,
  subtitle,
  action,
  footer,
  variant = "data",
  surface,
  children,
  className,
  contentClassName,
  noPadding,
  ariaLabel,
}: CardProps) {
  const cls = ["card", `card-${variant}`, className].filter(Boolean).join(" ");
  const bodyCls = ["card-body", noPadding && "card-body-no-padding", contentClassName].filter(Boolean).join(" ");
  const surfaceAttr = surface === undefined ? undefined : { "data-surface": surface };
  const variantCls =
    variant === "flat"
      ? "bg-transparent shadow-none border-0"
      : "bg-[var(--card)] shadow-[var(--shadow-card)] border border-[var(--border-soft)]";
  const surfaceCls =
    surface === "glass"
      ? "!bg-[var(--glass-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)]"
      : "";
  return (
    <section
      className={`${cls} rounded-[12px] p-[var(--space-5)] ${variantCls} ${surfaceCls}`}
      aria-label={ariaLabel}
      {...surfaceAttr}
    >
      {(title || action) && (
        <header className="card-header flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-4)] min-h-7 max-[479px]:flex-wrap [.home-analysis-grid_&]:h-7 [.home-analysis-grid_&]:min-h-7 [.home-summary-grid_&]:h-7 [.home-summary-grid_&]:min-h-7 [.home-expense-ranking_&]:h-7 [.home-expense-ranking_&]:min-h-7 [.income-analytics_&]:min-h-[var(--touch-target)]">
          <div>
            {title && <h2 className="card-title m-0 [font:var(--type-section-title)] text-[var(--text-strong)] [.home-analysis-grid_&]:min-w-0 [.home-analysis-grid_&]:text-left [.home-summary-grid_&]:min-w-0 [.home-summary-grid_&]:text-left [.home-expense-ranking_&]:min-w-0 [.home-expense-ranking_&]:text-left [.anomaly-group_&]:mb-[var(--space-3)]">{title}</h2>}
            {subtitle && <p className="card-subtitle mt-1 mx-0 mb-0 [font:var(--type-caption)] text-[var(--text-faint)]">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={bodyCls}>{children}</div>
      {footer && <footer className="card-footer mt-[var(--space-4)] pt-[var(--space-4)] border-t border-t-[var(--border-soft)] [font:var(--type-caption)] text-[var(--text-faint)]">{footer}</footer>}
    </section>
  );
}

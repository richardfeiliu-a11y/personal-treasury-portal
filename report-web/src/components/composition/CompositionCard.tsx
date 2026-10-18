import type { ReactNode } from "react";

/**
 * 构成分析共享卡壳（spec §7.2）：标题、控制区、context/caption、两栏布局与
 * 状态容器。业务计算、事件全部由 slot child 提供；本组件不做任何业务分支。
 */
export interface CompositionCardProps {
  ariaLabel: string;
  title?: string; // default 构成分析
  controls: ReactNode;
  context?: ReactNode;
  chart?: ReactNode;
  ranking?: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  /** blocked / empty 等单面板状态；提供时取代两栏 chart/ranking。 */
  children?: ReactNode;
}

export function CompositionCard({
  ariaLabel,
  title = "构成分析",
  controls,
  context,
  chart,
  ranking,
  footer,
  busy,
  children,
}: CompositionCardProps) {
  return (
    <section className="card comp-card min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none flex flex-col gap-[var(--space-4)] min-h-[360px] max-sm:p-[var(--card-padding-mobile)]" aria-label={ariaLabel} aria-busy={busy ? true : undefined}>
      <header className="flex items-center justify-between gap-[var(--space-3)] flex-wrap">
        <h2 className="m-0 [font:var(--type-title)] text-[var(--text-body)]">{title}</h2>
        <div className="flex items-center gap-[var(--space-2)] flex-wrap">{controls}</div>
      </header>
      {context ? <div className="text-[var(--text-faint)] [font:var(--type-caption)]">{context}</div> : null}
      {children ? (
        <div className="[grid-column:1_/_-1]">{children}</div>
      ) : (
        <div className="comp-card-grid grid [grid-template-columns:minmax(0,_2fr)_minmax(0,_3fr)] gap-[var(--space-6)] [align-items:start] max-sm:[grid-template-columns:minmax(0,_1fr)] max-sm:gap-[var(--space-4)]">
          <div className="comp-card-chart">{chart}</div>
          <div className="comp-card-ranking">{ranking}</div>
        </div>
      )}
      {footer ? <div className="comp-card-footer">{footer}</div> : null}
    </section>
  );
}

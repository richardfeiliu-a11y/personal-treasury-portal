/**
 * ExceptionRadar：紧急度排序的异常流（Critical -> Warning -> Info），
 * 内联 SnoozeMenu（ALIGN-08 obsidian overlay）+ Web->Hermes Quick Command。
 *
 * Trends 页（spec section 10）主键视图；UI 与 AlertsPage 异常列表并行，
 * 二者共享 snooze.ts 存储层。Snooze 菜单采用 inline popover（遮罩色）；
 * 如需浮动锚点可后续统一为 Radix Popover（非本 WP 范畴，避免新增依赖）。
 *
 * 纯展示：静音表 / 显隐切换 / 菜单打开状态由父页控制，便于单元测试。
 */
import { useEffect } from "react";
import type { AnomalyRow } from "../api/types";
import { Link } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { type DismissalState, type SnoozeDuration } from "../utils/snooze";
import {
  type DismissalMap,
  SEVERITY_LABEL,
  filterVisibleAnomalies,
  isAnomalySnoozed,
  sortAnomaliesBySeverity,
} from "../utils/anomalyFilters";
import { Amount } from "./Amount";
import { EmptyState } from "./EmptyState";

export interface ExceptionRadarProps {
  /** 全部异常（未经过滤）。 */
  items: AnomalyRow[];
  /** 归一化关闭表：id -> temporary/permanent 状态。 */
  dismissals: DismissalMap;
  showSnoozed: boolean;
  openMenuId: string | null;
  onToggleShowSnoozed: () => void;
  onOpenMenu: (id: string | null) => void;
  onSnooze: (id: string, duration: SnoozeDuration) => void;
  onUnsnooze: (id: string) => void;
  onQuickCommand: (row: AnomalyRow) => void;
}

/** Snooze 时长选项，镜像 AlertsPage，避免 label/duration 在多处漂移。 */
const SNOOZE_OPTIONS: { value: SnoozeDuration; label: string }[] = [
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "forever", label: "不再提醒此异常" },
];

/** 严重度遍历顺序（Critical -> Warning -> Info）。 */
const SEVERITY_ORDER: AnomalyRow["severity"][] = ["critical", "warning", "info"];

/** 严重度 -> 色点。分级标题已说明级别，行内不再重复文字。 */
const SEVERITY_DOT: Record<AnomalyRow["severity"], string> = {
  critical: "bg-[var(--danger-500,#c2413b)]",
  warning: "bg-[var(--warning-500,#c9a24b)]",
  info: "bg-[var(--data-neutral)]",
};

const RADAR_LINK =
  "inline-flex items-center h-[30px] px-2 text-[13px] font-medium text-[var(--brand-text)] no-underline hover:underline";
const RADAR_GHOST =
  "inline-flex items-center h-[30px] px-2 text-[13px] text-[var(--text-muted)] no-underline hover:text-[var(--text-strong)]";
const RADAR_ICON =
  "inline-flex h-[30px] w-[30px] items-center justify-center rounded-[8px] text-[var(--text-subtle)] hover:bg-[var(--surface-subtle)]";

export function ExceptionRadar({
  items,
  dismissals,
  showSnoozed,
  openMenuId,
  onToggleShowSnoozed,
  onOpenMenu,
  onSnooze,
  onUnsnooze,
  onQuickCommand,
}: ExceptionRadarProps) {
  const visible = filterVisibleAnomalies(items, dismissals, { showSnoozed });
  const ordered = sortAnomaliesBySeverity(visible);
  const groups = SEVERITY_ORDER
    .map((s) => ordered.filter((r) => r.severity === s))
    .filter((g) => g.length > 0);

  const dismissedCount = items.filter((r) => isAnomalySnoozed(r, dismissals)).length;
  const rowState = (r: AnomalyRow): DismissalState | undefined => dismissals[r.id];

  useEffect(() => {
    if (!openMenuId) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(".anomaly-snooze-menu [role='menuitem']")?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openMenuId]);

  return (
    <section className="card min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none" aria-label="异常雷达">
      <div className="filter-row grid [grid-template-columns:2fr_repeat(4,_1fr)] gap-[var(--space-3)] [align-items:end] max-[1439px]:[grid-template-columns:1fr_1fr_1fr] max-md:[grid-template-columns:1fr] [.filter-row+&]:mt-[var(--space-3)]">
        <div className="filter-checks flex flex-wrap gap-[var(--space-4)] [font:var(--type-caption)] text-[var(--text-muted)] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5 max-md:[.accounts-page_&_label]:h-[var(--touch-target)] max-md:[.accounts-page_&_label]:min-h-[var(--touch-target)]">
          <label>
            <input
              type="checkbox"
              checked={showSnoozed}
              onChange={onToggleShowSnoozed}
            />
            显示已静音异常
          </label>
          {dismissedCount > 0 && <span className="label">已静音 {dismissedCount} 项</span>}
        </div>
      </div>

      {ordered.length === 0 ? (
        <EmptyState
          title="暂无异常"
          description={
            showSnoozed
              ? "已静音的异常在当前周期不再提醒，取消勾选可恢复。"
              : "支出趋势与健康检查均正常。"
          }
        />
      ) : (
        groups.map((group) => {
          const title = SEVERITY_LABEL[group[0].severity];
          return (
            <div key={title} className="anomaly-group mb-[var(--space-5)] last:mb-0">
              <h2 className="m-0 [font:var(--type-section-title)] text-[var(--text-strong)] [.home-analysis-grid_&]:min-w-0 [.home-analysis-grid_&]:text-left [.home-summary-grid_&]:min-w-0 [.home-summary-grid_&]:text-left [.home-expense-ranking_&]:min-w-0 [.home-expense-ranking_&]:text-left [.anomaly-group_&]:mb-[var(--space-3)]">{title}</h2>
              <ul role="list" aria-label={title + "异常"} className="list-none m-0 p-0 flex flex-col gap-3">
                {group.map((r) => {
                  const snoozedNow = isAnomalySnoozed(r, dismissals);
                  const state = rowState(r);
                  return (
                    <li
                      key={r.id}
                      className={
                        "anomaly-item anomaly-" +
                        r.severity +
                        " is-neutral-surface" +
                        (snoozedNow ? " is-snoozed" : "")
                      }
                    >
                      <div className="flex items-center justify-between gap-3 w-full flex-wrap">
                        <span
                          className={"inline-block h-2 w-2 shrink-0 rounded-full " + SEVERITY_DOT[r.severity]}
                          role="img"
                          aria-label={title}
                        />
                        {snoozedNow && (
                          <span className="inline-flex items-center h-6 py-0 px-2.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)] [font:500_12px/1_var(--font-family-base)]">
                            {state?.type === "permanent" ? "已关闭" : "已静音"}
                          </span>
                        )}
                        <code className="font-[var(--font-family-base)] text-[12px] text-[var(--text-subtle)] bg-[var(--surface-subtle)] py-0.5 px-2 rounded break-all">
                          <span className="absolute w-px h-px m-[-1px] p-0 overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap border-0">来源：</span>
                          {r.source}
                        </code>
                        <span className="anomaly-actions ml-auto inline-flex items-center gap-1">
                          <Link className={RADAR_LINK} to="/alerts">查看详情</Link>
                          <Link
                            className={RADAR_GHOST}
                            to={r.category
                              ? "/transactions?category=" + encodeURIComponent(r.category)
                              : "/transactions"}
                          >
                            核对交易
                          </Link>
                          {snoozedNow ? (
                            <button type="button" className={RADAR_GHOST} onClick={() => onUnsnooze(r.id)}>
                              恢复提醒
                            </button>
                          ) : (
                            <DropdownMenu
                              open={openMenuId === r.id}
                              onOpenChange={(open) => onOpenMenu(open ? r.id : null)}
                            >
                              <DropdownMenuTrigger asChild>
                                <button type="button" className={RADAR_ICON} aria-label={"更多操作：" + r.source}>
                                  <MoreHorizontal size={16} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => onQuickCommand(r)}>在飞书排查</DropdownMenuItem>
                                {SNOOZE_OPTIONS.map((o) => (
                                  <DropdownMenuItem key={o.value} onSelect={() => onSnooze(r.id, o.value)}>
                                    暂不提醒 · {o.label}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </span>
                      </div>
                      <div className="anomaly-body">
                        <p className="m-0 text-[13px] text-[var(--text-body)] leading-[1.5] break-words">
                          {r.message}
                          {r.amount != null && r.currency ? (
                            <span className="ml-[var(--space-2)] font-semibold">
                              <Amount value={r.amount} currency={r.currency} />
                            </span>
                          ) : null}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

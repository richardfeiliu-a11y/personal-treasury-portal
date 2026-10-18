import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useAnomalies } from "../api/hooks";
import type { AnomalyRow } from "../api/types";
import { Amount } from "../components/Amount";
import { useAppHeader } from "../components/AppHeader";
import { EmptyState } from "../components/EmptyState";
import { QuickCommandCopy } from "../components/QuickCommandCopy";
import { ReportTimestampFooter } from "../components/ReportTimestampFooter";
import { StaleDataBanner } from "../components/StaleDataBanner";
import { formatTimestampBerlin } from "../utils/timestamps";
import { ErrorBanner } from "../components/StatusBanner";
import { useToast } from "../components/Toast";
import { usePageTitle } from "../utils/pageTitle";
import {
  clearExpiredSnoozes,
  type DismissalState,
  dismissAnomalyPermanently,
  getDismissals,
  isAnomalyVisible,
  unsnoozeAnomaly,
  snoozeAnomaly,
  type SnoozeDuration,
} from "../utils/snooze";

/** 关闭时长选项（value/label/toast 集中定义）。 */
const SNOOZE_OPTIONS: {
  value: SnoozeDuration;
  label: string;
  toast: string;
}[] = [
  { value: "7d", label: "7 天", toast: "已静音 7 天" },
  { value: "30d", label: "30 天", toast: "已静音 30 天" },
  { value: "forever", label: "不再提醒此异常", toast: "已永久关闭此异常" },
];

/** 严重度 Badge 风格（克制语义色）。 */
const SEVERITY_BADGE: Record<
  AnomalyRow["severity"],
  { label: string; cls: string }
> = {
  critical: {
    label: "严重",
    cls: "bg-[var(--surface-tint-danger)] text-[var(--delta-negative)]",
  },
  warning: {
    label: "警告",
    cls: "bg-[var(--surface-tint-warning)] text-[var(--delta-warning)]",
  },
  info: {
    label: "提示",
    cls: "bg-[var(--surface-tint-neutral)] text-[var(--text-secondary)]",
  },
};

/**
 * 异常页（shadcn/Tailwind 第二批迁移）。
 * 保留按严重度分组、snooze 存储层、键盘菜单、快速指令与全部链接契约；
 * 呈现层精修：分区卡、级别 Badge、条目 hover 与已静音态。
 */
export function AlertsPage() {
  usePageTitle("异常");
  const qc = useQueryClient();
  const q = useAnomalies();
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ["anomalies"] });
  const { showToast } = useToast();

  // 静音状态纯本地偏好，用 state 镜像驱动重渲染。
  const [dismissals, setDismissals] = useState<
    Record<string, DismissalState>
  >(() => getDismissals());
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    // 挂载清一次过期项（到期自动恢复）。
    clearExpiredSnoozes();
    setDismissals(getDismissals());
  }, []);

  const syncDismissals = () => setDismissals(getDismissals());

  const applySnooze = (id: string, duration: SnoozeDuration, toast: string) => {
    snoozeAnomaly(id, duration);
    syncDismissals();
    setOpenMenuId(null);
    showToast(toast);
  };

  const restoreAlert = (id: string) => {
    unsnoozeAnomaly(id);
    syncDismissals();
    showToast("已恢复提醒");
  };

  const dismissForever = (id: string) => {
    dismissAnomalyPermanently(id);
    syncDismissals();
    setOpenMenuId(null);
    showToast("已永久关闭此异常");
  };

  useAppHeader({
    title: "异常",
    // REL-05/DATA-01：与页脚同一 Europe/Berlin 口径。
    meta: q.data ? (
      <span>
        检查时间 {formatTimestampBerlin(q.data.checked_at)} · 共{" "}
        {q.data.count} 项
      </span>
    ) : undefined,
    actions: (
      <button type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]" onClick={refresh}>
        <RefreshCw size={15} aria-hidden="true" /> 刷新
      </button>
    ),
  });

  const rows = q.data?.anomalies ?? [];

  /** Web → Hermes Quick Command：含 source/id 的确定性指令。 */
  const quickCommandText = (r: {
    source: string;
    id: string;
    category: string | null;
    amount: string | null;
    currency: string | null;
  }) =>
    `排查异常 source=${r.source} id=${r.id}${r.category ? ` 类别=${r.category}` : ""}${r.amount ? ` 本月金额=${r.amount} ${r.currency}` : ""}`;

  const isRowSnoozed = (r: AnomalyRow) =>
    !isAnomalyVisible(r, dismissals, false);
  const snoozedCount = rows.filter(isRowSnoozed).length;
  const rowState = (r: AnomalyRow): DismissalState | undefined =>
    dismissals[r.id];

  useEffect(() => {
    if (!openMenuId) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(
        ".anomaly-snooze-menu [role='menuitem']",
      )?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openMenuId]);

  function handleSnoozeMenuKeyDown(event: ReactKeyboardEvent<HTMLSpanElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']",
      ),
    );
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const trigger = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
      "[aria-haspopup='menu']",
    );

    if (event.key === "Escape") {
      event.preventDefault();
      setOpenMenuId(null);
      trigger?.focus();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;

    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (currentIndex +
              (event.key === "ArrowDown" ? 1 : -1) +
              items.length) %
            items.length;
    items[nextIndex]?.focus();
  }

  // 静音过滤先于分组，避免空组。
  const visibleRows = rows.filter((r) =>
    isAnomalyVisible(r, dismissals, showSnoozed),
  );

  // 按严重度分组。
  const groups: {
    title: string;
    severity: AnomalyRow["severity"];
    items: AnomalyRow[];
  }[] = (
    [
      ["严重", "critical"],
      ["警告", "warning"],
      ["其他", "info"],
    ] as const
  ).map(([title, severity]) => ({
    title,
    severity,
    items: visibleRows.filter(
      (r) =>
        severity === "info"
          ? r.severity === "info"
          : r.severity === severity,
    ),
  }));
  const nonEmptyGroups = groups.filter((g) => g.items.length > 0);

  return (
    <div className="page alerts-page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      <StaleDataBanner queries={[q]} onRefresh={refresh} />
      {q.error ? (
        <ErrorBanner message={q.error.message} onRetry={refresh} />
      ) : q.isLoading ? (
        <div className="h-[200px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="暂无异常"
          description="健康检查与支出趋势均正常。"
        />
      ) : (
        <section aria-label="异常列表" className="anomaly-list rounded-xl border border-[var(--hairline)] bg-[var(--card)] shadow-[0_1px_2px_rgba(11,46,39,0.04)]">
          <div className="flex items-center gap-4 border-b border-[var(--hairline)] px-5 py-3">
            <label className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={showSnoozed}
                onChange={(e) => setShowSnoozed(e.target.checked)}
              />
              显示已静音异常
            </label>
            {snoozedCount > 0 && (
              <span className="text-[12.5px] text-[var(--delta-neutral)]">
                已静音 {snoozedCount} 项
              </span>
            )}
          </div>

          {nonEmptyGroups.length === 0 ? (
            // 全部静音时不能复用「暂无异常」空态。
            <p className="px-5 py-6 m-0 text-[13px] text-[var(--text-body)] leading-[1.5] break-words">
              当前异常已全部静音。勾选「显示已静音异常」可查看并恢复提醒。
            </p>
          ) : (
            nonEmptyGroups.map((g) => (
              <div
                key={g.title}
                className="anomaly-group border-b border-[var(--hairline)] last:border-b-0 mb-[var(--space-5)] last:mb-0"
              >
                <h2 className="px-5 pt-4 pb-2 text-[13.5px] font-semibold text-[var(--foreground)]">
                  {g.title}
                  <span
                    aria-hidden="true"
                    className="ml-2 text-[12px] font-normal text-[var(--delta-neutral)] tabular-nums"
                  >
                    {g.items.length}
                  </span>
                </h2>
                <ul
                  role="list"
                  aria-label={`${g.title}异常`}
                  className="px-3 pb-3 list-none m-0 p-0 flex flex-col gap-3"
                >
                  {g.items.map((r, i) => {
                    const rowSnoozed = isRowSnoozed(r);
                    const badge = SEVERITY_BADGE[r.severity];
                    return (
                      <li
                        key={`${r.source}-${i}`}
                        className={`anomaly-item anomaly-${r.severity} is-neutral-surface rounded-lg px-2 py-2.5 transition-colors hover:bg-[var(--surface-tint-neutral)]${rowSnoozed ? " is-snoozed opacity-60" : ""}`}
                      >
                        <div className="flex flex-wrap items-center gap-2 justify-between gap-3 w-full">
                          <span
                            className={`badge inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                          {rowSnoozed && (
                            <span className="inline-flex items-center rounded-full bg-[var(--surface-tint-neutral)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] h-6 py-0 px-2.5 bg-[rgba(255,_255,_255,_0.10)] text-[rgba(255,_255,_255,_0.92)] [font:500_12px/1_var(--font-family-base)]">
                              {rowState(r)?.type === "permanent"
                                ? "已关闭"
                                : "已静音"}
                            </span>
                          )}
                          <code className="rounded bg-[var(--surface-tint-neutral)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] font-[var(--font-family-base)] text-[12px] bg-[var(--surface-subtle)] px-2 break-all">
                            <span className="absolute w-px h-px m-[-1px] p-0 overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap border-0">来源：</span>
                            {r.source}
                          </code>
                          <span
                            className="anomaly-actions ml-auto inline-flex flex-wrap gap-1.5"
                          >
                            {r.category && (
                              <Link
                                className="inline-flex items-center justify-center gap-1.5 h-[30px] py-0 px-3 rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-tertiary)] [font:500_12px/1_var(--font-family-base)] whitespace-nowrap cursor-pointer [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--topbar-bg)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:text-[var(--text-body)] [[data-theme='dark']_&]:border-[var(--border-emphasis)]"
                                to={`/transactions?category=${encodeURIComponent(r.category)}`}
                                aria-label={`查看${r.category}交易`}
                              >
                                查看交易
                              </Link>
                            )}
                            <QuickCommandCopy
                              text={quickCommandText(r)}
                              ariaLabel="在飞书排查"
                              className="inline-flex items-center justify-center gap-1.5 h-[30px] py-0 px-3 rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-tertiary)] [font:500_12px/1_var(--font-family-base)] whitespace-nowrap cursor-pointer [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--topbar-bg)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:text-[var(--text-body)] [[data-theme='dark']_&]:border-[var(--border-emphasis)]"
                              onSuccess={() =>
                                showToast("已复制飞书排查指令")
                              }
                              onError={() =>
                                showToast("复制失败，请手动复制")
                              }
                            >
                              在飞书排查
                            </QuickCommandCopy>
                            {rowSnoozed ? (
                              <button
                                type="button"
                                className="inline-flex items-center justify-center gap-1.5 h-[30px] py-0 px-3 rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-tertiary)] [font:500_12px/1_var(--font-family-base)] whitespace-nowrap cursor-pointer [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--topbar-bg)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:text-[var(--text-body)] [[data-theme='dark']_&]:border-[var(--border-emphasis)]"
                                onClick={() => restoreAlert(r.id)}
                              >
                                恢复提醒
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="inline-flex items-center justify-center gap-1.5 h-[30px] py-0 px-3 rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-tertiary)] [font:500_12px/1_var(--font-family-base)] whitespace-nowrap cursor-pointer [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--topbar-bg)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:text-[var(--text-body)] [[data-theme='dark']_&]:border-[var(--border-emphasis)]"
                                  aria-haspopup="menu"
                                  aria-expanded={openMenuId === r.id}
                                  onClick={() =>
                                    setOpenMenuId(
                                      openMenuId === r.id ? null : r.id,
                                    )
                                  }
                                >
                                  暂不提醒
                                </button>
                                {openMenuId === r.id && (
                                  <span
                                    role="menu"
                                    aria-label="暂不提醒时长"
                                    className="anomaly-snooze-menu"
                                    onKeyDown={handleSnoozeMenuKeyDown}
                                    style={{
                                      display: "inline-flex",
                                      gap: 6,
                                      flexWrap: "wrap",
                                      background: "var(--overlay-obsidian)",
                                      boxShadow:
                                        "var(--shadow-family-overlay)",
                                      padding: 6,
                                      borderRadius: 8,
                                    }}
                                  >
                                    {SNOOZE_OPTIONS.map((o) => (
                                      <button
                                        key={o.value}
                                        type="button"
                                        role="menuitem"
                                        className="inline-flex items-center justify-center gap-1.5 h-[30px] py-0 px-3 rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text-tertiary)] [font:500_12px/1_var(--font-family-base)] whitespace-nowrap cursor-pointer [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--topbar-bg)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:text-[var(--text-body)] [[data-theme='dark']_&]:border-[var(--border-emphasis)]"
                                        onClick={() =>
                                          o.value === "forever"
                                            ? dismissForever(r.id)
                                            : applySnooze(r.id, o.value, o.toast)
                                        }
                                      >
                                        {o.label}
                                      </button>
                                    ))}
                                  </span>
                                )}
                              </>
                            )}
                          </span>
                        </div>
                        <div className="anomaly-body mt-1.5">
                          <p className="m-0 text-[13px] leading-5 text-[var(--foreground)] text-[var(--text-body)] leading-[1.5] break-words">
                            {r.message}
                            {r.amount != null && r.currency && (
                              <span className="anomaly-amount ml-2 ml-[var(--space-2)] font-semibold">
                                <Amount value={r.amount} currency={r.currency} />
                              </span>
                            )}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>
      )}
      <ReportTimestampFooter generatedAt={q.data?.checked_at} />
    </div>
  );
}

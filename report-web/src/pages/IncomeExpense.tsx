import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowLeftRight, ArrowUp, PiggyBank, RefreshCw } from "lucide-react";
import { api } from "../api/client";
import { useIncomeStatement } from "../api/hooks";
import { Amount, SignedAmount } from "../components/Amount";
import { useAppHeader } from "../components/AppHeader";
import { EChart, monthlyBarOption } from "../components/Chart";
import { ErrorBanner, WarningBanner } from "../components/StatusBanner";
import { EmptyState } from "../components/EmptyState";
import { IncomeExpenseCompositionCard } from "../components/composition/IncomeExpenseCompositionCard";
import { ExpenseBreakdownSection } from "../components/composition/ExpenseBreakdownSection";
import { KpiCard } from "../components/KpiCard";
import { PageAnchorNav } from "../components/report/ReportChrome";
import { PeriodToolbar, type PeriodPreset } from "../components/PeriodToolbar";
import { ReportTimestampFooter } from "../components/ReportTimestampFooter";
import { StaleDataBanner } from "../components/StaleDataBanner";
import { WaterfallChart } from "../components/WaterfallChart";
import { SankeyChart } from "../components/SankeyChart";
import { reconcileWaterfallData } from "../utils/waterfallReconciliation";
import { buildSankeyOption } from "../utils/sankeyOptions";
import {
  berlinCurrentMonth,
  berlinCurrentYear,
  berlinLastMonth,
  berlinLastNDays,
  berlinLastNMonthEnds,
  formatDateCn,
  previousPeriod,
  resolveBusinessPeriod,
} from "../utils/dates";
import { parseDecimal } from "../utils/decimal";
import { formatPct } from "../utils/format";
import { pctChange, trendTone } from "../utils/trends";
import type { ReportSection, ReportSectionRow } from "../api/types";
import { BASE_TAB, TAB_ISACTIVE } from "../utils/legacyClasses";

type RangeKey = "30d" | "month" | "lastMonth" | "year" | "custom";

/** 期间预设（spec 2.2）。 */
const RANGE_PRESETS: PeriodPreset[] = [
  { key: "30d", label: "最近30天" },
  { key: "month", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "year", label: "今年" },
  { key: "custom", label: "自定义" },
];

const ANCHORS = [
  { id: "overview", label: "概览" },
  { id: "structure", label: "构成分析" },
  { id: "expense-breakdown", label: "费用分析" },
  { id: "details", label: "收支明细" },
];

/** 财务角色：收入 / 支出 / 结余 / 还债。 */
type RoleKey = "income" | "expense" | "net" | "debt";

/** 财务角色类名（语义色定义在 styles.css，与 Delta Matrix 共用）。 */
const ROLE_CLASS: Record<RoleKey, string> = {
  income: "is-role-income",
  expense: "is-role-expense",
  net: "is-role-net",
  debt: "is-role-debt",
};

/**
 * 按 role 给金额上色（语义着色，而非单纯正负号）。
 * 颜色由 styles.css 的 .is-role-* 统一提供；结余按正负叠加
 * is-role-positive / is-role-negative。
 */
function RoleAmount({
  role,
  value,
  currency,
}: {
  role: RoleKey;
  value: string | null | undefined;
  currency: string;
}) {
  const signCls =
    role === "net" && value !== null && value !== undefined && Number(value) > 0
      ? "is-role-positive"
      : role === "net" &&
          value !== null &&
          value !== undefined &&
          Number(value) < 0
        ? "is-role-negative"
        : "";
  return (
    <span className={`role-amount ${ROLE_CLASS[role]} ${signCls}`.trim()}>
      {role === "net" ? (
        <SignedAmount value={value} currency={currency} />
      ) : (
        <Amount value={value} currency={currency} />
      )}
    </span>
  );
}

/**
 * 收入/支出/还债分组明细：桌面精致表格、移动端实体卡片。
 * 保留 aria 契约：table 名 = 标题，list 名 =「标题卡片」。
 */
function RoleSectionBlock({
  role,
  section,
  baseCurrency,
}: {
  role: RoleKey;
  section: ReportSection;
  baseCurrency: string;
}) {
  const roleLabel =
    role === "income"
      ? "收入"
      : role === "expense"
        ? "支出"
        : role === "debt"
          ? "还债"
          : "结余";
  const title = section.title || roleLabel;
  const rows: ReportSectionRow[] = section.rows ?? [];

  if (rows.length === 0) {
    return (
      <div className="income-role-block income-role-empty">
        <h2 className="text-[14px] font-semibold text-[var(--foreground)]">{title}</h2>
        <EmptyState
          title={`暂无${roleLabel}记录`}
          description={`当前筛选期间没有可归类的${roleLabel}交易。`}
        />
      </div>
    );
  }

  return (
    <div className="">
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-[14px] font-semibold text-[var(--foreground)]">{title}</h2>
        {section.subtotal_base !== null && (
          <span className="text-[12.5px] text-[var(--delta-neutral)]">
            小计{" "}
            <RoleAmount
              role={role}
              value={section.subtotal_base}
              currency={baseCurrency}
            />
          </span>
        )}
      </div>
      <div className="income-role-table data-table-wrap bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] overflow-hidden max-[479px]:overflow-x-auto max-[479px]:[-webkit-overflow-scrolling:touch] max-md:[.has-mobile-card_&]:hidden max-md:hidden">
        <table className="data-table" aria-label={title}>
          <thead>
            <tr>
              <th>项目</th>
              <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">笔数</th>
              <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">金额（原币）</th>
              <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">折 {baseCurrency}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${section.key}-${row.label}-${row.currency}`}>
                <td>{row.label}</td>
                <td className="is-num is-muted [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                  {row.count === null ? "—" : row.count}
                </td>
                <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                  <RoleAmount
                    role={role}
                    value={row.amount}
                    currency={row.currency}
                  />
                </td>
                <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                  {row.amount_base === null ? (
                    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum'_1] [.transaction-card-value_&]:whitespace-normal [.comp-donut-center_&]:font-semibold text-[var(--danger-600)]">汇率缺失</span>
                  ) : (
                    <RoleAmount
                      role={role}
                      value={row.amount_base}
                      currency={baseCurrency}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul
        className="income-role-cards hidden flex-col gap-3 w-full mt-3 mb-0 p-0 list-none max-md:flex max-md:[.accounts-page_&]:mt-0 max-md:mt-0"
        aria-label={`${title}卡片`}
      >
        {rows.map((row) => (
          <li
            key={`${section.key}-${row.label}-${row.currency}`}
            className="income-role-card bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl py-3.5 px-4 flex flex-col gap-2.5 shadow-[var(--shadow-sm)] max-sm:min-w-0 max-sm:max-w-full"
          >
            <div className="flex items-center justify-between gap-2 border-b border-b-[var(--border-soft)] pb-2.5 cursor-default [.income-top-card_&]:mb-0">
              <span className="min-w-0 text-[var(--text-strong)] [font:var(--type-body)] font-semibold [overflow-wrap:anywhere]">{row.label}</span>
              <RoleAmount
                role={role}
                value={row.amount}
                currency={row.currency}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">笔数</span>
                <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                  {row.count === null ? "—" : row.count}
                </span>
              </div>
              <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">折 {baseCurrency}</span>
                <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                  {row.amount_base === null ? (
                    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum'_1] [.transaction-card-value_&]:whitespace-normal [.comp-donut-center_&]:font-semibold text-[var(--danger-600)]">汇率缺失</span>
                  ) : (
                    <RoleAmount
                      role={role}
                      value={row.amount_base}
                      currency={baseCurrency}
                    />
                  )}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Delta({
  value,
  direction,
  label,
}: {
  value: string | null;
  direction: "higher-is-better" | "lower-is-better";
  label?: string;
}) {
  if (value === null)
    return (
      <span className="[font:var(--type-caption)] font-medium [font-variant-numeric:tabular-nums] text-[var(--text-faint)] [.hero-delta_&]:text-[rgba(255,_255,_255,_0.75)] [.kpi-card-delta_&]:text-[var(--text-faint)]">
        {label ? `${label}：—` : "—"}
      </span>
    );
  const tone = trendTone(value, direction);
  const cls =
    tone === "positive"
      ? "text-[var(--success-700)]"
      : tone === "negative"
        ? "text-[var(--danger-700)]"
        : "text-[var(--text-faint)]";
  return (
    <span className={`text-xs font-medium tabular-nums ${cls}`}>
      {label ? `${label}：` : ""}
      {value}
    </span>
  );
}

export function IncomeExpensePage() {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // WP05（U05/R05）：深链期间初始化——URL start/end 合法时以自定义期间进入；
  // 非法时显式报错，绝不静默换用另一期间。默认 = Berlin 本月至今。
  const deepLink = useMemo(
    () => resolveBusinessPeriod(searchParams.get("start"), searchParams.get("end")),
    [searchParams],
  );
  const hasDeepLink = Boolean(searchParams.get("start") || searchParams.get("end"));
  const [range, setRange] = useState<RangeKey>(() =>
    deepLink.error || hasDeepLink ? "custom" : "30d",
  );
  const [customStart, setCustomStart] = useState(() => deepLink.start);
  const [customEnd, setCustomEnd] = useState(() => deepLink.end);
  const [customQueryPeriod, setCustomQueryPeriod] = useState(() =>
    hasDeepLink && !deepLink.error
      ? { start: deepLink.start, end: deepLink.end }
      : berlinLastNDays(30),
  );
  const [analyticsTab, setAnalyticsTab] = useState<"waterfall" | "sankey">(
    "waterfall",
  );
  const toolbarPeriod = useMemo(
    () => resolveBusinessPeriod(customStart, customEnd),
    [customStart, customEnd],
  );
  const toolbarError = toolbarPeriod.error;
  const customPeriodError =
    customStart > customEnd ? "起始日期不能晚于截止日期" : undefined;
  const hasBlockingError =
    Boolean(toolbarError) ||
    (range === "custom" && Boolean(customPeriodError));

  // RV-05：路由历史变化 → 表单与请求跟随 URL。
  const appliedUrl = useRef<string | null>(null);
  useEffect(() => {
    const key = `${deepLink.start}|${deepLink.end}|${deepLink.error ?? ""}|${hasDeepLink ? "1" : "0"}`;
    if (appliedUrl.current === null) {
      appliedUrl.current = key;
      return;
    }
    if (appliedUrl.current === key) return;
    appliedUrl.current = key;
    if (deepLink.error) {
      setRange("custom");
      setCustomStart(deepLink.start);
      setCustomEnd(deepLink.end);
    } else if (hasDeepLink) {
      setRange("custom");
      setCustomStart(deepLink.start);
      setCustomEnd(deepLink.end);
      setCustomQueryPeriod({ start: deepLink.start, end: deepLink.end });
    } else {
      const p = berlinLastNDays(30);
      setRange("30d");
      setCustomStart(p.start);
      setCustomEnd(p.end);
      setCustomQueryPeriod(p);
    }
  }, [deepLink.start, deepLink.end, deepLink.error, hasDeepLink]);

  const period = useMemo(() => {
    if (range === "30d") return berlinLastNDays(30);
    if (range === "month") return berlinCurrentMonth();
    if (range === "lastMonth") return berlinLastMonth();
    if (range === "year") return berlinCurrentYear();
    return customQueryPeriod;
  }, [range, customQueryPeriod]);

  const prev = useMemo(
    () =>
      previousPeriod(
        period.start,
        period.end,
        range === "month" || range === "lastMonth"
          ? "month"
          : range === "year"
            ? "year"
            : "days",
      ),
    [period, range],
  );
  const cur = useIncomeStatement(period.start, period.end, {
    enabled: !hasBlockingError,
  });
  const prevInc = useIncomeStatement(prev.start, prev.end, {
    enabled: !hasBlockingError,
  });

  // DATA-01：6 个整月按柏林日历推导。
  const monthEnds = useMemo(() => berlinLastNMonthEnds(6), []);
  const monthlyQueries = useQueries({
    queries: monthEnds.map((end) => {
      const start = `${end.slice(0, 7)}-01`;
      return {
        queryKey: ["income-statement", start, end],
        queryFn: () => api.incomeStatement(start, end),
        staleTime: 5 * 60 * 1000,
        enabled: !hasBlockingError,
      };
    }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["income-statement"] });
  };
  const error = [cur.error, prevInc.error, ...monthlyQueries.map((q) => q.error)].find(
    Boolean,
  ) as Error | undefined;
  const isLoading =
    cur.isPending ||
    prevInc.isPending ||
    monthlyQueries.some((q) => q.isPending);

  const backendPeriod = cur.data?.period ?? null;

  useAppHeader({
    title: "收支",
    meta: (
      <>
        <span>·</span>
        <span>
          {backendPeriod
            ? `${formatDateCn(backendPeriod.start_date)} ~ ${formatDateCn(backendPeriod.end_date)}`
            : `${formatDateCn(period.start)} ~ ${formatDateCn(period.end)}`}
        </span>
      </>
    ),
    actions: (
      <button
        type="button"
        className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
        onClick={refresh}
        disabled={hasBlockingError}
      >
        <RefreshCw size={15} aria-hidden="true" /> 刷新
      </button>
    ),
  });

  const base = cur.data?.base_currency ?? "CNY";
  const s = cur.data?.summary as
    | {
        total_income_cny?: string | null;
        total_expenses_cny?: string | null;
        net_result_cny?: string | null;
        savings_rate_pct?: string | null;
      }
    | undefined;
  const ps = prevInc.data?.summary as
    | {
        total_income_cny?: string | null;
        total_expenses_cny?: string | null;
        net_result_cny?: string | null;
      }
    | undefined;

  // 收支瀑布勾稽：门禁在 reconcileWaterfallData 内完成。
  const waterfall = useMemo(
    () => (cur.data ? reconcileWaterfallData(cur.data, 5) : null),
    [cur.data],
  );

  const warnings = [
    ...(cur.data?.warnings ?? []),
    ...(prevInc.data?.warnings ?? []),
  ];

  const incomeSection = cur.data?.sections?.find((sect) => sect.key === "income");
  const expenseSection = cur.data?.sections?.find(
    (sect) => sect.key === "expenses",
  );
  const debtSection = cur.data?.sections?.find(
    (sect) =>
      sect.key === "debt_reduction" ||
      sect.key === "debt_repayment" ||
      /debt/i.test(sect.key),
  );

  const roleSections = [
    ...(incomeSection
      ? [{ role: "income" as RoleKey, section: incomeSection }]
      : []),
    ...(expenseSection
      ? [{ role: "expense" as RoleKey, section: expenseSection }]
      : []),
    ...(debtSection
      ? [{ role: "debt" as RoleKey, section: debtSection }]
      : []),
  ];

  const monthly = monthEnds.map((end, i) => {
    const q = monthlyQueries[i];
    const summary = q.data?.summary as
      | {
          total_income_cny?: string | null;
          total_expenses_cny?: string | null;
        }
      | undefined;
    const income =
      summary?.total_income_cny == null ? null : Number(summary.total_income_cny);
    const expense =
      summary?.total_expenses_cny == null
        ? null
        : Number(summary.total_expenses_cny);
    return { label: end.slice(0, 7), income, expense };
  });

  const handleCustomStartChange = (value: string) => {
    if (!value) return;
    setCustomStart(value);
    if (range !== "custom") setRange("custom");
    const checked = resolveBusinessPeriod(value, customEnd);
    if (!checked.error) {
      setCustomQueryPeriod({ start: checked.start, end: checked.end });
    }
  };

  const handleCustomEndChange = (value: string) => {
    if (!value) return;
    setCustomEnd(value);
    if (range !== "custom") setRange("custom");
    const checked = resolveBusinessPeriod(customStart, value);
    if (!checked.error) {
      setCustomQueryPeriod({ start: checked.start, end: checked.end });
    }
  };

  const handlePresetChange = (key: string) => {
    const next = key as RangeKey;
    setRange(next);
    if (next === "custom") return;
    const p =
      next === "30d"
        ? berlinLastNDays(30)
        : next === "month"
          ? berlinCurrentMonth()
          : next === "lastMonth"
            ? berlinLastMonth()
            : berlinCurrentYear();
    setCustomStart(p.start);
    setCustomEnd(p.end);
    setCustomQueryPeriod(p);
  };

  return (
    <div className="page income-expense-page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      <StaleDataBanner
        queries={[cur, prevInc, ...monthlyQueries]}
        onRefresh={hasBlockingError ? undefined : refresh}
      />
      <div className="period-toolbar period-filter-row inline-flex items-center gap-[var(--space-2)] flex-wrap flex flex-col gap-[var(--space-1)] items-start max-md:w-full max-sm:w-full max-sm:min-w-0 max-sm:max-w-full flex-row">
        <PeriodToolbar
          fromDate={customStart}
          toDate={customEnd}
          onFromDateChange={handleCustomStartChange}
          onToDateChange={handleCustomEndChange}
          error={customPeriodError}
          presets={RANGE_PRESETS}
          activePreset={range}
          onPresetChange={handlePresetChange}
        />
      </div>

      {toolbarError && (
        <ErrorBanner message={`期间无效：${toolbarError}（请在上方工具栏修正后查询）`} />
      )}
      {error ? (
        <ErrorBanner message={error.message} onRetry={refresh} />
      ) : (
        <>
          <WarningBanner
            items={warnings}
            onRefresh={hasBlockingError ? undefined : refresh}
          />

          {isLoading ? (
            <>
              <div className="h-[104px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
              <div className="h-[300px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
            </>
          ) : !cur.data ? (
            <EmptyState
              title="暂无收支数据"
              description="当前期间未返回可用于汇总和分类分析的收支记录。"
            />
          ) : (
            <>
              <PageAnchorNav items={ANCHORS} />

              {/* 概览 KPI */}
              <div id="overview" className="scroll-mt-20 row-kpis cashflow-grid summary-grid-4 grid [grid-template-columns:repeat(4,_minmax(0,_1fr))] gap-[var(--grid-gap)] max-[1199px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] max-[1439px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] max-md:[grid-template-columns:1fr] [.home-page_&>*]:min-w-0">
                <KpiCard
                  icon={ArrowDown}
                  tone="success"
                  label="收入"
                  value={
                    <Amount
                      value={s?.total_income_cny ?? null}
                      currency={base}
                    />
                  }
                  delta={
                    <Delta
                      value={pctChange(
                        s?.total_income_cny,
                        ps?.total_income_cny,
                      )}
                      direction="higher-is-better"
                      label="较上期"
                    />
                  }
                />
                <KpiCard
                  icon={ArrowUp}
                  tone="danger"
                  label="支出"
                  value={
                    <Amount
                      value={s?.total_expenses_cny ?? null}
                      currency={base}
                    />
                  }
                  delta={
                    <Delta
                      value={pctChange(
                        s?.total_expenses_cny,
                        ps?.total_expenses_cny,
                      )}
                      direction="lower-is-better"
                      label="较上期"
                    />
                  }
                />
                <KpiCard
                  icon={PiggyBank}
                  label="结余"
                  value={
                    <RoleAmount
                      role="net"
                      value={s?.net_result_cny ?? null}
                      currency={base}
                    />
                  }
                  delta={
                    <Delta
                      value={pctChange(s?.net_result_cny, ps?.net_result_cny)}
                      direction="higher-is-better"
                      label="较上期"
                    />
                  }
                />
                <KpiCard
                  icon={ArrowLeftRight}
                  tone="warning"
                  label="储蓄率"
                  value={<span>{formatPct(s?.savings_rate_pct)}</span>}
                  delta={
                    s?.savings_rate_pct != null &&
                    ps?.total_income_cny &&
                    ps?.total_expenses_cny ? (
                      (() => {
                        // WP06/U02：储蓄率差值在整数域定点计算（0.1pp），不经浮点。
                        const cur = parseDecimal(s.savings_rate_pct);
                        const income = parseDecimal(ps.total_income_cny);
                        const expenses = parseDecimal(ps.total_expenses_cny);
                        if (!cur || !income || !expenses || income.units === 0n) {
                          return (
                            <span className="[font:var(--type-caption)] font-medium [font-variant-numeric:tabular-nums] text-[var(--text-faint)] [.hero-delta_&]:text-[rgba(255,_255,_255,_0.75)] [.kpi-card-delta_&]:text-[var(--text-faint)]">较上期 —</span>
                          );
                        }
                        const roundDiv = (a: bigint, b: bigint): bigint => {
                          const neg = (a < 0n) !== (b < 0n);
                          const aa = a < 0n ? -a : a;
                          const bb = b < 0n ? -b : b;
                          const q = (aa * 2n + bb) / (bb * 2n);
                          return neg ? -q : q;
                        };
                        const pow = (n: number) => 10n ** BigInt(n);
                        const common = Math.max(income.scale, expenses.scale);
                        const i =
                          income.units * pow(common - income.scale);
                        const e =
                          expenses.units * pow(common - expenses.scale);
                        const prevTenths = 1000n - roundDiv(1000n * e, i);
                        const curTenths = roundDiv(
                          cur.units * 10n,
                          pow(cur.scale),
                        );
                        const diffTenths = Number(curTenths - prevTenths);
                        const diff = diffTenths / 10;
                        const sign = diff > 0 ? "+" : "";
                        const cls =
                          diff > 0
                            ? "delta-pos"
                            : diff < 0
                              ? "delta-neg"
                              : "delta-na";
                        return (
                          <span className={`text-xs font-medium tabular-nums ${cls}`}>
                            较上期 {sign}
                            {diff.toFixed(1)}pp
                          </span>
                        );
                      })()
                    ) : (
                      <span className="[font:var(--type-caption)] font-medium [font-variant-numeric:tabular-nums] text-[var(--text-faint)] [.hero-delta_&]:text-[rgba(255,_255,_255,_0.75)] [.kpi-card-delta_&]:text-[var(--text-faint)]">较上期 —</span>
                    )
                  }
                />
              </div>

              <p className="section-sub m-0 text-[var(--text-faint)] [font:var(--type-caption)]">
                {backendPeriod
                  ? `${formatDateCn(backendPeriod.start_date)} ~ ${formatDateCn(backendPeriod.end_date)}`
                  : `${formatDateCn(period.start)} ~ ${formatDateCn(period.end)}`}
                {" · 对比上期 "}
                {formatDateCn(prev.start)} ~ {formatDateCn(prev.end)}
                {"（上期收入 "}
                <Amount value={ps?.total_income_cny ?? null} currency="CNY" />
                {" / 支出 "}
                <Amount
                  value={ps?.total_expenses_cny ?? null}
                  currency="CNY"
                />
                ）
              </p>

              {/* 构成分析卡（Flow：category → Transactions 深链） */}
              <div id="structure" className="scroll-mt-20">
                <IncomeExpenseCompositionCard
                  data={cur.data}
                  fallbackPeriod={period}
                  isFetching={cur.isFetching}
                />
              </div>

              {/* 费用分析（Top N + 同期环比）：与构成卡并列，但为截断视图，不用于对账。 */}
              <ExpenseBreakdownSection
                startDate={period.start}
                endDate={period.end}
                compareStartDate={prev.start}
                compareEndDate={prev.end}
              />

              {/* 瀑布 / Sankey + 6 个月趋势 */}
              <div className="income-analytics grid [grid-template-columns:minmax(0,_5fr)_minmax(0,_7fr)] gap-[var(--grid-gap)] max-[1199px]:[grid-template-columns:1fr]">
                <section
                  className="card chart-card min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none max-[479px]:w-full max-[479px]:min-w-0 max-md:w-full max-md:min-w-0 max-md:max-w-full max-sm:w-full max-sm:min-w-0 max-md:[&_[role='img']]:w-full max-md:[&_[role='img']]:min-w-0 max-md:[&_[role='img']]:max-w-full max-sm:[&_[role='img']]:overflow-hidden"
                  aria-label="收支分析"
                  role="region"
                >
                  <header className="[&_.card-title]:self-start flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-4)] min-h-7 max-[479px]:flex-wrap [.home-analysis-grid_&]:h-7 [.home-analysis-grid_&]:min-h-7 [.home-summary-grid_&]:h-7 [.home-summary-grid_&]:min-h-7 [.home-expense-ranking_&]:h-7 [.home-expense-ranking_&]:min-h-7">
                    <h2 className="card-title m-0 [font:var(--type-section-title)] text-[var(--text-strong)] [.home-analysis-grid_&]:min-w-0 [.home-analysis_grid_&]:text-left [.home-summary-grid_&]:min-w-0 [.home-summary-grid_&]:text-left [.home-expense-ranking_&]:min-w-0 [.home-expense-ranking_&]:text-left [.anomaly-group_&]:mb-[var(--space-3)]">
                      {analyticsTab === "sankey"
                        ? "资金流向"
                        : "收支瀑布图"}
                    </h2>
                    <div
                      className="inline-flex items-center gap-[var(--space-1)] ml-[auto] shrink-0"
                      role="tablist"
                      aria-label="分析视图"
                      onKeyDown={(e) => {
                        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight")
                          return;
                        const tabs = ["waterfall", "sankey"] as const;
                        const current = tabs.indexOf(analyticsTab);
                        const next =
                          e.key === "ArrowRight"
                            ? (current + 1) % tabs.length
                            : (current - 1 + tabs.length) % tabs.length;
                        setAnalyticsTab(tabs[next]);
                        (
                          e.currentTarget.querySelector(
                            `#tab-${tabs[next]}`,
                          ) as HTMLElement | null
                        )?.focus();
                      }}
                    >
                      <button
                        type="button"
                        role="tab"
                        id="tab-waterfall"
                        aria-selected={analyticsTab === "waterfall"}
                        aria-controls="panel-waterfall"
                        className={`${ BASE_TAB } [.income-analytics_&]:min-h-8${ analyticsTab === "waterfall" ? ` ${ TAB_ISACTIVE }` : "" }`}
                        onClick={() => setAnalyticsTab("waterfall")}
                      >
                        瀑布
                      </button>
                      <button
                        type="button"
                        role="tab"
                        id="tab-sankey"
                        aria-selected={analyticsTab === "sankey"}
                        aria-controls="panel-sankey"
                        className={`${ BASE_TAB } [.income-analytics_&]:min-h-8${ analyticsTab === "sankey" ? ` ${ TAB_ISACTIVE }` : "" }`}
                        onClick={() => setAnalyticsTab("sankey")}
                      >
                        资金流向
                      </button>
                    </div>
                  </header>

                  <div
                    role="tabpanel"
                    id="panel-waterfall"
                    aria-labelledby="tab-waterfall"
                    className="min-w-0"
                    hidden={analyticsTab !== "waterfall"}
                  >
                    {cur.data && waterfall ? (
                      <WaterfallChart data={waterfall} baseCurrency={base} />
                    ) : (
                      <EmptyState
                        title="瀑布图暂不可用"
                        description="数据加载完成后再试。"
                      />
                    )}
                  </div>

                  <div
                    role="tabpanel"
                    id="panel-sankey"
                    aria-labelledby="tab-sankey"
                    className="min-w-0"
                    hidden={analyticsTab !== "sankey"}
                  >
                    {cur.data ? (
                      (() => {
                        const opt = buildSankeyOption(cur.data);
                        return opt ? (
                          <SankeyChart option={opt} baseCurrency={base} />
                        ) : (
                          <EmptyState
                            title="资金流向图暂不可用"
                            description="FX 不完整或该期间支出分类数据不足，无法绘制资金流向。"
                          />
                        );
                      })()
                    ) : (
                      <EmptyState
                        title="资金流向图暂不可用"
                        description="数据加载完成后再试。"
                      />
                    )}
                  </div>
                </section>

                <section
                  className="card chart-card min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none max-[479px]:w-full max-[479px]:min-w-0 max-md:w-full max-md:min-w-0 max-md:max-w-full max-sm:w-full max-sm:min-w-0 max-md:[&_[role='img']]:w-full max-md:[&_[role='img']]:min-w-0 max-md:[&_[role='img']]:max-w-full max-sm:[&_[role='img']]:overflow-hidden"
                  aria-label="最近6个月收支趋势"
                                    role="region"
                                  >
                                    <header className="[&_.card-title]:self-start flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-4)] min-h-7 max-[479px]:flex-wrap [.home-analysis-grid_&]:h-7 [.home-analysis-grid_&]:min-h-7 [.home-summary-grid_&]:h-7 [.home-summary-grid_&]:min-h-7 [.home-expense-ranking_&]:h-7 [.home-expense-ranking_&]:min-h-7">
                                      <h2 className="card-title m-0 [font:var(--type-section-title)] text-[var(--text-strong)] [.home-analysis-grid_&]:min-w-0 [.home-analysis_grid_&]:text-left [.home-summary-grid_&]:min-w-0 [.home-summary-grid_&]:text-left [.home-expense-ranking_&]:min-w-0 [.home-expense-ranking_&]:text-left [.anomaly-group_&]:mb-[var(--space-3)]">最近6个月收支趋势</h2>
                    <span className="topbar-meta inline-flex items-center gap-[var(--space-3)] text-[var(--text-faint)] [font:var(--type-caption)] [.home-analysis-grid_&]:ml-[auto] [.home-analysis-grid_&]:text-right [.home-summary-grid_&]:ml-[auto] [.home-summary-grid_&]:text-right [.home-expense-ranking_&]:ml-[auto] [.home-expense-ranking_&]:text-right">CNY</span>
                  </header>
                  <EChart
                    option={monthlyBarOption(
                      monthly.map((m) => m.label),
                      monthly.map((m) => m.income),
                      monthly.map((m) => m.expense),
                    )}
                    ariaLabel="最近6个月收支柱状图"
                    height={300}
                  />
                </section>
              </div>

              {roleSections.length > 0 && (
                <section
                  className="card has-mobile-card income-role-sections min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none"
                  aria-label="收支明细"
                  role="region"
                >
                  {roleSections.map(({ role, section }) => (
                    <RoleSectionBlock
                      key={section.key}
                      role={role}
                      section={section}
                      baseCurrency={base}
                    />
                  ))}
                </section>
              )}

              <ReportTimestampFooter generatedAt={cur.data.generated_at} />
            </>
          )}
        </>
      )}
    </div>
  );
}

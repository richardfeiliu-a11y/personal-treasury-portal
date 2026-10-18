import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Percent,
  PiggyBank,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { useFxAttribution } from "../api/hooks";
import { Amount } from "../components/Amount";
import { useAppHeader } from "../components/AppHeader";
import { EChart } from "../components/Chart";
import { EmptyState } from "../components/EmptyState";
import { FxCurrencyCard } from "../components/FxCurrencyCard";
import {
  PageAnchorNav,
  ReportSection,
} from "../components/report/ReportChrome";
import { useMask } from "../components/MaskContext";
import { PeriodToolbar, type PeriodPreset } from "../components/PeriodToolbar";
import { ErrorBanner, WarningBanner } from "../components/StatusBanner";
import { StaleDataBanner } from "../components/StaleDataBanner";
import {
  berlinCurrentMonth,
  berlinCurrentYear,
  berlinLastMonth,
  berlinLastNDays,
} from "../utils/dates";
import { formatNumber, formatPct } from "../utils/format";
import { usePageTitle } from "../utils/pageTitle";
import { BRAND_GOLD, brandHStackOption } from "../utils/brandChart";

type RangeKey = "30d" | "month" | "lastMonth" | "year" | "custom";

/** 期间预设，默认今年。 */
const RANGE_PRESETS: PeriodPreset[] = [
  { key: "30d", label: "最近30天" },
  { key: "month", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "year", label: "今年" },
  { key: "custom", label: "自定义" },
];

const ANCHORS = [
  { id: "overview", label: "概览" },
  { id: "attribution", label: "归因" },
  { id: "breakdown", label: "拆解" },
];

/**
 * 汇率归因页（shadcn/Tailwind 第二批迁移）。
 * 呈现层重构为锚点分区：焦点 KPI → 储蓄/汇率贡献横向堆叠条 → 币种拆解表。
 * 非汇率余额变动贡献走品牌绿、汇率贡献走克制金；query hooks/期间逻辑不变。
 */
export function FxAttributionPage() {
  usePageTitle("汇率归因");
  const qc = useQueryClient();
  // WP05/RV-05（DATA-01）：默认「今年」取 Berlin 业务日历。
  const year = useMemo(() => berlinCurrentYear(), []);
  const [range, setRange] = useState<RangeKey>("year");
  const [fromDate, setFromDate] = useState(year.start);
  const [toDate, setToDate] = useState(year.end);
  const [queryPeriod, setQueryPeriod] = useState({
    from: year.start,
    to: year.end,
  });
  const periodError =
    fromDate && toDate && fromDate > toDate
      ? "起始日期不能晚于截止日期"
      : undefined;
  const q = useFxAttribution(queryPeriod.from, queryPeriod.to);
  const { masked } = useMask();
  const refresh = () => void qc.invalidateQueries();
  const d = q.data;
  const refreshBtn = (
    <button
      type="button"
      className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
      onClick={refresh}
      disabled={Boolean(periodError)}
    >
      <RefreshCw size={15} aria-hidden="true" /> 刷新
    </button>
  );
  // REL-05：错误/正常分支共用同一份过期横幅。
  const staleBanner = <StaleDataBanner queries={[q]} onRefresh={refresh} />;

  const handleFromDateChange = (value: string) => {
    setFromDate(value);
    if (range !== "custom") setRange("custom");
    if (!value || !toDate || value <= toDate) {
      setQueryPeriod({ from: value, to: toDate });
    }
  };

  const handleToDateChange = (value: string) => {
    setToDate(value);
    if (range !== "custom") setRange("custom");
    if (!fromDate || !value || fromDate <= value) {
      setQueryPeriod({ from: fromDate, to: value });
    }
  };

  /** 预设芯片：同步起止日期与查询区间。 */
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
    setFromDate(p.start);
    setToDate(p.end);
    setQueryPeriod({ from: p.start, to: p.end });
  };

  useAppHeader({
    title: "汇率归因",
    meta: d ? (
      <span>
        {d.period_from} ~ {d.period_to}
      </span>
    ) : undefined,
    actions: refreshBtn,
  });

  if (q.error) {
    return (
      <>
        {staleBanner}
        <ErrorBanner message={q.error.message} onRetry={refresh} />
      </>
    );
  }

  // 储蓄/汇率贡献横向堆叠条（品牌绿 + 克制金）。
  const attributionChart = d ? (
    <EChart
      option={brandHStackOption(
        d.by_currency.map((r) => r.currency),
        [
          {
            name: "非汇率余额变动贡献",
            data: d.by_currency.map((r) => Number(r.savings_contribution_cny)),
          },
          {
            name: "汇率贡献",
            data: d.by_currency.map((r) => Number(r.fx_contribution_cny)),
          },
        ],
        { masked },
      )}
      ariaLabel="储蓄与汇率贡献"
    />
  ) : null;

  return (
    <div className="page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      {staleBanner}
      <PeriodToolbar
        fromDate={fromDate}
        toDate={toDate}
        onFromDateChange={handleFromDateChange}
        onToDateChange={handleToDateChange}
        error={periodError}
        presets={RANGE_PRESETS}
        activePreset={range}
        onPresetChange={handlePresetChange}
      />

      <WarningBanner items={d?.notes ?? []} />

      {q.isLoading ? (
        <>
          <div className="h-[104px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
          <div className="h-[260px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
        </>
      ) : !d ? (
        <EmptyState
          title="暂无汇率归因数据"
          description="期间内无可拆解的币种余额。"
        />
      ) : (
        <>
          <PageAnchorNav items={ANCHORS} />

          {/* 焦点 KPI */}
          <section
            id="overview"
            aria-label="归因概览"
            className="scroll-mt-20 rounded-xl border border-[var(--hairline)] bg-[var(--card)] px-6 py-5 shadow-[0_1px_2px_rgba(11,46,39,0.04)]"
          >
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <FxFact
                icon={TrendingUp}
                label="净资产变动"
                children={<Amount value={d.total_net_worth_change_cny} currency="CNY" />}
              />
              <FxFact
                icon={PiggyBank}
                label="非汇率余额变动贡献"
                children={<Amount value={d.total_savings_contribution_cny} currency="CNY" />}
              />
              <FxFact
                icon={ArrowLeftRight}
                label="汇率贡献"
                accent={BRAND_GOLD}
                children={<Amount value={d.total_fx_contribution_cny} currency="CNY" />}
              />
              <FxFact
                icon={Percent}
                label="汇率贡献占比"
                accent={BRAND_GOLD}
                children={
                  <span className="text-[21px] font-semibold tracking-[-0.015em] text-[var(--foreground)] tabular-nums">
                    {formatPct(d.fx_contribution_percentage)}
                  </span>
                }
              />
            </div>
          </section>

          {/* 储蓄与汇率贡献 */}
          <div id="attribution" className="scroll-mt-20">
            <ReportSection
              id="fx-attribution-inner"
              title="储蓄与汇率贡献"
              meta="单位：CNY · 按币种"
            >
              {attributionChart}
            </ReportSection>
          </div>

          {/* 币种拆解 */}
          <div id="breakdown" className="scroll-mt-20">
            <ReportSection id="fx-breakdown-inner" title="币种拆解">
              <div className="fx-attribution-table data-table-wrap relative hidden md:block bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] overflow-x-auto md:min-w-0 lg:overflow-hidden max-[479px]:[-webkit-overflow-scrolling:touch]">
                <table className="data-table md:min-w-[860px] lg:min-w-0" aria-label="币种拆解">
                  <thead>
                    <tr>
                      <th>币种</th>
                      <th>期初余额</th>
                      <th>期末余额</th>
                      <th>期初汇率</th>
                      <th>期末汇率</th>
                      <th>非汇率余额变动贡献 (CNY)</th>
                      <th>汇率贡献 (CNY)</th>
                      <th>净变动 (CNY)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.by_currency.map((r) => (
                      <tr key={r.currency}>
                        <td>{r.currency}</td>
                        <td>
                          <Amount value={r.start_balance} currency={r.currency} />
                        </td>
                        <td>
                          <Amount value={r.end_balance} currency={r.currency} />
                        </td>
                        <td>{formatNumber(r.start_rate)}</td>
                        <td>{formatNumber(r.end_rate)}</td>
                        <td>
                          <Amount
                            value={r.savings_contribution_cny}
                            currency="CNY"
                          />
                        </td>
                        <td>
                          <Amount value={r.fx_contribution_cny} currency="CNY" />
                        </td>
                        <td>
                          <Amount value={r.net_change_cny} currency="CNY" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul
                className="fx-currency-list hidden flex-col gap-3 w-full mt-3 mb-0 p-0 list-none max-md:flex max-md:[.accounts-page_&]:mt-0 m-0 md:hidden lg:hidden"
                aria-label="币种拆解卡片视图"
              >
                {d.by_currency.map((row) => (
                  <FxCurrencyCard
                    key={row.currency}
                    row={row}
                    baseCurrency="CNY"
                  />
                ))}
              </ul>
            </ReportSection>
          </div>
        </>
      )}
    </div>
  );
}

/** 焦点事实格：小图标 + 标签 + 大字值。 */
function FxFact({
  icon: Icon,
  label,
  accent,
  children,
}: {
  icon: typeof TrendingUp;
  label: string;
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--delta-neutral)]">
        <Icon size={14} aria-hidden="true" style={accent ? { color: accent } : undefined} />
        {label}
      </span>
      <span className="text-[21px] font-semibold leading-7 tracking-[-0.015em] text-[var(--foreground)] tabular-nums">
        {children}
      </span>
    </div>
  );
}

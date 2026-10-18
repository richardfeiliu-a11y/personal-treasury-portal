import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { ApiError } from "../../api/client";
import {
  useAccountBalances,
  useBalanceSheet,
  useFxAttribution,
  useIncomeStatement,
  useNetWorthTrend,
  useAnomalies,
  useTransactions,
} from "../../api/hooks";
import { useAppHeader } from "../../components/AppHeader";
import { EChart } from "../../components/Chart";
import { HealthSignalsStrip } from "../../components/HealthSignalsStrip";
import { GoalSetter } from "../../components/GoalSetter";
import { ReportTimestampFooter } from "../../components/ReportTimestampFooter";
import { StaleDataBanner } from "../../components/StaleDataBanner";
import { ErrorBanner, WarningBanner } from "../../components/StatusBanner";
import { useMask } from "../../components/MaskContext";
import { countUndismissedAnomalies } from "../../utils/anomalyFilters";
import { berlinCurrentMonth } from "../../utils/dates";
import { parseDecimal, decSum, formatDecimal } from "../../utils/decimal";
import { getNetWorthGoal, setNetWorthGoal } from "../../utils/goal";
import { getDismissals } from "../../utils/snooze";
import { homeNwTrendOption } from "./homeChartOptions";
import { HomeHero } from "./HomeHero";
import { HomePnlStrip } from "./HomePnlStrip";
import { HomeAttribution } from "./HomeAttribution";
import { HomeComposition } from "./HomeComposition";
import { HomeAccounts } from "./HomeAccounts";
import { HomeRecent } from "./HomeRecent";

/**
 * 首页（shadcn/Tailwind 样板页）：有明确焦点的高级财务首页。
 * 全部 query hooks / 事件 / 遮蔽 / 设目标数据逻辑保持不变，仅重写呈现层；
 * 图表配色走首页专用品牌绿 option（homeChartOptions），不影响其他页面。
 */
export function HomePage() {
  const qc = useQueryClient();
  // 首页唯一期间源（WP05 R05/U05）：Europe/Berlin 本月至今，必须在
  // 任何使用它的请求 hook 之前声明；收支与 useFxAttribution 共享同一期间。
  const month = berlinCurrentMonth();
  const balance = useBalanceSheet();
  const trend = useNetWorthTrend(undefined, 12);
  const accounts = useAccountBalances();
  const fxAttribution = useFxAttribution(month.start, month.end);
  const anomalies = useAnomalies();
  const curInc = useIncomeStatement(month.start, month.end);
  const recentTransactions = useTransactions({
    start: month.start,
    end: month.end,
    limit: 20,
    offset: 0,
  });
  const [goal, setGoal] = useState<number | null>(() => getNetWorthGoal());
  const { masked } = useMask();

  const trendPoints = trend.data?.points ?? [];
  const lastTwo = trendPoints.slice(-2);
  const prevNetWorth =
    lastTwo.length >= 2 ? (lastTwo[0]?.net_worth_base ?? null) : null;

  // 可用现金（WP06/U02）：Decimal 精确聚合 + 汇率完整性预检，三态区分——
  //   value       真实精确值（含真实零）
  //   fx_missing  任一现金账户非零余额缺折算 → fail-closed
  //   unknown     账户数据不可用（错误/未加载）→ 显示未知
  const availableCash = useMemo(() => {
    if (!accounts.data) return { kind: "unknown" as const };
    const cashAccounts = (accounts.data.accounts ?? [])
      .filter(
        (a) =>
          a.active && (a.account_role === "cash" || a.group === "cash"),
      );
    const missingFx = cashAccounts.some((a) => {
      if (a.balance_base !== null) return false;
      const native = parseDecimal(a.balance);
      return native !== null && native.units !== 0n; // 零余额不需要汇率
    });
    if (missingFx) return { kind: "fx_missing" as const };
    const total = decSum(
      cashAccounts.map(
        (a) =>
          parseDecimal(a.balance_base) ??
          parseDecimal(a.balance) ?? { units: 0n, scale: 0 },
      ),
    );
    return { kind: "value" as const, value: formatDecimal(total) };
  }, [accounts.data]);

  function handleGoalChange(nextGoal: number | null) {
    setNetWorthGoal(nextGoal);
    setGoal(nextGoal);
  }

  const refresh = () => void qc.invalidateQueries();

  const balanceError = Boolean(balance.isError);
  const trendError = Boolean(trend.isError);
  const incomeError = Boolean(curInc.isError);
  const accountsError = Boolean(accounts.isError);

  // 401 需要整页横幅明确提示重新登录；其他错误走内联部分渲染（M1）
  const authError = [balance.error, trend.error, accounts.error, curInc.error].find(
    (e): e is ApiError => e instanceof ApiError && e.status === 401,
  );

  const loading = [balance, trend, accounts, curInc, recentTransactions].some(
    (q) => q.isPending,
  );

  const pendingAnomalyCount = countUndismissedAnomalies(
    anomalies.data?.anomalies ?? [],
    getDismissals(),
  );

  useAppHeader({
    title: "首页",
    meta: balance.data ? (
      <span>截止 {balance.data.balance_as_of}</span>
    ) : undefined,
    actions: (
      <button type="button" className="home-page-action inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]" onClick={refresh}>
        <RefreshCw size={15} aria-hidden="true" /> 刷新
      </button>
    ),
  });

  const s = balance.data?.summary;
  const base = balance.data?.base_currency ?? "CNY";

  const incSummary = curInc.data?.summary as
    | {
        total_income_cny?: string | null;
        total_expenses_cny?: string | null;
        net_result_cny?: string | null;
        savings_rate_pct?: string | null;
      }
    | undefined;

  const warnings = [
    ...(balance.data?.warnings ?? []),
    ...(curInc.data?.warnings ?? []),
  ];

  return (
    <div className="page home-page narrative-spine flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)] gap-6 pt-8 px-10 pb-10 max-w-[1440px] max-sm:gap-4 max-sm:p-4">
      {/* REL-05：任一数据源刷新失败但缓存仍有旧值 → 顶部先说明「数据可能过期」 */}
      <StaleDataBanner
        queries={[
          balance,
          trend,
          accounts,
          curInc,
          fxAttribution,
          anomalies,
          recentTransactions,
        ]}
        onRefresh={refresh}
      />
      <WarningBanner items={warnings} onRefresh={refresh} />
      {authError && <ErrorBanner message={authError.message} />}

      {loading ? (
        <div className="flex flex-col gap-5">
          <div className="h-[68px] w-full animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
          <div className="h-[150px] w-full animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
          <div className="h-[300px] w-full animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
        </div>
      ) : (
        <>
          {/* 焦点：大字净资产 + 本月/上月变动 */}
          {balanceError ? (
            <InlineUnavailableNotice
              label="净资产概览"
              queryKeys={[["balance-sheet"], ["account-balances"]]}
            />
          ) : (
            <HomeHero
              netWorth={s?.net_worth_base ?? null}
              totalAssets={s?.total_assets_base ?? null}
              totalLiabilities={s?.total_liabilities_base ?? null}
              availableCash={
                availableCash.kind === "value" ? availableCash.value : null
              }
              availableCashUnknown={availableCash.kind === "unknown"}
              currency={base}
              prevNetWorth={prevNetWorth}
              fxComplete={balance.data?.fx_complete ?? true}
              missingCurrencies={balance.data?.missing_currencies ?? []}
              pendingAnomalyCount={pendingAnomalyCount}
            />
          )}

          {/* 本月收支 MTD */}
          {incomeError ? (
            <InlineUnavailableNotice
              label="本月收支"
              queryKeys={[["income-statement"]]}
            />
          ) : (
            <HomePnlStrip
              period={month}
              income={incSummary?.total_income_cny ?? null}
              expenses={incSummary?.total_expenses_cny ?? null}
              netResult={incSummary?.net_result_cny ?? null}
              savingsRate={incSummary?.savings_rate_pct ?? null}
              currency={base}
            />
          )}

          {/* 健康信号（critical 契约；无 critical 时隐藏） */}
          <HealthSignalsStrip anomalies={anomalies.data?.anomalies ?? []} />

          {/* 净资产趋势（品牌绿） */}
          <section className="narrative-chart-section bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl p-5" aria-label="净资产趋势">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="section-heading text-[16px] font-[650] m-0">净资产趋势</h2>
              <span className="narrative-chart-meta text-[13px] text-[var(--text-faint)] ml-[auto]">近12个月</span>
              <GoalSetter
                goal={goal}
                onChange={handleGoalChange}
                currency={base}
              />
            </div>
            {trendError ? (
              <InlineUnavailableNotice
                label="净资产趋势"
                queryKeys={[["net-worth-trend"]]}
              />
            ) : trend.data ? (
              <EChart
                option={homeNwTrendOption(trendPoints, masked, goal)}
                ariaLabel="近12个月净资产趋势"
              />
            ) : null}
          </section>

          {/* 本月变动归因（储蓄绿 + 汇率金） */}
          <HomeAttribution
            savingsContribution={
              fxAttribution.data?.total_savings_contribution_cny ?? null
            }
            fxContribution={
              fxAttribution.data?.total_fx_contribution_cny ?? null
            }
            totalChange={
              fxAttribution.data?.total_net_worth_change_cny ?? null
            }
            currency={base}
          />

          {/* 资产组合品牌绿环 */}
          {balanceError ? (
            <InlineUnavailableNotice
              label="资产组合"
              queryKeys={[["balance-sheet"], ["account-balances"]]}
            />
          ) : (
            <HomeComposition
              groups={balance.data?.groups ?? []}
              total={s?.total_assets_base ?? null}
              baseCurrency={base}
            />
          )}

          {/* 账户列表 + 近期活动 */}
          <div className="grid [grid-template-columns:1fr_1fr] items-start gap-6 max-sm:[grid-template-columns:1fr]">
            {accountsError ? (
              <InlineUnavailableNotice
                label="账户列表"
                queryKeys={[["account-balances"]]}
              />
            ) : (
              <HomeAccounts
                accounts={accounts.data?.accounts ?? []}
                baseCurrency={base}
              />
            )}
            {recentTransactions.isError ? (
              <InlineUnavailableNotice
                label="近期活动"
                queryKeys={[["transactions"]]}
              />
            ) : (
              <HomeRecent
                transactions={recentTransactions.data?.rows ?? []}
                baseCurrency={base}
              />
            )}
          </div>

          {/* 数据时间戳页脚 */}
          <ReportTimestampFooter
            generatedAt={balance.data?.generated_at ?? null}
            asOf={balance.data?.balance_as_of ?? null}
          />
        </>
      )}
    </div>
  );
}

function InlineUnavailableNotice({
  label,
  queryKeys,
}: {
  label: string;
  queryKeys: readonly unknown[][];
}) {
  const qc = useQueryClient();
  return (
    <div className="flex items-center gap-2 py-2.5 px-3 rounded-[10px] border border-solid border-[var(--data-neutral)] text-[var(--text-faint)] text-[13px]" role="alert">
      {label} · 部分数据不可用
      <button
        type="button"
        className="ml-[auto] border-0 bg-transparent text-inherit underline [font:inherit] cursor-pointer whitespace-nowrap"
        onClick={() => {
          for (const key of queryKeys)
            void qc.invalidateQueries({ queryKey: key });
        }}
      >
        重试
      </button>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { WebAccountRow } from "../api/types";
import { useBalanceSheet } from "../api/hooks";
import { Amount, SignedAmount } from "../components/Amount";
import { useAppHeader } from "../components/AppHeader";
import { AsOfToolbar } from "../components/AsOfToolbar";
import {
  BalanceSheetCompositionCard,
  BalanceSheetCompositionSkeleton,
} from "../components/composition/BalanceSheetCompositionCard";
import { DeltaMatrix } from "../components/DeltaMatrix";
import { ErrorBanner, WarningBanner } from "../components/StatusBanner";
import { PageAnchorNav, ReportSection } from "../components/report/ReportChrome";
import { ReportTimestampFooter } from "../components/ReportTimestampFooter";
import { StaleDataBanner } from "../components/StaleDataBanner";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { berlinTodayIso, formatDateCn, prevMonthEnd, prevYearEnd } from "../utils/dates";
import { formatTimestampBerlin } from "../utils/timestamps";
import { formatNumber } from "../utils/format";
import { type CompareMode } from "../utils/balanceSheetDelta";
import { decAbs, decDiff, decEquals, formatDecimal, parseDecimal } from "../utils/decimal";

/**
 * 资产负债页（shadcn/Tailwind 第二批迁移）。
 * 呈现层重构为「焦点 KPI → 构成分析 → 账户明细」的分区节奏，顶部锚点导航、
 * 明细默认折叠；全部 query hooks / as-of 对比 / 构成钻取 / Delta 计算逻辑不变。
 * 0 基期异常百分比由 balanceSheetDelta 的 new/closed 分支收敛（显示中性状态）。
 */

const ANCHORS = [
  { id: "overview", label: "概览" },
  { id: "composition", label: "构成" },
  { id: "details", label: "明细" },
];

export function BalanceSheetPage() {
  const qc = useQueryClient();
  // 顶栏操作区收窄阈值：完整时点工具栏 + 对比下拉 + 刷新共约 578px，加上全局图标按钮后
  // 需要 ≥1024px 视口才不与标题抢位（768–1023px 实测横向溢出）。故 1023px 及以下改用
  // 页面内的紧凑控件（与移动端同一套），避免顶栏撑破视口。
  const isCompactHeader = useMediaQuery("(max-width: 1023px)");
  // DATA-01：初始 as_of 必须是柏林业务日。
  const [asOf, setAsOf] = useState<string>(() => berlinTodayIso());
  const [compareMode, setCompareMode] = useState<CompareMode>("none");
  const query = useBalanceSheet(asOf);
  const compareDate =
    compareMode === "last_month_end"
      ? prevMonthEnd(asOf)
      : compareMode === "last_year_end"
        ? prevYearEnd(asOf)
        : undefined;
  const compareQuery = useBalanceSheet(compareDate, {
    enabled: compareMode !== "none",
  });
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  const data = query.data;

  // 对比行按稳定 account.id 对齐（禁止按账户名匹配）
  const compareByAccountId = useMemo(() => {
    if (!compareQuery.data) return undefined;
    const map = new Map<string, WebAccountRow>();
    for (const g of compareQuery.data.groups) {
      for (const a of g.accounts) map.set(a.id, a);
    }
    return map;
  }, [compareQuery.data]);
  const showDelta = compareMode !== "none" && compareQuery.data !== undefined;

  useAppHeader({
    title: "资产负债",
    meta: data ? (
      <span>截止 {formatDateCn(data.balance_as_of)}</span>
    ) : undefined,
    actions: (
      <>
        {!isCompactHeader && (
        <div className="inline-flex items-center gap-[var(--space-2)]">
          <AsOfToolbar
            asOf={asOf}
            onAsOfChange={setAsOf}
            maxDate={berlinTodayIso()}
          />
          <select
            className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] focus:outline-none focus:border-[var(--brand-accent)]"
            aria-label="对比基准"
            value={compareMode}
            onChange={(e) => setCompareMode(e.target.value as CompareMode)}
          >
            <option value="none">无对比</option>
            <option value="last_month_end">对比上月末</option>
            <option value="last_year_end">对比去年末</option>
          </select>
        </div>
        )}
        {!isCompactHeader && <span aria-hidden="true" className="mx-1 h-5 w-px bg-[var(--border-default)]" />}
        <button type="button" className="home-page-action inline-flex items-center justify-center gap-1.5 h-10 max-md:h-[var(--touch-target)] max-md:min-h-[var(--touch-target)] px-3 rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--topbar-bg)] text-[var(--text-tertiary)] text-[13px] font-medium hover:bg-[var(--surface-hover)]" onClick={refresh}>
          <RefreshCw size={15} aria-hidden="true" /> 刷新
        </button>
      </>
    ),
  });

  return (
    <div className="page balance-sheet-page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      {isCompactHeader && (
      <div className="flex flex-col gap-2">
        <AsOfToolbar asOf={asOf} onAsOfChange={setAsOf} maxDate={berlinTodayIso()} />
        <select
          className="h-10 w-fit rounded-[10px] border border-solid border-[var(--border-default)] bg-[var(--card)] px-3 text-[13px] text-[var(--text-body)]"
          aria-label="对比基准（移动端）"
          value={compareMode}
          onChange={(e) => setCompareMode(e.target.value as CompareMode)}
        >
          <option value="none">无对比</option>
          <option value="last_month_end">对比上月末</option>
          <option value="last_year_end">对比去年末</option>
        </select>
      </div>
      )}
      <StaleDataBanner queries={[query, compareQuery]} onRefresh={refresh} />
      {query.error ? (
        <ErrorBanner
          message={(query.error as Error).message}
          onRetry={refresh}
        />
      ) : query.isPending ? (
        <>
          <div className="h-[150px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
          <BalanceSheetCompositionSkeleton />
          <div className="h-[240px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
        </>
      ) : data ? (
        <>
          <WarningBanner items={data.warnings} onRefresh={refresh} />
          <PageAnchorNav items={ANCHORS} />

          {/* 焦点：大字净资产 + 资产 / 负债两格 */}
          <KpiFocus
            data={data}
            showDelta={showDelta}
            compareData={compareQuery.data ?? undefined}
          />

          {!data.fx_complete && (
            <p className="text-[var(--warning-800)] bg-[var(--warning-100)] border border-solid border-[var(--warning-600)] rounded-[10px] py-2.5 px-3 m-0 text-[13px] leading-[20px] font-normal">
              缺少汇率：{data.missing_currencies.join("、")}
              。涉及账户与汇总金额暂无法折算为 CNY，原币余额仍可见。
            </p>
          )}

          <div id="composition" className="scroll-mt-20">
            <BalanceSheetCompositionCard data={data} isFetching={query.isFetching} />
          </div>

          <div id="details" className="scroll-mt-20">
            <ReportSection
              id="balance-details-inner"
              title="账户对比明细"
              meta={showDelta ? "已启用对比基准" : "选择对比基准后显示变动"}
              collapsible
              defaultOpen={true}
            >
              <DeltaMatrix
                groups={data.groups}
                compareByAccountId={compareByAccountId}
                showDelta={showDelta}
                baseCurrency={data.base_currency}
              />
            </ReportSection>
          </div>

          <p className="meta-line m-0 text-[var(--text-faint)] [font:var(--type-caption)]">
            截止 {formatDateCn(data.balance_as_of)} · 生成于{" "}
            {formatTimestampBerlin(data.generated_at)} · 基础币种{" "}
            {data.base_currency}
          </p>

          <ReportTimestampFooter
            generatedAt={data.generated_at}
            asOf={data.balance_as_of}
          />
        </>
      ) : (
        <div className="empty-state flex flex-col items-center justify-center text-center py-[var(--space-8)] px-[var(--space-4)] text-[var(--text-faint)] [.waterfall-blocked_&]:p-0" role="status">
          <div className="title">暂无资产负债数据</div>
          <div className="desc">
            当前截止日期未返回可展示的资产负债数据。
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 焦点 KPI：大字净资产（含对比差额）+ 资产 / 负债两格。
 * 保留 test 契约：getByLabelText 总资产 / 总负债 / 净资产。
 */
function KpiFocus({
  data,
  showDelta,
  compareData,
}: {
  data: NonNullable<ReturnType<typeof useBalanceSheet>["data"]>;
  showDelta: boolean;
  compareData: ReturnType<typeof useBalanceSheet>["data"];
}) {
  const compareSummary = compareData?.summary;
  const currency = data.base_currency;

  // CALC-02：差值全程留在精确/字符串域，绝不经 Number；绝对值走 decAbs。
  function renderDiff(
    current: string | null | undefined,
    compare: string | null | undefined,
  ) {
    if (
      !showDelta ||
      compare === null ||
      compare === undefined ||
      current === null ||
      current === undefined
    )
      return null;
    const currentDecimal = parseDecimal(current);
    const compareDecimal = parseDecimal(compare);
    if (!currentDecimal || !compareDecimal) return null;

    const diff = decDiff(currentDecimal, compareDecimal);
    if (decEquals(diff, parseDecimal("0")!)) {
      return (
        <span className="text-[13px] font-medium text-[var(--delta-neutral)] tabular-nums">
          —
        </span>
      );
    }
    const displayDiff = formatNumber(formatDecimal(decAbs(diff)));
    const up = diff.units > 0n;
    return (
      <span
        className={[
          "inline-flex items-center gap-1 text-[13px] font-medium tabular-nums",
          up ? "text-[var(--delta-positive)]" : "text-[var(--delta-negative)]",
        ].join(" ")}
      >
        {up ? "↑ +" : "↓ "}
        {displayDiff}
      </span>
    );
  }

  return (
    <section
      id="overview"
      aria-label="净资产概览"
      className="scroll-mt-20 rounded-xl border border-[var(--hairline)] bg-[var(--card)] px-6 py-6 shadow-[0_1px_2px_rgba(11,46,39,0.04)]"
    >
      <div role="group" aria-label="净资产" className="flex flex-col gap-2">
        <span className="text-[13px] font-medium tracking-wide text-[var(--text-secondary)]">
          净资产
        </span>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <span className="text-[42px] font-semibold leading-none tracking-[-0.025em] text-[var(--foreground)] tabular-nums sm:text-[48px]">
            <SignedAmount
              value={data.summary.net_worth_base}
              currency={currency}
            />
          </span>
          {renderDiff(
            data.summary.net_worth_base,
            compareSummary?.net_worth_base,
          )}
        </div>
        <span className="text-[12px] text-[var(--delta-neutral)]">
          {formatNumber(data.summary.included_account_count)} 个账户
          {data.summary.pending_mapping_count > 0 &&
            ` · ${data.summary.pending_mapping_count} 个待分类`}
        </span>
      </div>

      <div className="my-5 h-px bg-[var(--hairline)]" />

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div
          role="group"
          aria-label="总资产"
          className="flex flex-col gap-1.5 sm:border-l sm:border-[var(--hairline)] sm:pl-6 first:sm:border-l-0 first:sm:pl-0"
        >
          <span className="text-[12.5px] text-[var(--delta-neutral)]">总资产</span>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--foreground)] tabular-nums">
              <Amount
                value={data.summary.total_assets_base}
                currency={currency}
              />
            </span>
            {renderDiff(
              data.summary.total_assets_base,
              compareSummary?.total_assets_base,
            )}
          </div>
        </div>
        <div
          role="group"
          aria-label="总负债"
          className="flex flex-col gap-1.5 sm:border-l sm:border-[var(--hairline)] sm:pl-6"
        >
          <span className="text-[12.5px] text-[var(--delta-neutral)]">总负债</span>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--foreground)] tabular-nums">
              <Amount
                value={data.summary.total_liabilities_base}
                currency={currency}
              />
            </span>
            {renderDiff(
              data.summary.total_liabilities_base,
              compareSummary?.total_liabilities_base,
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

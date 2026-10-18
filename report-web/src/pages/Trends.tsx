/**
 * 趋势页（shadcn/Tailwind 第二批迁移）。
 *
 * 呈现层重构为「异常雷达 → 支出偏差 → 币种敞口」三分区 + 顶部锚点；偏差区新增
 * 品牌绿/赭红发散条（低于历史月均绿、高于历史月均赭红）。全部 query hooks、snooze 逻辑、
 * 快速指令、ResponsiveDataView 表格/卡片契约保持不变。
 *
 * spec 立场：异常雷达，非历史堆砌——退役 KPI 汇总/异常计数横幅/历史支出柱状。
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useAnomalies, useCurrencyExposure, useSpendingTrends } from "../api/hooks";
import type { AnomalyRow, SpendingTrendRow } from "../api/types";
import { Amount } from "../components/Amount";
import { useAppHeader } from "../components/AppHeader";
import { EChart, exposureBarOption } from "../components/Chart";
import { EmptyState } from "../components/EmptyState";
import { ExceptionRadar } from "../components/ExceptionRadar";
import {
  PageAnchorNav,
  ReportSection,
} from "../components/report/ReportChrome";
import { SpendingDeviationTable } from "../components/SpendingDeviationTable";
import { ReportTimestampFooter } from "../components/ReportTimestampFooter";
import { StaleDataBanner } from "../components/StaleDataBanner";
import { ErrorBanner } from "../components/StatusBanner";
import { formatPct } from "../utils/format";
import {
  type DismissalMap,
  loadSnoozedAnomalies,
} from "../utils/anomalyFilters";
import {
  snoozeAnomaly,
  unsnoozeAnomaly,
  type SnoozeDuration,
} from "../utils/snooze";
import { useToast } from "../components/Toast";
import { useMask } from "../components/MaskContext";
import { usePageTitle } from "../utils/pageTitle";
import { brandBase, BRAND_TOOLTIP } from "../utils/brandChart";
import type * as echarts from "echarts";

/** Snooze 时长 -> toast 文案。 */
const SNOOZE_TOAST: Record<SnoozeDuration, string> = {
  "7d": "已静音 7 天",
  "30d": "已静音 30 天",
  forever: "已永久静音",
};

const ANCHORS = [
  { id: "radar", label: "异常雷达" },
  { id: "deviation", label: "支出偏差" },
  { id: "exposure", label: "币种敞口" },
];

/**
 * 偏差发散条：相对历史月均的偏离百分比；低于历史月均（负值）品牌绿，
 * 高于历史月均（正值）赭红；null（缺汇率）不绘制。
 * 注意：比的是历史月均，不是预算——预算功能已否决，不做预算管理。
 */
function deviationDivergingOption(
  rows: SpendingTrendRow[],
  masked: boolean,
) {
  const labels = rows.map((r) => r.category);
  const data = rows.map((r) =>
    r.deviation_percentage === null ? null : r.deviation_percentage,
  );
  return {
    ...brandBase,
    tooltip: {
      trigger: "axis",
      ...BRAND_TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null || v === undefined
          ? "汇率缺失"
          : masked
            ? "••••"
            : `${Number(v).toFixed(1)}%`,
    },
    grid: { left: 8, right: 24, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: "value",
      axisLabel: {
        fontSize: 11,
        color: "#8A93A0",
        formatter: (v: number) => (masked ? "••••" : `${v}%`),
      },
      splitLine: { lineStyle: { color: "#EDF0F2", width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLabel: { fontSize: 12, color: "#596273" },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "偏差",
        type: "bar",
        barMaxWidth: 20,
        data: data.map((v) => ({
          value: v,
          itemStyle: {
            color:
              v === null
                ? "#D7DCE0"
                : v > 0
                  ? "#BC564E"
                  : "#157A5A",
            borderRadius: v !== null && v > 0 ? [0, 3, 3, 0] : [3, 0, 0, 3],
          },
        })),
      },
    ],
  } as unknown as echarts.EChartsOption;
}

export function TrendsPage() {
  usePageTitle("趋势");
  const qc = useQueryClient();
  const trends = useSpendingTrends(6);
  const exposure = useCurrencyExposure();
  const anomaliesQ = useAnomalies();
  const { masked } = useMask();
  const { showToast } = useToast();
  // 本页三类数据各自失效。
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["spending-trends"] });
    void qc.invalidateQueries({ queryKey: ["currency-exposure"] });
    void qc.invalidateQueries({ queryKey: ["anomalies"] });
  };

  // 静音状态为纯本地偏好（localStorage）。
  const [snoozed, setSnoozed] = useState<DismissalMap>(() =>
    loadSnoozedAnomalies(),
  );
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    // 挂载清一次过期静音：到期自动恢复提醒
    setSnoozed(loadSnoozedAnomalies());
  }, []);

  const applySnooze = (id: string, dur: SnoozeDuration) => {
    snoozeAnomaly(id, dur);
    setSnoozed(loadSnoozedAnomalies());
    setOpenMenuId(null);
    showToast(SNOOZE_TOAST[dur]);
  };
  const restoreAnomaly = (id: string) => {
    unsnoozeAnomaly(id);
    setSnoozed(loadSnoozedAnomalies());
    showToast("已恢复提醒");
  };
  const quickCommandCopy = (row: AnomalyRow) => {
    const text =
      "排查异常 source=" +
      row.source +
      " id=" +
      row.id +
      (row.category ? " 类别=" + row.category : "") +
      (row.amount && row.currency
        ? " 本月金额=" + row.amount + " " + row.currency
        : "");
    void navigator.clipboard?.writeText(text);
    showToast("已复制飞书排查指令");
  };

  useAppHeader({
    title: "趋势",
    meta: trends.data ? (
      <span>
        本月 {trends.data.current_month} · 对比{" "}
        {trends.data.comparison_window_months} 个月
      </span>
    ) : undefined,
    actions: (
      <button type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]" onClick={refresh}>
        <RefreshCw size={15} aria-hidden="true" /> 刷新
      </button>
    ),
  });

  const trendsError = [trends.error, exposure.error, anomaliesQ.error].find(
    (e) => e instanceof Error,
  ) as Error | undefined;
  const loading =
    trends.isLoading || exposure.isLoading || anomaliesQ.isLoading;
  const rows = trends.data?.trends ?? [];
  const chartableRows = rows.filter(
    (r) => r.fx_complete || r.deviation_percentage !== null,
  );
  const exposureRows = exposure.data?.exposures ?? [];
  const anomalyItems = anomaliesQ.data?.anomalies ?? [];

  return (
    <div className="page trends-page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      <StaleDataBanner
        queries={[trends, exposure, anomaliesQ]}
        onRefresh={refresh}
      />
      {trendsError ? (
        <ErrorBanner message={trendsError.message} onRetry={refresh} />
      ) : loading ? (
        <>
          <div className="h-[260px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
          <div className="h-[260px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
        </>
      ) : !trends.data && !exposure.data && !anomaliesQ.data ? (
        <EmptyState
          title="暂无趋势数据"
          description="当前未返回支出趋势、异常或币种敞口数据。"
        />
      ) : (
        <>
          <PageAnchorNav items={ANCHORS} />

          {/* 异常雷达 */}
          <div id="radar" className="scroll-mt-20">
            <ExceptionRadar
              items={anomalyItems}
              dismissals={snoozed}
              showSnoozed={showSnoozed}
              openMenuId={openMenuId}
              onToggleShowSnoozed={() => setShowSnoozed(!showSnoozed)}
              onOpenMenu={setOpenMenuId}
              onSnooze={applySnooze}
              onUnsnooze={restoreAnomaly}
              onQuickCommand={quickCommandCopy}
            />
          </div>

          {trends.data?.fx_complete === false && (
            <p className="trends-fx-warning text-[var(--warning-800)] bg-[var(--warning-100)] border border-solid border-[var(--warning-600)] rounded-[10px] py-2.5 px-3 m-0 text-[13px] leading-[20px] font-normal" role="status">
              汇率不完整：
              {trends.data.missing_currencies?.length
                ? trends.data.missing_currencies.join("、")
                : "部分币种"}
              。受影响类别显示“汇率缺失”/“—”，不折算为 0。
            </p>
          )}

          {/* 支出偏差 */}
          <ReportSection
            id="deviation"
            title="支出偏差"
            meta="本月支出较历史月均"
          >
            {chartableRows.length > 0 && (
              <EChart
                option={deviationDivergingOption(chartableRows, masked)}
                ariaLabel="支出偏差发散条"
                height={Math.max(160, chartableRows.length * 34)}
              />
            )}
            <div className="mt-2">
              <SpendingDeviationTable rows={rows} />
            </div>
          </ReportSection>

          {/* 币种敞口 */}
          <ReportSection
            id="exposure"
            title="币种敞口"
            meta={`汇率日期 ${exposure.data?.fx_rates_date ?? ""}`}
          >
            {exposure.data?.fx_complete === false && (
              <p className="text-[var(--warning-800)] bg-[var(--warning-100)] border border-solid border-[var(--warning-600)] rounded-[10px] py-2.5 px-3 m-0 text-[13px] leading-[20px] font-normal">
                {exposure.data.missing_currencies?.length
                  ? "缺少汇率：" +
                    exposure.data.missing_currencies.join("、") +
                    "。相关敞口无法折算 CNY，原币余额仍可见。"
                  : "部分币种汇率缺失，相关敞口无法折算 CNY，原币余额仍可见。"}
              </p>
            )}
            {exposureRows.length > 0 && (
              <EChart
                option={exposureBarOption(exposureRows, masked)}
                ariaLabel="币种敞口"
                height={220}
              />
            )}
            <ResponsiveExposureTable
              rows={exposureRows}
              baseCurrency={exposure.data?.base_currency ?? "CNY"}
            />
          </ReportSection>
        </>
      )}

      {/* 异常检查瞬间 checked_at 与支出趋势估值日 as_of 语义不同，分列呈现 */}
      <ReportTimestampFooter
        generatedAt={anomaliesQ.data?.checked_at}
        asOf={trends.data?.as_of}
      />
    </div>
  );
}

/**
 * 币种敞口双轨表（从旧内联 JSX 抽出：桌面表格 / 移动卡片）。
 * 保留 aria 契约：table「币种敞口」、list「币种敞口卡片」。
 */
function ResponsiveExposureTable({
  rows,
  baseCurrency,
}: {
  rows: import("../api/types").CurrencyExposureRow[];
  baseCurrency: string;
}) {
  return (
    <ResponsiveDataViewLax
      isEmpty={rows.length === 0}
      desktop={
        <div className="data-table-wrap trends-currency-desktop bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] overflow-hidden max-[479px]:overflow-x-auto max-[479px]:[-webkit-overflow-scrolling:touch] max-md:[.has-mobile-card_&]:hidden max-md:hidden">
          <table className="data-table" aria-label="币种敞口">
            <thead>
              <tr>
                <th>币种</th>
                <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">原币余额</th>
                <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">折 {baseCurrency}</th>
                <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.currency}>
                  <td>{e.currency}</td>
                  <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    <Amount value={e.balance} currency={e.currency} />
                  </td>
                  <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {e.cny_value == null ? (
                      "汇率缺失"
                    ) : (
                      <Amount value={e.cny_value} currency="CNY" />
                    )}
                  </td>
                  <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">{formatPct(e.percentage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      mobile={
        <ul className="trends-currency-mobile mobile-card-list hidden flex-col gap-3 w-full mt-3 mb-0 p-0 list-none max-md:flex max-md:[.accounts-page_&]:mt-0 max-md:mt-0" aria-label="币种敞口卡片">
          {rows.map((e) => (
            <li
              key={e.currency}
              className="trends-currency-card bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl py-3.5 px-4 flex flex-col gap-2.5 shadow-[var(--shadow-sm)] max-sm:min-w-0 max-sm:max-w-full"
            >
              <div className="flex items-center justify-between gap-2 border-b border-b-[var(--border-soft)] pb-2.5 cursor-default [.income-top-card_&]:mb-0">
                <span className="min-w-0 text-[var(--text-strong)] [font:var(--type-body)] font-semibold [overflow-wrap:anywhere]">{e.currency}</span>
                <span className="ml-[auto] text-[var(--text-body)] [font:var(--type-body)] font-semibold [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                  {formatPct(e.percentage)}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                  <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">原币余额</span>
                  <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    <Amount value={e.balance} currency={e.currency} />
                  </span>
                </div>
                <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                  <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">折 {baseCurrency}</span>
                  <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {e.cny_value == null ? (
                      "汇率缺失"
                    ) : (
                      <Amount value={e.cny_value} currency="CNY" />
                    )}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      }
    />
  );
}

/** 直接用 ResponsiveDataView（空态由 ReportSection 承载，故这里只做双轨切换）。 */
function ResponsiveDataViewLax({
  isEmpty,
  desktop,
  mobile,
}: {
  isEmpty: boolean;
  desktop: React.ReactNode;
  mobile: React.ReactNode;
}) {
  if (isEmpty)
    return (
      <div className="empty-state flex flex-col items-center justify-center text-center py-[var(--space-8)] px-[var(--space-4)] text-[var(--text-faint)] [.waterfall-blocked_&]:p-0" role="status">
        <div className="title">暂无敞口数据</div>
        <div className="desc">汇率不完整或没有资产/负债账户。</div>
      </div>
    );
  return (
    <>
      <div className="max-md:hidden">{desktop}</div>
      <div className="hidden max-md:flex max-md:mt-0">{mobile}</div>
    </>
  );
}

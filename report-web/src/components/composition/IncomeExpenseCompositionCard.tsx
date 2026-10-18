import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { IncomeStatementSummary, ReportEnvelope } from "../../api/types";
import { EmptyState } from "../EmptyState";
import { useMask } from "../MaskContext";
import { SkeletonBlock, SkeletonLine } from "../Skeleton";
import { CompositionCard } from "./CompositionCard";
import { CompositionDonut } from "./CompositionDonut";
import { CompositionFilterControl, type FilterOption } from "./CompositionFilterControl";
import { CompositionFxBlocked } from "./CompositionFxBlocked";
import { CompositionOffsetBlock } from "./CompositionOffsetBlock";
import { CompositionRanking, type RankingItem, type RowAction } from "./CompositionRanking";
import { compositionColor, type CompositionDonutSlice } from "../../utils/chartOptions";
import { decToNumber } from "../../utils/decimal";
import { formatDateCn } from "../../utils/dates";
import {
  deriveIncomeComposition,
  type CompositionItem,
  type SelectionState,
} from "../../utils/compositionSeries";
import { BASE_SEGMENTEDITEM, SEGMENTEDITEM_ISACTIVE } from "../../utils/legacyClasses";

/**
 * IncomeExpense 构成分析业务 controller（spec §7.9）。
 * - 读写 `?side=income`（默认 expense）；per-side category 筛选与 Other 状态本地持有；
 * - 只消费 income/expenses section（refunds/adjustments/migration 不消费，避免双计）；
 * - 正向 category 行与 Other 子行是真实 Transactions 深链（report_side + report_category，
 *   日期来自后端 period）；Offset 行 V1 不链接；
 * - 勾稽失败 / FX 不完整 fail closed：amount-only 披露，无百分比与链接。
 */
export interface IncomeExpenseCompositionCardProps {
  data: ReportEnvelope<IncomeStatementSummary>;
  /** 后端 period 缺失时才回退的已提交 query period（§5.3）。 */
  fallbackPeriod: { start: string; end: string };
  isFetching?: boolean;
}

type Side = "expense" | "income";

const SIDE_LABEL: Record<Side, string> = { expense: "支出", income: "收入" };
const OFFSET_TITLE: Record<Side, string> = {
  expense: "冲减项（退款）",
  income: "冲减项（收入冲回）",
};

export function IncomeExpenseCompositionCard({
  data,
  fallbackPeriod,
  isFetching,
}: IncomeExpenseCompositionCardProps) {
  const { masked } = useMask();
  const [searchParams, setSearchParams] = useSearchParams();
  const sideParam = searchParams.get("side");
  const side: Side = sideParam === "income" ? "income" : "expense";

  // 非法 side 回退默认并清理 URL（§6.3）
  useEffect(() => {
    if (sideParam !== null && sideParam !== "expense" && sideParam !== "income") {
      const params = new URLSearchParams(searchParams);
      params.delete("side");
      setSearchParams(params, { replace: true });
    }
  }, [sideParam, searchParams, setSearchParams]);

  const [filters, setFilters] = useState<Record<Side, SelectionState>>({
    expense: { kind: "all" },
    income: { kind: "all" },
  });
  const [otherState, setOtherState] = useState<{ scope: string; expanded: boolean }>({
    scope: "",
    expanded: false,
  });
  const otherScope = side;
  const otherExpanded = otherState.scope === otherScope && otherState.expanded;
  const toggleOther = useCallback(() => {
    setOtherState((prev) => ({
      scope: otherScope,
      expanded: !(prev.scope === otherScope && prev.expanded),
    }));
  }, [otherScope]);

  const handleFilterChange = useCallback(
    (next: SelectionState) => {
      setFilters((prev) => ({ ...prev, [side]: next }));
      setOtherState({ scope: "", expanded: false });
    },
    [side],
  );

  // §6.4：side toggle / period change → Other expanded 重置。
  const periodStart = data.period?.start_date;
  const periodEnd = data.period?.end_date;
  useEffect(() => {
    setOtherState({ scope: "", expanded: false });
  }, [side, periodStart, periodEnd]);
  const handleFilterReset = useCallback(() => {
    setFilters((prev) => ({ ...prev, [side]: { kind: "all" } }));
    setOtherState({ scope: "", expanded: false });
  }, [side]);

  const selection = filters[side];
  const filtered = selection.kind === "include";

  const model = useMemo(
    () => deriveIncomeComposition({ report: data, side, selection }),
    [data, side, selection],
  );

  // 深链日期：优先后端 response period，缺失才回退当前已提交 query period（§5.3）
  const linkPeriod = data.period ?? {
    start_date: fallbackPeriod.start,
    end_date: fallbackPeriod.end,
  };

  const buildHref = (label: string): string => {
    const params = new URLSearchParams({
      start: linkPeriod.start_date,
      end: linkPeriod.end_date,
      report_side: side,
      report_category: label, // URLSearchParams 编码，不手工拼接中文
    });
    return `/transactions?${params.toString()}`;
  };

  // 正向 category 行与 Other 子行可链接；Offset 行不链接（由 none action 保证）
  const actionFor = (item: RankingItem): RowAction => ({
    kind: "link",
    href: buildHref(item.label),
    ariaLabel: `查看${item.label}流水`,
  });

  const sectionKey = side === "expense" ? "expenses" : "income";
  const sectionRows = useMemo(
    () => data.sections.find((s) => s.key === sectionKey)?.rows ?? [],
    [data.sections, sectionKey],
  );

  // 筛选选项：当前 side 的 category labels（去重）；已选但消失的 label 保留禁用项
  const filterOptions = useMemo<FilterOption[]>(() => {
    const labels: FilterOption[] = [...new Set(sectionRows.map((r) => r.label))].map((label) => ({
      key: label,
      label,
    }));
    if (selection.kind === "include") {
      const existing = new Set(labels.map((l) => l.key));
      for (const key of selection.keys) {
        if (!existing.has(key)) labels.push({ key, label: key, disabled: true });
      }
    }
    return labels;
  }, [sectionRows, selection]);

  const subjectLabel = SIDE_LABEL[side];
  const currency = data.base_currency;
  const periodText = `${formatDateCn(linkPeriod.start_date)} ~ ${formatDateCn(linkPeriod.end_date)}`;
  const caption = `${periodText}${filtered ? " · 已筛选" : ""}`;

  const toSlices = (items: CompositionItem[]): CompositionDonutSlice[] =>
    items.map((item) => ({
      key: item.key,
      label: item.label,
      amountText: item.amountText,
      value: decToNumber(item.amount),
      color: compositionColor(item.colorIndex),
    }));

  const donutAria =
    model.status === "ready"
      ? `${subjectLabel}构成：${model.items
          .map((i) => `${i.label} ${i.percentage.toFixed(1)}%`)
          .join("，")}；中心合计 ${model.grossText} ${currency}`
      : `${subjectLabel}构成`;

  const controls = (
    <>
      <div className="inline-flex items-center gap-0 h-[var(--control-height)] p-[3px] bg-[var(--surface-subtle)] rounded-[10px] border-0 max-md:[.income-expense-page_&]:h-[var(--touch-target)] max-md:[.income-expense-page_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_&]:h-[var(--touch-target)] max-md:[.transactions-page_&]:min-h-[var(--touch-target)] max-md:[.income-expense-page_&]:py-0 max-md:[.transactions-page_&]:py-0" role="group" aria-label="构成分析侧">
        <button
          type="button"
          className={`${ BASE_SEGMENTEDITEM }${ side === "expense" ? ` ${ SEGMENTEDITEM_ISACTIVE }` : "" }`}
          aria-pressed={side === "expense"}
          onClick={() => {
            if (side === "expense") return;
            const params = new URLSearchParams(searchParams);
            params.delete("side"); // 默认 expense 不写 URL
            setSearchParams(params, { replace: true });
          }}
        >
          支出
        </button>
        <button
          type="button"
          className={`${ BASE_SEGMENTEDITEM }${ side === "income" ? ` ${ SEGMENTEDITEM_ISACTIVE }` : "" }`}
          aria-pressed={side === "income"}
          onClick={() => {
            if (side === "income") return;
            const params = new URLSearchParams(searchParams);
            params.set("side", "income");
            setSearchParams(params, { replace: true });
          }}
        >
          收入
        </button>
      </div>
      <CompositionFilterControl
        ariaLabel={`筛选${subjectLabel}分类`}
        options={filterOptions}
        selection={selection}
        onChange={handleFilterChange}
        onReset={handleFilterReset}
        disabled={isFetching}
      />
    </>
  );

  let chartSlot: React.ReactNode;
  let rankingSlot: React.ReactNode;
  let childrenSlot: React.ReactNode;
  let footer: React.ReactNode = null;

  if (model.status === "ready") {
    const slices = toSlices(model.items);
    if (model.other) {
      slices.push({
        key: "__other__",
        label: "其他",
        amountText: model.other.amountText,
        value: decToNumber(model.other.amount),
        color: compositionColor(-1),
      });
    }
    chartSlot = (
      <CompositionDonut
        slices={slices}
        centerAmount={model.grossText}
        centerLabel={`${filtered ? "已筛选" : ""}${subjectLabel}正项合计`}
        currency={currency}
        caption={caption}
        tooltipContext={model.percentageContext}
        ariaLabel={donutAria}
      />
    );
    rankingSlot = (
      <CompositionRanking
        items={model.items}
        other={model.other}
        zeroItems={model.zeroItems}
        otherExpanded={otherExpanded}
        onToggleOther={toggleOther}
        actionFor={actionFor}
        currency={currency}
        percentageContext={model.percentageContext}
      />
    );
    if (model.offsets.length > 0) {
      footer = (
        <CompositionOffsetBlock
          title={OFFSET_TITLE[side]}
          offsets={model.offsets}
          grossText={model.grossText}
          offsetTotalText={model.offsetTotalText}
          netText={model.netText}
          grossLabel="正项合计"
          netLabel={`${subjectLabel}净额`}
          currency={currency}
        />
      );
    }
  } else if (model.status === "offset-only") {
    childrenSlot = (
      <EmptyState
        title="无正向构成"
        description="本期间只有负向冲减项，无构成占比可展示。"
      />
    );
    footer = (
      <CompositionOffsetBlock
        title={OFFSET_TITLE[side]}
        offsets={model.offsets}
        grossText={model.grossText}
        offsetTotalText={model.offsetTotalText}
        netText={model.netText}
        grossLabel="正项合计"
        netLabel={`${subjectLabel}净额`}
        currency={currency}
      />
    );
  } else if (model.status === "empty" || model.status === "filtered-empty") {
    childrenSlot = (
      <EmptyState
        title={model.title}
        description={model.description}
        action={
          model.status === "filtered-empty" ? (
            <button type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]" onClick={handleFilterReset}>
              清除筛选
            </button>
          ) : undefined
        }
      />
    );
  } else if (model.status === "fx-blocked") {
    childrenSlot = (
      <CompositionFxBlocked
        subjectLabel={model.subjectLabel}
        rows={model.rows}
        missingCurrencies={model.missingCurrencies}
        baseCurrency={currency}
        baseMissingText="报表汇率不完整，未提供折算"
        fallbackNote="报表已按原币保留金额，暂无法折算合计。"
      />
    );
  } else if (model.status === "contract-blocked") {
    // amount-only 披露（无百分比、无深链）
    childrenSlot = (
      <div className="comp-contract-blocked">
        <p className="comp-contract-title" role="status">
          构成比例暂不可用：{model.reason}
        </p>
        {model.controlText !== undefined ? (
          <p className="comp-contract-detail">
            {/* WP06/U01：勾稽明细行也是金额出口，必须走遮蔽（掩码保留小数点以免误导） */}
            权威合计 {masked ? "••••" : model.controlText} · 明细推导 {masked ? "••••" : model.derivedText}
            {model.differenceText !== undefined ? ` · 差异 ${masked ? "••••" : model.differenceText}` : ""}（{currency}）
          </p>
        ) : null}
        <CompositionRanking
          items={model.rows.map((r) => ({
            key: r.key,
            label: r.label,
            amountText: r.amountText,
            negative: r.negative,
          }))}
          other={null}
          otherExpanded={false}
          onToggleOther={() => {}}
          actionFor={() => ({ kind: "none" })}
          currency={currency}
          percentageContext="total"
          showPercentages={false}
        />
      </div>
    );
  }

  return (
    <CompositionCard
      ariaLabel={`${subjectLabel}构成分析`}
      title={`${subjectLabel}构成分析`}
      controls={controls}
      chart={chartSlot}
      ranking={rankingSlot}
      busy={isFetching}
      footer={footer}
    >
      {childrenSlot}
    </CompositionCard>
  );
}

/** Income Composition 卡骨架（页面 initial pending 时使用）。 */
export function IncomeExpenseCompositionSkeleton() {
  return (
    <section className="card min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none flex flex-col gap-[var(--space-4)] min-h-[360px] max-sm:p-[var(--card-padding-mobile)]" aria-label="构成分析加载中" aria-busy="true">
      <SkeletonLine width="30%" />
      <div className="grid [grid-template-columns:minmax(0,_2fr)_minmax(0,_3fr)] gap-[var(--space-6)] [align-items:start] max-sm:[grid-template-columns:minmax(0,_1fr)] max-sm:gap-[var(--space-4)]">
        <div>
          <SkeletonBlock height={270} />
          <SkeletonLine width="60%" />
        </div>
        <div>
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </div>
      </div>
    </section>
  );
}

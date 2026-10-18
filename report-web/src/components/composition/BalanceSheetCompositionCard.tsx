import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import type { PersonalBalanceSheet } from "../../api/types";
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
  deriveBalanceSheetComposition,
  type CompositionItem,
  type SelectionState,
} from "../../utils/compositionSeries";
import { BASE_SEGMENTEDITEM, SEGMENTEDITEM_ISACTIVE } from "../../utils/legacyClasses";

/**
 * BalanceSheet 构成分析业务 controller（spec §7.8）。
 * - 读写 `?side` / `?group`（默认 asset；非法值回退并清理）；
 * - 持有 per-side account 筛选与 Other 展开状态（本地，不进 URL/localStorage）；
 * - Ranking group 行是下钻唯一权威入口；Donut 不导航；
 * - 负余额进入冲减块；FX 缺折算 fail closed；勾稽失败 contract-blocked。
 */
export interface BalanceSheetCompositionCardProps {
  data: PersonalBalanceSheet;
  isFetching?: boolean;
}

type Side = "asset" | "liability";

const SIDE_LABEL: Record<Side, string> = { asset: "资产", liability: "负债" };

export function BalanceSheetCompositionCard({
  data,
  isFetching,
}: BalanceSheetCompositionCardProps) {
  const { masked } = useMask();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const sideParam = searchParams.get("side");
  const side: Side = sideParam === "liability" ? "liability" : "asset";
  const groupParam = searchParams.get("group");

  const sideGroups = useMemo(
    () => data.groups.filter((g) => g.side === side),
    [data.groups, side],
  );
  const groupExists = groupParam !== null && sideGroups.some((g) => g.key === groupParam);
  const activeGroup = useMemo(
    () => (groupExists ? sideGroups.find((g) => g.key === groupParam) ?? null : null),
    [groupExists, groupParam, sideGroups],
  );

  // 非法 side / 失效 group：静默回退并清理 URL（§6.3）
  useEffect(() => {
    if (sideParam !== null && sideParam !== "asset" && sideParam !== "liability") {
      const params = new URLSearchParams(searchParams);
      params.delete("side");
      setSearchParams(params, { replace: true });
      return;
    }
    if (groupParam !== null && !groupExists) {
      const params = new URLSearchParams(searchParams);
      params.delete("group");
      setSearchParams(params, { replace: true });
    }
  }, [sideParam, groupParam, groupExists, searchParams, setSearchParams]);

  // per-side 筛选 buckets + Other 展开状态（scope 切换即折叠）
  const [filters, setFilters] = useState<Record<Side, SelectionState>>({
    asset: { kind: "all" },
    liability: { kind: "all" },
  });
  const [otherState, setOtherState] = useState<{ scope: string; expanded: boolean }>({
    scope: "",
    expanded: false,
  });
  const otherScope = `${side}:${activeGroup?.key ?? "top"}`;
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
      setOtherState({ scope: "", expanded: false }); // 筛选变化 → Other 折叠
    },
    [side],
  );

  // §6.4：side toggle / as_of change → Other expanded 重置。
  // 用原始字符串做依赖，避免同 key 后台 refetch（对象身份变化）误重置。
  useEffect(() => {
    setOtherState({ scope: "", expanded: false });
  }, [side, data.balance_as_of]);
  const handleFilterReset = useCallback(() => {
    setFilters((prev) => ({ ...prev, [side]: { kind: "all" } }));
    setOtherState({ scope: "", expanded: false });
  }, [side]);

  const selection = filters[side];
  const filtered = selection.kind === "include";

  const model = useMemo(
    () =>
      deriveBalanceSheetComposition({
        data,
        side,
        groupKey: activeGroup?.key ?? null,
        selection,
      }),
    [data, side, activeGroup, selection],
  );

  // ---- 下钻导航与焦点闭环 ----
  const backRef = useRef<HTMLButtonElement>(null);
  const lastGroupTitleRef = useRef<string>("");

  const switchSide = (next: Side) => {
    if (next === side) return;
    const params = new URLSearchParams(searchParams);
    if (next === "asset") params.delete("side");
    else params.set("side", next);
    params.delete("group"); // side 切换重置 group（§6.3）
    setSearchParams(params, { replace: true });
  };

  const enterGroup = (key: string, title: string) => {
    lastGroupTitleRef.current = title;
    const params = new URLSearchParams(searchParams);
    params.set("group", key);
    // push 一个带 location state 标记的 history entry（§6.3）
    navigate(`?${params.toString()}`, { state: { compositionDrill: true } });
  };

  const exitGroup = useCallback(() => {
    const title = lastGroupTitleRef.current;
    if ((location.state as { compositionDrill?: boolean } | null)?.compositionDrill) {
      navigate(-1);
    } else {
      const params = new URLSearchParams(searchParams);
      params.delete("group");
      setSearchParams(params, { replace: true }); // 直接打开/刷新的 group URL：replace 清参数
    }
    // 返回后焦点移回原 group 行
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLButtonElement>(
        `button[aria-label="查看${title}构成明细"]`,
      );
      row?.focus();
    });
  }, [location.state, navigate, searchParams, setSearchParams]);

  // 进入 drill：焦点移到返回按钮
  useEffect(() => {
    if (activeGroup) backRef.current?.focus();
  }, [activeGroup]);

  // Esc 退出 drill（有 dialog 打开时让 dialog 处理）
  useEffect(() => {
    if (!activeGroup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      exitGroup();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeGroup, exitGroup]);

  // ---- 筛选树 ----
  const filterOptions = useMemo<FilterOption[]>(() => {
    const tree: FilterOption[] = sideGroups.map((g) => ({
      key: g.key,
      label: g.title,
      children: g.accounts.map((a) => ({ key: a.id, label: a.name })),
    }));
    if (selection.kind === "include") {
      const existing = new Set(tree.flatMap((g) => g.children?.map((c) => c.key) ?? []));
      for (const key of selection.keys) {
        if (!existing.has(key)) {
          // 已选但当前数据不存在：保留并显示禁用项，避免隐藏筛选（§6.2）
          tree.push({ key, label: key, disabled: true });
        }
      }
    }
    return tree;
  }, [sideGroups, selection]);

  // ---- 派生渲染 ----
  const subjectLabel = SIDE_LABEL[side];
  const currency = data.base_currency;
  const caption = `截至 ${formatDateCn(data.balance_as_of)}${filtered ? " · 已筛选" : ""}`;

  const toSlices = (items: CompositionItem[], otherAmountText: string | null, otherValue: number | null): CompositionDonutSlice[] => {
    const slices: CompositionDonutSlice[] = items.map((item) => ({
      key: item.key,
      label: item.label,
      amountText: item.amountText,
      value: decToNumber(item.amount),
      color: compositionColor(item.colorIndex),
    }));
    if (otherAmountText !== null && otherValue !== null) {
      slices.push({
        key: "__other__",
        label: "其他",
        amountText: otherAmountText,
        value: otherValue,
        color: compositionColor(-1),
      });
    }
    return slices;
  };

  const actionFor = (item: RankingItem): RowAction => {
    if (!activeGroup) {
      // 顶层 group 行：两个 side 均支持下钻（冻结决定）；Donut 不导航。
      const group = sideGroups.find((g) => g.key === item.key);
      if (group) {
        return {
          kind: "button",
          onActivate: () => enterGroup(group.key, group.title),
          ariaLabel: `查看${group.title}构成明细`,
        };
      }
    }
    return { kind: "none" }; // account 行 V1 只读
  };

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
          className={`${ BASE_SEGMENTEDITEM }${ side === "asset" ? ` ${ SEGMENTEDITEM_ISACTIVE }` : "" }`}
          aria-pressed={side === "asset"}
          onClick={() => switchSide("asset")}
        >
          资产
        </button>
        <button
          type="button"
          className={`${ BASE_SEGMENTEDITEM }${ side === "liability" ? ` ${ SEGMENTEDITEM_ISACTIVE }` : "" }`}
          aria-pressed={side === "liability"}
          onClick={() => switchSide("liability")}
        >
          负债
        </button>
      </div>
      <CompositionFilterControl
        ariaLabel={`筛选${subjectLabel}账户`}
        options={filterOptions}
        selection={selection}
        onChange={handleFilterChange}
        onReset={handleFilterReset}
        disabled={isFetching}
      />
    </>
  );

  const context = activeGroup ? (
    <div className="comp-breadcrumb">
      <button ref={backRef} type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] bg-transparent border-transparent text-[var(--text-muted)] hover:text-[var(--text-body)]" onClick={exitGroup}>
        <ChevronLeft size={15} aria-hidden="true" /> 返回{subjectLabel}构成
      </button>
      <span className="comp-breadcrumb-current" aria-current="page">
        {activeGroup.title}
      </span>
    </div>
  ) : (
    <span className="comp-context-caption">{caption}</span>
  );

  let chartSlot: React.ReactNode;
  let rankingSlot: React.ReactNode;
  let childrenSlot: React.ReactNode;
  let footer: React.ReactNode = null;

  if (model.status === "ready") {
    const slices = toSlices(
      model.items,
      model.other?.amountText ?? null,
      model.other ? decToNumber(model.other.amount) : null,
    );
    const centerLabel = filtered
      ? `已筛选${activeGroup ? activeGroup.title : subjectLabel}正项合计`
      : `${activeGroup ? activeGroup.title : subjectLabel === "资产" ? "正资产" : subjectLabel}合计`;
    chartSlot = (
      <CompositionDonut
        slices={slices}
        centerAmount={model.grossText}
        centerLabel={centerLabel}
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
          title="冲减项（负余额）"
          offsets={model.offsets}
          grossText={model.grossText}
          offsetTotalText={model.offsetTotalText}
          netText={model.netText}
          grossLabel="正向合计"
          netLabel="净额"
          currency={currency}
        />
      );
    }
  } else if (model.status === "offset-only") {
    childrenSlot = (
      <EmptyState
        title="无正向构成"
        description="当前范围只有负向冲减项，无构成占比可展示。"
      />
    );
    footer = (
      <CompositionOffsetBlock
        title="冲减项（负余额）"
        offsets={model.offsets}
        grossText={model.grossText}
        offsetTotalText={model.offsetTotalText}
        netText={model.netText}
        grossLabel="正向合计"
        netLabel="净额"
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
      />
    );
  } else if (model.status === "contract-blocked") {
    // amount-only 披露，无百分比
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
      // 未下钻时日期已由环图 figcaption 展示，标题下不再重复；下钻后这里是面包屑。
      context={activeGroup ? context : undefined}
      chart={chartSlot}
      ranking={rankingSlot}
      busy={isFetching}
      footer={footer}
    >
      {childrenSlot}
    </CompositionCard>
  );
}

/** Composition 卡骨架（页面 initial pending 时使用）。 */
export function BalanceSheetCompositionSkeleton() {
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

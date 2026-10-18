import type { ReactNode } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { Amount, SignedAmount } from "../Amount";
import { compositionColor } from "../../utils/chartOptions";
import type { PercentageContext, ZeroItem } from "../../utils/compositionSeries";
import { BASE_COMPRANKACTIONICON, COMPRANKACTIONICON_ISOPEN } from "../../utils/legacyClasses";

/**
 * 构成分析 Ranking（spec §7.4）：canvas Donut 的 DOM 等价面。
 * - Group 下钻与 Transactions 跳转的唯一权威交互入口（整行是 button / 真实 <a>）；
 * - Other 行只展开/收起子行，不改变 Donut 几何（父组件持有 expanded state）；
 * - 组件不持有业务 side/group state；amount-only 披露通过 showPercentages=false
 *   的展示分支渲染，不暴露 source/mode 业务 flag。
 */
export type RowAction =
  | { kind: "link"; href: string; ariaLabel: string }
  | { kind: "button"; onActivate: () => void; ariaLabel: string }
  | { kind: "none" };

export interface RankingItem {
  key: string;
  label: string;
  amountText: string;
  /** 仅正常构成路径提供；amount-only 披露行没有。 */
  percentage?: number;
  colorIndex?: number;
  negative?: boolean;
}

export interface CompositionRankingProps {
  items: RankingItem[];
  other: {
    amountText: string;
    percentage: number;
    children: RankingItem[];
  } | null;
  zeroItems?: ZeroItem[];
  otherExpanded: boolean;
  onToggleOther: () => void;
  actionFor: (item: RankingItem) => RowAction;
  currency: string;
  percentageContext: PercentageContext;
  /** amount-only（contract-blocked）披露时为 false：不输出任何百分比。 */
  showPercentages?: boolean;
}

function AmountCell({ item, currency }: { item: RankingItem; currency: string }) {
  return item.negative ? (
    <SignedAmount value={item.amountText} currency={currency} />
  ) : (
    <Amount value={item.amountText} currency={currency} />
  );
}

function RowShell({
  action,
  children,
  className,
}: {
  action: RowAction;
  children: ReactNode;
  className?: string;
}) {
  if (action.kind === "link") {
    return (
      <a className={`comp-rank-row comp-rank-actionable flex w-full items-center gap-[var(--space-2)] min-h-11 rounded-[var(--radius-sm,_8px)] bg-transparent px-[var(--space-1)] py-[var(--space-2)] text-left text-inherit no-underline [font:var(--type-body)] transition-none hover:bg-[var(--surface-hover)] ${className ?? ""}`} href={action.href} aria-label={action.ariaLabel}>
        {children}
        <ArrowUpRight className="text-[var(--text-placeholder)] flex-none transition-none" size={16} aria-hidden="true" />
      </a>
    );
  }
  if (action.kind === "button") {
    return (
      <button
        type="button"
        className={`comp-rank-row comp-rank-actionable flex w-full items-center gap-[var(--space-2)] min-h-11 rounded-[var(--radius-sm,_8px)] bg-transparent px-[var(--space-1)] py-[var(--space-2)] text-left text-inherit [font:var(--type-body)] transition-none hover:bg-[var(--surface-hover)] ${className ?? ""}`}
        aria-label={action.ariaLabel}
        onClick={action.onActivate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            // jsdom 不把 keydown 合成 click；preventDefault 防止真实浏览器双触发。
            e.preventDefault();
            action.onActivate();
          }
        }}
      >
        {children}
        <ChevronRight className="text-[var(--text-placeholder)] flex-none transition-none" size={16} aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className={`comp-rank-row flex w-full items-center gap-[var(--space-2)] min-h-11 rounded-[var(--radius-sm,_8px)] bg-transparent px-[var(--space-1)] py-[var(--space-2)] text-left text-inherit [font:var(--type-body)] transition-none ${className ?? ""}`}>{children}</div>
  );
}

function RankRow({
  index,
  item,
  actionFor,
  currency,
  showPercentage,
  contextSuffix,
}: {
  index: number;
  item: RankingItem;
  actionFor: (item: RankingItem) => RowAction;
  currency: string;
  showPercentage: boolean;
  contextSuffix: string;
}) {
  const action = actionFor(item);
  const color = compositionColor(item.colorIndex ?? -1);
  return (
    <li className="comp-rank-item flex flex-col">
      <RowShell action={action}>
        <span className="comp-rank-index min-w-[18px] text-[var(--text-faint)] [font:var(--type-caption)] [font-variant-numeric:tabular-nums] text-right" aria-hidden="true">{index}</span>
        <span className="comp-rank-dot w-2 h-2 rounded-full flex-none" style={{ background: color }} aria-hidden="true" />
        <span className="comp-rank-label flex-1 min-w-0 overflow-hidden [text-overflow:ellipsis] whitespace-nowrap max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere] [.comp-rank-zero_&]:not-italic" title={item.label}>{item.label}</span>
        <span className="[font-variant-numeric:tabular-nums] whitespace-nowrap">
          <AmountCell item={item} currency={currency} />
        </span>
        {showPercentage && item.percentage !== undefined ? (
          <span className="comp-rank-pct min-w-[52px] text-right text-[var(--text-faint)] [font:var(--type-caption)] [font-variant-numeric:tabular-nums]" title={`占${contextSuffix}`}>
            {item.percentage.toFixed(1)}%
          </span>
        ) : null}
      </RowShell>
      {showPercentage && item.percentage !== undefined ? (
        <span className="comp-rank-bar h-1 mt-0 mr-[var(--space-1)] mb-0.5 ml-[calc(18px_+_var(--space-2)_+_8px_+_var(--space-2))] bg-[var(--surface-subtle)] rounded-full overflow-hidden block max-sm:ml-[var(--space-1)]" aria-hidden="true">
          <span className="comp-rank-bar-fill block h-full rounded-full transition-none" style={{ width: `${item.percentage}%`, background: color }} />
        </span>
      ) : null}
    </li>
  );
}

export function CompositionRanking({
  items,
  other,
  zeroItems = [],
  otherExpanded,
  onToggleOther,
  actionFor,
  currency,
  percentageContext,
  showPercentages = true,
}: CompositionRankingProps) {
  const contextSuffix = percentageContext === "filtered" ? "当前筛选范围" : "总计";
  const startIndex = 1;
  let otherIndex = startIndex + items.length;

  return (
    <ol className="comp-ranking list-none m-0 p-0 flex flex-col">
      {items.map((item, i) => (
        <RankRow
          key={item.key}
          index={startIndex + i}
          item={item}
          actionFor={actionFor}
          currency={currency}
          showPercentage={showPercentages}
          contextSuffix={contextSuffix}
        />
      ))}

      {other ? (
        (() => {
          const index = otherIndex;
          otherIndex += 1;
          return (
            <li className="comp-rank-item flex flex-col">
              <button
                type="button"
                className="comp-rank-other flex items-center gap-[var(--space-2)] w-full min-h-11 py-[var(--space-2)] px-[var(--space-1)] bg-transparent border-0 rounded-[var(--radius-sm,_8px)] text-left no-underline text-inherit [font:var(--type-body)] transition-none cursor-pointer max-sm:min-h-12 [.comp-rank-zero_&]:text-[var(--text-placeholder)] hover:bg-[var(--surface-hover)]"
                aria-expanded={otherExpanded}
                onClick={onToggleOther}
              >
                <span className="comp-rank-index min-w-[18px] text-[var(--text-faint)] [font:var(--type-caption)] [font-variant-numeric:tabular-nums] text-right" aria-hidden="true">{index}</span>
                <span className="comp-rank-dot comp-rank-dot-other w-2 h-2 rounded-full flex-none bg-[var(--data-neutral)]" aria-hidden="true" />
                <span className="comp-rank-label flex-1 min-w-0 overflow-hidden [text-overflow:ellipsis] whitespace-nowrap max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere] [.comp-rank-zero_&]:not-italic" title="其他">其他</span>
                <span className="[font-variant-numeric:tabular-nums] whitespace-nowrap">
                  <Amount value={other.amountText} currency={currency} />
                </span>
                {showPercentages ? (
                  <span className="comp-rank-pct min-w-[52px] text-right text-[var(--text-faint)] [font:var(--type-caption)] [font-variant-numeric:tabular-nums]" title={`占${contextSuffix}`}>
                    {other.percentage.toFixed(1)}%
                  </span>
                ) : null}
                <ChevronDown
                  className={`${ BASE_COMPRANKACTIONICON }${ otherExpanded ? ` ${ COMPRANKACTIONICON_ISOPEN }` : "" }`}
                  size={16}
                  aria-hidden="true"
                />
              </button>
              {showPercentages ? (
                <span className="comp-rank-bar h-1 mt-0 mr-[var(--space-1)] mb-0.5 ml-[calc(18px_+_var(--space-2)_+_8px_+_var(--space-2))] bg-[var(--surface-subtle)] rounded-full overflow-hidden block max-sm:ml-[var(--space-1)]" aria-hidden="true">
                  <span
                    className="comp-rank-bar-fill comp-rank-bar-other block h-full rounded-full transition-none bg-[var(--data-neutral)]"
                    style={{ width: `${other.percentage}%` }}
                  />
                </span>
              ) : null}
              {otherExpanded ? (
                <ul className="comp-rank-children list-none m-0 ml-[calc(18px_+_var(--space-2))] pl-[var(--space-2)] border-l-[1px] border-l-solid border-l-[var(--divider)]">
                  {other.children.map((child, i) => (
                    <RankRow
                      key={child.key}
                      index={i + 1}
                      item={child}
                      actionFor={actionFor}
                      currency={currency}
                      showPercentage={showPercentages}
                      contextSuffix={contextSuffix}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })()
      ) : null}

      {zeroItems.map((z) => (
        <li key={z.key} className="comp-rank-item comp-rank-zero flex flex-col">
          <div className="comp-rank-row flex items-center gap-[var(--space-2)] w-full min-h-11 py-[var(--space-2)] px-[var(--space-1)] bg-transparent border-0 rounded-[var(--radius-sm,_8px)] text-left no-underline text-inherit [font:var(--type-body)] transition-none cursor-pointer max-sm:min-h-12 [.comp-rank-zero_&]:text-[var(--text-placeholder)]">
            <span className="comp-rank-index min-w-[18px] text-[var(--text-faint)] [font:var(--type-caption)] [font-variant-numeric:tabular-nums] text-right" aria-hidden="true">—</span>
            <span className="comp-rank-dot comp-rank-dot-zero w-2 h-2 rounded-full flex-none bg-[var(--surface-subtle)]" aria-hidden="true" />
            <span className="comp-rank-label flex-1 min-w-0 overflow-hidden [text-overflow:ellipsis] whitespace-nowrap max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere] [.comp-rank-zero_&]:not-italic" title={z.label}>{z.label}</span>
            <span className="[font-variant-numeric:tabular-nums] whitespace-nowrap">
              <Amount value={z.amountText} currency={currency} />
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

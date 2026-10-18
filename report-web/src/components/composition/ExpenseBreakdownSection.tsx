import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useExpenseBreakdown } from "../../api/hooks";
import type { ReportEnvelope, ReportSectionRow } from "../../api/types";
import { Amount } from "../Amount";
import { BASE_CARD } from "../../utils/legacyClasses";
import { EmptyState } from "../EmptyState";
import { SkeletonBlock, SkeletonLine } from "../Skeleton";
import { WarningBanner } from "../StatusBanner";
import { formatDateCn } from "../../utils/dates";

/**
 * 费用分析分区（IncomeExpense 页）：Top N 费用分类 + 同期环比。
 *
 * 与「构成分析卡」的区别（二者并列，不可互相替代）：
 * - 构成分析卡：消费 income-statement 的 expenses 节，是**全量**分类构成，用于对账；
 * - 本分区：消费 expense-breakdown，是 **Top N 截断**视图，带环比/占比/笔数。
 *
 * 由于是截断视图，本表**严禁用于对账**——勾稽只允许取 income-statement
 * 的 expenses 节（见 utils/waterfallReconciliation.ts R-D15）。文案必须明示。
 */

export interface ExpenseBreakdownSectionProps {
  startDate: string;
  endDate: string;
  compareStartDate?: string;
  compareEndDate?: string;
  topN?: number;
}

/** 后端 extra 契约（expense_breakdown.py:144-151）。 */
interface RowExtra {
  compare_amount?: string | null;
  change?: string | null;
  change_pct?: string | null;
  new_spend?: boolean;
  share_pct?: string | null;
  fx_converted?: boolean;
}

function extra(row: ReportSectionRow): RowExtra {
  return (row.extra ?? {}) as RowExtra;
}

/** 环比文案：新增支出不显示变化率（后端返回 null，避免 Infinity）。 */
function changeLabel(row: ReportSectionRow): { text: string; tone: string } {
  const e = extra(row);
  if (e.new_spend) return { text: "新增", tone: "text-[var(--text-secondary)]" };
  if (e.change_pct === null || e.change_pct === undefined) {
    return { text: "—", tone: "text-[var(--text-caption)]" };
  }
  // 仅用于着色判断（正/负/持平），不做金额运算，Number() 足够。
  const pct = Number(e.change_pct);
  if (!Number.isFinite(pct)) return { text: "—", tone: "text-[var(--text-caption)]" };
  const up = pct > 0;
  const flat = pct === 0;
  return {
    text: `${up ? "+" : ""}${e.change_pct}%`,
    tone: flat
      ? "text-[var(--text-secondary)]"
      : up
        ? "text-[var(--delta-negative)]"
        : "text-[var(--delta-positive)]",
  };
}

export function ExpenseBreakdownSection({
  startDate,
  endDate,
  compareStartDate,
  compareEndDate,
  topN = 10,
}: ExpenseBreakdownSectionProps) {
  const q = useExpenseBreakdown({
    startDate,
    endDate,
    compareStartDate,
    compareEndDate,
    topN,
  });

  const data = q.data as ReportEnvelope | undefined;
  const section = useMemo(
    () => data?.sections?.find((s) => s.key === "top_expenses"),
    [data],
  );
  const rows = section?.rows ?? [];
  const summary = data?.summary ?? {};
  const hasCompare = Boolean(compareStartDate && compareEndDate);
  const comparePeriod = summary.compare_period as
    | { start_date: string; end_date: string }
    | null
    | undefined;
  const globalRanking = summary.global_ranking_available !== false;
  const topNValue = Number(summary.top_n ?? topN);

  return (
    <section
      id="expense-breakdown"
      className={`${BASE_CARD} expense-breakdown-section scroll-mt-20`}
      aria-label="费用分析"
    >
      <header className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-4)] min-h-7 max-[479px]:flex-wrap">
        <h2 className="card-title m-0 [font:var(--type-section-title)] text-[var(--foreground)]">
          费用分析
        </h2>
        <p className="m-0 text-[var(--text-caption)] [font:var(--type-caption)]">
          {hasCompare && comparePeriod
            ? `对比 ${formatDateCn(comparePeriod.start_date)} ~ ${formatDateCn(comparePeriod.end_date)}`
            : "未选择对比期"}
        </p>
      </header>

      {q.isPending ? (
        <div className="flex flex-col gap-[var(--space-2)]">
          <SkeletonLine />
          <SkeletonBlock />
        </div>
      ) : q.isError ? (
        <EmptyState
          title="费用分析加载失败"
          description="请稍后重试，或检查后端服务状态。"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="暂无费用数据"
          description="当前期间没有可分析的支出分类。"
        />
      ) : (
        <>
          {/* 缺汇率降级 + 后端 warning 原文照登：降级原因由后端权威给出，前端不改写。
              WarningBanner 契约是 items: string[]（无 children，items 为空时返回 null）。 */}
          <WarningBanner
            items={[
              ...(globalRanking
                ? []
                : ["缺少汇率，已按币种分别排名（不做跨币种全局排序）。"]),
              ...(data?.warnings ?? []),
              ...(data && !data.data_complete
                ? ["数据不完整：部分金额未折算为人民币。"]
                : []),
            ]}
          />

          <div className="overflow-x-auto">
            <table className="data-table w-full [font:var(--type-body)]">
              <caption className="sr-only">
                前 {topNValue} 大费用分类
                {hasCompare ? "与对比期的金额、变化与占比" : "的金额与占比"}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="text-left">分类</th>
                  <th scope="col" className="text-right">本期</th>
                  {hasCompare && (
                    <th scope="col" className="text-right">环比</th>
                  )}
                  <th scope="col" className="text-right">占比</th>
                  <th scope="col" className="text-right">笔数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const change = changeLabel(row);
                  const share = extra(row).share_pct;
                  const href =
                    `/data/transactions?start=${startDate}&end=${endDate}` +
                    `&report_side=expense&report_category=${encodeURIComponent(row.label)}`;
                  return (
                    <tr key={`${row.label}-${row.currency}`}>
                      <th scope="row" className="text-left font-normal">
                        <Link
                          to={href}
                          className="text-[var(--foreground)] no-underline hover:underline"
                        >
                          {row.label}
                        </Link>
                        {row.currency !== "CNY" && (
                          <span className="ml-1 text-[var(--text-caption)] [font:var(--type-caption)]">
                            {row.currency}
                          </span>
                        )}
                      </th>
                      <td className="is-num text-right [font-variant-numeric:tabular-nums]">
                        {row.amount_base === null ? (
                          <span title="交易日前无可用汇率，未折算">汇率缺失</span>
                        ) : (
                          <Amount value={row.amount_base} currency="CNY" />
                        )}
                      </td>
                      {hasCompare && (
                        <td
                          className={`is-num text-right [font-variant-numeric:tabular-nums] ${change.tone}`}
                        >
                          {change.text}
                        </td>
                      )}
                      <td className="is-num text-right [font-variant-numeric:tabular-nums]">
                        {share === null || share === undefined
                          ? "—"
                          : `${share}%`}
                      </td>
                      <td className="is-num text-right [font-variant-numeric:tabular-nums]">
                        {row.count ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="m-0 mt-[var(--space-3)] text-[var(--text-caption)] [font:var(--type-caption)]">
            前 {topNValue} 大费用（共 {String(summary.candidate_categories ?? rows.length)} 个分类候选）；
            Top N 为截断视图，<strong className="font-semibold">不可用于对账</strong>
            ——勾稽请以收支表 expenses 节为准。
          </p>
        </>
      )}
    </section>
  );
}

/**
 * ALIGN-10 / REL-05：报表页脚新鲜度呈现。每个报表页底部渲染一次。
 *
 * 两类后端新鲜度字段语义不同，分别呈现、不得互相顶替：
 * - `generatedAt`：数据生成/检查瞬间（generated_at / checked_at）
 *   → "数据生成时间: 2026-08-18 16:30 (Europe/Berlin)"
 * - `asOf`：日历日槽位，喂的是「数据覆盖到哪一天」——估值/业务日历日
 *   （balance_as_of / as_of），或 transactions 这类无 instant 端点的查询区间止日
 *   （period_to，见 DATA-03：契约里没有 generated_at，不得为幽灵字段留空位）
 *   → "数据截止: 2026-08-18"（纯日历日，绝不臆造时分）
 *
 * 两者皆缺（或端点不携带时间戳）→ "—"。格式化统一走 utils/timestamps.ts。
 * 页脚只输出时间信息：遮蔽模式下同样不渲染任何金额。
 */

import { formatCalendarDate, formatTimestampBerlin } from "../utils/timestamps";

interface ReportTimestampFooterProps {
  /** ISO 8601 瞬间（带时区），来自后端 generated_at / checked_at */
  generatedAt?: string | null;
  /**
   * ISO 日历日 YYYY-MM-DD：估值/业务日（as_of / balance_as_of）；
   * TransactionsPage 喂 period_to（查询区间止日）——同一槽位的合法来源，勿改回幽灵字段。
   */
  asOf?: string | null;
}

export function ReportTimestampFooter({ generatedAt, asOf }: ReportTimestampFooterProps) {
  const segments: string[] = [];
  const instant = formatTimestampBerlin(generatedAt);
  if (instant !== "—") segments.push(`数据生成时间: ${instant} (Europe/Berlin)`);
  const businessDate = formatCalendarDate(asOf);
  if (businessDate !== "—") segments.push(`数据截止: ${businessDate}`);

  return (
    <footer className="report-timestamp-footer font-[var(--font-family-mono)] text-[12px] leading-[18px] text-[var(--text-faint)] text-center pt-[var(--space-6)] px-0 pb-[var(--space-4)]" data-testid="report-timestamp-footer">
      {segments.length ? segments.join(" · ") : "—"}
    </footer>
  );
}

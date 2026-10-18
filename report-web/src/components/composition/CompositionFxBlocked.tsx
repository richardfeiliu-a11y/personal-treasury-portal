import { Amount } from "../Amount";
import type { FxDisclosureRow } from "../../utils/compositionSeries";

/**
 * FX Fail Closed 面板（spec §7.7）：两页统一。
 * - 无 Donut、无 center、无 percentage；
 * - Balance rows 保持 group/account 顺序；Flow rows 已按 currency 分组排序；
 * - baseAmount 为 null 时显示调用方提供的口径文案（Balance「缺汇率」/
 *   Flow「报表汇率不完整，未提供折算」）；
 * - 金额走 Amount，自动响应 masking。
 */
export interface CompositionFxBlockedProps {
  subjectLabel: string; // 资产 / 负债 / 支出 / 收入
  rows: FxDisclosureRow[];
  missingCurrencies: string[];
  baseCurrency: string;
  /** baseAmount 为 null 时的单元格文案；默认「缺汇率」。 */
  baseMissingText?: string;
  /** missingCurrencies 为空时的后端 warning 摘要。 */
  fallbackNote?: string;
}

export function CompositionFxBlocked({
  subjectLabel,
  rows,
  missingCurrencies,
  baseCurrency,
  baseMissingText = "缺汇率",
  fallbackNote,
}: CompositionFxBlockedProps) {
  return (
    <div className="comp-fx-blocked flex flex-col gap-[var(--space-3)]" role="status">
      <p className="m-0 [font:var(--type-body)] font-semibold text-[var(--text-body)]">汇率不完整，暂无法计算完整{subjectLabel}构成占比</p>
      <table className="comp-fx-table w-full border-collapse [font:var(--type-caption)] [&_th]:text-left [&_th]:text-[var(--text-faint)] [&_th]:font-medium [&_th]:py-[var(--space-1)] [&_th]:px-[var(--space-2)] [&_th]:border-b [&_th]:border-b-[var(--border-soft)] [&_td]:p-[var(--space-2)] [&_td]:border-b [&_td]:border-b-[var(--border-soft)] [&_td]:text-[var(--text-muted)] [&_td]:[font-variant-numeric:tabular-nums]">
        <thead>
          <tr>
            <th scope="col">分组</th>
            <th scope="col">项目</th>
            <th scope="col">币种</th>
            <th scope="col">原币金额</th>
            <th scope="col">折{baseCurrency}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.groupLabel ?? "—"}</td>
              <td>{row.label}</td>
              <td>{row.currency}</td>
              <td className="comp-fx-amount">
                <Amount value={row.nativeAmount} currency={row.currency} />
              </td>
              <td className="comp-fx-amount">
                {row.baseAmount !== null ? (
                  <Amount value={row.baseAmount} currency={baseCurrency} />
                ) : (
                  <span className="text-[var(--danger-600)]">{baseMissingText}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-[var(--text-faint)] [font:var(--type-caption)]">
        {missingCurrencies.length > 0
          ? `缺失币种：${missingCurrencies.join("、")}`
          : (fallbackNote ?? "报表已按原币保留金额，暂无法折算合计。")}
      </p>
    </div>
  );
}

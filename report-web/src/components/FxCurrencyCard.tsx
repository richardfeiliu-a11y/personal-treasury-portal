import type { FxAttributionRow } from "../api/types";
import { formatNumber } from "../utils/format";
import { Amount } from "./Amount";

interface FxCurrencyCardProps {
  row: FxAttributionRow;
  baseCurrency: string;
}

function AmountRow({ label, value, currency }: { label: string; value: string; currency: string }) {
  return (
    <div className="fx-currency-row flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
      <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">{label}</span>
      <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]"><Amount value={value} currency={currency} /></span>
    </div>
  );
}

/** 汇率归因移动卡片：直接读取 API 行，不拥有或转换页面数据。 */
export function FxCurrencyCard({ row, baseCurrency }: FxCurrencyCardProps) {
  return (
    <li className="bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl py-3.5 px-4 flex flex-col gap-2.5 shadow-[var(--shadow-sm)] max-sm:min-w-0 max-sm:max-w-full m-0">
      <div className="flex items-center justify-between gap-2 border-b border-b-[var(--border-soft)] pb-2.5 cursor-default [.income-top-card_&]:mb-0 justify-start">
        <h3 className="m-0 text-[var(--text-strong)] [font:var(--type-section-title)]">{row.currency}</h3>
      </div>
      <div className="fx-currency-card-body flex flex-col gap-2">
        <AmountRow label="期初余额" value={row.start_balance} currency={row.currency} />
        <AmountRow label="期末余额" value={row.end_balance} currency={row.currency} />
        <AmountRow label="非汇率余额变动贡献" value={row.savings_contribution_cny} currency={baseCurrency} />
        <AmountRow label="汇率贡献" value={row.fx_contribution_cny} currency={baseCurrency} />
        <AmountRow label="净变动" value={row.net_change_cny} currency={baseCurrency} />
      </div>
      <details className="fx-currency-details border-t border-t-[var(--border-soft)] pt-[var(--space-2)] [&_summary]:min-h-[var(--touch-target)] [&_summary]:text-[var(--brand-text)] [&_summary]:cursor-pointer [&_summary]:[font:var(--type-caption)] [&_summary]:font-semibold [&_summary]:leading-[var(--touch-target)]">
        <summary>汇率详情</summary>
        <div className="flex flex-col gap-[var(--space-2)] pt-[var(--space-1)]">
          <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
            <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">期初汇率</span>
            <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">{formatNumber(row.start_rate)}</span>
          </div>
          <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
            <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">期末汇率</span>
            <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">{formatNumber(row.end_rate)}</span>
          </div>
        </div>
      </details>
    </li>
  );
}

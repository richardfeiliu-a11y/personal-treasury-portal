import type { AccountBalanceRow } from "../api/types";
import { isInvestmentAccount } from "../utils/accounts";
import { Amount } from "./Amount";
import { DeepLink } from "./DeepLink";

interface AccountCardProps {
  account: AccountBalanceRow;
  baseCurrency: string;
}

function accountTypeLabel(type: string): string {
  if (type === "asset") return "资产";
  if (type === "liabilities" || type === "liability") return "负债";
  return type;
}

/** 移动端账户卡片：两行 KV 只展示账户事实，不拥有筛选或分页状态。 */
export function AccountCard({ account, baseCurrency }: AccountCardProps) {
  return (
    <article className={`account-card mobile-card-item flex flex-col gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--card)] px-4 py-3.5 shadow-[var(--shadow-sm)] max-sm:max-w-full${account.active ? "" : " opacity-0.7"}`}>
      <div className="account-card-row flex items-center justify-between gap-[var(--space-2)] mb-0.5 max-sm:min-w-0 max-sm:max-w-full w-full items-baseline">
        <div className="min-w-0 flex flex-1 flex-col gap-[var(--space-1)]">
          <span className="account-name account-card-name [display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2] line-clamp-2 text-[14px] font-semibold leading-[20px] [overflow-wrap:anywhere]">{account.name}</span>
          {(!account.active || !account.include_net_worth) && (
            <span className="flex flex-wrap gap-[var(--space-1)]">
              {!account.active && <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)]">停用</span>}
              {!account.include_net_worth && <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)]">不计净资产</span>}
            </span>
          )}
        </div>
        <span className="account-card-value is-num account-card-native-value text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] min-w-0 max-w-[68%] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
          <Amount value={account.balance} currency={account.currency} />
        </span>
      </div>

      <div className="account-card-row flex items-baseline justify-between gap-[var(--space-3)] max-sm:min-w-0 max-sm:max-w-full w-full">
        <span className="account-card-label text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">
          {account.group_title ?? "未分组"} · {accountTypeLabel(account.type)}
        </span>
        <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] min-w-0 max-w-[68%] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
          {account.balance_base !== null ? (
            <Amount value={account.balance_base} currency={baseCurrency} />
          ) : (
            <span className="account-card-fx-missing text-[var(--danger-600)] leading-[18px]">
              {account.currency} 汇率缺失，无法折算 {baseCurrency}
            </span>
          )}
        </span>
      </div>

      {isInvestmentAccount(account) && (
        <DeepLink
          label="在 Invest 中打开"
          accountName={account.name}
        />
      )}
    </article>
  );
}

// 账户页：搜索、筛选、排序（纯函数，便于测试；实施文档 §6.2/§9.2）

import type { AccountBalanceRow } from "../api/types";

export type SortField = "name" | "balance" | "balanceBase";
export type SortDirection = "asc" | "desc";

export interface AccountFilters {
  query: string;
  side: "all" | "asset" | "liability";
  group: string; // "" = 全部；"pending" = 未分组
  currency: string; // "" = 全部
  includeInactive: boolean;
  hideZeroInactive: boolean;
  hideExcludedNetWorth: boolean;
}

export const DEFAULT_FILTERS: AccountFilters = {
  query: "",
  side: "all",
  group: "",
  currency: "",
  includeInactive: false,
  hideZeroInactive: true, // 默认隐藏停用且余额为零的账户
  hideExcludedNetWorth: true,
};

/** 金融账户（资产/负债）。账户页不展示 Firefly 的收支分类账户（expense/revenue）。 */
export function financialAccounts(accounts: AccountBalanceRow[]): AccountBalanceRow[] {
  return accounts.filter((a) => a.type === "asset" || a.type === "liabilities" || a.type === "liability");
}

export function applyFilters(accounts: AccountBalanceRow[], f: AccountFilters): AccountBalanceRow[] {
  const q = f.query.trim().toLowerCase();
  return accounts.filter((a) => {
    if (q && !a.name.toLowerCase().includes(q)) return false;
    if (f.side !== "all") {
      const isLiability = a.type === "liabilities" || a.type === "liability";
      if ((f.side === "asset") === isLiability) return false;
    }
    if (f.group) {
      const actual = a.group ?? "pending";
      if (actual !== f.group) return false;
    }
    if (f.currency && a.currency !== f.currency) return false;
    if (!a.active && !f.includeInactive) return false;
    if (f.hideZeroInactive && !a.active && Number(a.balance) === 0) return false;
    if (f.hideExcludedNetWorth && !a.include_net_worth) return false;
    return true;
  });
}

export function sortAccounts(
  accounts: AccountBalanceRow[],
  field: SortField,
  direction: SortDirection,
): AccountBalanceRow[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...accounts].sort((a, b) => {
    if (field === "name") {
      return a.name.localeCompare(b.name, "zh-CN") * dir;
    }
    if (field === "balanceBase") {
      if (a.balance_base === null && b.balance_base === null) return 0;
      if (a.balance_base === null) return 1;
      if (b.balance_base === null) return -1;
      const av = Number(a.balance_base);
      const bv = Number(b.balance_base);
      return (av - bv) * dir;
    }
    const av = Number(a.balance);
    const bv = Number(b.balance);
    return (av - bv) * dir;
  });
}

export function isInvestmentAccount(account: Pick<AccountBalanceRow, "account_role" | "group">): boolean {
  return account.account_role === "investment" || account.group === "investments";
}

export function uniqueCurrencies(accounts: AccountBalanceRow[]): string[] {
  return [...new Set(accounts.map((a) => a.currency))].sort();
}

export function groupOptions(accounts: AccountBalanceRow[]): { key: string; title: string }[] {
  const map = new Map<string, string>();
  for (const a of accounts) {
    if (a.group && a.group_title) map.set(a.group, a.group_title);
  }
  return [...map.entries()].map(([key, title]) => ({ key, title })).sort((x, y) => x.title.localeCompare(y.title, "zh-CN"));
}

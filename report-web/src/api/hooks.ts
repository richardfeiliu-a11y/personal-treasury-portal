import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

const FIVE_MINUTES = 5 * 60 * 1000;

export function useBalanceSheet(asOf?: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["balance-sheet", asOf ?? "today"],
    queryFn: () => api.balanceSheet(asOf),
    staleTime: FIVE_MINUTES,
    enabled: options?.enabled,
  });
}

export function useNetWorthTrend(asOf?: string, months = 12) {
  return useQuery({
    queryKey: ["net-worth-trend", asOf ?? "today", months],
    queryFn: () => api.netWorthTrend(asOf, months),
    staleTime: FIVE_MINUTES,
  });
}

export function useIncomeStatement(startDate: string, endDate: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["income-statement", startDate, endDate],
    queryFn: () => api.incomeStatement(startDate, endDate),
    staleTime: FIVE_MINUTES,
    enabled: options?.enabled,
  });
}

/** 费用分析（Top N 截断视图，带可选同期环比；不用于对账）。 */
export function useExpenseBreakdown(params: {
  startDate: string;
  endDate: string;
  compareStartDate?: string;
  compareEndDate?: string;
  topN?: number;
}) {
  const {
    startDate, endDate,
    compareStartDate = "", compareEndDate = "",
    topN = 10,
  } = params;
  return useQuery({
    queryKey: [
      "expense-breakdown",
      startDate, endDate, compareStartDate, compareEndDate, topN,
    ],
    queryFn: () => api.expenseBreakdown({
      startDate, endDate, compareStartDate, compareEndDate, topN,
    }),
    staleTime: FIVE_MINUTES,
  });
}

export function useAccountBalances() {
  return useQuery({
    queryKey: ["account-balances"],
    queryFn: () => api.accountBalances(),
    staleTime: FIVE_MINUTES,
  });
}


export function useFxAttribution(fromDate?: string, toDate?: string) {
  return useQuery({
    queryKey: ["fx-attribution", fromDate ?? "", toDate ?? ""],
    queryFn: () => api.fxAttribution(fromDate, toDate),
    staleTime: FIVE_MINUTES,
  });
}

/**
 * UX-02：key 元组必须覆盖全部影响 response 的请求参数——`as_of` 在 client.ts
 * 会真的发给后端，因此必须进 key，否则不同估值日静默共享同一缓存槽。
 */
export function useSpendingTrends(months = 6, asOf?: string) {
  return useQuery({
    queryKey: ["spending-trends", months, asOf ?? ""],
    queryFn: () => api.spendingTrends(months, asOf),
    staleTime: FIVE_MINUTES,
  });
}

export function useCurrencyExposure() {
  return useQuery({
    queryKey: ["currency-exposure"],
    queryFn: () => api.currencyExposure(),
    staleTime: FIVE_MINUTES,
  });
}

export function useTransactions(params: {
  start: string;
  end: string;
  account?: string;
  category?: string;
  txnType?: string;
  reportSide?: "expense" | "income";
  reportCategory?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    // UX-03：limit 与 offset 同样影响 response，缺一即换页/换页大小会命中旧槽。
    queryKey: [
      "transactions", params.start, params.end, params.account ?? "", params.category ?? "",
      params.txnType ?? "", params.reportSide ?? "", params.reportCategory ?? "",
      params.limit ?? 100, params.offset ?? 0,
    ],
    queryFn: () => api.transactions(params),
    staleTime: FIVE_MINUTES,
  });
}

export function useAnomalies() {
  return useQuery({
    queryKey: ["anomalies"],
    queryFn: () => api.anomalies(),
    staleTime: FIVE_MINUTES,
  });
}

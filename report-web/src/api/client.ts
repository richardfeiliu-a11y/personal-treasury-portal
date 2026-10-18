// 只读 API 客户端：全部走 /api 前缀，由 Nginx BFF 网关注入内部 Token。
// 浏览器永远接触不到 BRIDGE_INTERNAL_TOKEN。

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  // 30 秒超时：Bridge 挂起时前端必须进入错误状态（§9.2 API 错误）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(504, "请求超时，请稍后重试。");
    }
    throw new ApiError(0, "网络请求失败，请检查网络连接。");
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 401) {
    throw new ApiError(401, "登录已过期，请刷新页面重新输入用户名和密码。");
  }
  if (!resp.ok) {
    let detail = `请求失败（HTTP ${resp.status}）`;
    try {
      const body = await resp.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* 忽略解析失败 */
    }
    throw new ApiError(resp.status, detail);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  balanceSheet(asOf?: string) {
    return getJson<import("./types").PersonalBalanceSheet>(
      "/api/reports/personal-balance-sheet",
      asOf ? { as_of: asOf } : {},
    );
  },
  netWorthTrend(asOf?: string, months = 12) {
    return getJson<import("./types").NetWorthTrend>("/api/reports/net-worth-trend", {
      as_of: asOf ?? "",
      months: String(months),
    });
  },
  incomeStatement(startDate: string, endDate: string) {
    // V1（spec §5.2）：income statement summary 契约收紧为 IncomeStatementSummary。
    return getJson<import("./types").ReportEnvelope<import("./types").IncomeStatementSummary>>(
      "/api/reports/income-statement", {
      start_date: startDate,
      end_date: endDate,
      accounting_view: "management",
    });
  },
  accountBalances() {
    return getJson<import("./types").AccountBalances>("/api/reports/account-balances");
  },
  fxAttribution(fromDate?: string, toDate?: string) {
    return getJson<import("./types").FxAttribution>("/api/reports/web/fx-attribution", {
      from_date: fromDate ?? "",
      to_date: toDate ?? "",
    });
  },
  spendingTrends(months = 6, asOf?: string) {
    return getJson<import("./types").SpendingTrends>("/api/reports/web/spending-trends", {
      months: String(months),
      ...(asOf ? { as_of: asOf } : {}),
    });
  },
  currencyExposure() {
    return getJson<import("./types").CurrencyExposure>("/api/reports/web/currency-exposure");
  },
  transactions(params: {
    start: string;
    end: string;
    account?: string;
    category?: string;
    txnType?: string;
    /** V1 management 报表口径深链：成对提供时后端启用 report filter（与既有筛选交集）。 */
    reportSide?: "expense" | "income";
    reportCategory?: string;
    limit?: number;
    offset?: number;
  }) {
    return getJson<import("./types").Transactions>("/api/reports/web/transactions", {
      start: params.start,
      end: params.end,
      account: params.account ?? "",
      category: params.category ?? "",
      txn_type: params.txnType ?? "",
      report_side: params.reportSide ?? "",
      report_category: params.reportCategory ?? "",
      limit: String(params.limit ?? 100),
      offset: String(params.offset ?? 0),
    });
  },
  /**
   * 费用分析表（Top N + 可选同期对比）。
   * 注意：Top N 为截断视图，**不可用于对账**——勾稽只允许取 income-statement
   * 的 expenses 节（见 utils/waterfallReconciliation.ts）。
   */
  expenseBreakdown(params: {
    startDate: string;
    endDate: string;
    compareStartDate?: string;
    compareEndDate?: string;
    topN?: number;
  }) {
    return getJson<import("./types").ReportEnvelope>(
      "/api/reports/expense-breakdown", {
      start_date: params.startDate,
      end_date: params.endDate,
      compare_start_date: params.compareStartDate ?? "",
      compare_end_date: params.compareEndDate ?? "",
      top_n: String(params.topN ?? 10),
      accounting_view: "management",
    });
  },
  anomalies() {
    return getJson<import("./types").Anomalies>("/api/reports/web/anomalies");
  },
};

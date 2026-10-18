/**
 * WP06 财务显示契约（遮蔽泄露 + 精度 + 错误隔离）。
 *
 * 三类断言：
 * 1. 遮蔽模式：正文/title/tooltip/aria-label 全出口不得泄露合成金额；
 * 2. 精度：金融聚合走 Decimal（BigInt 定点），不依赖 Number 浮点；
 * 3. 错误隔离：单接口失败显示局部失败与重试，不清空其他区块、
 *    不以「暂无交易/暂无」掩盖失败。
 *
 * 全部使用独特合成金额（12345.67 / 6789.01 / 10000000000000001），
 * 任何泄露都会被精确断言捕获；不使用真实账簿数据。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { HomePage } from "../features/home/HomePage";
import { IncomeExpensePage } from "../pages/IncomeExpense";
import { AttributionBar } from "../components/AttributionBar";
import { AppHeaderProvider } from "../components/AppHeader";
import { MaskProvider } from "../components/MaskContext";

vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  nwTrendOption: () => ({}),
  monthlyBarOption: () => ({}),
}));

const SYNTHETIC_A = "12345.67"; // 归因总额/储蓄贡献
const SYNTHETIC_B = "6789.01"; // 汇率贡献/上期金额

const BALANCE = {
  schema_version: "1.0", source: "firefly_live",
  generated_at: "2026-08-09T10:00:00+00:00", base_currency: "CNY",
  balance_as_of: "2026-08-09", fx_complete: true, missing_currencies: [], warnings: [],
  summary: {
    total_assets_base: "22345.67", total_liabilities_base: "0",
    net_worth_base: "22345.67", included_account_count: 2, pending_mapping_count: 0,
  },
  groups: [{
    key: "cash", title: "现金", side: "asset" as const, subtotal_base: "22345.67",
    accounts: [
      { id: "1", name: "现金甲", currency: "CNY", balance_native: "10000000000000001", balance_base: "10000000000000001", active: true, include_net_worth: true },
    ],
  }],
};

const ACCOUNT_BALANCES_CASH_PRECISION = {
  base_currency: "CNY", as_of: "2026-08-09", fx_complete: true, missing_currencies: [],
  accounts: [
    { id: "1", name: "现金甲", type: "asset", currency: "CNY", balance: "10000000000000001", balance_base: "10000000000000001", active: true, account_role: "cash", include_net_worth: true, group: "cash", group_title: "现金" },
    { id: "2", name: "现金乙", type: "asset", currency: "CHF", balance: "0", balance_base: "0", active: true, account_role: "cash", include_net_worth: true, group: "cash", group_title: "现金" },
  ],
};

/** 缺汇率现金：非零 EUR 余额无 base → 可用现金 fail-closed。 */
const ACCOUNT_BALANCES_CASH_FX_MISSING = {
  base_currency: "CNY", as_of: "2026-08-09", fx_complete: false, missing_currencies: ["EUR"],
  accounts: [
    { id: "1", name: "现金甲", type: "asset", currency: "CNY", balance: "100.00", balance_base: "100.00", active: true, account_role: "cash", include_net_worth: true, group: "cash", group_title: "现金" },
    { id: "2", name: "现金乙", type: "asset", currency: "EUR", balance: "50.00", balance_base: null, active: true, account_role: "cash", include_net_worth: true, group: "cash", group_title: "现金" },
  ],
};

const INCOME = {
  schema_version: "1.0", report_id: "income-2026-08", report_type: "income_statement",
  generated_at: "2026-08-09T10:00:00+00:00", base_currency: "CNY",
  period: { start_date: "2026-08-01", end_date: "2026-08-09" },
  fx_complete: true, data_complete: true, warnings: [],
  summary: { total_income_cny: SYNTHETIC_A, total_expenses_cny: SYNTHETIC_B, net_result_cny: "5556.66", savings_rate_pct: "45.1" },
  sections: [],
};

const PREV_INCOME = {
  ...INCOME,
  period: { start_date: "2026-07-01", end_date: "2026-07-09" },
  summary: { total_income_cny: SYNTHETIC_B, total_expenses_cny: "1111.22", net_result_cny: "5677.79" },
};

type AnyRecord = Record<string, unknown>;
function makeMockFetch(opts: { failTransactions?: boolean; accounts?: AnyRecord } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (opts.failTransactions && url.includes("web/transactions")) {
      return new Response(JSON.stringify({ detail: "transactions failed" }), { status: 500 });
    }
    let body: unknown;
    if (url.includes("personal-balance-sheet")) body = BALANCE;
    else if (url.includes("net-worth-trend")) body = { schema_version: "1.0", base_currency: "CNY", as_of: "2026-08-09", months: 12, points: [] };
    else if (url.includes("income-statement")) {
      body = url.includes("2026-07") ? PREV_INCOME : INCOME;
    } else if (url.includes("account-balances")) body = (opts.accounts as AnyRecord) ?? ACCOUNT_BALANCES_CASH_PRECISION;
    else if (url.includes("fx-attribution")) body = {
      schema_version: "1.0", period_from: "2026-08-01", period_to: "2026-08-09",
      total_net_worth_change_cny: SYNTHETIC_A, total_savings_contribution_cny: SYNTHETIC_A,
      total_fx_contribution_cny: SYNTHETIC_B, fx_contribution_percentage: 1.0,
      by_currency: [], notes: [],
    };
    else if (url.includes("web/transactions")) body = {
      schema_version: "1.0", generated_at: "2026-08-09T10:00:00+00:00",
      period_from: "2026-08-01", period_to: "2026-08-09", total: 1, offset: 0, limit: 20,
      rows: [{ date: "2026-08-05", type: "withdrawal", description: "房租", category: "居住", source: "现金甲", destination: "房东", amount_native: "6800.00", currency: "CNY", amount_base: "6800.00", fx_exact: true, tags: [], journal_id: "c1" }],
      fx_notes: [],
    };
    else if (url.includes("anomalies")) body = { schema_version: "1.0", checked_at: "2026-08-09T10:00:00+00:00", count: 0, anomalies: [] };
    else body = {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function renderMasked(ui: React.ReactElement) {
  window.localStorage.setItem("report-web.mask", "1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <MaskProvider>
        <AppHeaderProvider>
          <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
        </AppHeaderProvider>
      </MaskProvider>
    </MemoryRouter>,
  );
}

function renderUnmasked(ui: React.ReactElement) {
  window.localStorage.setItem("report-web.mask", "0");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <MaskProvider>
        <AppHeaderProvider>
          <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
        </AppHeaderProvider>
      </MaskProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1) 遮蔽全覆盖（U01）：归因总额 + 上期收支 + 全部出口
// ---------------------------------------------------------------------------

describe("financial display contract: mask coverage", () => {
  it("AttributionBar 遮蔽模式：总额/分段 label/title/aria 全出口无合成金额", () => {
    renderMasked(
      <AttributionBar
        savingsContribution={SYNTHETIC_A}
        fxContribution={SYNTHETIC_B}
        totalChange={SYNTHETIC_A}
        currency="CNY"
      />,
    );
    const html = document.body.innerHTML;
    // 原串与千分位格式化变体都不得出现（formatNumber 会加千分位）
    for (const leak of [SYNTHETIC_A, SYNTHETIC_B, "12,345.67", "6,789.01"]) {
      expect(html).not.toContain(leak);
    }
    // 遮蔽符号存在且总额出口仍在 DOM（总区域未消失）
    expect(document.querySelector(".attribution-bar-total")).not.toBeNull();
  });

  it("IncomeExpense 遮蔽模式：上期收入/支出不泄露（U01 修复）", async () => {
    vi.stubGlobal("fetch", makeMockFetch());
    renderMasked(<IncomeExpensePage />);
    await screen.findAllByText(/上期/);
    const html = document.body.innerHTML;
    expect(html).not.toContain(SYNTHETIC_B);      // 上期收入 = SYNTHETIC_B（原串）
    expect(html).not.toContain("6,789.01");       // 千分位变体
    expect(html).not.toContain("1,111.22");       // 上期支出（千分位变体）
    expect(html).not.toContain("1111.22");
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
});

// ---------------------------------------------------------------------------
// 2) 精度（U02）：现金聚合走 Decimal
// ---------------------------------------------------------------------------

describe("financial display contract: decimal precision", () => {
  it("可用现金聚合在 2^53 域外保持精确（Number 会丢 1）", async () => {
    vi.stubGlobal("fetch", makeMockFetch({ accounts: ACCOUNT_BALANCES_CASH_PRECISION }));
    renderUnmasked(<HomePage />);
    await screen.findByText("可用现金");
    await waitFor(() => {
      const item = screen.getByText("可用现金").closest(".headline-secondary-item");
      const text = item?.querySelector(".headline-secondary-value")?.textContent ?? "";
      // 精确聚合（Decimal）→ 千分位显示保留 2^53 之外的 1
      expect(text).toContain("10,000,000,000,000,001");
      // Number 聚合会丢 1 变成 ...000
      expect(text).not.toContain("10,000,000,000,000,000");
    });
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("缺汇率的非零现金余额 → 可用现金 fail-closed（不造零、不 1:1）", async () => {
    vi.stubGlobal("fetch", makeMockFetch({ accounts: ACCOUNT_BALANCES_CASH_FX_MISSING }));
    renderUnmasked(<HomePage />);
    await screen.findByText("可用现金");
    await waitFor(() => {
      expect(screen.getByText(/汇率缺失/)).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
});

// ---------------------------------------------------------------------------
// 3) 错误隔离：单接口失败不掩盖、不清空
// ---------------------------------------------------------------------------

describe("financial display contract: error isolation", () => {
  it("交易接口失败 → 近期活动区块显示局部失败与重试，其他区块照常", async () => {
    vi.stubGlobal("fetch", makeMockFetch({ failTransactions: true }));
    renderUnmasked(<HomePage />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    // 失败区块有重试入口
    expect(screen.getAllByRole("button", { name: /重试/ }).length).toBeGreaterThan(0);
    // 不用「暂无显著交易」掩盖失败
    expect(screen.queryByText("暂无显著交易")).not.toBeInTheDocument();
    // 其他区块仍渲染
    expect(screen.getByText("可用现金")).toBeInTheDocument();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });
});

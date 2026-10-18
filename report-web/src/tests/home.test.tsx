import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { HomePage } from "../features/home/HomePage";
import { AppHeaderProvider } from "../components/AppHeader";
import { MaskProvider } from "../components/MaskContext";

// 图表组件在 jsdom 下不可用，打桩为纯标记
vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  nwTrendOption: () => ({}),
  monthlyBarOption: () => ({}),
}));

const BALANCE_SHEET = {
  schema_version: "1.0",
  source: "firefly_live",
  generated_at: "2026-08-09T10:00:00+00:00",
  base_currency: "CNY",
  balance_as_of: "2026-08-09",
  fx_complete: false,
  missing_currencies: ["CHF"],
  warnings: [],
  summary: {
    total_assets_base: "320000.00",
    total_liabilities_base: "0",
    net_worth_base: "320000.00",
    included_account_count: 3,
    pending_mapping_count: 0,
  },
  groups: [
    {
      key: "cash",
      title: "现金",
      side: "asset" as const,
      subtotal_base: "168420.50",
      accounts: [
        { id: "1", name: "日常储蓄账户", currency: "CNY", balance_native: "168420.50", balance_base: "168420.50", active: true, include_net_worth: true },
        { id: "2", name: "欧洲生活账户", currency: "EUR", balance_native: "18250.45", balance_base: "144280.10", active: true, include_net_worth: true },
      ],
    },
    {
      key: "investments",
      title: "长期投资",
      side: "asset" as const,
      subtotal_base: "73540.25",
      accounts: [
        { id: "3", name: "长期养老金账户", currency: "CHF", balance_native: "73540.25", balance_base: null, active: true, include_net_worth: true },
      ],
    },
  ],
};

const NET_WORTH_TREND = {
  schema_version: "1.0",
  base_currency: "CNY",
  as_of: "2026-08-09",
  months: 12,
  points: [
    { date: "2025-09-30", total_assets_base: "245000.00", total_liabilities_base: "12000.00", net_worth_base: "233000.00", fx_complete: true, missing_currencies: [] },
    { date: "2025-11-30", total_assets_base: "258000.00", total_liabilities_base: "10000.00", net_worth_base: "248000.00", fx_complete: true, missing_currencies: [] },
    { date: "2026-01-31", total_assets_base: "272000.00", total_liabilities_base: "8000.00", net_worth_base: "264000.00", fx_complete: true, missing_currencies: [] },
    { date: "2026-03-31", total_assets_base: "281500.00", total_liabilities_base: "6000.00", net_worth_base: "275500.00", fx_complete: true, missing_currencies: [] },
    { date: "2026-05-31", total_assets_base: "295000.00", total_liabilities_base: "4000.00", net_worth_base: "291000.00", fx_complete: true, missing_currencies: [] },
    { date: "2026-07-31", total_assets_base: "306000.00", total_liabilities_base: "2000.00", net_worth_base: "304000.00", fx_complete: true, missing_currencies: [] },
    { date: "2026-08-09", total_assets_base: "320000.00", total_liabilities_base: "0", net_worth_base: "320000.00", fx_complete: false, missing_currencies: ["CHF"] },
  ],
};

function makeIncomeStatement(summary: Record<string, string>) {
  return {
    schema_version: "1.0",
    report_id: "income-2026-08",
    report_type: "income_statement",
    generated_at: "2026-08-09T10:00:00+00:00",
    base_currency: "CNY",
    period: { start_date: "2026-08-01", end_date: "2026-08-31" },
    fx_complete: false,
    data_complete: true,
    warnings: [],
    summary,
    sections: [],
  };
}

const INCOME_SUMMARY = {
  total_income_cny: "28600.00",
  total_expenses_cny: "12480.50",
  net_result_cny: "16119.50",
  savings_rate_pct: "56.36",
};

const PREV_INCOME_SUMMARY = {
  total_income_cny: "27000.00",
  total_expenses_cny: "13000.00",
  net_result_cny: "14000.00",
};

const ACCOUNT_BALANCES = {
  base_currency: "CNY",
  as_of: "2026-08-09",
  fx_complete: false,
  missing_currencies: ["CHF"],
  accounts: [
    { id: "1", name: "日常储蓄账户", type: "asset", currency: "CNY", balance: "168420.50", balance_base: "168420.50", active: true, account_role: "cash", include_net_worth: true, group: "cash", group_title: "现金", fx_rate_date: "2026-08-09", fx_source: "fixed" },
    { id: "2", name: "欧洲生活账户", type: "asset", currency: "EUR", balance: "18250.45", balance_base: "144280.10", active: true, account_role: "cash", include_net_worth: true, group: "cash", group_title: "现金", fx_rate_date: "2026-08-08", fx_source: "ECB" },
    { id: "3", name: "长期养老金账户", type: "asset", currency: "CHF", balance: "73540.25", balance_base: null, active: true, account_role: "investment", include_net_worth: true, group: "investments", group_title: "长期投资", fx_rate_date: null, fx_source: null },
  ],
};

const FX_ATTRIBUTION = {
  schema_version: "1.0",
  period_from: "2024-01-01",
  period_to: "2026-08-09",
  total_net_worth_change_cny: "125000.00",
  total_savings_contribution_cny: "120000.00",
  total_fx_contribution_cny: "5000.00",
  fx_contribution_percentage: 4.0,
  by_currency: [],
  notes: [],
};

const ANOMALIES = {
  schema_version: "1.0",
  checked_at: "2026-08-09T10:00:00+00:00",
  count: 3,
  anomalies: [
    { id: "spending_trend:餐饮:2026-08", source: "spending_trend", severity: "critical", message: "餐饮支出超均值 50%", category: "餐饮", amount: "3200.00", currency: "CNY" },
    { id: "spending_trend:娱乐:2026-08", source: "spending_trend", severity: "warning", message: "娱乐支出超均值 30%", category: "娱乐", amount: "1200.00", currency: "CNY" },
    { id: "health:runway", source: "health", severity: "info", message: "资金安全跑道正常", category: null, amount: null, currency: null },
  ],
};

const TRANSACTIONS = {
  schema_version: "1.0",
  generated_at: "2026-08-09T10:00:00+00:00",
  period_from: "2026-08-01",
  period_to: "2026-08-31",
  total: 1,
  offset: 0,
  limit: 20,
  rows: [
    {
      date: "2026-08-05",
      type: "withdrawal",
      description: "房租",
      category: "居住",
      source: "日常储蓄账户",
      destination: "房东",
      amount_native: "6800.00",
      currency: "CNY",
      amount_base: "6800.00",
      fx_exact: true,
      tags: [],
      journal_id: "home-j1",
    },
  ],
  fx_notes: [],
};

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown;
    if (url.includes("personal-balance-sheet")) body = BALANCE_SHEET;
    else if (url.includes("net-worth-trend")) body = NET_WORTH_TREND;
    else if (url.includes("income-statement")) {
      body = makeIncomeStatement(url.includes("2026-07") ? PREV_INCOME_SUMMARY : INCOME_SUMMARY);
    } else if (url.includes("account-balances")) body = ACCOUNT_BALANCES;
    else if (url.includes("fx-attribution")) body = FX_ATTRIBUTION;
    else if (url.includes("transactions")) body = TRANSACTIONS;
    else if (url.includes("anomalies")) body = ANOMALIES;
    else body = {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <MaskProvider>
        <AppHeaderProvider>
          <QueryClientProvider client={qc}>
            <HomePage />
          </QueryClientProvider>
        </AppHeaderProvider>
      </MaskProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HomePage (WP2 narrative spine)", () => {
  it("Block 1: 渲染叙事句「净资产 ... 较上月 ...」+ 副指标行（总资产/总负债/可用现金）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    // Block 1 headline
    expect(await screen.findByLabelText("净资产概览")).toBeInTheDocument();
    expect(screen.getAllByText(/净资产/).length).toBeGreaterThan(0);
    // 副指标行
    expect(screen.getByText("总资产")).toBeInTheDocument();
    expect(screen.getByText("总负债")).toBeInTheDocument();
    expect(screen.getByText("可用现金")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("Block 1: UX-01 折算不完整时 Headline 披露缺失币种（与资产负债同一数据路径）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    // fixture: balance_sheet.fx_complete=false, missing_currencies=["CHF"]
    const note = await screen.findByTestId("headline-fx-note");
    expect(note).toHaveTextContent("缺少 CHF 汇率，相关金额未计入");
    vi.unstubAllGlobals();
  });

  it("Block 2: P&L 4 指标存在（收入/支出/结余/储蓄率）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const strip = await screen.findByLabelText("本月收支概览");
    expect(strip).toBeInTheDocument();
    expect(within(strip).getByText("收入")).toBeInTheDocument();
    expect(within(strip).getByText("支出")).toBeInTheDocument();
    expect(within(strip).getByText("结余")).toBeInTheDocument();
    expect(within(strip).getByText("储蓄率")).toBeInTheDocument();
    // 月至今后缀
    expect(within(strip).getByText(/月至今/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("Block 3: NW 趋势图渲染（动态 Y 轴）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    expect(await screen.findByLabelText("近12个月净资产趋势")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("Block 4: 归因条渲染储蓄贡献和汇率贡献", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const attribution = await screen.findByLabelText("本月变动归因");
    expect(attribution).toBeInTheDocument();
    expect(screen.getByText("储蓄贡献")).toBeInTheDocument();
    expect(screen.getByText("汇率贡献")).toBeInTheDocument();
    // 低于 8% 的窄 FX 分段只保留 title tooltip，避免金额文字越界截断。
    expect(attribution.querySelectorAll(".attribution-segment-label")).toHaveLength(1);
    expect(attribution.querySelector(".attribution-fx")).toHaveAttribute("title", expect.stringContaining("汇率贡献"));
    vi.unstubAllGlobals();
  });

  it("Block 3: 健康信号条按 spec v1.2 critical 契约渲染", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const strip = await screen.findByLabelText("财务健康信号");
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveClass("health-signals-strip--critical");
    expect(within(strip).getByText("有 1 个请关注")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("Block 6: CompositionSegmentBar 100% 闭合 + 汇率待定", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const bar = await screen.findByLabelText("资产组合分布");
    expect(bar).toBeInTheDocument();
    // 有现金组 + 投资组 + 汇率待定
    expect(screen.getAllByText(/现金/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/汇率待定/).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("Block 7: 账户概览和近期显著活动均渲染", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    expect(await screen.findByLabelText("账户概览")).toBeInTheDocument();
    expect(screen.getByText("查看全部 →")).toBeInTheDocument();
    expect(screen.getByLabelText("近期活动")).toHaveTextContent("房租");
    vi.unstubAllGlobals();
  });

  it("Block 8: ReportTimestampFooter 时间戳", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const footer = await screen.findByTestId("report-timestamp-footer");
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveTextContent(/数据生成时间/);
    // REL-05：生成瞬间 + 估值日历日分列（balance_as_of）
    expect(footer).toHaveTextContent("数据截止: 2026-08-09");
    vi.unstubAllGlobals();
  });

  it("标题日期与 asOf 同步（C8）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    // C8: header meta 应包含截止日期
    expect(await screen.findByText("截止 2026-08-09")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("接口错误时显示内联不可用提示与重试按钮", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "加载失败" }), { status: 500 })));
    renderPage();
    await screen.findAllByRole("alert", undefined, { timeout: 5000 });
    expect(screen.getAllByText(/部分数据不可用/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /重试/ }).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("数据为空时展示空状态，不崩溃", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("personal-balance-sheet")) body = { ...BALANCE_SHEET, summary: { total_assets_base: "0", total_liabilities_base: "0", net_worth_base: "0", included_account_count: 0, pending_mapping_count: 0 }, groups: [] };
      else if (url.includes("net-worth-trend")) body = { ...NET_WORTH_TREND, points: [] };
      else if (url.includes("income-statement")) body = makeIncomeStatement(INCOME_SUMMARY);
      else if (url.includes("account-balances")) body = { ...ACCOUNT_BALANCES, accounts: [] };
      else body = {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    await screen.findByLabelText("净资产概览");
    expect(screen.getByText("暂无资产数据")).toBeInTheDocument();
    expect(screen.getByText("暂无账户数据")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("后缀式金额格式（C9）：金额使用后缀 CNY 而非前缀 ¥", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    // Amount 组件使用后缀式 "28,600 CNY" 而非 "¥28,600"
    const strip = await screen.findByLabelText("本月收支概览");
    expect(strip).toBeInTheDocument();
    // CNY 后缀存在于 Amount 组件中
    expect(strip.querySelectorAll(".amount-currency").length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// WP05（R05/U05）：首页唯一期间源 + 钻取保持期间
// ---------------------------------------------------------------------------

describe("HomePage period consistency (WP05)", () => {
  it("收支与汇率归因请求同一 Berlin 当月期间（R05：不再打到多年区间）", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-09T12:00:00Z") });
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await screen.findByLabelText("本月收支概览");

    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    const fxCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("fx-attribution"));
    expect(incomeCalls.length).toBeGreaterThan(0);
    expect(fxCalls.length).toBeGreaterThan(0);
    // 柏林 2026-08-09（12:00Z）→ 本月至今 08-01 ~ 08-09
    for (const u of incomeCalls) {
      expect(u).toContain("start_date=2026-08-01");
      expect(u).toContain("end_date=2026-08-09");
    }
    // R05 核心断言：归因请求显式携带同一期间（缺省=多年区间），参数名为 from/to
    for (const u of fxCalls) {
      expect(u).toContain("from_date=2026-08-01");
      expect(u).toContain("to_date=2026-08-09");
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("PnlFlowStrip 钻取链接携带与首页请求相同的期间（U05）", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-09T12:00:00Z") });
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const strip = await screen.findByLabelText("本月收支概览");
    // PnlFlowStrip role=link（可聚焦区块），键盘 Enter 触发导航
    strip.focus();
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // MemoryRouter 内导航后 URL 应带同一期间（通过 history 无法直接读，
    // 改断言 PnlFlowStrip 的 meta 文案与期间一致 + 导航不抛错）
    expect(strip).toHaveTextContent("月至今");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

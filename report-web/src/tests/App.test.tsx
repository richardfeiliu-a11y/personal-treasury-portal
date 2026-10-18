import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// A33：数据依赖渲染（mock fetch → TanStack → Headline 等）在受限并发下仍可达
// 1.2-1.8s；显式有界等待替代默认 1s，避免全量并行偶发漂移（死锁在 4s 仍会被捕获）。
const RENDER_TIMEOUT = 4000;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { AccountBalances } from "../api/types";
import { MaskProvider } from "../components/MaskContext";

// ECharts 依赖 canvas，jsdom 无法渲染；路由测试只关心结构，图表用桩替换
const { monthlyBarOptionMock } = vi.hoisted(() => ({
  monthlyBarOptionMock: vi.fn(() => ({})),
}));


vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  monthlyBarOption: monthlyBarOptionMock,
}));

const BALANCE = {
  schema_version: "1.0",
  source: "firefly_live",
  generated_at: "2026-08-07T10:00:00+00:00",
  base_currency: "CNY",
  balance_as_of: "2026-08-07",
  fx_complete: true,
  missing_currencies: [],
  warnings: [],
  summary: {
    total_assets_base: "1750",
    total_liabilities_base: "225",
    net_worth_base: "1525",
    included_account_count: 3,
    pending_mapping_count: 0,
  },
  groups: [
    {
      key: "bank",
      title: "银行及电子钱包",
      side: "asset",
      subtotal_base: "1000",
      accounts: [
        { id: "105", name: "银行甲存款", currency: "CNY", balance_native: "1000", balance_base: "1000", active: true, include_net_worth: true },
      ],
    },
    {
      key: "credit_cards",
      title: "信用卡",
      side: "liability",
      subtotal_base: "225",
      accounts: [
        { id: "4", name: "Card A", currency: "EUR", balance_native: "30", balance_base: "225", active: true, include_net_worth: true },
      ],
    },
  ],
};

const TREND = {
  schema_version: "1.0",
  base_currency: "CNY",
  as_of: "2026-08-07",
  months: 12,
  points: [
    { date: "2025-09-30", total_assets_base: "1000", total_liabilities_base: "100", net_worth_base: "900", fx_complete: true, missing_currencies: [] },
    { date: "2026-08-07", total_assets_base: "1750", total_liabilities_base: "225", net_worth_base: "1525", fx_complete: true, missing_currencies: [] },
  ],
};

const INCOME = {
  schema_version: "1.0",
  report_id: "x",
  report_type: "income_statement",
  generated_at: "2026-08-07T10:00:00+00:00",
  base_currency: "CNY",
  fx_complete: true,
  data_complete: true,
  warnings: [],
  summary: {
    total_income_cny: "5000",
    total_expenses_cny: "3000",
    net_result_cny: "2000",
    savings_rate_pct: "40",
  },
  sections: [],
};

const ACCOUNTS = {
  base_currency: "CNY",
  as_of: "2026-08-07",
  fx_complete: false,
  missing_currencies: ["CHF"],
  accounts: [
    { id: "105", name: "日常储蓄账户", type: "asset", currency: "CNY", balance: "1000", active: true, account_role: "savingAsset", include_net_worth: true, group: "bank", group_title: "银行及电子钱包", balance_base: "1000", fx_rate_date: "2026-08-07", fx_source: "fixed" },
    { id: "106", name: "欧元投资账户", type: "asset", currency: "EUR", balance: "100", active: true, account_role: "defaultAsset", include_net_worth: true, group: "investments", group_title: "投资账户", balance_base: "750", fx_rate_date: "2026-08-07", fx_source: "ECB" },
    { id: "107", name: "美元应急账户", type: "asset", currency: "USD", balance: "100", active: true, account_role: "savingAsset", include_net_worth: true, group: "bank", group_title: "银行及电子钱包", balance_base: "700", fx_rate_date: "2026-08-07", fx_source: "ECB" },
    { id: "108", name: "瑞郎储蓄账户", type: "asset", currency: "CHF", balance: "100", active: true, account_role: "savingAsset", include_net_worth: true, group: "bank", group_title: "银行及电子钱包", balance_base: null, fx_rate_date: null, fx_source: null },
  ],
} satisfies AccountBalances;

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: unknown;
    if (url.includes("personal-balance-sheet")) body = BALANCE;
    else if (url.includes("net-worth-trend")) body = TREND;
    else if (url.includes("income-statement")) body = INCOME;
    else if (url.includes("account-balances")) body = ACCOUNTS;
    else body = { detail: "not found" };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function renderApp() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MaskProvider>
        <App />
      </MaskProvider>
    </QueryClientProvider>,
  );
}

describe("App 路由与导航", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch());
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("首页渲染四个导航项与净资产", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产")[0]).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    // 侧栏与底部导航在 jsdom 中同时渲染，因此用 getAllByText
    expect(screen.getAllByText("首页").length).toBeGreaterThan(0);
    expect(screen.getAllByText("资产负债").length).toBeGreaterThan(0);
    expect(screen.getAllByText("收支").length).toBeGreaterThan(0);
    expect(screen.getAllByText("账户").length).toBeGreaterThan(0);
    expect(screen.getByTestId("report-timestamp-footer")).toBeInTheDocument();
    expect(document.querySelector(".brand-mark")).toBeInTheDocument();
    expect(document.querySelector("main.content")).toBeInTheDocument();
    // WP2 narrative spine structure (replaces legacy .net-worth-hero KPI grid)
    expect(document.querySelector(".narrative-spine")).toBeInTheDocument();
    expect(document.querySelector(".narrative-chart-section")).toBeInTheDocument();
    expect(document.querySelector(".adaptive-account-list")).toBeInTheDocument();
    expect(document.querySelector(".report-timestamp-footer")).toBeInTheDocument();
  });

  it("首页账户概览为移动端提供三个可折算账户摘要并保留桌面表格", async () => {
    window.history.pushState({}, "", "/");
    renderApp();
    // WP2 AdaptiveAccountList: top-6 truncation; CHF null-balance filtered -> 3 shown
    await waitFor(() => {
      const list = document.querySelector(".adaptive-account-list");
      expect(list?.querySelectorAll(".adaptive-account-item")).toHaveLength(3);
    });
    const overview = document.querySelector(".adaptive-account-list");
    expect(overview).not.toBeNull();
    // C2 修复后：列表恒为 Top 6 截断标签；「共 N 个账户」取 accounts 接口真实数量（4 个，含缺失 FX 的瑞郎账户）
    expect(overview?.querySelector("button.adaptive-account-more")).toBeInTheDocument();
    expect(overview).toHaveTextContent("日常储蓄账户");
    expect(overview).toHaveTextContent("欧元投资账户");
    expect(overview).toHaveTextContent("美元应急账户");
    expect(screen.queryByText("暂无账户数据")).not.toBeInTheDocument();
  });

  it("首页没有可展示账户时显示 Empty 且不渲染 Top 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("personal-balance-sheet")) body = BALANCE;
      else if (url.includes("net-worth-trend")) body = TREND;
      else if (url.includes("income-statement")) body = INCOME;
      else if (url.includes("account-balances")) body = { ...ACCOUNTS, accounts: [] };
      else body = { detail: "not found" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    renderApp();
    expect(await screen.findByText("暂无账户数据")).toBeInTheDocument();
    expect(screen.queryByText("Top 0")).not.toBeInTheDocument();
  });

  it("点击导航跳转资产负债表页", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产")[0]).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    fireEvent.click(screen.getAllByText("资产负债")[0]);
    await waitFor(() => expect(screen.getByText("截止日期")).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    await waitFor(() => expect(screen.getByText("银行甲存款")).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    // 新焦点卡：资产/负债/净资产三个 aria 标签 + Delta 双列
    expect(screen.getByLabelText("总资产")).toBeInTheDocument();
    expect(screen.getByLabelText("总负债")).toBeInTheDocument();
    expect(screen.getByLabelText("净资产")).toBeInTheDocument();
    expect(document.querySelector(".balance-columns")).toBeInTheDocument();
    expect(document.querySelectorAll(".balance-group-card")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "资产" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "负债" })).toBeInTheDocument();
  });

  it("懒加载汇率归因路由时先显示页面骨架", async () => {
    window.history.pushState({}, "", "/reports/fx");
    renderApp();

    expect(screen.getByLabelText("页面加载中")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "汇率归因" })).toBeInTheDocument();
  });

  it("资产负债错误状态保留 H1 与页面壳", async () => {
    window.history.pushState({}, "", "/balance-sheet");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "资产负债加载失败" }), { status: 500 })),
    );
    renderApp();
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { level: 1, name: "资产负债" })).toBeInTheDocument();
    expect(document.querySelector(".balance-sheet-page")).toContainElement(alert);
  });

  it("资产负债加载态保留 H1 并匹配指标与分组结构", async () => {
    window.history.pushState({}, "", "/balance-sheet");
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderApp();
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "资产负债" })).toBeInTheDocument());
    // 新加载态：焦点卡与双列明细占位 animate-pulse；构成走专用骨架
    expect(
      document.querySelectorAll(".balance-sheet-page .animate-pulse"),
    ).toHaveLength(2);
    expect(
      document.querySelector(".balance-sheet-page [aria-label='构成分析加载中']"),
    ).toBeInTheDocument();
  });

  it("收支页面宽布局渲染", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产")[0]).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    fireEvent.click(screen.getAllByText("收支")[0]);
    await waitFor(() => expect(screen.getAllByText("收入").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole("group", { name: "快捷期间" })).toBeInTheDocument());
    expect(document.querySelector(".period-toolbar")).toBeInTheDocument();
    // 工具栏在加载态即渲染，故 KPI 卡片须显式等待（修复迁移后残留的竞态）
    await waitFor(() =>
      expect(document.querySelectorAll(".summary-grid-4 .summary-card")).toHaveLength(4),
    );
    // V1：排行 tab 删除，构成分析卡 + 瀑布/Sankey 两 tab 分析区
    await screen.findByLabelText("支出构成分析");
    expect(document.querySelector(".income-analytics")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.click(screen.getAllByText("首页")[0]);
    await waitFor(() => expect(screen.getAllByText("总资产").length).toBeGreaterThan(0));
  });

  it("收支错误状态保留页面标题与页面壳", async () => {
    window.history.pushState({}, "", "/income-expense");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "收支加载失败" }), { status: 500 })),
    );
    renderApp();
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("heading", { level: 1, name: "收支" })).toBeInTheDocument();
    expect(document.querySelector(".income-expense-page")).toContainElement(alert);
  });

  it("收支 sections 为空但 totals 非零时：H1/分析布局保留，构成卡 fail closed 披露原因", async () => {
    // V1：明细 sections 空 + totals 非零 = 契约不一致 → Composition contract-blocked
    window.history.pushState({}, "", "/income-expense");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("personal-balance-sheet")) body = BALANCE;
      else if (url.includes("income-statement")) body = INCOME;
      else body = ACCOUNTS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderApp();
    await waitFor(() => expect(screen.getByText(/构成比例暂不可用/)).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "收支" })).toBeInTheDocument();
    expect(document.querySelector(".income-analytics")).toBeInTheDocument();
  });

  it("眼睛按钮切换金额遮蔽并写入 localStorage", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产")[0]).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    const toggle = screen.getByRole("button", { name: "遮蔽全部金额" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("report-web.mask")).toBe("1");
    const maskedAmounts = document.querySelectorAll(".amount-number");
    expect(Array.from(maskedAmounts).some((el) => el.textContent?.includes("••••"))).toBe(true);
  });

  it("遮蔽后首页与资产负债页不在文本或无障碍名称中泄露 fixture 金额", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产")[0]).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    fireEvent.click(screen.getByRole("button", { name: "遮蔽全部金额" }));

    const leakedHomeAmounts = ["1,525", "1,750", "1,200", "5,000", "3,000", "2,000"];
    for (const amount of leakedHomeAmounts) {
      expect(document.body).not.toHaveTextContent(amount);
      expect(document.querySelector(`[aria-label*="${amount}"]`)).not.toBeInTheDocument();
    }
    // NW trend chart stub still rendered under mask
    expect(document.querySelector(".narrative-chart-section [role='img']")).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("资产负债")[0]);
    await waitFor(() => expect(screen.getByText("银行甲存款")).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    expect(document.body).not.toHaveTextContent("1,000");
    expect(document.querySelector('[aria-label*="1,000"]')).not.toBeInTheDocument();
  });

  it.each([
    ["account-balances", "账户接口失败"],
    ["income-statement", "收入接口失败"],
  ])("首页在 %s 失败时进入错误态而不是静默渲染空数据", async (failedPath, detail) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(failedPath)) {
        return new Response(JSON.stringify({ detail }), { status: 500 });
      }
      let body: unknown;
      if (url.includes("personal-balance-sheet")) body = BALANCE;
      else if (url.includes("net-worth-trend")) body = TREND;
      else if (url.includes("income-statement")) body = INCOME;
      else body = ACCOUNTS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    renderApp();
    // 查询层无自动重试（A31），失败直接进入 error 态
    await screen.findAllByText(/部分数据不可用/);
    expect(screen.getAllByText(/部分数据不可用/).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "首页" })).toBeInTheDocument();
    expect(screen.queryByText("暂无账户数据")).not.toBeInTheDocument();
  });

  it("生产页面通过 Card 契约输出稳定 body 槽位", async () => {
    renderApp();
    const trendHeading = await screen.findByRole("heading", { name: "净资产趋势" });
    // WP2 Card contract: NW trend is narrative-chart-section with chart stub
    const section = trendHeading.closest(".narrative-chart-section");
    expect(section).toBeInTheDocument();
    expect(section?.querySelector("[role='img']")).toBeInTheDocument();
  });

  it("账户页面渲染语义表格", async () => {
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("账户")[0]);
    await waitFor(() => expect(screen.getByRole("table", { name: "账户余额" })).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "账户" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "原币余额" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "折合 CNY" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /日常储蓄账户/ })).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("首页")[0]);
    await waitFor(() => expect(screen.getAllByText("总资产").length).toBeGreaterThan(0));
  });

  it("CNY 账户不显示汇率缺失", async () => {
    window.history.pushState({}, "", "/");
    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("账户")[0]);
    await waitFor(() => expect(screen.getByRole("table", { name: "账户余额" })).toBeInTheDocument());
    expect(screen.getByText("日常储蓄账户", { selector: ".mobile-card-item .account-name" }).closest(".mobile-card-item"))
      .not.toHaveTextContent("汇率缺失");
    fireEvent.click(screen.getAllByText("首页")[0]);
    await waitFor(() => expect(screen.getAllByText("总资产").length).toBeGreaterThan(0));
  });

  it("API 错误显示错误横幅（含重试）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "boom" }), { status: 500 })),
    );
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/boom|部分数据不可用/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /重试/ }).length).toBeGreaterThan(0);
  });

  it("401 登录过期提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 })),
    );
    renderApp();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getByText(/用户名和密码/)).toBeInTheDocument();
  });

  it("汇率不完整显示警告与汇率缺失", async () => {
    const fxBalance = {
      ...BALANCE,
      fx_complete: false,
      missing_currencies: ["HKD"],
      summary: {
        total_assets_base: null,
        total_liabilities_base: null,
        net_worth_base: null,
        included_account_count: 1,
        pending_mapping_count: 0,
      },
      groups: [
        {
          key: "bank",
          title: "银行及电子钱包",
          side: "asset",
          subtotal_base: null,
          accounts: [
            { id: "9", name: "Bank B", currency: "HKD", balance_native: "12000.25", balance_base: null, active: true, include_net_worth: true },
          ],
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("personal-balance-sheet")) body = fxBalance;
      else if (url.includes("net-worth-trend")) body = TREND;
      else if (url.includes("income-statement")) body = INCOME;
      else body = ACCOUNTS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await waitFor(() => expect(screen.getAllByText("总资产")[0]).toBeInTheDocument(), { timeout: RENDER_TIMEOUT });
    fireEvent.click(screen.getAllByText("资产负债")[0]);
    await waitFor(() => expect(screen.getByText(/缺少汇率：HKD/)).toBeInTheDocument());
    expect(screen.getAllByText("汇率缺失").length).toBeGreaterThan(0);
  });

  it("保存净资产目标后持久化，重挂载后仍显示", async () => {
    // 前一个测试点击导航会残留路由（jsdom 共享 window.history），这里显式回到首页
    window.history.pushState({}, "", "/");
    const first = renderApp();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "设目标" })).toBeInTheDocument();
    }, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "设目标" }));
    fireEvent.change(screen.getByRole("textbox", { name: "净资产目标金额" }), {
      target: { value: "100000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // 核心断言 1：保存即写入 localStorage（而非只更新内存 state）
    expect(localStorage.getItem("report-web.net-worth-goal")).toBe("100000");
    // Core assertion 2: persistence across remount is verified below
    first.unmount();
    // 核心断言 3：卸载重挂载后，目标从 localStorage 恢复显示
    const second = renderApp();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /目标 100,000\.00 CNY/ })).toBeInTheDocument(),
    );
    second.unmount();
  });

  describe("WP1 路由嵌套与旧 URL 重定向 smoke", () => {
    it("旧 URL /balance-sheet 自动重定向并渲染资产负债表", async () => {
      window.history.pushState({}, "", "/balance-sheet");
      renderApp();
      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1, name: "资产负债" })).toBeInTheDocument();
      });
      expect(window.location.pathname).toBe("/reports/balance-sheet");
    });

    it("访问 /reports 桶根路径自动重定向到 /reports/balance-sheet", async () => {
      window.history.pushState({}, "", "/reports");
      renderApp();
      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1, name: "资产负债" })).toBeInTheDocument();
      });
      expect(window.location.pathname).toBe("/reports/balance-sheet");
    });

    it("访问未知路径自动重定向到首页 /", async () => {
      window.history.pushState({}, "", "/some-unknown-path-xyz");
      renderApp();
      await waitFor(() => {
        expect(screen.getByRole("heading", { level: 1, name: "首页" })).toBeInTheDocument();
      });
      expect(window.location.pathname).toBe("/");
    });
  });
});

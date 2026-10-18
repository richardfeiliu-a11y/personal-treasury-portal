import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { IncomeExpensePage } from "../pages/IncomeExpense";
import { AppHeaderProvider } from "../components/AppHeader";

vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  monthlyBarOption: () => ({}),
}));

// CompositionDonut 直接从 ChartWrapper 引 EChart（jsdom 无 canvas，按仓内惯例 mock）
vi.mock("../components/ChartWrapper", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} data-testid="echart" />
  ),
}));

// 与 e2e fixture 同构：period 使用 ReportEnvelope 的 start_date/end_date（不是 period_from/period_to）。
const INCOME_STATEMENT = {
  schema_version: "1.0",
  report_id: "income-2026-08",
  report_type: "income_statement",
  generated_at: "2026-08-09T10:00:00+00:00",
  base_currency: "CNY",
  period: { start_date: "2026-08-01", end_date: "2026-08-31" },
  fx_complete: true,
  data_complete: true,
  warnings: [],
  summary: {
    total_income_cny: "28600.00",
    total_expenses_cny: "12480.50",
    net_result_cny: "16119.50",
    savings_rate_pct: "56.36",
  },
  sections: [
    {
      key: "income",
      title: "收入",
      rows: [
        { label: "工资", currency: "CNY", amount: "22000.00", amount_base: "22000.00", count: 1 },
        { label: "副业", currency: "CNY", amount: "6600.00", amount_base: "6600.00", count: 3 },
      ],
      subtotal_base: "28600.00",
    },
    {
      key: "expenses",
      title: "支出",
      rows: [
        { label: "居住", currency: "CNY", amount: "6800.00", amount_base: "6800.00", count: 1 },
        { label: "餐饮", currency: "CNY", amount: "2480.50", amount_base: "2480.50", count: 23 },
      ],
      subtotal_base: "12480.50",
    },
    {
      key: "top_expenses",
      title: "前 N 大费用",
      rows: [
        { label: "居住", currency: "CNY", amount: "6800.00", amount_base: "6800.00", count: 1 },
        { label: "餐饮", currency: "CNY", amount: "2480.50", amount_base: "2480.50", count: 23 },
      ],
      subtotal_base: "12480.50",
    },
  ],
};

const EXPENSE_BREAKDOWN = {
  schema_version: "1.0",
  report_id: "expense-2026-08",
  report_type: "expense_breakdown",
  generated_at: "2026-08-09T10:00:00+00:00",
  base_currency: "CNY",
  period: { start_date: "2026-08-01", end_date: "2026-08-31" },
  fx_complete: true,
  data_complete: true,
  warnings: [],
  summary: { total_expenses_cny: "12480.50" },
  sections: [
    {
      key: "top_expenses",
      title: "前 N 大费用",
      rows: [
        { label: "居住", currency: "CNY", amount: "6800.00", amount_base: "6800.00", count: 1 },
        { label: "餐饮", currency: "CNY", amount: "2480.50", amount_base: "2480.50", count: 23 },
      ],
      subtotal_base: "12480.50",
    },
  ],
};

// 收支对平的 income-statement：expenses 两行 6800 + 2480.50 = 9280.50，
// 与 summary.total_expenses_cny 一致，净结余 = 28600 − 9280.50 = 19319.50。
// 用于验证瀑布图在「数据对平」时能正常出图（与默认 INCOME_STATEMENT 故意不一致区分开）。
const CONSISTENT_INCOME_STATEMENT = {
  ...INCOME_STATEMENT,
  summary: {
    total_income_cny: "28600.00",
    total_expenses_cny: "9280.50",
    net_result_cny: "19319.50",
    savings_rate_pct: "67.58",
  },
  sections: [
    {
      key: "income",
      title: "收入",
      rows: [
        { label: "工资", currency: "CNY", amount: "22000.00", amount_base: "22000.00", count: 1 },
        { label: "副业", currency: "CNY", amount: "6600.00", amount_base: "6600.00", count: 3 },
      ],
      subtotal_base: "28600.00",
    },
    {
      key: "expenses",
      title: "支出",
      rows: [
        { label: "居住", currency: "CNY", amount: "6800.00", amount_base: "6800.00", count: 1 },
        { label: "餐饮", currency: "CNY", amount: "2480.50", amount_base: "2480.50", count: 23 },
      ],
      subtotal_base: "9280.50",
    },
    {
      key: "top_expenses",
      title: "前 N 大费用",
      rows: [
        { label: "居住", currency: "CNY", amount: "6800.00", amount_base: "6800.00", count: 1 },
        { label: "餐饮", currency: "CNY", amount: "2480.50", amount_base: "2480.50", count: 23 },
      ],
      subtotal_base: "9280.50",
    },
  ],
};

function mockFetchConsistent() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("expense-breakdown") ? EXPENSE_BREAKDOWN : CONSISTENT_INCOME_STATEMENT;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("expense-breakdown") ? EXPENSE_BREAKDOWN : INCOME_STATEMENT;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function renderPage(entry = "/income-expense") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <AppHeaderProvider>
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={qc}>
          <IncomeExpensePage />
        </QueryClientProvider>
      </MemoryRouter>
    </AppHeaderProvider>,
  );
}

describe("IncomeExpensePage", () => {
  it("展示后端返回的查询期间（period.start_date / period.end_date）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    // 2026-08-01 → 2026年8月1日；2026-08-31 → 2026年8月31日
    expect(screen.getAllByText(/2026年8月1日 ~ 2026年8月31日/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/period_from/)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("按财务角色语义着色：收入行=income 色、支出行=expense 色、结余=net 色（按正负）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    const incomeRows = screen.getAllByRole("row").filter((r) => r.textContent?.includes("工资"));
    expect(incomeRows.length).toBeGreaterThan(0);
    const incomeAmount = incomeRows[0].querySelector(".is-role-income");
    expect(incomeAmount).not.toBeNull();
    expect(incomeAmount).toHaveClass("is-role-income");
    expect(incomeAmount).not.toHaveClass("is-role-expense");

    const expenseRows = screen.getAllByRole("row").filter((r) => r.textContent?.includes("居住"));
    expect(expenseRows.length).toBeGreaterThan(0);
    const expenseAmount = expenseRows[0].querySelector(".is-role-expense");
    expect(expenseAmount).not.toBeNull();
    expect(expenseAmount).toHaveClass("is-role-expense");
    expect(expenseAmount).not.toHaveClass("is-role-income");

    const netAmount = screen
      .getByText("结余", { selector: ".kpi-card-label" })
      .closest(".kpi-card")
      ?.querySelector(".is-role-net");
    expect(netAmount).not.toBeNull();
    expect(netAmount).toHaveClass("is-role-net", "is-role-positive");
    vi.unstubAllGlobals();
  });

  it("结余为负时使用 net 负值角色色", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("expense-breakdown")
        ? EXPENSE_BREAKDOWN
        : {
            ...INCOME_STATEMENT,
            summary: {
              total_income_cny: "1000.00",
              total_expenses_cny: "3000.00",
              net_result_cny: "-2000.00",
              savings_rate_pct: "-100.00",
            },
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    const netAmount = screen
      .getByText("结余", { selector: ".kpi-card-label" })
      .closest(".kpi-card")
      ?.querySelector(".is-role-net");
    expect(netAmount).not.toBeNull();
    expect(netAmount).toHaveClass("is-role-negative");
    expect(netAmount).not.toHaveClass("is-role-positive");
    vi.unstubAllGlobals();
  });

  it("收入/支出明细区段与汇总同时渲染", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    expect(screen.getByRole("region", { name: "收支明细" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "收入" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "支出" })).toBeInTheDocument();
    expect(screen.getAllByText("工资").length).toBeGreaterThan(0);
    expect(screen.getAllByText("餐饮").length).toBeGreaterThan(0);
    const incomeKpi = screen.getByText("收入", { selector: ".kpi-card-label" }).closest(".kpi-card");
    const expenseKpi = screen.getByText("支出", { selector: ".kpi-card-label" }).closest(".kpi-card");
    const netKpi = screen.getByText("结余", { selector: ".kpi-card-label" }).closest(".kpi-card");
    expect(incomeKpi).toHaveTextContent("28,600");
    expect(expenseKpi).toHaveTextContent("12,480.5");
    expect(netKpi).toHaveTextContent("16,119.5");
    expect(screen.getByText("储蓄率")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("移动端卡片与桌面表格同构：收入卡/支出卡按角色着色", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    const incomeCard = screen.getByRole("list", { name: "收入卡片" });
    expect(incomeCard.querySelector(".income-role-card")).not.toBeNull();
    expect(incomeCard.querySelector(".is-role-income")).not.toBeNull();
    const expenseCard = screen.getByRole("list", { name: "支出卡片" });
    expect(expenseCard.querySelector(".is-role-expense")).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it("明细区段缺失时页面仍渲染其余内容（不崩溃）", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("expense-breakdown")
        ? EXPENSE_BREAKDOWN
        : { ...INCOME_STATEMENT, sections: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "收支明细" })).not.toBeInTheDocument();
    expect(screen.getByText("结余", { selector: ".kpi-card-label" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "收支分析" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("支出 section 为空时 Composition 显示本期无支出记录，收支明细保留", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("expense-breakdown")
        ? EXPENSE_BREAKDOWN
        : {
            ...CONSISTENT_INCOME_STATEMENT,
            sections: [
              CONSISTENT_INCOME_STATEMENT.sections[0], // income
              { key: "expenses", title: "支出", rows: [], subtotal_base: "0" },
            ],
            summary: {
              total_income_cny: "28600.00",
              total_expenses_cny: "0",
              net_result_cny: "28600.00",
              savings_rate_pct: "100.00",
            },
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    const card = await screen.findByLabelText("支出构成分析");
    await waitFor(() => expect(within(card).getByText("本期无支出记录")).toBeInTheDocument());
    expect(screen.getByRole("table", { name: "收入" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("接口错误时显示错误横幅并保留页面标题", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "收支加载失败" }), { status: 500 })));
    renderPage();
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert).toHaveTextContent("收支加载失败");
    expect(screen.getByRole("heading", { level: 1, name: "收支" })).toBeInTheDocument();
    expect(document.querySelector(".income-expense-page")).toContainElement(alert);
    vi.unstubAllGlobals();
  });

  it("收入/支出数据为空时显示空状态与说明", async () => {
    // 后端未返回汇总与明细（空 envelope）时，页面降级为空状态；缺失金额渲染为"汇率缺失"，绝不显示 0。
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("expense-breakdown")
        ? { ...EXPENSE_BREAKDOWN, summary: { total_expenses_cny: null }, sections: [] }
        : {
            ...INCOME_STATEMENT,
            summary: { total_income_cny: null, total_expenses_cny: null, net_result_cny: null, savings_rate_pct: null },
            sections: [],
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());
    // 明细区段缺失：页面不崩溃，KPI 全部渲染为"汇率缺失"而非 0
    expect(screen.queryByRole("region", { name: "收支明细" })).not.toBeInTheDocument();
    expect(screen.getAllByText("汇率缺失").length).toBeGreaterThan(0);
    expect(document.querySelector(".income-expense-page")).not.toHaveTextContent(/28,600|12,480|16,119/);
    expect(screen.getByRole("heading", { level: 1, name: "收支" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("分析卡只剩瀑布/资金流向两个 tab，默认瀑布", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    const waterfallTab = screen.getByRole("tab", { name: "瀑布" });
    const sankeyTab = screen.getByRole("tab", { name: "资金流向" });
    expect(waterfallTab).toHaveAttribute("aria-selected", "true");
    expect(sankeyTab).toHaveAttribute("aria-selected", "false");
    // 排行 tab 已删除（V1：语义由 Composition Card 承担）
    expect(screen.queryByRole("tab", { name: "排行" })).not.toBeInTheDocument();
    // 默认瀑布：瀑布图可见
    expect(screen.getByRole("img", { name: "收支瀑布图" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "资金流向桑基图" })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("箭头导航在 2 个 tab 间循环", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    const tablist = screen.getByRole("tablist", { name: "分析视图" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" }); // waterfall → sankey
    expect(screen.getByRole("tab", { name: "资金流向" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tablist, { key: "ArrowRight" }); // sankey → waterfall（循环）
    expect(screen.getByRole("tab", { name: "瀑布" })).toHaveAttribute("aria-selected", "true");
    vi.unstubAllGlobals();
  });

  it("切换到资金流向 tab 渲染 Sankey 资金流向图", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "资金流向" }));
    expect(screen.getByRole("tab", { name: "资金流向" })).toHaveAttribute("aria-selected", "true");
    // 数据完整（fx_complete=true 且 top_expenses 两行有效）→ Sankey 正常出图
    expect(screen.getByRole("img", { name: "资金流向桑基图" })).toBeInTheDocument();
    expect(screen.queryByText("资金流向图暂不可用")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("切换到瀑布 tab 且数据对平时渲染收支瀑布图", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "瀑布" }));
    expect(screen.getByRole("tab", { name: "瀑布" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("img", { name: "收支瀑布图" })).toBeInTheDocument();
    expect(screen.queryByText("瀑布图已阻断")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("数据不对平时瀑布 tab 显示阻断态而非图表", async () => {
    // 默认 INCOME_STATEMENT：expenses 两行求和 9280.50 ≠ 总支出 12480.50 → G3 阻断
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "瀑布" }));
    expect(screen.getByText("瀑布图已阻断")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "收支瀑布图" })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------
  // Composition Analytics V1（WP5）
  // -------------------------------------------------------------------

  it("请求 expense-breakdown（2026-10-16 门户化）与 income-statement", async () => {
    // 历史断言为「不再请求 expense-breakdown」：Composition Analytics V1（WP5）曾
    // 用构成卡替换它。2026-10-16 费用分析分区回归门户，断言随之反转。
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("expense-breakdown")
        ? EXPENSE_BREAKDOWN
        : CONSISTENT_INCOME_STATEMENT;
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("expense-breakdown"))).toBe(true);
    expect(urls.some((u) => u.includes("income-statement"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("Composition 卡位于期间比较之后、analytics 之前；明细在 analytics 之后", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("支出构成分析")).toBeInTheDocument());
    const comparison = screen.getByText(/对比上期/);
    const composition = screen.getByLabelText("支出构成分析");
    const analytics = screen.getByRole("region", { name: "收支分析" });
    const details = screen.getByRole("region", { name: "收支明细" });
    expect(comparison.compareDocumentPosition(composition) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composition.compareDocumentPosition(analytics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(analytics.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("默认支出侧：donut + category 行携带 report_side/report_category 深链", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage();
    const card = await screen.findByLabelText("支出构成分析");
    await waitFor(() => expect(within(card).getByTestId("echart")).toBeInTheDocument());
    const link = within(card).getByRole("link", { name: /居住/ }) as HTMLAnchorElement;
    const href = new URL(link.getAttribute("href")!, "http://localhost");
    expect(href.pathname).toBe("/transactions");
    // 日期来自后端 response period（2026-08-01/31），URLSearchParams 编码
    expect(href.searchParams.get("start")).toBe("2026-08-01");
    expect(href.searchParams.get("end")).toBe("2026-08-31");
    expect(href.searchParams.get("report_side")).toBe("expense");
    expect(href.searchParams.get("report_category")).toBe("居住");
    expect(href.searchParams.get("txnType")).toBeNull(); // 不带 txnType
    vi.unstubAllGlobals();
  });

  it("勾稽不一致（明细 ≠ 权威合计）→ contract-blocked：无 donut、无链接、金额可见", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    const card = await screen.findByLabelText("支出构成分析");
    await waitFor(() => expect(within(card).getByText(/构成比例暂不可用/)).toBeInTheDocument());
    expect(within(card).queryByTestId("echart")).toBeNull();
    expect(within(card).queryByRole("link")).toBeNull();
    expect(within(card).getAllByText("居住").length).toBeGreaterThanOrEqual(1); // amount-only 披露
    expect(card.textContent).not.toContain("%");
    vi.unstubAllGlobals();
  });

  it("退款冲减进入「冲减项（退款）」并保留负号；冲回行不链接", async () => {
    const WITH_REFUND = {
      ...CONSISTENT_INCOME_STATEMENT,
      sections: CONSISTENT_INCOME_STATEMENT.sections.map((s: any) =>
        s.key === "expenses"
          ? {
              ...s,
              subtotal_base: "8980.50",
              rows: [
                ...s.rows,
                { label: "购物", currency: "CNY", amount: "-300.00", amount_base: "-300.00", count: 1 },
              ],
            }
          : s,
      ),
      summary: {
        total_income_cny: "28600.00",
        total_expenses_cny: "8980.50",
        net_result_cny: "19619.50",
        savings_rate_pct: "68.60",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(WITH_REFUND), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderPage();
    const card = await screen.findByLabelText("支出构成分析");
    await waitFor(() => expect(within(card).getByText("冲减项（退款）")).toBeInTheDocument());
    const offsetRow = within(card).getByText("购物").closest("li")!;
    expect(offsetRow.textContent).toContain("−300.00");
    expect(offsetRow.querySelector("a")).toBeNull(); // offset 不可点
    vi.unstubAllGlobals();
  });

  it("?side=income 直达收入侧；side 切换两侧筛选独立", async () => {
    vi.stubGlobal("fetch", mockFetchConsistent());
    renderPage("/income-expense?side=income");
    const card = await screen.findByLabelText("收入构成分析");
    await waitFor(() => expect(within(card).getByRole("link", { name: /工资/ })).toBeInTheDocument());
    const link = within(card).getByRole("link", { name: /工资/ }) as HTMLAnchorElement;
    const href = new URL(link.getAttribute("href")!, "http://localhost");
    expect(href.searchParams.get("report_side")).toBe("income");
    expect(href.searchParams.get("report_category")).toBe("工资");
    // 支出侧筛选不受收入侧筛选影响：默认 all
    expect(within(card).getByRole("button", { name: "筛选" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("FX 不完整 → CompositionFxBlocked：无 donut、无百分比、原币分组披露", async () => {
    const FX_BLOCKED = {
      ...CONSISTENT_INCOME_STATEMENT,
      fx_complete: false,
      data_complete: false,
      summary: {
        ...CONSISTENT_INCOME_STATEMENT.summary,
        total_income_cny: null,
        total_expenses_cny: null,
        net_result_cny: null,
        savings_rate_pct: null,
        missing_currencies: ["EUR"],
      },
      sections: CONSISTENT_INCOME_STATEMENT.sections.map((s: any) => ({
        ...s,
        rows: s.rows.map((r: any) => ({ ...r, amount_base: null })),
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async () => {
      // 逐月趋势查询也走 income-statement；全部返回同一 FX-blocked 响应即可
      return new Response(JSON.stringify(FX_BLOCKED), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    const card = await screen.findByLabelText("支出构成分析");
    await waitFor(() => expect(within(card).getByText("汇率不完整，暂无法计算完整支出构成占比")).toBeInTheDocument());
    expect(within(card).queryByTestId("echart")).toBeNull();
    expect(card.textContent).not.toContain("%");
    expect(within(card).getAllByText("报表汇率不完整，未提供折算").length).toBeGreaterThanOrEqual(1);
    vi.unstubAllGlobals();
  });
});

describe("IncomeExpensePage — Other 展开态重置（P3-1，spec §6.4）", () => {
  // 9 个支出分类（100..900，合计 4500）→ Top7+Other
  const TOP8 = (() => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      label: `类目${i + 1}`, currency: "CNY",
      amount: String((i + 1) * 100) + ".00", amount_base: String((i + 1) * 100) + ".00",
      count: i + 1,
    }));
    return {
      ...CONSISTENT_INCOME_STATEMENT,
      summary: {
        total_income_cny: "28600.00", total_expenses_cny: "4500.00",
        net_result_cny: "24100.00", savings_rate_pct: "84.27",
      },
      sections: [
        CONSISTENT_INCOME_STATEMENT.sections[0],
        { key: "expenses", title: "支出", rows, subtotal_base: "4500.00" },
      ],
    };
  })();

  function top8Fetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      // period 随请求参数变化，使 response.period 与已提交期间一致
      const url = new URL(String(input), "http://localhost");
      const start = url.searchParams.get("start_date") ?? "2026-08-01";
      const end = url.searchParams.get("end_date") ?? "2026-08-31";
      return new Response(JSON.stringify({
        ...TOP8,
        period: { start_date: start, end_date: end },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  async function expandOther(card: HTMLElement) {
    await waitFor(() => expect(within(card).getByRole("button", { name: /其他/ })).toBeInTheDocument());
    fireEvent.click(within(card).getByRole("button", { name: /其他/ }));
    expect(within(card).getByRole("button", { name: /其他/ })).toHaveAttribute("aria-expanded", "true");
  }

  it("side toggle 往返后 Other 重置为折叠", async () => {
    vi.stubGlobal("fetch", top8Fetch());
    renderPage();
    const card = await screen.findByLabelText("支出构成分析");
    await expandOther(card);

    fireEvent.click(within(card).getByRole("button", { name: "收入" }));
    const incomeCard = await screen.findByLabelText("收入构成分析");
    fireEvent.click(within(incomeCard).getByRole("button", { name: "支出" }));

    const expenseCard = await screen.findByLabelText("支出构成分析");
    await waitFor(() =>
      expect(within(expenseCard).getByRole("button", { name: /其他/ })).toHaveAttribute("aria-expanded", "false"));
    vi.unstubAllGlobals();
  });

  it("period change 后 Other 重置为折叠", async () => {
    vi.stubGlobal("fetch", top8Fetch());
    renderPage();
    await expandOther(await screen.findByLabelText("支出构成分析"));

    // 切换期间：新 query key 先经骨架屏，卡片重挂载 + effect 兜底折叠
    fireEvent.click(screen.getByRole("button", { name: "本月" }));
    const nextCard = await screen.findByLabelText("支出构成分析");
    await waitFor(() =>
      expect(within(nextCard).getByRole("button", { name: /其他/ })).toBeInTheDocument());
    expect(within(nextCard).getByRole("button", { name: /其他/ })).toHaveAttribute("aria-expanded", "false");
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// WP05（U05）：深链期间初始化与非法区间显式报错
// ---------------------------------------------------------------------------

describe("IncomeExpensePage deep-link period (WP05)", () => {
  it("URL start/end 初始化查询期间（首页钻取保持日期）", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/income-expense?start=2026-08-01&end=2026-08-31");
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls[0]).toContain("start_date=2026-08-01");
    expect(incomeCalls[0]).toContain("end_date=2026-08-31");
    vi.unstubAllGlobals();
  });

  it("深链非法区间（起>止）→ 显式错误说明，不静默换期间", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage("/income-expense?start=2026-08-31&end=2026-08-01");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    // 工具栏与深链横幅同文案（getAllByText）：起始>截止 双重可见
    expect(screen.getAllByText(/起始日期不能晚于截止日期/).length).toBeGreaterThanOrEqual(1);
    vi.unstubAllGlobals();
  });

  it("深链非 ISO 日期 → 显式错误说明", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage("/income-expense?start=2026%2F08%2F01&end=2026-08-31");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// RV-05：非法期间禁请求 / 预设 Berlin / 历史同步 / 修正后解除阻塞
// ---------------------------------------------------------------------------

describe("IncomeExpensePage invalid-period gating (RV-05)", () => {
  it("深链非法区间（起>止）→ 横幅 + 零 income-statement 请求", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/income-expense?start=2026-08-31&end=2026-08-01");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("深链不存在的日期（02-30）→ 横幅 + 零 income-statement 请求", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/income-expense?start=2026-02-01&end=2026-02-30");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("RRV-04：非法起始日未修正、只改截止日 → 继续阻塞，零请求", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/income-expense?start=2026-02-30&end=2026-03-01");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    // 只改截止日（起始日 2026-02-30 仍非法）→ 不得解除阻塞
    fireEvent.change(screen.getByLabelText("截止日期"), { target: { value: "2026-03-02" } });
    await waitFor(() => expect(screen.getByText(/日期不存在/)).toBeInTheDocument());
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("RRV-04：非法起始日未修正、只改起始日为另一非法值 → 继续阻塞", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/income-expense?start=2026-02-30&end=2026-03-01");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-02-31" } });
    await waitFor(() => expect(screen.getByText(/日期不存在/)).toBeInTheDocument());
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("用户在工具栏修正非法区间后 → 查询解除阻塞", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/income-expense?start=2026-08-31&end=2026-08-01");
    expect(await screen.findByText(/期间无效/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("截止日期"), { target: { value: "2026-08-31" } });
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls.some((u) => u.includes("start_date=2026-08-01") && u.includes("end_date=2026-08-31"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("正式路由历史变化 → 表单与请求跟随新 URL（七月）", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = renderPage("/reports/income-expense?start=2026-08-01&end=2026-08-31");
    await waitFor(() => expect(screen.getByRole("img", { name: "最近6个月收支柱状图" })).toBeInTheDocument());
    unmount();
    renderPage("/reports/income-expense?start=2026-07-01&end=2026-07-31");
    await waitFor(() => {
      expect((screen.getByLabelText("起始日期") as HTMLInputElement).value).toBe("2026-07-01");
      expect((screen.getByLabelText("截止日期") as HTMLInputElement).value).toBe("2026-07-31");
    });
    const incomeCalls = fetchMock.mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes("income-statement"));
    expect(incomeCalls.some((u) => u.includes("start_date=2026-07-01") && u.includes("end_date=2026-07-31"))).toBe(true);
    vi.unstubAllGlobals();
  });
});

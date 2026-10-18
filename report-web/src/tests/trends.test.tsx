import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TrendsPage } from "../pages/Trends";
import { AppHeaderProvider } from "../components/AppHeader";
import { ToastProvider } from "../components/Toast";

// 冻结 ECharts 绘制：无 jsdom canvas，仅需 option 传参与占位。
vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  trendsBarOption: () => ({}),
  exposureBarOption: () => ({}),
}));

const TRENDS = {
  schema_version: "1.0",
  as_of: "2026-08-07",
  current_month: "2026-08",
  comparison_window_months: 6,
  base_currency: "CNY",
  fx_complete: true,
  missing_currencies: [],
  categories_count: 1,
  anomalies_count: 1,
  trends: [
    {
      category: "餐饮",
      current_month_amount: "3000.00",
      historical_monthly_average: "1000.00",
      deviation_percentage: 200,
      fx_complete: true,
      missing_currencies: [],
      anomaly: true,
    },
  ],
};

const TRENDS_WITH_MISSING_FX = {
  ...TRENDS,
  fx_complete: false,
  missing_currencies: ["USD"],
  categories_count: 2,
  anomalies_count: 0,
  trends: [
    ...TRENDS.trends,
    {
      category: "旅行",
      current_month_amount: null,
      historical_monthly_average: null,
      deviation_percentage: null,
      fx_complete: false,
      missing_currencies: ["USD"],
      anomaly: false,
    },
  ],
};

const EXPOSURE = {
  schema_version: "1.0",
  base_currency: "CNY",
  total_net_worth_cny: "1250.00",
  fx_rates_date: "2026-08-07",
  fx_complete: true,
  missing_currencies: [],
  exposures: [
    { currency: "CNY", balance: "1000.00", cny_value: "1000.00", percentage: 80 },
    { currency: "EUR", balance: "33.33", cny_value: "250.00", percentage: 20 },
  ],
};

const EXPOSURE_WITH_MISSING_FX = {
  ...EXPOSURE,
  fx_complete: false,
  missing_currencies: ["CHF"],
  exposures: [
    ...EXPOSURE.exposures,
    { currency: "CHF", balance: "73540.25", cny_value: null, percentage: null },
  ],
};

const ANOMALIES = {
  schema_version: "1.0",
  checked_at: "2026-08-09T10:00:00+00:00",
  count: 2,
  anomalies: [
    {
      id: "health:backup",
      source: "health:backup",
      severity: "critical",
      message: "备份过期或从未成功",
      category: null,
      amount: null,
      currency: null,
    },
    {
      id: "spending_trend:餐饮:2026-08",
      source: "spending:餐饮",
      severity: "warning",
      message: "类别「餐饮」本月支出较历史月均偏差 90.8%",
      category: "餐饮",
      amount: "2480.50",
      currency: "CNY",
    },
  ],
};

function anomaliesFor(url: string) {
  if (url.includes("anomalies")) return ANOMALIES;
  if (url.includes("spending-trends")) return TRENDS;
  if (url.includes("currency-exposure")) return EXPOSURE;
  return null;
}

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = anomaliesFor(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function renderPage(): RenderResult {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AppHeaderProvider>
          <QueryClientProvider client={qc}>
            <TrendsPage />
          </QueryClientProvider>
        </AppHeaderProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("TrendsPage", () => {
  beforeEach(() => localStorage.clear());

  it("渲染支出趋索异常雷达、偏差表与币种敞口", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "支出趋势" })).toBeInTheDocument());
    expect(screen.getByRole("table", { name: "币种敞口" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "支出趋势类别卡片" }).children).toHaveLength(1);
    expect(screen.getByRole("list", { name: "币种敞口卡片" }).children).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "本月支出" })).toHaveClass("is-num");
    expect(screen.getByRole("columnheader", { name: "折 CNY" })).toHaveClass("is-num");
    expect(screen.getByRole("list", { name: "严重异常" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "警告异常" })).toBeInTheDocument();
    expect(screen.getAllByText("200%").length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("错误状态保留趋势标题与页面壳", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "趋势加载失败" }), { status: 500 })));
    renderPage();
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(screen.getByRole("heading", { level: 1, name: "趋势" })).toBeInTheDocument();
    expect(document.querySelector(".trends-page")).toContainElement(alert);
    vi.unstubAllGlobals();
  });

  it("趋索与敞口均为空时保留 H1 与两组原因说明", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("anomalies")
        ? { ...ANOMALIES, count: 0, anomalies: [] }
        : url.includes("spending-trends")
        ? { ...TRENDS, categories_count: 0, anomalies_count: 0, trends: [] }
        : { ...EXPOSURE, total_net_worth_cny: "0", exposures: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无支出数据")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "趋势" })).toBeInTheDocument();
    expect(screen.getByText("本月或历史窗口内没有支出记录。")).toBeInTheDocument();
    expect(screen.getByText("汇率不完整或没有资产/负债账户。")).toBeInTheDocument();
    expect(screen.getByText("暂无敞口数据")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("解析并展示 current_month 与 comparison_window_months（头信息）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByText("本月 2026-08 · 对比 6 个月")).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("解析并展示 fx_rates_date（汇率日期）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByText("汇率日期 2026-08-07")).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("支出趋索 fx 不完整类别按 汇率缺失/— 披露并带缺汇率标签，绝不渲染为 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("anomalies")
        ? ANOMALIES
        : url.includes("spending-trends")
        ? TRENDS_WITH_MISSING_FX
        : EXPOSURE;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "支出趋势" })).toBeInTheDocument());
    expect(screen.getAllByText("汇率缺失").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("缺汇率").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/汇率不完整：USD/)).toBeInTheDocument();
    expect(screen.queryByText(/0(\.00)?\s*CNY/)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("缺失汇率按 汇率缺失/— 披露，绝不渲染为 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("anomalies")
        ? ANOMALIES
        : url.includes("spending-trends")
        ? TRENDS
        : EXPOSURE_WITH_MISSING_FX;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "币种敞口" })).toBeInTheDocument());
    expect(screen.getAllByText("汇率缺失").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/缺少汇率：CHF/)).toBeInTheDocument();
    expect(screen.queryByText(/0(\.00)?\s*CNY/)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("渲染 ReportTimestampFooter 并回放生成时间", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "支出趋势" })).toBeInTheDocument());
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent(/数据生成时间/);
    vi.unstubAllGlobals();
  });
});

describe("ExceptionRadar integration on Trends", () => {
  beforeEach(() => localStorage.clear());

  it("按严重度分组展示异常流，支持暂不提醒 7 天 -> 勾选显示已静音恢复", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await waitFor(() => expect(screen.getByRole("list", { name: "严重异常" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "严重" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "警告" })).toBeInTheDocument();
    const severe = screen.getByRole("heading", { name: "严重" });
    const warning = screen.getByRole("heading", { name: "警告" });
    expect(severe.compareDocumentPosition(warning)).toBe(4);

    // 警告组的「更多操作」-> 暂不提醒 7 天。Radix 菜单只认指针事件。
    const user = userEvent.setup();
    const more = screen.getAllByRole("button", { name: /^更多操作/ });
    await user.click(more[1]);
    await user.click(await screen.findByRole("menuitem", { name: "暂不提醒 · 7 天" }));

    // 警告项已静音并隐藏，严重项仍可见，已静音计数可见
    await waitFor(() => expect(screen.queryByText("类别「餐饮」本月支出较历史月均偏差 90.8%")).not.toBeInTheDocument());
    expect(screen.getByText("备份过期或从未成功")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("已静音 1 项")).toBeInTheDocument());

    // 勾选"显示已静音异常"恢复可见并带已静音标记
    fireEvent.click(screen.getByLabelText("显示已静音异常"));
    await waitFor(() => expect(screen.getByText("类别「餐饮」本月支出较历史月均偏差 90.8%")).toBeInTheDocument());
    expect(screen.getAllByText("已静音").length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("永久关闭在重新挂载后仍隐藏该异常，且提供 7 天/30 天/不再提醒此异常三档", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const first = renderPage();
    await waitFor(() => expect(screen.getByRole("list", { name: "警告异常" })).toBeInTheDocument());

    const warningMessage = "类别「餐饮」本月支出较历史月均偏差 90.8%";
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^更多操作/ })[1]);
    expect(await screen.findByRole("menuitem", { name: "暂不提醒 · 7 天" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "暂不提醒 · 30 天" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "暂不提醒 · 不再提醒此异常" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "暂不提醒 · 不再提醒此异常" }));
    await waitFor(() => expect(screen.queryByText(warningMessage)).not.toBeInTheDocument());

    first.unmount();
    renderPage();
    await waitFor(() => expect(screen.getByRole("list", { name: "严重异常" })).toBeInTheDocument());
    expect(screen.queryByText(warningMessage)).not.toBeInTheDocument();
    expect(screen.getByText("已静音 1 项")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeriodToolbar } from "../components/PeriodToolbar";
import { ToastProvider } from "../components/Toast";
import { IncomeExpensePage } from "../pages/IncomeExpense";
import { TransactionsPage } from "../pages/Transactions";

vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  monthlyBarOption: () => ({}),
}));

const REPORT = {
  schema_version: "1.0",
  report_id: "test",
  report_type: "test",
  generated_at: "2026-08-09T00:00:00Z",
  base_currency: "CNY",
  fx_complete: true,
  data_complete: true,
  warnings: [],
  summary: {
    total_income_cny: "1000.00",
    total_expenses_cny: "400.00",
    net_result_cny: "600.00",
    savings_rate_pct: "60.00",
  },
  sections: [{ key: "top_expenses", title: "支出", rows: [], subtotal_base: "400.00" }],
};

const TRANSACTIONS = {
  schema_version: "1.0",
  period_from: "2026-07-11",
  period_to: "2026-08-09",
  total: 1,
  offset: 0,
  limit: 100,
  fx_notes: [],
  rows: [{
    date: "2026-08-01",
    type: "withdrawal",
    description: "咖啡",
    category: "餐饮",
    source: "存款",
    destination: "商户",
    amount_native: "35.00",
    currency: "CNY",
    amount_base: "35.00",
    fx_exact: true,
    tags: [],
    journal_id: "j1",
  }],
};

function renderWithQueryClient(page: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // WP-03 后明细页使用 useSearchParams，测试渲染需路由上下文
  return render(
    <MemoryRouter>
      <ToastProvider>
        <QueryClientProvider client={client}>{page}</QueryClientProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PeriodToolbar", () => {
  it("为两个日期字段提供可见标签和稳定的表单字段契约", () => {
    const onFromDateChange = vi.fn();
    const onToDateChange = vi.fn();

    render(
      <PeriodToolbar
        fromDate="2026-01-01"
        toDate="2026-08-09"
        onFromDateChange={onFromDateChange}
        onToDateChange={onToDateChange}
      />,
    );

    const from = screen.getByLabelText("起始日期");
    const to = screen.getByLabelText("截止日期");
    expect(from).toHaveAttribute("id", "period-from");
    expect(from).toHaveAttribute("name", "from_date");
    expect(to).toHaveAttribute("id", "period-to");
    expect(to).toHaveAttribute("name", "to_date");

    fireEvent.change(from, { target: { value: "2026-02-01" } });
    fireEvent.change(to, { target: { value: "2026-07-31" } });
    expect(onFromDateChange).toHaveBeenCalledWith("2026-02-01");
    expect(onToDateChange).toHaveBeenCalledWith("2026-07-31");
  });

  it("在起始日期晚于截止日期时显示字段关联的错误说明", () => {
    render(
      <PeriodToolbar
        fromDate="2026-08-10"
        toDate="2026-08-09"
        onFromDateChange={() => {}}
        onToDateChange={() => {}}
      />,
    );

    const error = screen.getByText("起始日期不能晚于截止日期");
    expect(error).toHaveAttribute("id", "period-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("起始日期")).toHaveAttribute("aria-describedby", "period-error");
    expect(screen.getByLabelText("截止日期")).toHaveAttribute("aria-describedby", "period-error");
  });

  it("收支页自定义期间无效时保留最后有效查询且不发新请求", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(REPORT), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderWithQueryClient(<IncomeExpensePage />);
    await waitFor(() => expect(screen.getByText("最近6个月收支趋势")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    const requestCount = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-12-31" } });

    // RRV-04：工具栏整体非法 → 顶部阻塞横幅（role=alert 可能多处，取横幅文案）。
    expect(screen.getByText(/期间无效：起始日期不能晚于截止日期/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(requestCount));
  });

  it("presets 渲染快捷芯片、高亮激活项并回调 onPresetChange", () => {
    const onPresetChange = vi.fn();
    render(
      <PeriodToolbar
        fromDate="2026-08-01"
        toDate="2026-08-16"
        onFromDateChange={() => {}}
        onToDateChange={() => {}}
        presets={[
          { key: "30d", label: "近30天" },
          { key: "month", label: "本月" },
          { key: "lastMonth", label: "上月" },
          { key: "year", label: "今年" },
          { key: "custom", label: "自定义" },
        ]}
        activePreset="30d"
        onPresetChange={onPresetChange}
      />,
    );

    const group = screen.getByRole("group", { name: "快捷期间" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "近30天" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "本月" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "上月" }));
    expect(onPresetChange).toHaveBeenCalledWith("lastMonth");
  });

  it("不传 presets 时保持原有日期区间控件（无快捷芯片）", () => {
    render(
      <PeriodToolbar
        fromDate="2026-01-01"
        toDate="2026-08-09"
        onFromDateChange={() => {}}
        onToDateChange={() => {}}
      />,
    );
    expect(screen.queryByRole("group", { name: "快捷期间" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("起始日期")).toBeInTheDocument();
    expect(screen.getByLabelText("截止日期")).toBeInTheDocument();
  });

  it("明细页期间无效时保留最后有效查询且不发新请求", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? { base_currency: "CNY", as_of: "2026-08-09", accounts: [] }
        : TRANSACTIONS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithQueryClient(<TransactionsPage />);
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());
    const requestCount = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-12-31" } });

    expect(screen.getByRole("alert")).toHaveTextContent("起始日期不能晚于截止日期");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(requestCount));
  });
});

import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ExpenseBreakdownSection } from "../components/composition/ExpenseBreakdownSection";

const SECTION = {
  key: "top_expenses",
  title: "前 N 大费用",
  subtotal_base: "9280.50",
  rows: [
    {
      label: "居住", currency: "CNY", amount: "6800.00",
      amount_base: "6800.00", count: 1,
      extra: {
        compare_amount: "6800.00", change: "0.00", change_pct: "0.0",
        new_spend: false, share_pct: "73.3", fx_converted: true,
      },
    },
    {
      label: "餐饮", currency: "CNY", amount: "2480.50",
      amount_base: "2480.50", count: 23,
      extra: {
        compare_amount: "2170.00", change: "310.50", change_pct: "14.3",
        new_spend: false, share_pct: "26.7", fx_converted: true,
      },
    },
  ],
};

function envelope(over: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    report_id: "eb-1",
    report_type: "expense_breakdown",
    generated_at: "2026-10-16T10:00:00+00:00",
    base_currency: "CNY",
    period: { start_date: "2026-10-01", end_date: "2026-10-31" },
    fx_complete: true,
    data_complete: true,
    warnings: [] as string[],
    summary: {
      top_n: 10,
      global_ranking_available: true,
      ranking_basis: "cny",
      total_expenses_cny: "9280.50",
      compare_period: { start_date: "2026-09-01", end_date: "2026-09-30" },
      compare_total_expenses_cny: "8970.00",
      candidate_categories: 2,
      unclassified_count: 0,
      missing_currencies: [],
    },
    sections: [SECTION],
    ...over,
  };
}

function renderSection(ui: React.ReactElement, url = "/reports/income-expense") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExpenseBreakdownSection", () => {
  it("渲染分类排名与环比数字", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(envelope()), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    ));
    renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
        compareStartDate="2026-09-01"
        compareEndDate="2026-09-30"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("居住")).toBeInTheDocument(),
    );
    expect(screen.getByText("餐饮")).toBeInTheDocument();
    // 环比：餐饮 +14.3%
    expect(screen.getByText(/\+14\.3%/)).toBeInTheDocument();
    // 占比
    expect(screen.getByText(/73\.3%/)).toBeInTheDocument();
  });

  it("新增支出显示「新增」而非无穷大的变化率", async () => {
    const rows = [
      {
        ...SECTION.rows[0],
        extra: {
          compare_amount: null, change: null, change_pct: null,
          new_spend: true, share_pct: "50.0", fx_converted: true,
        },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify(envelope({
          sections: [{ ...SECTION, rows }],
        })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
        compareStartDate="2026-09-01"
        compareEndDate="2026-09-30"
      />,
    );

    await waitFor(() => expect(screen.getByText("新增")).toBeInTheDocument());
    expect(screen.queryByText(/Infinity|NaN/)).not.toBeInTheDocument();
  });

  it("Top N 截断语义可见：注明不用于对账", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(envelope()), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    ));
    renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
      />,
    );

    await waitFor(() =>
      expect(screen.getAllByText(/前 10 大费用/).length).toBeGreaterThan(0),
    );
    // 勾稽门禁（waterfallReconciliation）：此表为 Top N 截断，严禁用于对账。
    expect(screen.getByText(/不用于对账|不可用于对账/)).toBeInTheDocument();
  });

  it("缺汇率降级：按币种分别排名并明示，不跨币种硬比", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify(envelope({
          fx_complete: false,
          data_complete: false,
          warnings: ["缺少汇率，无法生成全局 Top N；已按币种分别排名"],
          summary: {
            top_n: 10,
            global_ranking_available: false,
            ranking_basis: "per_currency",
            total_expenses_cny: null,
            compare_period: null,
            compare_total_expenses_cny: null,
            candidate_categories: 2,
            unclassified_count: 0,
            missing_currencies: ["JPY"],
          },
        })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
      />,
    );

    await waitFor(() =>
      expect(screen.getAllByText(/按币种分别排名/).length).toBeGreaterThan(0),
    );
    // 数据不完整时不得静默折算
    expect(screen.getByText(/数据不完整|缺汇率/)).toBeInTheDocument();
  });

  it("无数据时显示空态而非空白表格", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify(envelope({ sections: [{ ...SECTION, rows: [] }] })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("暂无费用数据")).toBeInTheDocument(),
    );
  });

  it("环比涨/跌用已定义的语义 delta token 着色（回归：曾引用不存在的 --positive/negative-600）", async () => {
    // 餐饮 +14.3%（支出上涨 → delta-negative 红）；居住 -5.0%（支出下降 → delta-positive 绿）。
    const rows = [
      {
        ...SECTION.rows[1],
        extra: {
          compare_amount: "2170.00", change: "310.50", change_pct: "14.3",
          new_spend: false, share_pct: "60.0", fx_converted: true,
        },
      },
      {
        ...SECTION.rows[0],
        label: "居住",
        extra: {
          compare_amount: "7158.00", change: "-358.00", change_pct: "-5.0",
          new_spend: false, share_pct: "40.0", fx_converted: true,
        },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify(envelope({ sections: [{ ...SECTION, rows }] })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ));
    const { container } = renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
        compareStartDate="2026-09-01"
        compareEndDate="2026-09-30"
      />,
    );

    await waitFor(() => expect(screen.getByText(/\+14\.3%/)).toBeInTheDocument());
    const down = screen.getByText(/-5\.0%/).closest("td");
    const up = screen.getByText(/\+14\.3%/).closest("td");
    expect(up?.className).toContain("var(--delta-negative)");
    expect(down?.className).toContain("var(--delta-positive)");
    // 两个 class 里引用的变量都不允许是未定义名（容器内快速自检）。
    const referenced = [...container.innerHTML.matchAll(/var\(--([a-z0-9-]+)\)/gi)].map((m) => m[1]);
    expect(referenced).not.toContain("positive-600");
    expect(referenced).not.toContain("negative-600");
  });

  it("请求带上对比期参数（仅当提供时）", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(envelope()), {
        status: 200, headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSection(
      <ExpenseBreakdownSection
        startDate="2026-10-01"
        endDate="2026-10-31"
        compareStartDate="2026-09-01"
        compareEndDate="2026-09-30"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("start_date=2026-10-01");
    expect(url).toContain("compare_start_date=2026-09-01");
  });
});

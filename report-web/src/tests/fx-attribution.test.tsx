import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FxAttributionPage } from "../pages/FxAttribution";

vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  fxAttributionOption: () => ({}),
}));

const DATA = {
  schema_version: "1.0",
  period_from: "2026-01-01",
  period_to: "2026-08-07",
  total_net_worth_change_cny: "5000.00",
  total_savings_contribution_cny: "4800.00",
  total_fx_contribution_cny: "200.00",
  fx_contribution_percentage: 4,
  by_currency: [
    {
      currency: "EUR", start_balance: "100.00", end_balance: "150.00",
      start_rate: 7.5, end_rate: 7.6,
      savings_contribution_cny: "380.00", fx_contribution_cny: "10.00", net_change_cny: "390.00",
    },
    {
      currency: "CNY", start_balance: "1000.00", end_balance: "5500.00",
      start_rate: 1, end_rate: 1,
      savings_contribution_cny: "4500.00", fx_contribution_cny: "0.00", net_change_cny: "4500.00",
    },
  ],
  notes: ["CHF 因历史汇率不可用被排除"],
};

describe("FxAttributionPage", () => {
  it("使用同一组币种行渲染桌面表格和移动卡片", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <FxAttributionPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("img", { name: "储蓄与汇率贡献" })).toBeInTheDocument());
    const table = screen.getByRole("table", { name: "币种拆解" });
    const cardList = screen.getByRole("list", { name: "币种拆解卡片视图" });
    expect(within(table).getAllByRole("row")).toHaveLength(DATA.by_currency.length + 1);
    expect(within(cardList).getAllByRole("listitem")).toHaveLength(DATA.by_currency.length);
    expect(within(table).getByRole("cell", { name: "EUR" })).toBeInTheDocument();
    expect(within(cardList).getByRole("heading", { name: "EUR" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("无效日期区间显示错误且不发起新的汇率归因查询", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <FxAttributionPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("table", { name: "币种拆解" })).toBeInTheDocument());
    const requestCount = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-12-31" } });

    expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("起始日期不能晚于截止日期"))).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(requestCount));
    vi.unstubAllGlobals();
  });

  it("KPI 严格使用后端标签「非汇率余额变动贡献」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <FxAttributionPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("img", { name: "储蓄与汇率贡献" })).toBeInTheDocument());
    expect(screen.getAllByText("非汇率余额变动贡献").length).toBeGreaterThan(0);
    expect(screen.queryByText("储蓄贡献")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("披露因历史汇率不可用而被排除的币种", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <QueryClientProvider client={qc}>
        <FxAttributionPage />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("CHF 因历史汇率不可用被排除"))).toBe(true));
    vi.unstubAllGlobals();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountBalanceRow, AccountBalances } from "../api/types";
import { MaskProvider } from "../components/MaskContext";
import { AccountsPage } from "../pages/Accounts";
import {
  applyFilters,
  DEFAULT_FILTERS,
  financialAccounts,
  groupOptions,
  sortAccounts,
  uniqueCurrencies,
} from "../utils/accounts";

const { useAccountBalancesMock } = vi.hoisted(() => ({
  useAccountBalancesMock: vi.fn(),
}));

vi.mock("../api/hooks", () => ({
  useAccountBalances: useAccountBalancesMock,
}));

vi.mock("../components/AppHeader", () => ({
  useAppHeader: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function acct(partial: Partial<AccountBalanceRow> & { id: string; name: string }): AccountBalanceRow {
  return {
    type: "asset",
    currency: "CNY",
    balance: "0",
    active: true,
    account_role: null,
    include_net_worth: true,
    group: null,
    group_title: null,
    balance_base: "0",
    fx_rate_date: "2026-08-07",
    fx_source: "fixed",
    ...partial,
  };
}

const ROWS = [
  acct({ id: "1", name: "银行甲存款", type: "asset", currency: "CNY", balance: "1000", group: "bank", group_title: "银行", balance_base: "1000" }),
  acct({ id: "2", name: "Broker A", type: "asset", currency: "EUR", balance: "100", group: "investments", group_title: "投资", balance_base: "750" }),
  acct({ id: "3", name: "信用钱包甲", type: "liabilities", currency: "CNY", balance: "-2300.00", group: "consumer_credit", group_title: "消费信贷", balance_base: "2300.00" }),
  acct({ id: "4", name: "旧卡", type: "liabilities", currency: "CNY", balance: "0", active: false, group: "credit_cards", group_title: "信用卡" }),
  acct({ id: "5", name: "迁移清算", type: "asset", currency: "CNY", balance: "500", include_net_worth: false }),
];

function balances(count: number): AccountBalances {
  return {
    base_currency: "CNY",
    as_of: "2026-08-07",
    fx_complete: true,
    missing_currencies: [],
    accounts: Array.from({ length: count }, (_, index) => acct({
      id: String(index + 1),
      name: `账户 ${String(index + 1).padStart(2, "0")}`,
      currency: index % 2 === 0 ? "CNY" : "EUR",
      balance: String(count - index),
      balance_base: String(count - index),
      group: "bank",
      group_title: "银行",
    })),
  };
}

function renderAccounts(data: AccountBalances, query: Record<string, unknown> = {}) {
  useAccountBalancesMock.mockReturnValue({
    data, error: null, isPending: false, isError: false, ...query,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MaskProvider, null, createElement(AccountsPage)),
  ));
}

describe("accounts 筛选排序", () => {
  it("financialAccounts 只保留资产/负债金融账户", () => {
    const mixed = [
      ...ROWS,
      acct({ id: "99", name: "餐饮", type: "expense", currency: "CNY", balance: "0" }),
      acct({ id: "98", name: "工资", type: "revenue", currency: "CNY", balance: "0" }),
    ];
    expect(financialAccounts(mixed).map((a) => a.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("默认过滤：隐藏停用、隐藏未计入净资产、隐藏停用零余额", () => {
    const result = applyFilters(ROWS, DEFAULT_FILTERS);
    expect(result.map((a) => a.id)).toEqual(["1", "2", "3"]);
  });

  it("搜索账户名称（不区分大小写）", () => {
    expect(applyFilters(ROWS, { ...DEFAULT_FILTERS, query: "broker a" }).map((a) => a.id)).toEqual(["2"]);
  });

  it("按负债/资产侧筛选", () => {
    expect(applyFilters(ROWS, { ...DEFAULT_FILTERS, side: "liability" }).map((a) => a.id)).toEqual(["3"]);
    expect(applyFilters(ROWS, { ...DEFAULT_FILTERS, side: "asset" }).map((a) => a.id)).toEqual(["1", "2"]);
  });

  it("按分组筛选，未分组用 pending", () => {
    expect(applyFilters(ROWS, { ...DEFAULT_FILTERS, group: "bank" }).map((a) => a.id)).toEqual(["1"]);
    expect(applyFilters(ROWS, { ...DEFAULT_FILTERS, group: "pending" }).map((a) => a.id)).toEqual([]);
  });

  it("按币种筛选", () => {
    expect(applyFilters(ROWS, { ...DEFAULT_FILTERS, currency: "EUR" }).map((a) => a.id)).toEqual(["2"]);
  });

  it("显示停用与未计入净资产账户", () => {
    const all = applyFilters(ROWS, {
      ...DEFAULT_FILTERS,
      includeInactive: true,
      hideZeroInactive: false,
      hideExcludedNetWorth: false,
    });
    expect(all).toHaveLength(5);
  });

  it("排序：原币金额降序 / 名称升序 / CNY 折算", () => {
    expect(sortAccounts(ROWS, "balance", "desc").map((a) => a.id)).toEqual(["1", "5", "2", "4", "3"]);
    // zh-CN 排序：汉字按拼音（旧卡/迁移清算/信用钱包甲/银行甲存款），拉丁字母在后
    expect(sortAccounts(ROWS, "name", "asc").map((a) => a.id)).toEqual(["4", "5", "3", "1", "2"]);
    expect(sortAccounts(ROWS, "balanceBase", "desc").map((a) => a.id)).toEqual(["3", "1", "2", "4", "5"]);
  });

  it("按折算金额排序时 null 无论升降序都固定在底部", () => {
    const rows = [
      acct({ id: "high", name: "高", balance_base: "100" }),
      acct({ id: "missing-a", name: "缺 A", balance_base: null }),
      acct({ id: "low", name: "低", balance_base: "10" }),
      acct({ id: "missing-b", name: "缺 B", balance_base: null }),
    ];
    expect(sortAccounts(rows, "balanceBase", "asc").map((row) => row.id))
      .toEqual(["low", "high", "missing-a", "missing-b"]);
    expect(sortAccounts(rows, "balanceBase", "desc").map((row) => row.id))
      .toEqual(["high", "low", "missing-a", "missing-b"]);
  });

  it("uniqueCurrencies / groupOptions", () => {
    expect(uniqueCurrencies(ROWS)).toEqual(["CNY", "EUR"]);
    const groups = groupOptions(ROWS);
    expect(groups).toContainEqual({ key: "bank", title: "银行" });
  });
});

describe("账户页面渲染", () => {
  it("筛选面板通过生产 Card flat 契约渲染", () => {
    const { container } = renderAccounts(balances(1));
    fireEvent.click(screen.getByRole("button", { name: "展开或收起账户筛选条件" }));

    const panel = container.querySelector(".account-filter-panel");
    expect(panel).toHaveClass("card", "card-flat");
    expect(panel?.querySelector(":scope > .card-body")).toBeInTheDocument();
  });

  it("桌面表格说明 CHF 缺率及无法折算的目标币种", () => {
    const data = balances(1);
    data.accounts[0] = {
      ...data.accounts[0],
      currency: "CHF",
      balance_base: null,
      fx_rate_date: null,
      fx_source: null,
    };
    renderAccounts(data);

    expect(within(screen.getByRole("table", { name: "账户余额" }))
      .getByText("CHF 汇率缺失，无法折算 CNY"))
      .toBeInTheDocument();
  });

  it("移动卡片同样掩蔽缺汇率金额（不渲染为零），与表格一致", () => {
    const data = balances(1);
    data.accounts[0] = {
      ...data.accounts[0],
      currency: "CHF",
      balance: "73540.25",
      balance_base: null,
      fx_rate_date: null,
      fx_source: null,
    };
    renderAccounts(data);

    const card = document.querySelector(".account-card");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("CHF 汇率缺失，无法折算 CNY")).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText(/折合 CNY\s*0/)).not.toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText("¥0.00")).not.toBeInTheDocument();
  });
});

describe("账户渐进显示", () => {
  it("首批只渲染 20 个账户，每次显示更多增加 20，全部显示后隐藏按钮", () => {
    const { container } = renderAccounts(balances(45));

    expect(container.querySelectorAll(".account-table tbody tr")).toHaveLength(20);
    expect(container.querySelectorAll(".account-card")).toHaveLength(20);
    expect(screen.getByText(/当前显示/)).toHaveTextContent("当前显示 20 个");

    fireEvent.click(screen.getByRole("button", { name: "显示更多账户" }));
    expect(container.querySelectorAll(".account-table tbody tr")).toHaveLength(40);

    fireEvent.click(screen.getByRole("button", { name: "显示更多账户" }));
    expect(container.querySelectorAll(".account-table tbody tr")).toHaveLength(45);
    expect(screen.queryByRole("button", { name: "显示更多账户" })).not.toBeInTheDocument();
  });

  it("筛选变化后重置为首批 20 个账户", async () => {
    const { container } = renderAccounts(balances(45));
    fireEvent.click(screen.getByRole("button", { name: "显示更多账户" }));
    expect(container.querySelectorAll(".account-table tbody tr")).toHaveLength(40);

    fireEvent.click(screen.getByRole("button", { name: "展开或收起账户筛选条件" }));
    fireEvent.change(screen.getByLabelText("币种"), { target: { value: "EUR" } });

    await waitFor(() => expect(container.querySelectorAll(".account-table tbody tr")).toHaveLength(20));
    expect(screen.getByRole("button", { name: "显示更多账户" })).toBeInTheDocument();
  });
});

describe("账户页新鲜度呈现 (REL-05)", () => {
  it("页脚用 as_of 呈现估值日（account-balances 契约无 generated_at）", () => {
    renderAccounts(balances(2));
    const footer = screen.getByTestId("report-timestamp-footer");
    expect(footer).toHaveTextContent("数据截止: 2026-08-07");
    // 幽灵字段：不得显示「数据生成时间」这一本页没有的信息
    expect(footer.textContent).not.toContain("数据生成时间");
  });

  it("刷新失败但缓存仍有上一次结果 → 顶部显示「数据可能过期」且错误横幅并存", () => {
    renderAccounts(balances(2), {
      error: new Error("刷新失败"),
      isError: true,
    });
    expect(screen.getByTestId("stale-data-banner")).toHaveTextContent(/数据可能过期/);
    expect(screen.getByText("刷新失败")).toBeInTheDocument();
    // 旧值仍在页面上渲染（桌面表格 + 移动卡片两处）——这正是必须披露的原因
    expect(screen.getAllByText("账户 01").length).toBeGreaterThan(0);
  });

  it("首次加载即失败（无缓存）→ 只报错误，不谎称过期", () => {
    renderAccounts(undefined as unknown as AccountBalances, {
      error: new Error("刷新失败"),
      isError: true,
    });
    expect(screen.queryByTestId("stale-data-banner")).toBeNull();
    expect(screen.getByText("刷新失败")).toBeInTheDocument();
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("—");
  });

  it("数据新鲜 → 不渲染过期横幅", () => {
    renderAccounts(balances(2));
    expect(screen.queryByTestId("stale-data-banner")).toBeNull();
  });
});

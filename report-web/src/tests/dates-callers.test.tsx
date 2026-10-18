// DATA-01（P0）回归锁定：任何进入 API start/end/from_date/to_date/as_of 的金融日期必须产自
// berlin* 函数（utils/dates.ts 头注释铁律 / WP05 / RV-05）。
//
// 覆盖范围：明细页/归因页的金融区间（首批）+ 资产负债页初始 as_of、maxDate 与
// AsOfToolbar 的今日最新/上月末/去年末预设（补漏：审计计划漏掉的同缺陷类站点）。
//
// 本文件把宿主时区改为 America/Los_Angeles，并用 vi.setSystemTime 把时钟钉在
// 「柏林已跨入次日、宿主仍在昨日」的瞬间（2026-08-31T22:30Z → 柏林 09-01 00:30，
// 洛杉矶 08-31 15:30）。此时宿主时区版 lastNDays/currentMonth/currentYear/lastMonth
// 与 berlin* 版本必然相差一天或一整月，因此任一调用点回退到宿主时区都会让断言失败。
// 跨年分叉另钉 2026-01-01T00:30Z（柏林 01-01 / 洛杉矶 2025-12-31），用于「去年末」。
// 注：pool 为 forks（每个测试文件独立进程），此处改 TZ 不会污染其他测试文件。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  berlinCurrentMonth,
  berlinCurrentYear,
  berlinLastMonth,
  berlinLastMonthEnd,
  berlinLastNDays,
  berlinLastNMonthEnds,
  berlinLastYearEnd,
  berlinTodayIso,
  currentMonth,
  currentYear,
  lastMonth,
  lastMonthEnd,
  lastNDays,
  lastNMonthEnds,
  lastYearEnd,
  todayIso,
} from "../utils/dates";
import { TransactionsPage } from "../features/transactions/TransactionsPage";
import { BalanceSheetPage } from "../pages/BalanceSheet";
import { FxAttributionPage } from "../pages/FxAttribution";
import { IncomeExpensePage } from "../pages/IncomeExpense";
import { AppHeaderProvider } from "../components/AppHeader";
import { ToastProvider } from "../components/Toast";

// vi.hoisted 先于 import 求值，确保被测模块首次调用 new Date() 前 TZ 已生效。
// tsconfig 未引入 @types/node，故按最小形状取 process；若未生效，
// 「前提」用例会因宿主/柏林日历日不再分叉而立即失败（不会静默放行）。
vi.hoisted(() => {
  const proc = (globalThis as unknown as { process?: { env: Record<string, string> } }).process;
  if (proc) proc.env.TZ = "America/Los_Angeles";
});

const CROSS_MIDNIGHT_UTC = "2026-08-31T22:30:00Z";
/** 跨年分叉瞬间：柏林 2026-01-01 00:30，洛杉矶仍是 2025-12-31 16:30。 */
const NEW_YEAR_CROSS_UTC = "2026-01-01T00:30:00Z";

const TRANSACTIONS_PATH = "/api/reports/web/transactions";
const FX_PATH = "/api/reports/web/fx-attribution";
const BALANCE_PATH = "/api/reports/personal-balance-sheet";
const INCOME_PATH = "/api/reports/income-statement";

vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  fxAttributionOption: () => ({}),
  monthlyBarOption: () => ({}),
}));

// 资产负债构成卡经 CompositionDonut 直接引 ChartWrapper 的 EChart（jsdom 无 canvas）
vi.mock("../components/ChartWrapper", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

const TRANSACTIONS = {
  schema_version: "1.0",
  period_from: "2026-08-03",
  period_to: "2026-09-01",
  total: 1,
  offset: 0,
  limit: 100,
  fx_notes: [],
  rows: [{
    date: "2026-09-01",
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

const FX = {
  schema_version: "1.0",
  period_from: "2026-01-01",
  period_to: "2026-09-01",
  total_net_worth_change_cny: "5000.00",
  total_savings_contribution_cny: "4800.00",
  total_fx_contribution_cny: "200.00",
  fx_contribution_percentage: 4,
  by_currency: [],
  notes: [],
};

// 与 balance-sheet.test.tsx 同构的最小可渲染载荷；balance_as_of 由后端给出，前端不参与
const BALANCE_SHEET = {
  schema_version: "1.0",
  source: "firefly_live",
  generated_at: "2026-09-01T10:00:00+00:00",
  base_currency: "CNY",
  balance_as_of: "2026-09-01",
  fx_complete: true,
  missing_currencies: [],
  warnings: [],
  summary: {
    total_assets_base: "312700.60",
    total_liabilities_base: "0",
    net_worth_base: "312700.60",
    included_account_count: 1,
    pending_mapping_count: 0,
  },
  groups: [
    {
      key: "cash",
      title: "现金",
      side: "asset",
      subtotal_base: "312700.60",
      accounts: [
        {
          id: "1",
          name: "日常储蓄账户",
          currency: "CNY",
          balance_native: "312700.60",
          balance_base: "312700.60",
          active: true,
          include_net_worth: true,
        },
      ],
    },
  ],
};

/** 每个金融端点最后一次请求的 query 参数（金融区间的真实出处）。 */
type Recorded = Record<string, URLSearchParams>;

function recordFetch() {
  const recorded: Recorded = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    recorded[url.pathname] = url.searchParams;
    const body = url.pathname.includes("account-balances")
      ? { base_currency: "CNY", as_of: "2026-09-01", accounts: [] }
      : url.pathname === TRANSACTIONS_PATH
        ? TRANSACTIONS
        : url.pathname === BALANCE_PATH
          ? BALANCE_SHEET
          : FX;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return recorded;
}

// 收支页 envelope（与 income-expense.test.tsx 同构，够渲染即可；断言只看请求参数）
const INCOME_STATEMENT = {
  schema_version: "1.0",
  report_id: "income-statement",
  report_type: "income_statement",
  generated_at: "2026-09-01T10:00:00+00:00",
  base_currency: "CNY",
  period: { start_date: "2026-09-01", end_date: "2026-09-01" },
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
      rows: [{ label: "工资", currency: "CNY", amount: "28600.00", amount_base: "28600.00", count: 1 }],
      subtotal_base: "28600.00",
    },
    {
      key: "expenses",
      title: "支出",
      rows: [{ label: "居住", currency: "CNY", amount: "12480.50", amount_base: "12480.50", count: 1 }],
      subtotal_base: "12480.50",
    },
  ],
};

/** 逐月趋势对同一端点并发多次请求，故这里保留全部调用而非最后一次。 */
function recordIncomeFetch() {
  const pairs: Array<{ start: string | null; end: string | null }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === INCOME_PATH) {
      pairs.push({ start: url.searchParams.get("start_date"), end: url.searchParams.get("end_date") });
    }
    return new Response(JSON.stringify(INCOME_STATEMENT), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return pairs;
}

/** 已挂载的树，afterEach 统一卸载（预设用例在循环内即时卸载以免多棵树并存）。 */
const mounted: Array<() => void> = [];

function renderPage(node: React.ReactNode) {
  // 每个用例独立 QueryClient：staleTime Infinity 会缓存 [fx-attribution, from, to]，
  // 复用同一 client 时点击与默认相同的预设不再发请求，就无法观察其金融区间出处。
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const view = render(
    <MemoryRouter>
      <ToastProvider>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
  mounted.push(view.unmount);
  return view;
}

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("金融区间调用点 Berlin 化（DATA-01 / WP05 / RV-05）", () => {
  it("前提：钉住的瞬间宿主（洛杉矶）与柏林日历日确实分叉，宿主时区回退必可察觉", () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    // 分叉证据：同一时刻两口径产出不同期间——否则本文件的断言没有约束力
    expect(todayIso()).toBe("2026-08-31");
    expect(berlinTodayIso()).toBe("2026-09-01");
    expect(lastNDays(30)).not.toEqual(berlinLastNDays(30));
    expect(currentMonth()).not.toEqual(berlinCurrentMonth());
    expect(currentYear()).not.toEqual(berlinCurrentYear());
    expect(lastMonth()).not.toEqual(berlinLastMonth());
    // 资产负债页站点：月初分叉使「上月末」相差一整月
    expect(lastMonthEnd()).toBe("2026-07-31");
    expect(berlinLastMonthEnd()).toBe("2026-08-31");
    // 「去年末」在该瞬间两侧同为 2025-12-31 → 需另钉跨年瞬间才有约束力
    expect(lastYearEnd()).toBe("2025-12-31");
    expect(berlinLastYearEnd()).toBe("2025-12-31");

    vi.setSystemTime(new Date(NEW_YEAR_CROSS_UTC));
    expect(todayIso()).toBe("2025-12-31");
    expect(berlinTodayIso()).toBe("2026-01-01");
    expect(lastYearEnd()).toBe("2024-12-31");
    expect(berlinLastYearEnd()).toBe("2025-12-31");
    expect(lastMonthEnd()).toBe("2025-11-30");
    expect(berlinLastMonthEnd()).toBe("2025-12-31");
  });

  it("明细页默认区间 = berlinLastNDays(30)，请求参数与日期控件同步", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    const expected = berlinLastNDays(30);
    const recorded = recordFetch();

    renderPage(<TransactionsPage />);
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());

    const params = recorded[TRANSACTIONS_PATH];
    expect(params).toBeDefined();
    expect({ start: params.get("start"), end: params.get("end") }).toEqual(expected);
    // 期望值本身随 Berlin 日历而非宿主：宿主口径会给出 end=2026-08-31
    expect(expected.end).toBe("2026-09-01");
    expect(screen.getByLabelText("起始日期")).toHaveValue(expected.start);
    expect(screen.getByLabelText("截止日期")).toHaveValue(expected.end);
  });

  it("归因页默认「今年」= berlinCurrentYear()", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    const expected = berlinCurrentYear();
    const recorded = recordFetch();

    renderPage(<FxAttributionPage />);
    await waitFor(() => expect(recorded[FX_PATH]).toBeDefined());

    const params = recorded[FX_PATH];
    expect({ from: params.get("from_date"), to: params.get("to_date") }).toEqual({
      from: expected.start,
      to: expected.end,
    });
    expect(expected.end).toBe("2026-09-01");
  });

  it("归因页四个预设芯片全部按 Berlin 日历产出区间", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));

    const cases: Array<[string, { start: string; end: string }]> = [
      ["最近30天", berlinLastNDays(30)],
      ["本月", berlinCurrentMonth()],
      ["上月", berlinLastMonth()],
      ["今年", berlinCurrentYear()],
    ];
    for (const [label, expected] of cases) {
      // 每轮独立记录 + 全新 QueryClient，确保观察到该预设真正发出的请求参数
      const recorded = recordFetch();
      const view = renderPage(<FxAttributionPage />);
      await waitFor(() => expect(recorded[FX_PATH]).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => {
        const params = recorded[FX_PATH];
        expect({ from: params.get("from_date"), to: params.get("to_date") }).toEqual({
          from: expected.start,
          to: expected.end,
        });
      });
      // 日期控件回显同一期间（跨页钻取的期间对象一致性）
      expect(screen.getByLabelText("起始日期")).toHaveValue(expected.start);
      expect(screen.getByLabelText("截止日期")).toHaveValue(expected.end);
      view.unmount();
    }
  });
});

/**
 * DATA-01 补漏：资产负债页与 AsOfToolbar。
 * AsOfToolbar 渲染在 AppHeader 的 actions 槽内，因此必须包 AppHeaderProvider；
 * 断言一律落在「真正发出的 as_of 请求参数」上，而非组件内部状态。
 */
function renderBalanceSheet() {
  return renderPage(
    <AppHeaderProvider>
      <BalanceSheetPage />
    </AppHeaderProvider>,
  );
}

describe("资产负债页与估值日工具 Berlin 化（DATA-01 补漏）", () => {
  it("初始 as_of = berlinTodayIso()：宿主时区回退会请求前一日", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    const recorded = recordFetch();

    renderBalanceSheet();
    await waitFor(() => expect(recorded[BALANCE_PATH]).toBeDefined());

    expect(recorded[BALANCE_PATH].get("as_of")).toBe(berlinTodayIso());
    // 期望值锚在柏林日历而非宿主：宿主口径会得到 2026-08-31
    expect(berlinTodayIso()).toBe("2026-09-01");
    expect(todayIso()).toBe("2026-08-31");
  });

  it("maxDate = berlinTodayIso()：柏林今天仍可选，其后一天不可选", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    const recorded = recordFetch();

    renderBalanceSheet();
    await waitFor(() => expect(recorded[BALANCE_PATH]).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "自定义日期" }));
    await screen.findByRole("dialog", { name: "选择日期" });

    // 视图月份 = 2026-09（跟随 as_of）：补尾 08-30/08-31 + 当月 01..30 + 补头 10-01..10-10。
    // 可点集合恰为 [08-30, 08-31, 09-01] 才说明上界是柏林今天：
    // 宿主口径（maxDate=2026-08-31）会连 09-01 一起禁用。
    const enabled = screen.getAllByRole("gridcell").filter((c) => !(c as HTMLButtonElement).disabled);
    expect(enabled.map((c) => c.textContent)).toEqual(["30", "31", "1"]);
  });

  it("预设「上月末」写入 as_of = berlinLastMonthEnd()（宿主版差一整月）", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    const recorded = recordFetch();

    renderBalanceSheet();
    await waitFor(() => expect(recorded[BALANCE_PATH]).toBeDefined());
    expect(recorded[BALANCE_PATH].get("as_of")).toBe("2026-09-01");

    fireEvent.click(screen.getByRole("button", { name: "上月末" }));
    await waitFor(() => expect(recorded[BALANCE_PATH].get("as_of")).toBe("2026-08-31"));
    expect(berlinLastMonthEnd()).toBe("2026-08-31");
    expect(lastMonthEnd()).toBe("2026-07-31");
    // 芯片高亮与请求值同源（证明预设值本身就是柏林日期）
    expect(screen.getByRole("button", { name: "上月末" })).toHaveClass("is-active");
  });

  it("预设「去年末」在跨年分叉瞬间 = berlinLastYearEnd()", async () => {
    vi.setSystemTime(new Date(NEW_YEAR_CROSS_UTC));
    const recorded = recordFetch();

    renderBalanceSheet();
    await waitFor(() => expect(recorded[BALANCE_PATH]).toBeDefined());
    expect(recorded[BALANCE_PATH].get("as_of")).toBe("2026-01-01"); // 柏林今天

    fireEvent.click(screen.getByRole("button", { name: "去年末" }));
    await waitFor(() => expect(recorded[BALANCE_PATH].get("as_of")).toBe("2025-12-31"));
    expect(berlinLastYearEnd()).toBe("2025-12-31");
    expect(lastYearEnd()).toBe("2024-12-31");
    expect(screen.getByRole("button", { name: "去年末" })).toHaveClass("is-active");
  });
});

/**
 * DATA-01 补漏（同类站点排查所得）：收支页逐月趋势把 6 个整月窗口直接作为
 * start_date/end_date 请求参数发出，其月份序列此前由宿主时区推导（lastNMonthEnds），
 * 跨月瞬间整体滑向上一月。
 */
describe("收支页逐月趋势窗口 Berlin 化（DATA-01 补漏）", () => {
  it("六个整月请求窗口 = berlinLastNMonthEnds(6)，不含宿主时区的上一月", async () => {
    vi.setSystemTime(new Date(CROSS_MIDNIGHT_UTC));
    const pairs = recordIncomeFetch();

    renderPage(<IncomeExpensePage />);
    // 本期 + 上期 + 6 个整月
    await waitFor(() => expect(pairs.length).toBeGreaterThanOrEqual(8));

    const requested = new Set(pairs.map((p) => `${p.start}~${p.end}`));
    const berlinEnds = berlinLastNMonthEnds(6);
    expect(berlinEnds).toContain("2026-08-31");
    for (const end of berlinEnds) {
      expect(requested.has(`${end.slice(0, 7)}-01~${end}`)).toBe(true);
    }
    // 反证：宿主（洛杉矶 08-31）口径的窗口是 2026-02-28…2026-07-31，会多请求 2 月
    const hostEnds = lastNMonthEnds(6);
    expect(hostEnds).toContain("2026-02-28");
    expect(requested.has("2026-02-01~2026-02-28")).toBe(false);
  });
});

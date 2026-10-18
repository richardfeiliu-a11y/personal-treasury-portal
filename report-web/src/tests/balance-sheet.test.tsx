import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { BalanceSheetPage } from "../pages/BalanceSheet";
import { AppHeaderProvider } from "../components/AppHeader";
import { berlinTodayIso, prevMonthEnd } from "../utils/dates";

// EChart 按仓内惯例 mock（jsdom 无 canvas）
vi.mock("../components/ChartWrapper", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} data-testid="echart" />
  ),
}));

// 与 e2e fixture 同构的静态响应；balance_as_of 来自后端，页面不得用前端日期。
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
    total_assets_base: "312700.60",
    total_liabilities_base: "0",
    net_worth_base: "312700.60",
    included_account_count: 3,
    pending_mapping_count: 0,
  },
  groups: [
    {
      key: "cash",
      title: "现金",
      side: "asset",
      subtotal_base: "168420.50",
      accounts: [
        {
          id: "1",
          name: "日常储蓄账户",
          currency: "CNY",
          balance_native: "168420.50",
          balance_base: "168420.50",
          active: true,
          include_net_worth: true,
        },
        {
          id: "2",
          name: "欧洲生活账户",
          currency: "EUR",
          balance_native: "18250.45",
          balance_base: "144280.10",
          active: true,
          include_net_worth: true,
        },
      ],
    },
    {
      key: "investments",
      title: "长期投资",
      side: "asset",
      subtotal_base: "73540.25",
      accounts: [
        {
          id: "3",
          name: "长期养老金账户",
          currency: "CHF",
          balance_native: "73540.25",
          balance_base: null,
          active: true,
          include_net_worth: true,
        },
      ],
    },
    {
      key: "credit",
      title: "信用卡",
      side: "liability",
      subtotal_base: "0",
      accounts: [
        {
          id: "4",
          name: "银行甲信用卡",
          currency: "CNY",
          balance_native: "0",
          balance_base: "0",
          active: true,
          include_net_worth: true,
        },
      ],
    },
  ],
};

function mockFetch(body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function renderPage(initialEntry = "/balance-sheet") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return render(
    <AppHeaderProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <QueryClientProvider client={qc}>
          <BalanceSheetPage />
        </QueryClientProvider>
      </MemoryRouter>
    </AppHeaderProvider>,
  );
}

describe("BalanceSheetPage", () => {
  it("As-of 日期渲染自后端 balance_as_of（头信息与底部元信息）", async () => {
    vi.stubGlobal("fetch", mockFetch(BALANCE_SHEET));
    renderPage();
    // 底部元信息行：截止 2026年8月9日（formatDateCn 输出），源自 balance_as_of 而非前端日期
    await waitFor(() => expect(screen.getAllByText(/截止 2026年8月9日/).length).toBeGreaterThanOrEqual(1));
    // 头信息 meta 同样渲染后端 as-of 日期（出现次数 ≥2：头 meta + 底部 meta）
    expect(screen.getAllByText(/2026年8月9日/).length).toBeGreaterThanOrEqual(2);
    // 页面壳与标题
    expect(screen.getByRole("heading", { level: 1, name: "资产负债" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("缺失汇率按 汇率缺失/缺汇率 披露，绝不渲染为 0", async () => {
    vi.stubGlobal("fetch", mockFetch(BALANCE_SHEET));
    renderPage();
    await waitFor(() => expect(screen.getAllByText("长期养老金账户").length).toBeGreaterThanOrEqual(1));
    // 行内披露：换算列“汇率缺失” + 缺汇率标签
    expect(screen.getAllByText("汇率缺失").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("缺汇率").length).toBeGreaterThanOrEqual(1);
    // 区块级披露：fx_complete=false 时列出缺失币种
    expect(screen.getByText(/缺少汇率：CHF/)).toBeInTheDocument();
    // 原币余额仍可见（不得被吞掉）
    expect(screen.getAllByText(/73,540\.25/).length).toBeGreaterThanOrEqual(1);
    // 缺失敞口不得出现 "0" 数值（含 "0.00 CNY" 一类的错误渲染）
    expect(screen.queryByText(/0(\.00)?\s*CNY/)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("资产/负债分组渲染：分组标题、小计与账户行", async () => {
    vi.stubGlobal("fetch", mockFetch(BALANCE_SHEET));
    renderPage();
    await waitFor(() => expect(screen.getByText("现金")).toBeInTheDocument());
    // 资产/负债两栏
    expect(screen.getByRole("region", { name: "资产" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "负债" })).toBeInTheDocument();
    // 分组卡片（现金/长期投资/信用卡）与小计
    expect(screen.getByRole("region", { name: "现金" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "长期投资" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "信用卡" })).toBeInTheDocument();
    // 账户行
    expect(screen.getByText("日常储蓄账户")).toBeInTheDocument();
    expect(screen.getByText("欧洲生活账户")).toBeInTheDocument();
    expect(screen.getByText("银行甲信用卡")).toBeInTheDocument();
    // 汇总卡（总资产/总负债/净资产），来自 summary（MetricCard 以 aria-label 呈现）
    expect(screen.getByLabelText("总资产")).toBeInTheDocument();
    expect(screen.getByLabelText("总负债")).toBeInTheDocument();
    expect(screen.getByLabelText("净资产")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("错误状态保留资产负债标题与页面壳", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "资产负债加载失败" }), { status: 500 })));
    renderPage();
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(screen.getByRole("heading", { level: 1, name: "资产负债" })).toBeInTheDocument();
    expect(document.querySelector(".balance-sheet-page")).toContainElement(alert);
    vi.unstubAllGlobals();
  });

  it("无分组数据时展示空状态（Composition Card 空态）", async () => {
    vi.stubGlobal("fetch", mockFetch({
      ...BALANCE_SHEET,
      groups: [],
      summary: {
        ...BALANCE_SHEET.summary,
        total_assets_base: "0",
        total_liabilities_base: "0",
        net_worth_base: "0",
        included_account_count: 0,
      },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无资产数据")).toBeInTheDocument());
    // 切到负债 side：各自空态独立
    fireEvent.click(screen.getByRole("button", { name: "负债" }));
    await waitFor(() => expect(screen.getByText("暂无负债数据")).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("对比上月末：按 account.id 对齐渲染中性涨跌 Delta 与门禁指示", async () => {
    // DATA-01：页面初始 as_of 与对比日按柏林业务日推导，期望值须同口径
    const today = berlinTodayIso();
    const compareDate = prevMonthEnd(today);
    const COMPARE = {
      ...BALANCE_SHEET,
      balance_as_of: compareDate,
      groups: [
        {
          key: "cash",
          title: "现金",
          side: "asset",
          subtotal_base: "310000.00",
          accounts: [
            { id: "1", name: "日常储蓄账户", currency: "CNY", balance_native: "150000.00", balance_base: "150000.00", active: true, include_net_worth: true },
            { id: "2", name: "欧洲生活账户", currency: "EUR", balance_native: "20000.00", balance_base: "160000.00", active: true, include_net_worth: true },
          ],
        },
        {
          key: "investments",
          title: "长期投资",
          side: "asset",
          subtotal_base: "3000.00",
          accounts: [
            { id: "3", name: "长期养老金账户", currency: "CHF", balance_native: "3000.00", balance_base: "3000.00", active: true, include_net_worth: true },
          ],
        },
        {
          key: "credit",
          title: "信用卡",
          side: "liability",
          subtotal_base: "0",
          accounts: [
            { id: "4", name: "银行甲信用卡", currency: "CNY", balance_native: "100.00", balance_base: "100.00", active: true, include_net_worth: true },
          ],
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const asOf = new URL(String(input)).searchParams.get("as_of");
      return new Response(JSON.stringify(asOf === compareDate ? COMPARE : BALANCE_SHEET), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByText("日常储蓄账户")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("对比基准"), { target: { value: "last_month_end" } });

    // 上涨/下跌中性箭头（↑ +12.3% / ↓ -9.8%，无红绿语义）
    await waitFor(() => expect(screen.getByText("↑ +12.3%")).toBeInTheDocument());
    expect(screen.getByText("↓ -9.8%")).toBeInTheDocument();
    // 当前缺汇率 → Delta 必须为「— (汇率不完整)」，禁止把 null 当 0 相减
    expect(screen.getByText("— (汇率不完整)")).toBeInTheDocument();
    // 本期零余额 → 已退出
    expect(screen.getByText("已退出 / 无余额")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("对比模式下新账户显示新增徽标且不出现 +∞%", async () => {
    const today = berlinTodayIso();
    const compareDate = prevMonthEnd(today);
    const CURRENT = {
      ...BALANCE_SHEET,
      groups: [
        ...BALANCE_SHEET.groups,
        {
          key: "new-cash",
          title: "新账户组",
          side: "asset",
          subtotal_base: "1000.00",
          accounts: [
            { id: "6", name: "新开账户", currency: "CNY", balance_native: "1000.00", balance_base: "1000.00", active: true, include_net_worth: true },
          ],
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const asOf = new URL(String(input)).searchParams.get("as_of");
      return new Response(JSON.stringify(asOf === compareDate ? BALANCE_SHEET : CURRENT), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByText("新开账户")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("对比基准"), { target: { value: "last_month_end" } });

    await waitFor(() => expect(screen.getByText("新增")).toBeInTheDocument());
    expect(screen.queryByText("+∞%")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("汇总卡差值走字符串精确域：>2^53 的差值不被 Intl 改掉低位（CALC-02 收尾）", async () => {
    // SummaryTrio.renderDiff 旧实现是 formatNumber(Math.abs(decToNumber(diff)))，
    // 走的是 number → Intl 分支：实测精确差值 30000000000000005.10 −
    // 10000000000000001.20 = 20000000000000003.90 会渲染成
    // "20,000,000,000,000,004.00"（该值落在 [2^54, 2^55)，ulp = 4，低位数字被
    // double 改掉），与账户行 / 卡片金额（字符串 → quantize2）分叉。
    // 现在渲染路径把 |diff| 留在精确域（decAbs + formatDecimal）再交给
    // formatNumber 的字符串分支——这里断言的就是页面上真实出现的数字串。
    const today = berlinTodayIso();
    const compareDate = prevMonthEnd(today);
    const CURRENT = {
      ...BALANCE_SHEET,
      summary: {
        ...BALANCE_SHEET.summary,
        total_assets_base: "30000000000000005.10",
        net_worth_base: "30000000000000005.10",
      },
    };
    const COMPARE = {
      ...BALANCE_SHEET,
      balance_as_of: compareDate,
      summary: {
        ...BALANCE_SHEET.summary,
        total_assets_base: "10000000000000001.20",
        net_worth_base: "10000000000000001.20",
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const asOf = new URL(String(input)).searchParams.get("as_of");
      return new Response(JSON.stringify(asOf === compareDate ? COMPARE : CURRENT), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByText("日常储蓄账户")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("对比基准"), { target: { value: "last_month_end" } });

    const assetsCard = screen.getByLabelText("总资产");
    await waitFor(() =>
      expect(within(assetsCard).getByText(/^↑ \+20,000,000,000,000,003\.90$/)).toBeInTheDocument());
    // 浮点分支的产物不得出现在页面上（一旦出现说明差值又经过了 Number）。
    expect(assetsCard.textContent).not.toContain("000,004.00");
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------
  // Composition Analytics V1（WP4）
  // -------------------------------------------------------------------

  // fx 完整且勾稽一致的 ready fixture（资产 1000 + 7500 + 500 − 100 = 9100−100=9000? 见断言）
  const READY = {
    ...BALANCE_SHEET,
    fx_complete: true,
    missing_currencies: [],
    summary: {
      total_assets_base: "9400", // 1000 + 7500 + 1000 - 100
      total_liabilities_base: "200",
      net_worth_base: "9200",
      included_account_count: 5,
      pending_mapping_count: 0,
    },
    groups: [
      {
        key: "cash",
        title: "现金",
        side: "asset",
        subtotal_base: "8500",
        accounts: [
          { id: "1", name: "日常储蓄账户", currency: "CNY", balance_native: "1000", balance_base: "1000", active: true, include_net_worth: true },
          { id: "2", name: "欧洲生活账户", currency: "EUR", balance_native: "1000", balance_base: "7500", active: true, include_net_worth: true },
        ],
      },
      {
        key: "investments",
        title: "长期投资",
        side: "asset",
        subtotal_base: "900", // 1000 − 100
        accounts: [
          { id: "3", name: "养老金", currency: "CNY", balance_native: "1000", balance_base: "1000", active: true, include_net_worth: true },
          { id: "5", name: "保证金", currency: "CNY", balance_native: "-100", balance_base: "-100", active: true, include_net_worth: true },
        ],
      },
      {
        key: "credit",
        title: "信用卡",
        side: "liability",
        subtotal_base: "200",
        accounts: [
          { id: "4", name: "银行甲信用卡", currency: "CNY", balance_native: "200", balance_base: "200", active: true, include_net_worth: true },
        ],
      },
    ],
  };

  it("DOM 顺序：Summary → FX alert（若有）→ Composition → DeltaMatrix；segment bar 已删除", async () => {
    vi.stubGlobal("fetch", mockFetch(BALANCE_SHEET));
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("资产构成分析")).toBeInTheDocument());
    expect(document.querySelector(".composition-segment-bar")).toBeNull(); // Segment bars 从本页删除
    const summary = screen.getByLabelText("总资产");
    const fxAlert = screen.getByText(/缺少汇率：CHF/);
    const composition = screen.getByLabelText("资产构成分析");
    const delta = screen.getByRole("region", { name: "资产" });
    expect(summary.compareDocumentPosition(fxAlert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fxAlert.compareDocumentPosition(composition) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composition.compareDocumentPosition(delta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("当前 scope 含非零缺折算账户 → FX blocked 卡：无 Donut、无百分比", async () => {
    vi.stubGlobal("fetch", mockFetch(BALANCE_SHEET));
    renderPage();
    await waitFor(() => expect(screen.getByText("汇率不完整，暂无法计算完整资产构成占比")).toBeInTheDocument());
    const card = screen.getByLabelText("资产构成分析");
    expect(card.querySelector('[data-testid="echart"]')).toBeNull();
    expect(card.textContent).not.toContain("%");
    // 排除 missing 账户后允许正确 filtered scope
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "长期养老金账户" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.getByTestId("echart")).toBeInTheDocument());
    const card2 = screen.getByLabelText("资产构成分析");
    expect(within(card2).getAllByText(/已筛选/).length).toBeGreaterThanOrEqual(1);
    vi.unstubAllGlobals();
  });

  it("ready：donut + 分组行 + 负余额冲减披露与勾稽公式", async () => {
    vi.stubGlobal("fetch", mockFetch(READY));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("echart")).toBeInTheDocument());
    const card = screen.getByLabelText("资产构成分析");
    // 顶层 group 行（现金 / 长期投资 正项降序，正项不含负余额）
    expect(within(card).getByRole("button", { name: /现金/ })).toBeInTheDocument();
    expect(within(card).getByText("长期投资")).toBeInTheDocument();
    // 负余额进入冲减块，不进 Donut
    expect(within(card).getByText("冲减项（负余额）")).toBeInTheDocument();
    const formula = card.querySelector(".comp-offset-formula")!;
    expect(formula.textContent).toContain("9,500"); // gross = 1000+7500+1000
    expect(formula.textContent).toContain("100");   // offset
    expect(formula.textContent).toContain("9,400"); // net = control
    vi.unstubAllGlobals();
  });

  it("Group 下钻：行按钮进入账户明细，Esc 退出并恢复焦点", async () => {
    vi.stubGlobal("fetch", mockFetch(READY));
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /现金/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /现金/ }));
    // 账户粒度行 + breadcrumb 返回按钮
    const card = screen.getByLabelText("资产构成分析");
    await waitFor(() => expect(within(card).getByText("日常储蓄账户")).toBeInTheDocument());
    expect(within(card).getByText("欧洲生活账户")).toBeInTheDocument();
    const back = screen.getByRole("button", { name: /返回/ });
    expect(document.activeElement).toBe(back); // 进入 drill 焦点移到返回按钮
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(within(screen.getByLabelText("资产构成分析")).queryByText("欧洲生活账户")).toBeNull());
    // 返回后焦点回到原 group 行
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label") ?? "").toMatch(/现金/));
    vi.unstubAllGlobals();
  });

  it("?side=liability 直达负债：group 行下钻到账户；负债无 offset 块", async () => {
    vi.stubGlobal("fetch", mockFetch(READY));
    renderPage("/balance-sheet?side=liability");
    const card = await screen.findByLabelText("负债构成分析");
    await waitFor(() => expect(within(card).getByRole("button", { name: /信用卡/ })).toBeInTheDocument());
    // 两个 side 均支持一层下钻
    fireEvent.click(within(card).getByRole("button", { name: /信用卡/ }));
    await waitFor(() => expect(within(card).getByText("银行甲信用卡")).toBeInTheDocument());
    expect(document.querySelector(".comp-offset")).toBeNull(); // 负债无冲减块
    vi.unstubAllGlobals();
  });

  it("非法 side 与失效 group URL 静默回退顶层", async () => {
    vi.stubGlobal("fetch", mockFetch(READY));
    const first = renderPage("/balance-sheet?side=foo");
    await waitFor(() => expect(screen.getByLabelText("资产构成分析")).toBeInTheDocument());
    expect(within(screen.getByLabelText("资产构成分析")).getByText("现金")).toBeInTheDocument();
    first.unmount();

    renderPage("/balance-sheet?group=nonexistent");
    await waitFor(() => expect(screen.getByRole("button", { name: /现金/ })).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("筛选：取消一个账户后 badge 与已筛选 caption 出现；重置回全量", async () => {
    vi.stubGlobal("fetch", mockFetch(READY));
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /现金/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "欧洲生活账户" }));
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "筛选 (3)" })).toBeInTheDocument());
    expect(
      within(screen.getByLabelText("资产构成分析")).getAllByText(/已筛选/).length,
    ).toBeGreaterThanOrEqual(1);
    // 重置回全量
    fireEvent.click(screen.getByRole("button", { name: "筛选 (3)" }));
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "筛选" })).toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});

describe("BalanceSheetPage — Other 展开态重置（P3-1，spec §6.4）", function () {
  // cash 组 9 个正向账户（100..108，合计 936）→ 下钻后 Top7+Other；
  // investments 含负余额；合计 936 + (1000-100) = 1836
  const READY9 = {
    ...BALANCE_SHEET,
    fx_complete: true,
    missing_currencies: [],
    summary: {
      total_assets_base: "1836", total_liabilities_base: "200",
      net_worth_base: "1636", included_account_count: 12,
      pending_mapping_count: 0,
    },
    groups: [
      {
        key: "cash", title: "现金", side: "asset" as const, subtotal_base: "936",
        accounts: Array.from({ length: 9 }, (_, i) => ({
          id: `a${i}`, name: `账户${i}`, currency: "CNY",
          balance_native: String(100 + i), balance_base: String(100 + i),
          active: true, include_net_worth: true,
        })),
      },
      {
        key: "investments", title: "长期投资", side: "asset" as const, subtotal_base: "900",
        accounts: [
          { id: "x1", name: "养老金", currency: "CNY", balance_native: "1000", balance_base: "1000", active: true, include_net_worth: true },
          { id: "x2", name: "保证金", currency: "CNY", balance_native: "-100", balance_base: "-100", active: true, include_net_worth: true },
        ],
      },
      {
        key: "credit", title: "信用卡", side: "liability" as const, subtotal_base: "200",
        accounts: [
          { id: "l1", name: "银行甲信用卡", currency: "CNY", balance_native: "200", balance_base: "200", active: true, include_net_worth: true },
        ],
      },
    ],
  };

  async function drillAndExpand() {
    await waitFor(() => expect(screen.getByRole("button", { name: /现金/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /现金/ }));
    const card = screen.getByLabelText("资产构成分析");
    await waitFor(() => expect(within(card).getByRole("button", { name: /其他/ })).toBeInTheDocument());
    fireEvent.click(within(card).getByRole("button", { name: /其他/ }));
    expect(within(card).getByRole("button", { name: /其他/ })).toHaveAttribute("aria-expanded", "true");
    return card;
  }

  it("side toggle 往返并重新下钻后 Other 重置为折叠", async () => {
    vi.stubGlobal("fetch", mockFetch(READY9));
    renderPage();
    await drillAndExpand();

    fireEvent.click(within(screen.getByLabelText("资产构成分析")).getByRole("button", { name: "负债" }));
    fireEvent.click(within(screen.getByLabelText("负债构成分析")).getByRole("button", { name: "资产" }));

    await waitFor(() => expect(screen.getByRole("region", { name: "资产构成分析" }).querySelector(".comp-breadcrumb")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /现金/ }));
    const card = await screen.findByLabelText("资产构成分析");
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: /其他/ })).toHaveAttribute("aria-expanded", "false"));
    vi.unstubAllGlobals();
  });

  it("as_of change（group 保留）后 Other 重置为折叠", async () => {
    const prevMonthEndValue = prevMonthEnd(berlinTodayIso());
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const asOf = new URL(String(input)).searchParams.get("as_of") ?? berlinTodayIso();
      const body = asOf === prevMonthEndValue
        ? { ...READY9, balance_as_of: prevMonthEndValue }
        : READY9;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await drillAndExpand();

    fireEvent.click(screen.getByRole("button", { name: "上月末" }));

    // group 保留（§6.4），但 Other 必须折叠
    const card = await screen.findByLabelText("资产构成分析");
    await waitFor(() =>
      expect(within(card).getByRole("button", { name: /其他/ })).toHaveAttribute("aria-expanded", "false"));
    vi.unstubAllGlobals();
  });
});

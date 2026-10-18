import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { TransactionsPage } from "../pages/Transactions";
import { AppHeaderProvider } from "../components/AppHeader";
import { ToastProvider } from "../components/Toast";

const ROWS = {
  schema_version: "1.0",
  period_from: "2026-08-01",
  // 与 ACCOUNTS.as_of（2026-08-07）**故意不同日**：页脚的日历日槽位取自 period_to，
  // 若 fixture 与账户 as_of 同值，误接成 accounts.data.as_of 也会得到绿色测试。
  period_to: "2026-08-09",
  total: 2,
  offset: 0,
  limit: 100,
  fx_notes: [],
  rows: [
    {
      date: "2026-08-05", type: "withdrawal", description: "房租",
      category: "居住", source: "银行甲存款", destination: "房东",
      amount_native: "3000.00", currency: "CNY", amount_base: "3000.00",
      fx_exact: true, tags: [], journal_id: "j2",
    },
    {
      date: "2026-08-01", type: "withdrawal", description: "咖啡",
      category: "餐饮", source: "银行甲存款", destination: "咖啡店",
      amount_native: "35.00", currency: "CNY", amount_base: "35.00",
      fx_exact: true, tags: [], journal_id: "j1",
    },
  ],
};

const ACCOUNTS = {
  base_currency: "CNY",
  as_of: "2026-08-07",
  accounts: [
    { id: "1", name: "银行甲存款" },
  ],
};

/** 构造带 3 页数据（total=250）的响应，用于分页测试。 */
function makePagedRows(offsetParam: string | number) {
  const offset = Number(offsetParam) || 0;
  return {
    ...ROWS,
    total: 250,
    offset,
    rows: Array.from({ length: 100 }, (_, i) => ({
      date: "2026-08-01",
      type: "withdrawal" as const,
      description: `交易 ${offset + i + 1}`,
      category: "餐饮",
      source: "银行甲存款",
      destination: "咖啡店",
      amount_native: "35.00",
      currency: "CNY",
      amount_base: "35.00",
      fx_exact: true,
      tags: [],
      journal_id: `j-${offset + i}`,
    })),
  };
}

// 探测路由当前 location：MemoryRouter 不触碰 window.location，
// 单元测试必须断言路由内部状态（location.search），URL 栏行为由 e2e 覆盖。
let lastLocation: { search: string; key: string } | undefined;

function LocationProbe() {
  const location = useLocation();
  lastLocation = { search: location.search, key: location.key };
  return null;
}

function renderPage(initialPath = "/transactions") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  lastLocation = undefined;
  return render(
    <ToastProvider>
      <AppHeaderProvider>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[initialPath]}>
            <LocationProbe />
            <TransactionsPage />
          </MemoryRouter>
        </QueryClientProvider>
      </AppHeaderProvider>
    </ToastProvider>,
  );
}

/** 读取路由当前 search 参数（与组件读到的 URL 一致）。 */
function readUrl() {
  return new URLSearchParams(lastLocation?.search ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TransactionsPage — CSV 导出本页", () => {
  /**
   * 只桩 URL.createObjectURL（jsdom 未实现）+ 监听真实 <a>.click。
   * 不 mock createElement/appendChild——那会连带劫持 testing-library
   * 的挂载容器，导致整个页面渲染不出来。
   */
  function stubDownload() {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob | MediaSource) => {
      created.push(b as Blob);
      return "blob:mock";
    });
    const revokeObjectURL = vi.fn();
    // jsdom 未实现 URL.createObjectURL/revokeObjectURL，直接定义到 URL 上；
    // 用 configurable 以便 afterEach 的 unstubAllGlobals/restore 清理。
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true, writable: true, value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true, writable: true, value: revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    return { createObjectURL, revokeObjectURL, click, created };
  }

  function stubFetch() {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? { base_currency: "CNY", as_of: "2026-08-07", accounts: [] }
        : ROWS;
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
  }

  it("按钮如实标注本页条数，点击触发下载且文件名含区间与条数", async () => {
    const d = stubDownload();
    stubFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument(),
    );

    const btn = screen.getByRole("button", { name: /导出本页 \(2\)/ });
    fireEvent.click(btn);

    expect(d.click).toHaveBeenCalledTimes(1);
    // 诚实语义：文件名用本页条数（2），不是服务端 total。
    expect(d.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = d.created[0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(d.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    await waitFor(() =>
      expect(screen.getByText("已导出本页 2 条")).toBeInTheDocument(),
    );
  });

  /** jsdom 的 Blob 未实现 .text()，用 FileReader 读取。 */
  function readBlob(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  it("导出内容含 BOM、表头与本页两行数据", async () => {
    const d = stubDownload();
    stubFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /导出本页/ }));

    // BOM 由 csv-export.test.ts 单元验证（jsdom 的 Blob 无 arrayBuffer，
    // 且 FileReader 会剥掉 BOM）；这里只验证内容结构。
    const text = await readBlob(d.created[0]);
    const lines = text.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(3); // 表头 + 2 行
    expect(lines[0]).toContain("日期");
    expect(text).toContain("咖啡");
    expect(text).toContain("房租");
  });

  it("搜索命中 1 条时导出 1 条：范围随筛选，不冒充服务端 total", async () => {
    const d = stubDownload();
    stubFetch();
    renderPage("/transactions?keyword=咖啡");
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument(),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /导出本页 \(1\)/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /导出本页 \(1\)/ }));

    const text = await readBlob(d.created[0]);
    expect(text).toContain("咖啡");
    expect(text).not.toContain("房租");
  });

  it("零命中时按钮禁用，不产出空文件", async () => {
    const d = stubDownload();
    stubFetch();
    renderPage("/transactions?keyword=zzz-不存在");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /导出本页/ })).toBeDisabled(),
    );
    expect(d.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("TransactionsPage", () => {
  it("渲染交易表格并支持类型/类别筛选，URL 含正确参数", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? { base_currency: "CNY", as_of: "2026-08-07", fx_complete: true, missing_currencies: [], accounts: [] }
        : ROWS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());
    expect(screen.getByText("咖啡")).toBeInTheDocument();
    expect(screen.getByText("房租")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "交易明细卡片视图" }).children).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "金额（原币）" })).toHaveClass("is-num");
    expect(screen.getByRole("columnheader", { name: "折 CNY" })).toHaveClass("is-num");
    // DATA-03：transactions 契约无 generated_at（幽灵字段），页脚只能用期间末日
    // 这个纯日历日槽位（数据截止），不显示「数据生成时间」。
    const footer = screen.getByTestId("report-timestamp-footer");
    expect(footer).toHaveTextContent("数据截止: 2026-08-09");
    // 反向钉住来源：账户列表的 as_of（2026-08-07）不是页脚的日历日槽位
    expect(footer.textContent).not.toContain("2026-08-07");
    expect(footer.textContent).not.toContain("数据生成时间");
    expect(footer.textContent).not.toContain("(Europe/Berlin)");
    fireEvent.click(screen.getByRole("button", { name: "支出" }));
    // P1 修复：填写类别筛选后断言 category 参数
    fireEvent.change(screen.getByRole("combobox", { name: "类别筛选" }), {
      target: { value: "餐饮" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "本页搜索" }), {
      target: { value: "咖啡" },
    });
    // P1 修复：先筛选出交易请求（排除 account-balances），再断言参数
    await waitFor(() => {
      const txUrls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/reports/web/transactions"));
      expect(txUrls.length).toBeGreaterThan(0);
      const lastTx = txUrls[txUrls.length - 1];
      expect(lastTx).toContain("txn_type=withdrawal");
      expect(lastTx).toMatch(/start=/);
      expect(lastTx).toMatch(/end=/);
      expect(lastTx).toMatch(/category=/);
    });
    await waitFor(() => {
      expect(screen.getByText("咖啡")).toBeInTheDocument();
      expect(screen.queryByText("房租")).not.toBeInTheDocument();
      expect(readUrl().get("keyword")).toBe("咖啡");
    });
    vi.unstubAllGlobals();
  });

  it("复制飞书核对指令：剪贴板写入含 journal_id 的精确指令并显示 toast", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? { base_currency: "CNY", as_of: "2026-08-07", accounts: [] }
        : ROWS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());

    const copyBtn = screen.getAllByRole("button", { name: /复制交易 咖啡 核对指令/ })[0];
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith("核对交易 journal_id=j1 日期=2026-08-01 描述=咖啡 金额=35.00 CNY");
    // toast 由 showToast 的 setToasts 异步触发重渲染，需等待其落入 DOM
    await waitFor(() => expect(screen.getByText("已复制飞书核对指令")).toBeInTheDocument());
  });

  it("错误状态保留明细标题与筛选页面壳", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("account-balances")) {
        return new Response(JSON.stringify({ base_currency: "CNY", as_of: "2026-08-07", accounts: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "明细加载失败" }), { status: 500 });
    }));
    renderPage();
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(screen.getByRole("heading", { level: 1, name: "明细" })).toBeInTheDocument();
    expect(document.querySelector(".transactions-page")).toContainElement(alert);
    expect(screen.getByRole("group", { name: "交易类型" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("无交易时保留 H1、筛选上下文与调整说明", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? { base_currency: "CNY", as_of: "2026-08-07", accounts: [] }
        : { ...ROWS, total: 0, rows: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderPage();
    await waitFor(() => expect(screen.getByText("该期间暂无交易")).toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: "明细" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "交易类型" })).toBeInTheDocument();
    expect(screen.getByText("调整日期区间或筛选条件。")).toBeInTheDocument();
  });

  it("筛选变更更新 URL（默认值省略）且 offset 归零", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? ACCOUNTS
        : makePagedRows(new URL(url).searchParams.get("offset") ?? "0");
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    // 初始 URL 带 offset=100（第 2 页），用于验证筛选后 offset 被重置并省略。
    renderPage("/transactions?start=2026-07-01&end=2026-08-01&offset=100");
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());

    // 选择支出类型 → URL 含 txnType=withdrawal，offset 重置为 0 且被省略
    fireEvent.click(screen.getByRole("button", { name: "支出" }));
    await waitFor(() => {
      const url = readUrl();
      expect(url.get("txnType")).toBe("withdrawal");
      expect(url.get("start")).toBe("2026-07-01");
      expect(url.get("end")).toBe("2026-08-01");
      expect(url.get("offset")).toBeNull();
    });

    // 类别筛选 → URL 含 category=餐饮
    fireEvent.change(screen.getByRole("combobox", { name: "类别筛选" }), {
      target: { value: "餐饮" },
    });
    await waitFor(() => {
      const url = readUrl();
      expect(url.get("category")).toBe("餐饮");
      expect(url.get("txnType")).toBe("withdrawal");
      expect(url.get("offset")).toBeNull();
    });

    // 账户筛选 → URL 含 account=银行甲存款
    fireEvent.change(screen.getByRole("combobox", { name: "账户筛选" }), {
      target: { value: "银行甲存款" },
    });
    await waitFor(() => {
      const url = readUrl();
      expect(url.get("account")).toBe("银行甲存款");
      expect(url.get("offset")).toBeNull();
    });

    // 日期变更 → URL 含新 start，offset 保持省略
    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-06-01" } });
    await waitFor(() => {
      const url = readUrl();
      expect(url.get("start")).toBe("2026-06-01");
      expect(url.get("offset")).toBeNull();
    });
  });

  it("分页更新 offset 且保留其他参数", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? ACCOUNTS
        : makePagedRows(new URL(url).searchParams.get("offset") ?? "0");
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/transactions?category=餐饮&start=2026-07-01&end=2026-08-01");
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    // 新 offset 的请求在途时页面回到加载态；等数据就绪后再操作
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());
    await waitFor(() => {
      const url = readUrl();
      expect(url.get("offset")).toBe("100");
      expect(url.get("category")).toBe("餐饮");
      expect(url.get("start")).toBe("2026-07-01");
      expect(url.get("end")).toBe("2026-08-01");
    });

    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());
    await waitFor(() => expect(readUrl().get("offset")).toBeNull());
  });

  it("deep-link：初始 URL 参数初始化筛选控件与查询参数", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? ACCOUNTS
        : makePagedRows(new URL(url).searchParams.get("offset") ?? "0");
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/transactions?start=2026-07-01&end=2026-08-01&account=银行甲存款&category=餐饮&txnType=withdrawal&offset=100");
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());

    // 筛选控件回显 URL 值
    expect(screen.getByRole("combobox", { name: "类别筛选" })).toHaveValue("餐饮");
    expect(screen.getByRole("combobox", { name: "账户筛选" })).toHaveValue("银行甲存款");
    expect(screen.getByRole("button", { name: "支出" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("起始日期")).toHaveValue("2026-07-01");
    expect(screen.getByLabelText("截止日期")).toHaveValue("2026-08-01");
    expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument();

    // 查询请求携带 URL 中的全部参数
    await waitFor(() => {
      const txUrls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/reports/web/transactions"));
      const lastTx = txUrls[txUrls.length - 1];
      expect(lastTx).toContain("start=2026-07-01");
      expect(lastTx).toContain("end=2026-08-01");
      expect(lastTx).toContain("account=%E9%93%B6%E8%A1%8C%E7%94%B2%E5%AD%98%E6%AC%BE");
      expect(lastTx).toContain("category=%E9%A4%90%E9%A5%AE");
      expect(lastTx).toContain("txn_type=withdrawal");
      expect(lastTx).toContain("offset=100");
    });
  });

  it("clean URL：默认区间与 offset=0 不出现在 URL 中", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("account-balances")
        ? { base_currency: "CNY", as_of: "2026-08-07", accounts: [] }
        : ROWS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    await waitFor(() => expect(screen.getByRole("table", { name: "交易明细" })).toBeInTheDocument());

    // 初次渲染 + 一次筛选变更后，URL 均不含默认区间 / txnType=all / offset=0
    expect(lastLocation?.search).toBe("");
    fireEvent.change(screen.getByRole("combobox", { name: "类别筛选" }), {
      target: { value: "餐饮" },
    });
    await waitFor(() => expect(readUrl().toString()).toBe("category=%E9%A4%90%E9%A5%AE"));

    // 切回全部类型 → txnType 被省略
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(readUrl().toString()).toBe("category=%E9%A4%90%E9%A5%AE"));
  });
});

// ---------------------------------------------------------------------------
// Composition Analytics V1（WP6）：management 报表口径深链
// ---------------------------------------------------------------------------

describe("TransactionsPage — report_side/report_category 深链", () => {
  function mockFetchCapture() {
    const calls: string[] = [];
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const u = new URL(url, "http://localhost");
      const offsetNum = Number(u.searchParams.get("offset") ?? "0") || 0;
      const body = u.pathname.includes("transactions") && offsetNum > 0
        ? makePagedRows(offsetNum)
        : ROWS;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return { fn, calls };
  }

  it("URL 有效 pair：显示报表口径 chip，且 pair 进入 API 请求参数", async () => {
    const { fn, calls } = mockFetchCapture();
    vi.stubGlobal("fetch", fn);
    renderPage("/transactions?start=2026-08-01&end=2026-08-07&report_side=expense&report_category=%E9%A4%90%E9%A5%AE");
    await waitFor(() => expect(screen.getByText(/报表口径：支出 · 餐饮/)).toBeInTheDocument());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const txUrls = calls.filter((u) => u.includes("/api/reports/web/transactions"));
    expect(txUrls.length).toBeGreaterThan(0);
    const u = new URL(txUrls[0], "http://localhost");
    expect(u.searchParams.get("report_side")).toBe("expense");
    expect(u.searchParams.get("report_category")).toBe("餐饮");
    vi.unstubAllGlobals();
  });

  it("清除 chip：原子删除两个 report 参数并重置 offset", async () => {
    vi.stubGlobal("fetch", mockFetchCapture().fn);
    const { unmount } = renderPage(
      "/transactions?start=2026-08-01&end=2026-08-07&offset=100&report_side=income&report_category=%E5%B7%A5%E8%B5%84",
    );
    await waitFor(() => expect(screen.getByText(/报表口径：收入 · 工资/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "清除报表口径筛选" }));
    await waitFor(() => expect(screen.queryByText(/报表口径/)).toBeNull());
    expect(lastLocation?.search).not.toContain("report_side");
    expect(lastLocation?.search).not.toContain("report_category");
    expect(lastLocation?.search).not.toContain("offset");
    // start/end 保留
    expect(lastLocation?.search).toContain("start=2026-08-01");
    unmount();
    vi.unstubAllGlobals();
  });

  it("调整既有筛选（日期/类别/交易类型）时保留 report pair", async () => {
    vi.stubGlobal("fetch", mockFetchCapture().fn);
    renderPage("/transactions?start=2026-08-01&end=2026-08-07&report_side=expense&report_category=%E9%A4%90%E9%A5%AE");
    await waitFor(() => expect(screen.getByText(/报表口径：支出 · 餐饮/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("类别筛选"), { target: { value: "居住" } });
    await waitFor(() => expect(lastLocation?.search).toContain("report_side=expense"));
    expect(lastLocation?.search).toContain("report_category");
    expect(lastLocation?.search).toContain("category="); // 既有筛选与 report pair 交集
    vi.unstubAllGlobals();
  });

  it("部分 pair（只有 report_side）被忽略：无 chip、不发 report 参数", async () => {
    const { fn, calls } = mockFetchCapture();
    vi.stubGlobal("fetch", fn);
    renderPage("/transactions?start=2026-08-01&end=2026-08-07&report_side=expense");
    await waitFor(() => expect(screen.getByText("房租")).toBeInTheDocument());
    expect(screen.queryByText(/报表口径/)).toBeNull();
    const txUrls = calls.filter((u) => u.includes("/api/reports/web/transactions"));
    expect(txUrls.length).toBeGreaterThan(0);
    expect(txUrls[0]).not.toContain("report_side");
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// WP08（U04）：本页搜索诚实语义——总笔数/本页笔数/命中数独立
// ---------------------------------------------------------------------------

/** 250 条合成交易；关键词 needle 仅出现在指定 offset 页的第 idx 行。 */
function makeNeedleRows(offsetParam: string | number, needleOffset: number | null) {
  const offset = Number(offsetParam) || 0;
  return {
    ...ROWS,
    total: 250,
    offset,
    rows: Array.from({ length: 100 }, (_, i) => {
      const n = offset + i + 1;
      return {
        date: "2026-08-01",
        type: "withdrawal" as const,
        description: offsetParam === needleOffset && i === 57 ? `needle unique-命中 ${n}` : `交易 ${n}`,
        category: "餐饮",
        source: "银行甲存款",
        destination: "咖啡店",
        amount_native: "35.00",
        currency: "CNY",
        amount_base: "35.00",
        fx_exact: true,
        tags: [],
        journal_id: `j${n}`,
      };
    }),
  };
}

describe("TransactionsPage — WP08 本页搜索与分页诚实", () => {
  async function searchOnPage(pageOffset: number, needle: string) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("web/transactions")) {
        const m = url.match(/offset=(\d+)/);
        body = makeNeedleRows(m ? Number(m[1]) : 0, needle === "needle" ? 100 : null);
      } else if (url.includes("account-balances")) body = ACCOUNTS;
      else body = {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage(`/transactions?start=2026-08-01&end=2026-08-07&offset=${pageOffset}`);
    await waitFor(() => expect(screen.getAllByText(/交易 1\b|needle/).length).toBeGreaterThan(0));
    const input = screen.getByLabelText(/本页搜索/);
    fireEvent.change(input, { target: { value: needle } });
    await waitFor(() => expect(screen.getAllByText(/本页命中/).length).toBeGreaterThan(0));
    return fetchMock;
  }

  it("总笔数不被关键词改写：页码按服务端 total 计算（250 → 3 页）", async () => {
    await searchOnPage(0, "nomatch-xyz");
    // 命中数 0 独立显示
    expect(screen.getByText(/本页命中 0 条/)).toBeInTheDocument();
    // 分页仍按服务端 total=250 计算：第 1 / 3 页
    expect(screen.getByText(/第 1 \/ 3 页/)).toBeInTheDocument();
    // 头部「共 N 笔」保持 250（服务端口径），未被过滤结果改写
    expect(screen.getByText(/共 250 笔/)).toBeInTheDocument();
    // 下一页按钮可用（首页零命中不阻断翻页）
    const next = screen.getByRole("button", { name: /下一页/ });
    expect(next).not.toBeDisabled();
    vi.unstubAllGlobals();
  });

  it("第 2 页命中 1 条：本页命中数与总笔数独立并存（深链关键词+offset）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("web/transactions")) {
        const m = url.match(/offset=(\d+)/);
        body = makeNeedleRows(m ? Number(m[1]) : 0, 100);
      } else if (url.includes("account-balances")) body = ACCOUNTS;
      else body = {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage("/transactions?start=2026-08-01&end=2026-08-07&offset=100&keyword=needle");
    await waitFor(() => expect(screen.getAllByText(/needle unique-命中/).length).toBeGreaterThan(0));
    expect(screen.getByText(/本页命中 1 条/)).toBeInTheDocument();
    expect(screen.getByText(/共 250 笔/)).toBeInTheDocument();
    expect(screen.getByText(/第 2 \/ 3 页/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("本页零命中时清除搜索入口与翻页控件仍然可用", async () => {
    await searchOnPage(0, "nomatch-xyz");
    // 空状态提示明确「本页无命中」而非「该期间暂无交易」
    expect(screen.getByText(/本页无命中/)).toBeInTheDocument();
    // 清除搜索入口
    const clear = screen.getByRole("button", { name: /清除本页搜索/ });
    fireEvent.click(clear);
    await waitFor(() => expect(screen.getAllByText(/交易 \d+/).length).toBeGreaterThan(0));
    vi.unstubAllGlobals();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AlertsPage } from "../pages/Alerts";
import { AppHeaderProvider } from "../components/AppHeader";
import { ToastProvider } from "../components/Toast";
import { formatTimestampBerlin } from "../utils/timestamps";

// REL-05 的柏林断言必须有「宿主时区 ≠ 柏林」这个前提才有约束力：本页页首/页脚都渲染
// 同一瞬间，若宿主恰好是 Europe/Berlin，宿主时区实现（已删除的 formatTimestampLocal）
// 会给出与柏林口径一模一样的读数，断言再强也测不出回归。
// 因此本文件按 dates-callers.test.tsx 的既有做法把宿主时区钉成 America/Los_Angeles，
// 并把 checked_at 钉在「柏林已跨入次日、洛杉矶仍是当日」的瞬间（2026-08-07T22:30Z →
// 柏林 08-08 00:30 / 洛杉矶 08-07 15:30），日历日与时分同时分叉。
// 注：pool 为 forks（每个测试文件独立进程），此处改 TZ 不会污染其他测试文件。
vi.hoisted(() => {
  const proc = (globalThis as unknown as { process?: { env: Record<string, string> } }).process;
  if (proc) proc.env.TZ = "America/Los_Angeles";
});

const DATA = {
  schema_version: "1.0",
  checked_at: "2026-08-07T22:30:00Z",
  count: 2,
  anomalies: [
    { id: "health:backup", source: "health:backup", severity: "critical", message: "备份过期或从未成功", category: null, amount: null, currency: null },
    { id: "spending_trend:餐饮:2026-08", source: "spending:餐饮", severity: "warning", message: "类别「餐饮」本月支出较历史月均偏差 200%", category: "餐饮", amount: "3000.00", currency: "CNY" },
  ],
};

describe("AlertsPage", () => {
  function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    return render(
      <MemoryRouter>
        <ToastProvider>
          <AppHeaderProvider>
            <QueryClientProvider client={qc}>
              <AlertsPage />
            </QueryClientProvider>
          </AppHeaderProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  /** 用指定 anomalies 列表渲染页面,并等渲染完成。 */
  async function renderWithAnomalies(anomalies: typeof DATA.anomalies) {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ...DATA, anomalies, count: anomalies.length }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })));
    renderPage();
    await waitFor(() => expect(document.querySelector(".anomaly-list")).toBeInTheDocument());
  }

  const SNOOZE_KEY = "personal_treasury_snoozed_anomalies_v1";

  /**
   * 宿主时区读数：与被删除的 utils/timestamps.formatTimestampLocal 同构
   * （`new Date()` + 本地 getHours/getDate），供「前提」用例证明宿主 ≠ 柏林。
   */
  function formatHostLocal(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 静音状态存在 localStorage，测试间必须清干净，否则用例顺序会影响结果
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("前提：宿主（洛杉矶）与柏林在 checked_at 瞬间分叉，宿主时区回退必可察觉", () => {
    // 分叉证据：同一瞬间两口径产出不同读数（日历日也差一天）——否则本文件的页首/页脚
    // 断言没有约束力。期望值写死宿主读数：若 vi.hoisted 的 TZ 未生效（例如宿主本就是
    // Europe/Berlin），第一行立即失败，而不是让断言在宿主时区实现下静默通过。
    expect(formatHostLocal(DATA.checked_at)).toBe("2026-08-07 15:30");
    expect(formatTimestampBerlin(DATA.checked_at)).toBe("2026-08-08 00:30");
    expect(formatHostLocal(DATA.checked_at)).not.toBe(formatTimestampBerlin(DATA.checked_at));
  });

  it("按严重度分组渲染异常列表与空状态", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderPage();
    await waitFor(() => expect(screen.getByRole("list", { name: "严重异常" })).toBeInTheDocument());
    // 分组标题存在
    expect(screen.getByRole("heading", { name: "严重" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "警告" })).toBeInTheDocument();
    // 严重组在前、警告组在后（DOM 顺序）
    const severe = screen.getByRole("heading", { name: "严重" });
    const warning = screen.getByRole("heading", { name: "警告" });
    expect(severe.compareDocumentPosition(warning)).toBe(4 /* Node.DOCUMENT_POSITION_FOLLOWING */);
    // critical 在严重组内，warning 在警告组内
    expect(screen.getByRole("list", { name: "严重异常" })).toHaveTextContent("备份过期或从未成功");
    expect(screen.getByRole("list", { name: "警告异常" })).toHaveTextContent("类别「餐饮」");
    expect(screen.getByText(/类别「餐饮」/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看餐饮交易" })).toHaveAttribute(
      "href",
      "/transactions?category=%E9%A4%90%E9%A5%AE",
    );
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("(Europe/Berlin)");
    expect(document.querySelectorAll(".anomaly-item.is-neutral-surface")).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("页首「检查时间」与页脚同一瞬间、同一口径（Europe/Berlin）", async () => {
    // REL-05/DATA-01：checked_at = 07T22:30Z → 柏林 08-08 00:30（CEST），洛杉矶宿主仍是
    // 08-07 15:30。页首曾用 formatTimestampLocal（宿主时区）：浏览器时区不是柏林时，
    // 同一瞬间会在同一页面显示两个值，甚至显示成前一天。
    // 本用例把页首与页脚钉成同一个柏林时刻（前提见上一条用例）。
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderPage();
    const meta = await screen.findByText(/检查时间 2026-08-08 00:30/);
    expect(meta).toHaveTextContent("检查时间 2026-08-08 00:30 · 共 2 项");
    expect(screen.getByTestId("report-timestamp-footer"))
      .toHaveTextContent("数据生成时间: 2026-08-08 00:30 (Europe/Berlin)");
    vi.unstubAllGlobals();
  });

  it("无异常时显示空状态", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ...DATA, anomalies: [], count: 0 }), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderPage();
    await waitFor(() => expect(screen.getByText("暂无异常")).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it("warning 异常带金额时渲染金额与币种", async () => {
    await renderWithAnomalies([
      {
        id: "spending_trend:餐饮:2026-08",
        source: "spending:餐饮",
        severity: "warning",
        message: "类别「餐饮」本月支出较历史月均偏差 200%",
        category: "餐饮",
        amount: "3000.00",
        currency: "CNY",
      },
    ]);
    const item = document.querySelector(".anomaly-item.anomaly-warning");
    expect(item).not.toBeNull();
    expect(item).toHaveClass("is-neutral-surface");
    expect(item).toHaveTextContent("警告");
    expect(item).toHaveTextContent("spending:餐饮");
    // Amount 组件按币种格式化（千分位）后渲染金额
    expect(item).toHaveTextContent("3,000");
    expect(item).toHaveTextContent("CNY");
    // 有金额时渲染金额元素
    expect(document.querySelector(".anomaly-amount")).not.toBeNull();
  });

  it("critical 异常无金额(null)时不渲染金额", async () => {
    await renderWithAnomalies([
      {
        id: "health:backup",
        source: "health:backup",
        severity: "critical",
        message: "备份过期或从未成功",
        category: null,
        amount: null,
        currency: null,
      },
    ]);
    const item = document.querySelector(".anomaly-item.anomaly-critical");
    expect(item).not.toBeNull();
    expect(item).toHaveTextContent("严重");
    expect(item).toHaveTextContent("备份过期或从未成功");
    // 金额为 null 时页面不渲染任何金额元素
    expect(document.querySelector(".anomaly-amount")).toBeNull();
  });

  it("未知 severity 归入「其他」分组并显示中性标签", async () => {
    await renderWithAnomalies([
      {
        id: "health:notice",
        source: "misc:notice",
        severity: "info",
        message: "计划性维护通知",
        category: null,
        amount: null,
        currency: null,
      },
    ]);
    expect(screen.getByRole("heading", { name: "其他" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "其他异常" })).toHaveTextContent("计划性维护通知");
    expect(document.querySelector(".anomaly-item")).toHaveClass("anomaly-info");
    expect(document.querySelector(".anomaly-item .badge")).toHaveTextContent("提示");
  });

  it("点击「在飞书排查」写入确定性 id 的排查指令并显示 toast", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await renderWithAnomalies([
      {
        id: "spending_trend:餐饮:2026-08",
        source: "spending:餐饮",
        severity: "warning",
        message: "类别「餐饮」本月支出较历史月均偏差 200%",
        category: "餐饮",
        amount: "3000.00",
        currency: "CNY",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "在飞书排查" }));

    expect(writeText).toHaveBeenCalledWith("排查异常 source=spending:餐饮 id=spending_trend:餐饮:2026-08 类别=餐饮 本月金额=3000.00 CNY");
    await waitFor(() => expect(screen.getByText("已复制飞书排查指令")).toBeInTheDocument());
  });

  it("点击「暂不提醒」→「7 天」后该异常从列表隐藏并写入 localStorage", async () => {
    await renderWithAnomalies(DATA.anomalies);
    // 两条异常时每条都有独立的静音入口，这里静音 warning 那条
    const triggers = screen.getAllByRole("button", { name: "暂不提醒" });
    expect(triggers).toHaveLength(2);
    fireEvent.click(triggers[1]);

    fireEvent.click(screen.getByRole("menuitem", { name: "7 天" }));

    // warning 消失，critical 仍在（静音是逐条生效，不影响其它异常）
    await waitFor(() => expect(screen.queryByText(/类别「餐饮」/)).not.toBeInTheDocument());
    expect(screen.getByRole("list", { name: "严重异常" })).toHaveTextContent("备份过期或从未成功");
    expect(screen.queryByRole("list", { name: "警告异常" })).not.toBeInTheDocument();

    // 只写 localStorage 的指定 key，且记的是未来的过期时间戳
    const map = JSON.parse(localStorage.getItem(SNOOZE_KEY) as string);
    expect(Object.keys(map)).toEqual(["spending_trend:餐饮:2026-08"]);
    expect(map["spending_trend:餐饮:2026-08"]).toBeGreaterThan(Date.now());
    expect(screen.getByText("已静音 7 天")).toBeInTheDocument();
  });

  it("静音操作不发起任何写请求（只读观察层约束）", async () => {
    await renderWithAnomalies(DATA.anomalies);
    fireEvent.click(screen.getAllByRole("button", { name: "暂不提醒" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "不再提醒此异常" }));
    await waitFor(() => expect(screen.queryByText("备份过期或从未成功")).not.toBeInTheDocument());

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    for (const call of fetchMock.mock.calls) {
      const method = (call[1] as RequestInit | undefined)?.method ?? "GET";
      expect(method).toBe("GET");
    }
  });

  it("开启「显示已静音异常」后显示已静音标记与「恢复提醒」按钮", async () => {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ "health:backup": Date.now() + 7 * 86400000 }));
    await renderWithAnomalies(DATA.anomalies);
    // 默认隐藏已静音项
    expect(screen.queryByText("备份过期或从未成功")).not.toBeInTheDocument();
    expect(screen.getByText("已静音 1 项")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "显示已静音异常" }));

    expect(screen.getByText("备份过期或从未成功")).toBeInTheDocument();
    // 视觉标记 + 恢复入口；严重度徽标仍是第一个 badge（不破坏既有断言结构）
    const item = document.querySelector(".anomaly-item.anomaly-critical") as HTMLElement;
    expect(item).toHaveClass("is-snoozed");
    expect(item).toHaveClass("is-neutral-surface");
    expect(item.querySelector(".badge")).toHaveTextContent("严重");
    expect(item).toHaveTextContent("已静音");
    expect(screen.getByRole("button", { name: "恢复提醒" })).toBeInTheDocument();
    // 已静音项不再提供重复静音入口
    expect(screen.getAllByRole("button", { name: "暂不提醒" })).toHaveLength(1);
  });

  it("点击「恢复提醒」后清除 localStorage 记录并恢复常显", async () => {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ "health:backup": Date.now() + 7 * 86400000 }));
    await renderWithAnomalies(DATA.anomalies);
    fireEvent.click(screen.getByRole("checkbox", { name: "显示已静音异常" }));

    fireEvent.click(screen.getByRole("button", { name: "恢复提醒" }));

    expect(JSON.parse(localStorage.getItem(SNOOZE_KEY) as string)).toEqual({});
    expect(screen.getByText("已恢复提醒")).toBeInTheDocument();
    // 关掉开关后依然可见，说明真的解除了静音而不只是被开关放行
    fireEvent.click(screen.getByRole("checkbox", { name: "显示已静音异常" }));
    expect(screen.getByText("备份过期或从未成功")).toBeInTheDocument();
    expect(screen.queryByText(/已静音 \d+ 项/)).not.toBeInTheDocument();
  });

  it("挂载时清理过期静音项，过期异常自动恢复显示", async () => {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({
      "health:backup": Date.now() - 1000, // 已过期
      "spending_trend:餐饮:2026-08": Date.now() + 30 * 86400000, // 未过期
    }));
    await renderWithAnomalies(DATA.anomalies);

    // 过期项被清理并重新提醒
    expect(screen.getByText("备份过期或从未成功")).toBeInTheDocument();
    expect(Object.keys(JSON.parse(localStorage.getItem(SNOOZE_KEY) as string)))
      .toEqual(["spending_trend:餐饮:2026-08"]);
    // 未过期项仍被静音
    expect(screen.queryByText(/类别「餐饮」/)).not.toBeInTheDocument();
  });

  it("全部异常被静音时提示而不是误报「暂无异常」", async () => {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({
      "health:backup": Date.now() + 7 * 86400000,
      "spending_trend:餐饮:2026-08": Date.now() + 7 * 86400000,
    }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(DATA), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderPage();

    await waitFor(() => expect(screen.getByText(/当前异常已全部静音/)).toBeInTheDocument());
    expect(screen.queryByText("暂无异常")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".anomaly-item")).toHaveLength(0);
    // 恢复入口仍然可达
    expect(screen.getByRole("checkbox", { name: "显示已静音异常" })).toBeInTheDocument();
  });

  it("永久关闭后重新挂载仍隐藏，badge 标记为「已关闭」且恢复入口有效", async () => {
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ "health:backup": Date.now() + 100 * 365 * 86400000 }),
    );
    await renderWithAnomalies(DATA.anomalies);

    // 默认隐藏已关闭项，计数文案仍为「已静音 N 项」
    expect(screen.queryByText("备份过期或从未成功")).not.toBeInTheDocument();
    expect(screen.getByText("已静音 1 项")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "显示已静音异常" }));
    const item = document.querySelector(".anomaly-item.anomaly-critical") as HTMLElement;
    // permanent 与 temporary 的 badge 文案区分
    expect(item).toHaveTextContent("已关闭");
    expect(screen.getByRole("button", { name: "恢复提醒" })).toBeInTheDocument();

    // 恢复后记录清除、异常回到常显列表
    fireEvent.click(screen.getByRole("button", { name: "恢复提醒" }));
    expect(JSON.parse(localStorage.getItem(SNOOZE_KEY) as string)).toEqual({});
    await waitFor(() => expect(screen.getByText("备份过期或从未成功")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "显示已静音异常" }));
    expect(screen.getByText("备份过期或从未成功")).toBeInTheDocument();
  });

  it("错误状态保留异常标题与页面壳", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "异常加载失败" }), { status: 500 })));
    renderPage();
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(screen.getByRole("heading", { level: 1, name: "异常" })).toBeInTheDocument();
    expect(document.querySelector(".alerts-page")).toContainElement(alert);
    vi.unstubAllGlobals();
  });
});

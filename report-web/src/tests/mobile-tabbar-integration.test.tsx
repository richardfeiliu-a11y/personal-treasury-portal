import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// A33：路由 redirect 依赖懒加载 chunk，受限并发下可达 1.3-1.8s。
const RENDER_TIMEOUT = 4000;
import { App } from "../App";
import { MaskProvider } from "../components/MaskContext";

// 图表在 jsdom 下不可用，打桩替代
vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
  monthlyBarOption: () => ({}),
  nwTrendOption: () => ({}),
}));

describe("Mobile TabBar & Bucket Routing Integration (WP1 + WP2 + WP3)", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("767px") ? true : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            schema_version: "1.0",
            summary: { total_assets_base: "1000", total_liabilities_base: "0", net_worth_base: "1000" },
            groups: [],
            points: [],
            accounts: [],
            anomalies: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
  });

  function renderMobileApp() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MaskProvider>
          <App />
        </MaskProvider>
      </QueryClientProvider>
    );
  }

  it("移动端视口下渲染 4 个主 Tab 项 (首页/报表/数据/提醒)", async () => {
    window.history.pushState({}, "", "/");
    renderMobileApp();

    const tablist = screen.getByRole("tablist", { name: "主导航" });
    expect(tablist).toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["首页", "报表", "数据", "提醒"]);
  });

  it("点击「报表」Tab 跳转到 /reports/balance-sheet 并展示 4 个二级 chip", async () => {
    window.history.pushState({}, "", "/");
    renderMobileApp();

    const reportTab = screen.getByRole("tab", { name: "报表" });
    fireEvent.click(reportTab);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/reports/balance-sheet");
    }, { timeout: RENDER_TIMEOUT });

    const chipNav = await screen.findByRole("tablist", { name: "报表子导航" });
    expect(chipNav).toBeInTheDocument();
    const chips = within(chipNav).getAllByRole("tab");
    expect(chips.map((c) => c.textContent)).toEqual(["资产负债", "收支", "趋势", "汇率归因"]);
  });

  it("点击「数据」Tab 跳转到 /data/accounts 并展示 2 个二级 chip", async () => {
    window.history.pushState({}, "", "/");
    renderMobileApp();

    const dataTab = screen.getByRole("tab", { name: "数据" });
    fireEvent.click(dataTab);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/data/accounts");
    }, { timeout: RENDER_TIMEOUT });

    const chipNav = await screen.findByRole("tablist", { name: "数据子导航" });
    expect(chipNav).toBeInTheDocument();
    const chips = within(chipNav).getAllByRole("tab");
    expect(chips.map((c) => c.textContent)).toEqual(["账户", "明细"]);
  });

  it("首页与提醒单页直达，不渲染二级 chip 行", async () => {
    window.history.pushState({}, "", "/alerts");
    renderMobileApp();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "异常" })).toBeInTheDocument();
    }, { timeout: RENDER_TIMEOUT });

    expect(screen.queryByRole("tablist", { name: "报表子导航" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "数据子导航" })).not.toBeInTheDocument();
  });

  it("底部 TabBar 支持 WAI-ARIA Tabs 方向键导航与 roving tabindex", () => {
    window.history.pushState({}, "", "/");
    renderMobileApp();

    const tablist = screen.getByRole("tablist", { name: "主导航" });
    const tabs = screen.getAllByRole("tab");

    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-current", "page");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");

    tabs[0].focus();
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(tabs[0]).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// WP07（U03）：768-1199px 无主导航区间修复
// ---------------------------------------------------------------------------

describe("WP07 tablet viewport main navigation", () => {
  function renderMobileApp() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MaskProvider>
          <App />
        </MaskProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    // 平板 1199px：<768 底栏不挂载；桌面侧栏必须渲染（U03 修复后 CSS 同步）
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width: 767px") ? false : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        schema_version: "1.0",
        summary: { total_assets_base: "1000", total_liabilities_base: "0", net_worth_base: "1000" },
        groups: [], points: [], accounts: [], anomalies: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  it("1199px（平板）下 DOM 渲染桌面侧栏主导航（底栏不挂载）", async () => {
    window.history.pushState({}, "", "/");
    renderMobileApp();
    const sidebarNav = await screen.findByRole("navigation", { name: "主导航链接" }, { timeout: RENDER_TIMEOUT });
    expect(sidebarNav).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "首页" }).length).toBeGreaterThan(0);
    // 底栏 tablist 不应挂载
    expect(screen.queryByRole("tablist", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("CSS 契约：侧栏显隐交给 Tailwind 响应式工具，shadcn.css 无遗留 .sidebar 媒体隐藏规则", async () => {
    const { default: css } = await import("../shadcn.css?raw");
    // 纯 Tailwind 外壳：样式表里不再有任何 .sidebar 选择器，也无旧媒体块隐藏侧栏。
    expect(css).not.toContain(".sidebar");
    const blocks1199 = css.match(/@media[^{]*1199px[^{]*\{[\s\S]*?\n\}/g) ?? [];
    for (const block of blocks1199) {
      expect(block).not.toContain(".side-nav");
    }
    // 显隐由 Tailwind 的 max-md:hidden（侧栏）/ max-md:flex（移动底栏）在 DOM 层表达。
    expect(screen.queryByRole("tablist", { name: "主导航" })).not.toBeInTheDocument();
  });
});

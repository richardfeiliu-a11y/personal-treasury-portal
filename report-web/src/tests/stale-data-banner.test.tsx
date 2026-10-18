/**
 * REL-05：刷新失败但缓存仍有上一次成功结果时，页面顶部必须出现「数据可能过期」横幅。
 * 复用 StatusBanner.WarningBanner；判定统一走 isStaleWhileError（含真实 React Query 行为验证）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StaleDataBanner, STALE_DATA_MESSAGE } from "../components/StaleDataBanner";

afterEach(() => {
  cleanup();
});

describe("StaleDataBanner (REL-05)", () => {
  it("error + data 同时存在 → 渲染过期横幅（role=alert）", () => {
    render(
      <StaleDataBanner
        queries={[{ isError: true, data: { generated_at: "2026-08-09T10:00:00+00:00" } }]}
      />,
    );
    const banner = screen.getByTestId("stale-data-banner");
    expect(banner).toHaveTextContent(/数据可能过期/);
    expect(banner).toHaveRole("alert");
  });

  it("横幅措辞只声明必然成立的事实，不谎称屏上是上一次的结果", () => {
    // 横幅出现只能推出「最近一次刷新失败」+「缓存仍有旧值」；
    // 多数页面（明细/异常/收支等）在错误分支用错误横幅替换内容，屏幕上并没有旧值。
    expect(STALE_DATA_MESSAGE).toContain("最近一次刷新失败");
    expect(STALE_DATA_MESSAGE).not.toMatch(/以下为上一次|上一次成功获取/);
    render(<StaleDataBanner queries={[{ isError: true, data: { rows: [] } }]} />);
    expect(screen.getByTestId("stale-data-banner")).toHaveTextContent(STALE_DATA_MESSAGE);
  });

  it("只有错误、无缓存数据 → 不渲染横幅", () => {
    const { container } = render(<StaleDataBanner queries={[{ isError: true, data: undefined }]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("stale-data-banner")).toBeNull();
  });

  it("数据新鲜（无错误）→ 不渲染横幅", () => {
    const { container } = render(<StaleDataBanner queries={[{ isError: false, data: { rows: [] } }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("多路查询：任一陈旧即提示，且只出现一条横幅（避免八处/多路复制）", () => {
    render(
      <StaleDataBanner
        queries={[
          { isError: false, data: { a: 1 } },
          { isError: true, data: { b: 2 } },
          { isError: true, data: { c: 3 } },
        ]}
      />,
    );
    expect(screen.getAllByTestId("stale-data-banner")).toHaveLength(1);
  });

  it("可选依赖槽位为 undefined 时不抛错", () => {
    render(<StaleDataBanner queries={[undefined, { isError: true, data: {} }]} />);
    expect(screen.getByTestId("stale-data-banner")).toBeInTheDocument();
  });

  it("传入 onRefresh 时提供刷新入口，点击触发一次", () => {
    const onRefresh = vi.fn();
    render(<StaleDataBanner queries={[{ isError: true, data: {} }]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("真实 React Query：refetch 失败保留旧 data → 横幅出现（陈旧数据不得伪装成最新）", async () => {
    let fail = false;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });

    function Probe() {
      const q = useQuery<{ value: string }, Error>({
        queryKey: ["rel-05-probe"],
        queryFn: async () => {
          if (fail) throw new Error("刷新失败");
          return { value: "上一次成功结果" };
        },
      });
      return (
        <div>
          <StaleDataBanner queries={[q]} />
          <span data-testid="probe-value">{q.data?.value ?? "无数据"}</span>
        </div>
      );
    }

    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("probe-value")).toHaveTextContent("上一次成功结果"));
    expect(screen.queryByTestId("stale-data-banner")).toBeNull();

    fail = true;
    void qc.invalidateQueries({ queryKey: ["rel-05-probe"] });

    // 关键前提：v5 在 refetch 失败时保留 data —— 若该前提变化，本用例会诚实失败
    await waitFor(() => expect(screen.getByTestId("stale-data-banner")).toBeInTheDocument());
    expect(screen.getByTestId("probe-value")).toHaveTextContent("上一次成功结果");
  });
});

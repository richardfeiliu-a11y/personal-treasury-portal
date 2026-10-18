/**
 * Batch 06（UX-02 / UX-03）：query key 与请求参数严格一一对应。
 *
 * 不变式：key 元组 ⊇ 影响 response 的全部请求参数。
 * 反例（修复前）：`useSpendingTrends` 的 key 只有 `months`（请求却可带 `as_of`）、
 * `useTransactions` 的 key 有 `offset` 却无 `limit`——两组不同的请求参数会静默
 * 共享同一缓存槽，页面因此可能展示与筛选条件不符的数据。
 *
 * 断言双向：key 补齐维度的同时，该维度必须真的进入请求 URL（防止 key 虚增——
 * key 里有、queryFn 不传，只会凭空多出不必要的缓存槽）。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpendingTrends, useTransactions } from "../api/hooks";

function setup() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    void input;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  /** 当前缓存里全部 query key（集合语义：缓存顺序不保证，断言只判成员关系）。 */
  const keys = () => qc.getQueryCache().getAll().map((q) => q.queryKey);
  const hasKey = (k: unknown[]) =>
    keys().some((q) => JSON.stringify(q) === JSON.stringify(k));
  /** 已发出的请求 URL（相对路径 + query string）。 */
  const urls = () => fetchMock.mock.calls.map((call) => String(call[0]));
  /** 第 i 个请求的解析后 query 参数——按参数值比对，避免 `months=6` 被 `months=60` 蒙混过关。 */
  const sp = (i = 0) => new URL(urls()[i]).searchParams;
  return { wrapper, keys, hasKey, urls, sp };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSpendingTrends 查询键（UX-02）", () => {
  it("asOf 进入 key，且同一维度确实进入请求", async () => {
    const { wrapper, keys, hasKey, urls, sp } = setup();
    renderHook(() => useSpendingTrends(6, "2026-01-31"), { wrapper });
    await waitFor(() => expect(urls()).toHaveLength(1));

    expect(keys()).toHaveLength(1);
    expect(hasKey(["spending-trends", 6, "2026-01-31"])).toBe(true);
    expect(sp().get("as_of")).toBe("2026-01-31");
    expect(sp().get("months")).toBe("6");
  });

  it("不传 asOf 时以空串占位，请求也不带 as_of", async () => {
    const { wrapper, keys, hasKey, urls, sp } = setup();
    renderHook(() => useSpendingTrends(6), { wrapper });
    await waitFor(() => expect(urls()).toHaveLength(1));

    expect(keys()).toHaveLength(1);
    expect(hasKey(["spending-trends", 6, ""])).toBe(true);
    expect(sp().has("as_of")).toBe(false);
  });

  it("不同 asOf 各自独立缓存槽，不再共享同一 key", async () => {
    const { wrapper, keys, hasKey, urls } = setup();
    renderHook(() => {
      useSpendingTrends(6, "2026-01-31");
      useSpendingTrends(6, "2026-02-28");
      return null;
    }, { wrapper });
    await waitFor(() => expect(urls()).toHaveLength(2));

    expect(keys()).toHaveLength(2);
    expect(hasKey(["spending-trends", 6, "2026-01-31"])).toBe(true);
    expect(hasKey(["spending-trends", 6, "2026-02-28"])).toBe(true);
  });
});

describe("useTransactions 查询键（UX-03）", () => {
  it("未显式传 limit 时按默认 100 入 key，与请求保持一致", async () => {
    const { wrapper, keys, hasKey, urls, sp } = setup();
    renderHook(
      () => useTransactions({ start: "2026-01-01", end: "2026-01-31" }),
      { wrapper },
    );
    await waitFor(() => expect(urls()).toHaveLength(1));

    expect(keys()).toHaveLength(1);
    expect(hasKey([
      "transactions", "2026-01-01", "2026-01-31", "", "", "", "", "", 100, 0,
    ])).toBe(true);
    expect(sp().get("limit")).toBe("100");
  });

  it("不同 limit 各自独立缓存槽（首页 limit=20 与列表页 limit=100 不再互串）", async () => {
    const { wrapper, keys, hasKey, urls, sp } = setup();
    renderHook(
      () => {
        useTransactions({ start: "2026-01-01", end: "2026-01-31", limit: 20 });
        useTransactions({ start: "2026-01-01", end: "2026-01-31", limit: 100 });
        return null;
      },
      { wrapper },
    );
    await waitFor(() => expect(urls()).toHaveLength(2));

    expect(keys()).toHaveLength(2);
    expect(hasKey([
      "transactions", "2026-01-01", "2026-01-31", "", "", "", "", "", 20, 0,
    ])).toBe(true);
    expect(hasKey([
      "transactions", "2026-01-01", "2026-01-31", "", "", "", "", "", 100, 0,
    ])).toBe(true);
    const limits = urls().map((_, i) => sp(i).get("limit"));
    expect(limits).toHaveLength(2);
    expect(limits).toContain("20");
    expect(limits).toContain("100");
  });

  it("全部筛选维度都在 key 中：任一维度变化都换新缓存槽", async () => {
    const { wrapper, keys, hasKey, urls, sp } = setup();
    renderHook(
      () => {
        useTransactions({
          start: "2026-01-01", end: "2026-01-31", account: "105", category: "餐饮",
          txnType: "expense", reportSide: "expense", reportCategory: "生活",
          limit: 50, offset: 100,
        });
        return null;
      },
      { wrapper },
    );
    await waitFor(() => expect(urls()).toHaveLength(1));

    expect(keys()).toHaveLength(1);
    expect(hasKey([
      "transactions", "2026-01-01", "2026-01-31", "105", "餐饮", "expense", "expense",
      "生活", 50, 100,
    ])).toBe(true);
    expect(sp().get("limit")).toBe("50");
    expect(sp().get("offset")).toBe("100");
  });
});

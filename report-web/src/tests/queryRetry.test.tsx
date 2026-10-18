/**
 * REL-01（Batch 07）：app 级 QueryClient 不做任何前端重试。
 *
 * React Query v5 默认 `retry: 3` + 指数退避（query-core retryer：
 * `defaultRetryDelay = 1000 * 2 ** failureCount`，即首跳 1s、最坏 1+2+4s 之后才 error）。
 * 这一层之上已有两重退避/上限：finance_bridge 的 FireflyClient 用 tenacity 重试 2 次，
 * src/api/client.ts 单请求由 AbortController 封顶 30s。三者叠乘的最坏情况是 90s+ 才
 * 呈现错误。桥已是唯一需要退避的一层，前端因此 fail-fast：失败即刻进入 error，由每页
 * ErrorBanner 的手动刷新按钮承担「再试一次」——用户可见错误延迟 ≤ 单次请求上限（30s）。
 *
 * 被测对象是 main.tsx 构造的那个 client 实例本身（不是手搓的等价配置），因此删掉
 * main.tsx 里的 `retry: false` 会让下面的用例转红；配置断言只是给出更直白的失败原因。
 *
 * 边界：① 计数时点假设 v5 默认 retryDelay；显式设置 retryDelay 后「error 时点即完整尝试数」
 *      仍然成立（重试必然先于 error 终止），只是等待上限需要重估。② 只钉住 app 级默认项，
 *      某个 hook 自带 retry 覆盖这里抓不到。③ app client 是模块级单例，跨文件互不污染靠
 *      vitest `pool: "forks"` 的按文件进程隔离，afterEach 的 clear() 只清缓存、不重置 defaultOptions。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../main";
import { ApiError } from "../api/client";
import { useAnomalies } from "../api/hooks";

// main.tsx 是应用入口：被 import 就会执行 createRoot(document.getElementById("root")!).render(...)。
// jsdom 文档里没有 #root，故只把「容器为空」这一条路径的 createRoot 换成 no-op（挡住入口自渲染，
// 避免整站挂载与真实网络请求）；RTL 从 node_modules 里 require 的是真实实现（外部依赖不经
// vitest mock 拦截），本文件的 renderHook 仍走真 React。
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  type Root = ReturnType<typeof actual.createRoot>;
  const noopRoot = { render: () => {}, unmount: () => {} } as unknown as Root;
  const createRoot = (
    container: Element | DocumentFragment | null,
    options?: Parameters<typeof actual.createRoot>[1],
  ): Root => (container ? actual.createRoot(container, options) : noopRoot);
  const patched = { ...actual, createRoot };
  // main.tsx 用 `import ReactDOM from "react-dom/client"` 取默认导出，故 default 也要打上补丁
  return { ...patched, default: patched };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // app client 是模块级单例：清掉缓存，用例之间不共享 query 状态
  queryClient.clear();
});

describe("app 级 QueryClient 的重试语义（REL-01）", () => {
  it("fetch 失败即刻进入 error，且只发一次请求（不等待退避）", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "Firefly 桥不可用" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAnomalies(), { wrapper });

    // 请求确实发出了（与 error 时序解耦，先确立「一次」这个基线）
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // error 态只在退避链走完后出现，此刻读请求计数即完整尝试数：漏掉 `retry: false` 时
    // error 要等默认退避链 1+2+4s，先被 4s 上限判红；`retry: 1` 时 error 约 1s 到达、
    // 计数已变成 2，由下面那次计数断言判红。
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 4000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(502);
    expect(result.current.error?.message).toBe("Firefly 桥不可用");
  });

  it("main.tsx 的 queries 默认项显式声明 retry: false（配置层直白证据）", () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(false);
  });
});

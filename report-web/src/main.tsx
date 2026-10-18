import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { MaskProvider } from "./components/MaskContext";
import "./fonts.css";
import "./shadcn.css";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      // REL-01：前端一处都不重试——退避只在桥内（FireflyClient tenacity 2 次），单请求
      // 延迟由 src/api/client.ts 的 AbortController 封顶；失败即刻进入 error，由每页
      // ErrorBanner 的手动刷新承担「再试一次」。叠乘延迟的算术与依据见 tests/queryRetry.test.tsx。
      retry: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <MaskProvider>
        <App />
      </MaskProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

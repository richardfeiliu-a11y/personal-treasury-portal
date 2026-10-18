import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:18711",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    sourcemap: false,
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/echarts/") || id.includes("/node_modules/zrender/")) {
            return "echarts";
          }
          if (
            id.includes("/node_modules/react/")
            || id.includes("/node_modules/react-dom/")
            || id.includes("/node_modules/react-router/")
            || id.includes("/node_modules/react-router-dom/")
            || id.includes("/node_modules/@tanstack/")
            || id.includes("/node_modules/scheduler/")
          ) {
            return "vendor";
          }
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["src/tests/setup.ts"],
    // 仅处理 ?raw 导入（CSS fallback 解析测试需要读取原文），其余 CSS 保持 stub
    css: { include: /\.css\?raw$/ },
    // 只收集 src/tests 下的单元测试;e2e/ 由 Playwright 负责,避免重复收集
    include: ["src/tests/**/*.test.{ts,tsx}"],
    // A33：10 核默认全并发 → jsdom 渲染被 CPU 争抢推过 1s 默认 waitFor 超时，
    // 全量偶发漂移失败。上限 4 worker（治本：确定性负载）配合显式等待超时。
    pool: "forks",
    poolOptions: { forks: { maxWorkers: 4 } },
    // 单测超时放宽到 20s（vitest 默认 5s）。原因：本套件 30+ 个文件全部跑 jsdom 环境
    // 并行，页面级用例（Transactions/App 等）单独跑仅 0.5-2.5s，但全量并行时 CPU/内存
    // 争抢会把个别用例推过 5s，导致同一 commit 多次运行的失败集来回漂移（实测同一
    // commit 三次全量分别出现 2/0/1 个超时失败，且失败用例不固定）。这类抖动会掩盖
    // 真实回归，使每次代码审查无法判断失败源于代码还是负载。
    // 放宽阈值不掩盖真正的死锁/挂起——那类问题在 20s 依旧失败；它只为"慢但正确"的
    // 用例留出并行余量。若将来希望治本，可改为限制并发（poolOptions.maxWorkers）。
    testTimeout: 20000,
  },
});

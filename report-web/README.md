# report-web（只读报表门户）

个人 ERP 的只读财务报表前端：React + TypeScript + Vite + TanStack Query + ECharts。

## 本地开发

```bash
npm install
npm run dev            # 开发服务器（需 Nginx 或代理 /api → Bridge）
npm test               # vitest 单元测试
npx tsc --noEmit       # 类型检查
npm run build          # 生产构建到 dist/
npm run build:budget   # 产物体积门禁
```

> 公开代码展示副本不包含 Playwright 端到端套件与截图基线（`e2e/` 目录未随附）；
> 单元测试、类型检查、构建与体积门禁保持完整。

## 目录

- `src/pages/`：资产负债表 / 收支分析 / 账户 / 汇率归因 / 趋势 / 明细 / 异常
- `src/features/home/`：首页（冻结叙事脊，含 hero、组合、归因、账户、近期活动各分区）
- `src/components/`：金额遮蔽、图表、数据表、状态横幅、布局与导航
- `src/utils/`：日期区间、金额格式化、账户筛选排序、图表主题（纯函数，单测覆盖）
- `src/api/`：只读 API 客户端（一律走 `/api`，由 Nginx 注入内部 Token）
- `src/shadcn.css`：设计 token 与组件类的唯一入口

## 样式约定

**只引语义角色 token。** 旧的 `--green-*` / `--neutral-*` / `--page-bg` / `--surface`
双轨已于 2026-10-18 物理删除，现在语义层是唯一入口：

| 组 | token |
|---|---|
| 文字 | `--text-strong` `--text-body` `--text-tertiary` `--text-muted` `--text-subtle` `--text-faint` `--text-placeholder` `--text-disabled` `--text-inverse` |
| 表面 | `--surface-subtle` `--surface-hover` `--table-header-bg` `--surface-inset` `--surface-inverse` `--surface-shimmer` `--surface-raised` |
| 边框 | `--border-subtle` `--border-emphasis` `--divider` |
| 品牌 | `--brand-accent` `--brand-text` `--brand-deep` `--brand-tint` `--brand-border` |
| 数据 | `--data-neutral` `--data-neutral-strong` |

每个 token 在亮/暗各定义一次，不要再写死 hex，也不要把某个 token 当另一个角色用
（`--neutral-50` 当年既做 hover 底又做反白文字，正是这类混用造成了暗色下的实际缺陷）。
`src/tests/css-var-contract.test.ts` 会拦截"引用了未定义且无 fallback 的变量"。

**报表数据表走 `.data-table` 组件类**（`shadcn.css` 的 `@layer components`，作用域限定在
`.data-table-wrap` 内）。表头/单元格/hover/暗色覆盖都在那里，页面只保留各表自己的布局差异。
新增报表表时给 `<table>` 加 `data-table` 并套上 `data-table-wrap` 容器即可。

**语义 token 契约**：`src/tests/css-var-contract.test.ts` 会拦截「引用了未定义
且无 fallback 的 CSS 变量」。私有仓库另有 Playwright 像素基线 / computed-style / axe 三类
e2e 门禁，本公开副本未随附。

## 安全边界

- 浏览器只调用白名单 GET 接口，写接口不可达；
- 金额遮蔽偏好只存 `localStorage`；
- 生产由多阶段 Docker 镜像（Nginx 静态托管）提供，不运行 Node 服务。

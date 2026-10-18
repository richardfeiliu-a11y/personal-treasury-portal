import type * as echarts from "echarts";
import type { ReportEnvelope, ReportSectionRow } from "../api/types";
import { CHART_BASE_OPTION, CHART_COLORS, CHART_TOOLTIP } from "./chartThemes";

/**
 * 把已校验的 Decimal 串转成图表数值（Money discipline R-D7）。
 * 契约（fx-statement K02 裁决）：buildSankeyOption 的入口守卫保证
 * fx_complete=true 时 summary 与行金额均非 null，此处不再对 null 兜底为 0
 * （「缺失绝不折算为 0」铁律的图形版）；非空串必须是有效数字。
 */
function toChartNum(v: string | null | undefined): number {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || Number.isNaN(n)) {
    throw new Error(`sankey: unexpected non-numeric amount ${JSON.stringify(v)}`);
  }
  return n;
}

/** 取节点标签里嵌入的"原始金额小数串"（不含千分位）；契约同上，无兜底。 */
function rawAmountLabel(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") {
    throw new Error(`sankey: unexpected missing amount ${JSON.stringify(v)}`);
  }
  return v;
}

/** 资金流向 Sankey 的节点名称：`<标签> (<原始金额> <币种>)`。 */
function nodeName(label: string, amount: string | null | undefined, currency: string): string {
  return `${label} (${rawAmountLabel(amount)} ${currency})`;
}

/**
 * 由 income-statement 回包（ReportEnvelope）构建资金流向 Sankey option。
 *
 * 数据契约（裁定 D19）：本仓库没有 `IncomeExpenseReport` 类型，真实回包即
 * `ReportEnvelope`；其 `summary` 是 `Record<string, unknown>`，支出分类在
 * `sections` 的 `top_expenses` 节（每行 `label` / `amount_base: string|null`）。
 * 因此函数签名与取数都必须基于 `ReportEnvelope`，而不是任何虚构契约。
 *
 * 优雅降级：以下任一情况返回 `null`（页面据此渲染降级提示，绝不画错图）：
 *  - `report.fx_complete` 为 false（FX 未对齐，金额不可比）；
 *  - `top_expenses` 节缺失或无行；
 *  - 有效支出分类连线（即 `amount_base` 非 null 的分类行）数量 < 2。
 *
 * 连线来源：每条有效支出分类行 → 一条「总收入 → 该分类」的连线
 * （value = Number(amount_base)）；外加一条「总收入 → 结余」的连线
 * （value = Number(net_result_cny)）。节点 = 总收入 + 各支出分类 + 结余。
 */
export function buildSankeyOption(report: ReportEnvelope): echarts.EChartsOption | null {
  // FX 未对齐：金额跨币种不可比，画出来是误导，直接降级。
  if (!report.fx_complete) return null;

  const expenseSection = report.sections.find((sect) => sect.key === "top_expenses");
  const expenseRows: ReportSectionRow[] = expenseSection?.rows ?? [];
  // 找不到 top_expenses 节或它没行 → 无法构成资金去向，降级。
  if (expenseRows.length === 0) return null;

  // 仅保留 amount_base 非 null 的有效分类行用于构建连线；
  // 有效连线数量 < 2 时桑基图会残缺，降级。
  const validRows = expenseRows.filter((r) => r.amount_base !== null && r.amount_base !== undefined);
  if (validRows.length < 2) return null;

  const s = report.summary as {
    total_income_cny?: string | null;
    total_expenses_cny?: string | null;
    net_result_cny?: string | null;
  };
  const base = report.base_currency;
  const incomeNode = nodeName("总收入", s.total_income_cny, base);
  const netNode = nodeName("结余", s.net_result_cny, base);

  const nodes = [
    { name: incomeNode },
    ...validRows.map((r) => ({ name: nodeName(r.label, r.amount_base, base) })),
    { name: netNode },
  ];

  const links = [
    ...validRows.map((r) => ({
      source: incomeNode,
      target: nodeName(r.label, r.amount_base, base),
      value: toChartNum(r.amount_base),
    })),
    // 「总收入 → 结余」：结余可能为负，但连线数值照实反映净结果。
    { source: incomeNode, target: netNode, value: toChartNum(s.net_result_cny) },
  ];

  return {
    ...CHART_BASE_OPTION,
    tooltip: {
      trigger: "item",
      ...CHART_TOOLTIP,
    },
    series: [
      {
        type: "sankey",
        // 节点标签 / 连线颜色在暗色模式下由 applyDarkOverrides 覆盖（裁定 R-D30），
        // 此处只给浅色模式的默认值。
        emphasis: { focus: "adjacency" },
        nodeWidth: 16,
        nodeGap: 12,
        data: nodes,
        links,
        label: { color: CHART_COLORS.axis, fontSize: 12 },
        lineStyle: { color: CHART_COLORS.grid, opacity: 0.5 },
        itemStyle: { color: CHART_COLORS.allocation[0] },
      },
    ],
  };
}

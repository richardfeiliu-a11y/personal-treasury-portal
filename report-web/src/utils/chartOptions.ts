import type * as echarts from "echarts";
import { formatNumber, maskAmount } from "./format";
import { CHART_BASE_OPTION, CHART_COLORS, CHART_TOOLTIP } from "./chartThemes";
import type { WaterfallStep } from "./waterfallReconciliation";

/** 汇率归因（roadmap P0-2） */
export function fxAttributionOption(
  rows: { currency: string; savings_contribution_cny: number | string; fx_contribution_cny: number | string }[],
  masked = false,
) {
  return {
    ...CHART_BASE_OPTION,
    color: [CHART_COLORS.allocation[0], CHART_COLORS.allocation[1]],
    tooltip: {
      trigger: "axis",
      ...CHART_TOOLTIP,
      valueFormatter: (v: unknown) => masked ? "••••" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 0 }),
    },
    legend: { type: "scroll", top: 0, textStyle: { fontSize: 12, color: CHART_COLORS.axis } },
    grid: { left: 8, right: 12, top: 32, bottom: 8, containLabel: true },
    xAxis: {
      type: "category",
      data: rows.map((r) => r.currency),
      axisLabel: { fontSize: 12, color: CHART_COLORS.axis },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        fontSize: 12,
        color: CHART_COLORS.axis,
        formatter: (v: number) => masked ? "••••" : v.toLocaleString("zh-CN", { maximumFractionDigits: 0 }),
      },
      splitLine: { lineStyle: { color: CHART_COLORS.grid, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      { name: "非汇率余额变动贡献", type: "bar", stack: "attribution", data: rows.map((r) => Number(r.savings_contribution_cny)), barMaxWidth: 40,
        label: { show: true, position: "right", fontSize: 12, formatter: (p: { value: number }) => masked ? "••••" : p.value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) } },
      { name: "汇率贡献", type: "bar", stack: "attribution", data: rows.map((r) => Number(r.fx_contribution_cny)), barMaxWidth: 40,
        label: { show: true, position: "right", fontSize: 12, formatter: (p: { value: number }) => masked ? "••••" : p.value.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) } },
    ],
  } as echarts.EChartsOption;
}

/** 币种敞口条形图（roadmap P0-3） */
export function exposureBarOption(
  rows: { currency: string; cny_value: number | string | null }[],
  masked = false,
) {
  const fmt = (v: number) => masked ? "••••" : v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  return {
    ...CHART_BASE_OPTION,
    color: [CHART_COLORS.accent],
    tooltip: {
      trigger: "axis",
      ...CHART_TOOLTIP,
      valueFormatter: (v: unknown) => masked ? "••••" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 0 }),
    },
    grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: "category",
      data: rows.map((r) => r.currency),
      axisLabel: { fontSize: 12, color: CHART_COLORS.axis },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: { fontSize: 12, color: CHART_COLORS.axis, formatter: fmt },
      splitLine: { lineStyle: { color: CHART_COLORS.grid, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [{
      name: "折 CNY",
      type: "bar",
      barMaxWidth: 40,
      data: rows.map((r) => (r.cny_value === null ? null : Number(r.cny_value))),
    }],
  } as echarts.EChartsOption;
}

// ---------------------------------------------------------------------------
// 构成分析 Donut（Composition Analytics V1，spec §7.3 / §8）
// ---------------------------------------------------------------------------

export interface CompositionDonutSlice {
  key: string;
  label: string;
  /** 权威 Decimal 文本；tooltip 直接使用，绝不走 value 浮点回环。 */
  amountText: string;
  value: number;
  color: string;
}

/** 构成扇区配色：colorIndex 对 allocation 循环（第 7 项起复用）；-1 = Other 中性灰。 */
export function compositionColor(colorIndex: number): string {
  if (colorIndex < 0) return CHART_COLORS.allocation[CHART_COLORS.allocation.length - 1];
  return CHART_COLORS.allocation[colorIndex % CHART_COLORS.allocation.length];
}

export interface CompositionDonutOpts {
  masked: boolean;
  currency: string;
  /** 百分比分母口径文案（tooltip 末尾）。 */
  context: "total" | "filtered";
  /** ≤640px 时使用更小的环半径（§8.3）。 */
  mobile?: boolean;
}

/**
 * 构成分析 Donut option（spec §7.3）。
 * - 中心金额由 DOM Amount 叠加渲染（CompositionDonut），不在 canvas graphic 里；
 * - tooltip 金额用 slice 的权威 amountText，遮蔽时金额为 ••••、百分比保留；
 * - 单一正项 = 单条 datum 的 360° 环，显示 100.0%；
 * - 不注册任何 click/事件：V1 扇区不承担导航（Ranking 行是权威交互面）。
 */
export function compositionDonutOption(
  slices: CompositionDonutSlice[],
  opts: CompositionDonutOpts,
): echarts.EChartsOption {
  const contextText = opts.context === "filtered" ? "占当前筛选范围" : "占总计";
  return {
    ...CHART_BASE_OPTION,
    tooltip: {
      trigger: "item",
      ...CHART_TOOLTIP,
      formatter: (params: any) => {
        const slice = params.data as CompositionDonutSlice | undefined;
        const amount = opts.masked
          ? "••••"
          : (slice?.amountText ?? String(params.value));
        const pct =
          params.percent !== undefined ? Number(params.percent).toFixed(1) : "0.0";
        return `${params.name}<br/>${amount} ${opts.currency} · ${pct}%（${contextText}）`;
      },
    },
    series: [
      {
        type: "pie",
        radius: opts.mobile ? ["50%", "70%"] : ["52%", "72%"],
        center: ["50%", "50%"],
        data: slices.map((s) => ({
          name: s.label,
          value: s.value,
          amountText: s.amountText,
          key: s.key,
          itemStyle: { color: s.color },
        })),
        label: { show: false },
        emphasis: {
          scaleSize: 4,
        },
        itemStyle: { borderColor: "#FFFFFF", borderWidth: 2 },
      },
    ],
  } as echarts.EChartsOption;
}

/** 收支柱状（spec §8.4）：income primary-green, expense red */
export function monthlyBarOption(
  months: string[],
  income: (number | null)[],
  expense: (number | null)[],
  masked = false,
) {
  return {
    ...CHART_BASE_OPTION,
    color: [CHART_COLORS.positive, CHART_COLORS.negative],
    tooltip: {
      trigger: "axis",
      ...CHART_TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null
          ? "汇率缺失"
          : masked
            ? "••••"
          : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    },
    legend: { type: "scroll", data: ["收入 (CNY)", "支出 (CNY)"], bottom: 0, textStyle: { color: CHART_COLORS.axis, fontSize: 12 } },
    grid: { left: 8, right: 12, top: 16, bottom: 28, containLabel: true },
    xAxis: {
      type: "category",
      data: months,
      axisLabel: { fontSize: 12, color: CHART_COLORS.axis, hideOverlap: true },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        fontSize: 12,
        color: CHART_COLORS.axis,
        formatter: (v: number) => masked ? "••••" : v.toLocaleString("zh-CN", { maximumFractionDigits: 0 }),
      },
      splitLine: { lineStyle: { color: CHART_COLORS.grid, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "收入 (CNY)",
        type: "bar",
        data: income,
        itemStyle: { color: CHART_COLORS.positive, borderRadius: [3, 3, 0, 0] },
        barCategoryGap: "28%",
      },
      {
        name: "支出 (CNY)",
        type: "bar",
        data: expense,
        itemStyle: { color: CHART_COLORS.negative, borderRadius: [3, 3, 0, 0] },
      },
    ],
  } as echarts.EChartsOption;
}

/**
 * 收支瀑布图（Task 2.1）：透明垫底柱 + 可见柱的堆叠柱状图。
 * - 第 1 个 series 是透明垫底（itemStyle 透明、tooltip 不显示），负责把可见柱"抬"到正确高度；
 * - 第 2 个 series 是可见柱，按收入/支出/合计三类分色。
 * tooltip 显示的金额用 step 的**权威 amount 字符串**，绝不走 value 浮点回环。
 * 收入/支出/合计三类柱应有区分色：绿(收入) / 红(支出) / 蓝(合计)。
 */
export function waterfallOption(steps: WaterfallStep[], baseCurrency: string) {
  const WATERFALL_TYPE_COLOR: Record<WaterfallStep["type"], string> = {
    income: CHART_COLORS.positive,
    expense: CHART_COLORS.negative,
    total: CHART_COLORS.allocation[2],
  };
  const labels = steps.map((s) => s.label);
  const baseData = steps.map((s) => s.base);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visibleData: any[] = steps.map((s) => ({
    value: s.value,
    itemStyle: { color: WATERFALL_TYPE_COLOR[s.type] },
    // 透传权威十进制金额，tooltip/标签使用，避免浮点回环
    stepAmount: s.amount,
    stepType: s.type,
  }));
  return {
    ...CHART_BASE_OPTION,
    color: [CHART_COLORS.positive, CHART_COLORS.negative, CHART_COLORS.allocation[2]],
    tooltip: {
      trigger: "axis",
      ...CHART_TOOLTIP,
      formatter: (params: any) => {
        const arr = Array.isArray(params) ? params : [params];
        // 只取可见柱（seriesName="收支"），忽略透明垫底柱
        const p = arr.find((x: any) => x.seriesName === "收支") ?? arr[arr.length - 1];
        if (!p) return "";
        const step = steps[p.dataIndex];
        if (!step) return "";
        const sign = step.type === "expense" ? "−" : step.type === "income" ? "+" : "";
        return `${step.label}<br/>${sign}${step.amount} ${baseCurrency}`;
      },
    },
    grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { fontSize: 12, color: CHART_COLORS.axis, hideOverlap: true },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        fontSize: 12,
        color: CHART_COLORS.axis,
        formatter: (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 0 }),
      },
      splitLine: { lineStyle: { color: CHART_COLORS.grid, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "_base",
        type: "bar",
        stack: "waterfall",
        barMaxWidth: 44,
        itemStyle: { color: "transparent" },
        emphasis: { itemStyle: { color: "transparent" } },
        tooltip: { show: false },
        silent: true,
        data: baseData,
      },
      {
        name: "收支",
        type: "bar",
        stack: "waterfall",
        barMaxWidth: 44,
        data: visibleData,
        label: {
          show: true,
          position: "top",
          fontSize: 11,
          color: CHART_COLORS.axis,
          formatter: (p: any) => {
            const step = steps[p.dataIndex];
            return step ? step.amount : "";
          },
        },
      },
    ],
  } as echarts.EChartsOption;
}

/**
 * 净资产趋势（dynamic baseline, Spec §7.3, C4 P0）
 * Y-axis starts at dataMin * 0.9 (never zero-anchored)
 * grid lines: neutral-100, dark mode: neutral-700
 */
export function nwTrendOption(
  points: { date: string; net_worth_base: string | null }[],
  masked = false,
  goal?: number | null,
) {
  const labels = points.map((p) => p.date.slice(0, 7));
  const values = points.map((p) => (p.net_worth_base === null ? null : Number(p.net_worth_base)));
  const numericValues = values.filter((v): v is number => v !== null);

  if (numericValues.length === 0) {
    return { ...CHART_BASE_OPTION, series: [] };
  }

  const dataMin = Math.min(...numericValues);

  const yMin = dataMin >= 0 ? dataMin * 0.9 : dataMin * 1.1;
  // yMax auto (echarts will handle it)
  const goalLabel =
    goal !== undefined && goal !== null
      ? masked
        ? `目标 ${maskAmount(formatNumber(goal))}`
        : `目标 ${formatNumber(goal)}`
      : "";

  const axisFmt = (v: number) =>
    masked ? '\u2022\u2022\u2022\u2022' : v.toLocaleString('zh-CN', { maximumFractionDigits: 0 });

  return {
    ...CHART_BASE_OPTION,
    color: [CHART_COLORS.accent],
    tooltip: {
      trigger: 'axis',
      ...CHART_TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null
          ? '汇率缺失'
          : masked
            ? '\u2022\u2022\u2022\u2022'
            : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }),
    },
    grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 12, color: CHART_COLORS.axis, hideOverlap: true },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      min: yMin,
      axisLabel: {
        fontSize: 12,
        color: CHART_COLORS.axis,
        formatter: axisFmt,
      },
      splitLine: { lineStyle: { color: CHART_COLORS.grid, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: '净资产 (CNY)',
        type: 'line',
        data: values,
        smooth: true,
        connectNulls: false,
        symbol: 'circle',
        symbolSize: 4,
        itemStyle: { borderColor: '#FFFFFF', borderWidth: 2 },
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.14 },
        markLine:
          goal !== undefined && goal !== null
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { type: "dashed", width: 1, color: CHART_COLORS.allocation[1] },
                label: {
                  formatter: goalLabel,
                  position: "end",
                  color: CHART_COLORS.allocation[1],
                  fontSize: 12,
                },
                data: [{ yAxis: goal }],
              }
            : undefined,
      },
    ],
  } as echarts.EChartsOption;
}

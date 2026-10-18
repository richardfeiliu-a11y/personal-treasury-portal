/**
 * 首页专用图表 option（品牌绿）。
 *
 * 刻意独立于 src/utils/chartThemes.ts / chartOptions.ts——那些常量仍被尚未迁移的
 * reports/data/alerts 页面引用，改全局配色会污染其他页面。首页只引用本文件，
 * 绿的明度阶梯为主、克制金色点缀；网格/轴/tooltip 走中性色与卡片面。
 */
import type * as echarts from "echarts";
import { formatNumber } from "../../utils/format";

/** 品牌绿明度阶梯（深 → 浅），第 6 段起中性灰；金色仅作克制点缀。 */
export const HOME_GREENS = [
  "#0B2E27",
  "#157A5A",
  "#28A06F",
  "#5FBE95",
  "#94D4B6",
  "#C9E9DA",
] as const;

/** 克制金色点缀（目标线 / 汇率归因）。 */
export const HOME_GOLD = "#C9A24B";

const AXIS = "#8A93A0";
const GRID = "#EDF0F2";

const TOOLTIP = {
  backgroundColor: "#FFFFFF",
  borderColor: "#E5E7EB",
  borderWidth: 1,
  padding: [8, 12] as [number, number],
  textStyle: { color: "#0B2E27", fontSize: 12 },
  extraCssText:
    "box-shadow:0 8px 24px rgba(11,46,39,0.10);border-radius:10px;",
};

/**
 * 首页净资产趋势：品牌绿折线 + 同色淡面积；动态基线（不锚零）；
 * 目标线用克制金色虚线。null 值不连线（缺汇率月份留空）。
 */
export function homeNwTrendOption(
  points: { date: string; net_worth_base: string | null }[],
  masked = false,
  goal?: number | null,
): echarts.EChartsOption {
  const labels = points.map((p) => p.date.slice(0, 7));
  const values = points.map((p) =>
    p.net_worth_base === null ? null : Number(p.net_worth_base),
  );
  const numeric = values.filter((v): v is number => v !== null);

  if (numeric.length === 0) {
    return {
      animationDuration: 240,
      textStyle: {
        fontFamily:
          "Inter Variable, Inter, PingFang SC, Hiragino Sans GB, sans-serif",
      },
      series: [],
    };
  }

  const dataMin = Math.min(...numeric);
  const yMin = dataMin >= 0 ? dataMin * 0.92 : dataMin * 1.08;
  const dots = masked ? "••••" : "";
  const axisFmt = (v: number) =>
    masked ? "••••" : v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });

  return {
    animationDuration: 320,
    animationDurationUpdate: 200,
    textStyle: {
      fontFamily:
        "Inter Variable, Inter, PingFang SC, Hiragino Sans GB, sans-serif",
    },
    tooltip: {
      trigger: "axis",
      ...TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null
          ? "汇率缺失"
          : masked
            ? dots
            : Number(v).toLocaleString("zh-CN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
    },
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLabel: { fontSize: 11, color: AXIS, hideOverlap: true, margin: 12 },
      axisLine: { lineStyle: { color: GRID } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      min: yMin,
      axisLabel: { fontSize: 11, color: AXIS, formatter: axisFmt },
      splitLine: { lineStyle: { color: GRID, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        name: "净资产 (CNY)",
        type: "line",
        data: values,
        smooth: 0.32,
        connectNulls: false,
        symbol: "circle",
        symbolSize: 5,
        itemStyle: { color: "#157A5A", borderColor: "#FFFFFF", borderWidth: 2 },
        lineStyle: { width: 2.5, color: "#157A5A" },
        areaStyle: {
          opacity: 1,
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(40,160,111,0.22)" },
              { offset: 1, color: "rgba(40,160,111,0.02)" },
            ],
          },
        },
        markLine:
          goal !== undefined && goal !== null
            ? {
                silent: true,
                symbol: "none",
                lineStyle: { type: "dashed", width: 1.5, color: HOME_GOLD },
                label: {
                  formatter: masked
                    ? `目标 ${dots}`
                    : `目标 ${formatNumber(goal)}`,
                  position: "insideEndTop",
                  color: HOME_GOLD,
                  fontSize: 11,
                },
                data: [{ yAxis: goal }],
              }
            : undefined,
      },
    ],
  } as echarts.EChartsOption;
}

export interface HomeDonutSlice {
  key: string;
  label: string;
  /** 权威 Decimal 文本，tooltip 直接使用，不走浮点回环。 */
  amountText: string;
  value: number;
  color: string;
}

/**
 * 首页资产组合环：品牌绿明度阶梯；白色细分隔（暗色由 EChart 走
 * applyDarkOverrides 自动换深边）。中心金额由 DOM 叠加，不在 canvas 内。
 */
export function homeCompositionDonutOption(
  slices: HomeDonutSlice[],
  opts: { masked: boolean; currency: string },
): echarts.EChartsOption {
  return {
    animationDuration: 320,
    textStyle: {
      fontFamily:
        "Inter Variable, Inter, PingFang SC, Hiragino Sans GB, sans-serif",
    },
    tooltip: {
      trigger: "item",
      ...TOOLTIP,
      formatter: (params: any) => {
        const slice = params.data as HomeDonutSlice | undefined;
        const amount = opts.masked
          ? "••••"
          : (slice?.amountText ?? String(params.value));
        const pct =
          params.percent !== undefined ? Number(params.percent).toFixed(1) : "0.0";
        return `${params.name}<br/>${amount} ${opts.currency} · ${pct}%`;
      },
    },
    series: [
      {
        type: "pie",
        radius: ["66%", "84%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        data: slices.map((s) => ({
          name: s.label,
          value: s.value,
          amountText: s.amountText,
          key: s.key,
          itemStyle: { color: s.color },
        })),
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scaleSize: 4 },
        itemStyle: { borderColor: "#FFFFFF", borderWidth: 2 },
      },
    ],
  } as echarts.EChartsOption;
}

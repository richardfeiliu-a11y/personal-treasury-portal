/**
 * 品牌绿 ECharts 共享主题（迁移页统一图表层）。
 *
 * 设计语言（与 features/home/homeChartOptions.ts 一致）：
 * - 品牌绿明度阶梯为主色，金色仅作克制点缀；
 * - 坐标轴 / 网格 / tooltip 走中性细线与卡片白底，暗色由 ChartWrapper 的
 *   applyDarkOverrides 统一处理。
 *
 * 旧 utils/chartOptions.ts 的各 option builder 仍保留（第三轮清理），其色值经
 * chartThemes.ts 的 CHART_COLORS 已重映射为品牌绿；本文件提供迁移页直接使用的
 * 高阶 option 工厂，避免每页重复拼 axis/grid/tooltip。
 */
import type * as echarts from "echarts";

/** 品牌绿明度阶梯（深 → 浅）。 */
export const BRAND_GREENS = [
  "#0B2E27",
  "#157A5A",
  "#28A06F",
  "#5FBE95",
  "#94D4B6",
  "#C9E9DA",
] as const;

/** 克制金色点缀（汇率贡献 / 目标线）。 */
export const BRAND_GOLD = "#C9A24B";

/** 语义色（克制使用）。 */
export const BRAND_SEMANTIC = {
  income: "#157A5A",
  expense: "#BC564E",
  neutral: "#8A93A0",
} as const;

const AXIS = "#8A93A0";
const GRID = "#EDF0F2";

const FONT_STACK =
  "Inter Variable, Inter, PingFang SC, Hiragino Sans GB, sans-serif";

/** 卡片白底 tooltip（中性发丝边 + 柔和深绿投影）。 */
export const BRAND_TOOLTIP = {
  backgroundColor: "#FFFFFF",
  borderColor: "#E5E7EB",
  borderWidth: 1,
  padding: [8, 12] as [number, number],
  textStyle: { color: "#0B2E27", fontSize: 12, fontFamily: FONT_STACK },
  extraCssText:
    "box-shadow:0 8px 24px rgba(11,46,39,0.10);border-radius:10px;",
};

/** 所有品牌图表共享的基础项（字体 + 动画契约）。 */
export const brandBase = {
  textStyle: { fontFamily: FONT_STACK },
  animationDuration: 300,
  animationDurationUpdate: 200,
} as const;

/** 遮蔽时的占位符。 */
export const MASK_DOTS = "••••";

const intFmt = (v: number) =>
  v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });

export interface BrandSeries {
  name: string;
  data: (number | null)[];
  /** 缺省按品牌绿阶梯取色。 */
  color?: string;
  /** 面积透明度（仅折线）。 */
  area?: boolean;
  /** 虚线（对比 / 目标序列）。 */
  dashed?: boolean;
}

/**
 * 多指标折线图：品牌绿折线 + 可选淡面积；null 不连线；动态基线（不锚零）。
 */
export function brandLineOption(
  labels: string[],
  series: BrandSeries[],
  opts: { masked?: boolean; yMin?: number } = {},
): echarts.EChartsOption {
  const numeric = series
    .flatMap((s) => s.data)
    .filter((v): v is number => v !== null);
  if (numeric.length === 0)
    return { ...brandBase, series: [] } as echarts.EChartsOption;

  const dataMin = Math.min(...numeric);
  const yMin =
    opts.yMin ?? (dataMin >= 0 ? dataMin * 0.92 : dataMin * 1.08);
  const axisFmt = (v: number) => (opts.masked ? MASK_DOTS : intFmt(v));

  return {
    ...brandBase,
    tooltip: {
      trigger: "axis",
      ...BRAND_TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null
          ? "缺失"
          : opts.masked
            ? MASK_DOTS
            : Number(v).toLocaleString("zh-CN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
    },
    legend:
      series.length > 1
        ? {
            type: "scroll",
            top: 0,
            textStyle: { fontSize: 12, color: AXIS },
            itemWidth: 14,
            itemHeight: 8,
          }
        : undefined,
    grid: { left: 8, right: 16, top: series.length > 1 ? 36 : 20, bottom: 8, containLabel: true },
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
    series: series.map((s, i) => {
      const color = s.color ?? BRAND_GREENS[(i + 1) % BRAND_GREENS.length];
      return {
        name: s.name,
        type: "line",
        smooth: 0.3,
        connectNulls: false,
        symbol: "circle",
        symbolSize: 5,
        data: s.data,
        itemStyle: { color, borderColor: "#FFFFFF", borderWidth: 2 },
        lineStyle: { width: 2.5, color, type: s.dashed ? "dashed" : "solid" },
        areaStyle: s.area
          ? {
              opacity: 1,
              color: {
                type: "linear",
                x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: hexToRgba(color, 0.2) },
                  { offset: 1, color: hexToRgba(color, 0.02) },
                ],
              },
            }
          : undefined,
      };
    }),
  } as echarts.EChartsOption;
}

/**
 * 分组柱状图（纵向）：品牌绿阶梯；radius 顶部圆角。
 */
export function brandBarOption(
  labels: string[],
  series: BrandSeries[],
  opts: { masked?: boolean; legendData?: string[] } = {},
): echarts.EChartsOption {
  return {
    ...brandBase,
    tooltip: {
      trigger: "axis",
      ...BRAND_TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null
          ? "缺失"
          : opts.masked
            ? MASK_DOTS
            : Number(v).toLocaleString("zh-CN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
    },
    legend:
      series.length > 1
        ? {
            type: "scroll",
            bottom: 0,
            data: opts.legendData ?? series.map((s) => s.name),
            textStyle: { fontSize: 12, color: AXIS },
            itemWidth: 14,
            itemHeight: 8,
          }
        : undefined,
    grid: { left: 8, right: 12, top: 16, bottom: series.length > 1 ? 32 : 8, containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { fontSize: 11, color: AXIS, hideOverlap: true },
      axisLine: { lineStyle: { color: GRID } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        fontSize: 11,
        color: AXIS,
        formatter: (v: number) => (opts.masked ? MASK_DOTS : intFmt(v)),
      },
      splitLine: { lineStyle: { color: GRID, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: "bar",
      barCategoryGap: "30%",
      barMaxWidth: 36,
      data: s.data,
      itemStyle: {
        color: s.color ?? BRAND_GREENS[(i + 1) % BRAND_GREENS.length],
        borderRadius: [3, 3, 0, 0],
      },
    })),
  } as echarts.EChartsOption;
}

/**
 * 横向堆叠条（汇率归因专用）：储蓄贡献品牌绿 + 汇率贡献克制金；
 * 同时支持负值（FX 损失）。
 */
export function brandHStackOption(
  categories: string[],
  series: BrandSeries[],
  opts: { masked?: boolean } = {},
): echarts.EChartsOption {
  return {
    ...brandBase,
    tooltip: {
      trigger: "axis",
      ...BRAND_TOOLTIP,
      valueFormatter: (v: unknown) =>
        v === null
          ? "缺失"
          : opts.masked
            ? MASK_DOTS
            : Number(v).toLocaleString("zh-CN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
    },
    legend: {
      type: "scroll",
      top: 0,
      textStyle: { fontSize: 12, color: AXIS },
      itemWidth: 14,
      itemHeight: 8,
    },
    grid: { left: 8, right: 24, top: 36, bottom: 8, containLabel: true },
    xAxis: {
      type: "value",
      axisLabel: {
        fontSize: 11,
        color: AXIS,
        formatter: (v: number) => (opts.masked ? MASK_DOTS : intFmt(v)),
      },
      splitLine: { lineStyle: { color: GRID, width: 1 } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: "category",
      data: categories,
      axisLabel: { fontSize: 12, color: AXIS },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: "bar",
      stack: "total",
      barMaxWidth: 26,
      data: s.data,
      itemStyle: {
        color: s.color ?? [BRAND_GREENS[1], BRAND_GOLD][i] ?? BRAND_GREENS[i + 1],
      },
    })),
  } as echarts.EChartsOption;
}

/** #RRGGBB + alpha → rgba()。 */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

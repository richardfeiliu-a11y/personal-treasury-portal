import type * as echarts from "echarts";

/**
 * 图表主题常量。第二批迁移起已统一为品牌绿色板（见 utils/brandChart.ts）：
 * 品牌绿明度阶梯 + 克制语义色，金色点缀收在 brandChart.BRAND_GOLD。
 * 旧字段名保留，以免 chartOptions / sankeyOptions / composition 各调用点改动。
 */
export const CHART_COLORS = {
  // 品牌主绿（净资产趋势 / 正向序列）
  accent: "#157A5A",
  // 收入绿
  positive: "#157A5A",
  // 支出赭红（克制语义色）
  negative: "#BC564E",
  // 品牌绿明度阶梯；第 6 段为中性灰（Other / 缺折算）
  allocation: ["#157A5A", "#28A06F", "#5FBE95", "#94D4B6", "#C9E9DA", "#8A93A0"],
  // Axes & gridlines
  axis: "#8A93A0",
  grid: "#EDF0F2",
} as const;

/** 图表 tooltip 主题（roadmap P2-2）：所有图表函数共用，避免硬编码。 */
export const CHART_TOOLTIP = {
  backgroundColor: "#FFFFFF",
  borderColor: "#E5E7EB",
  textStyle: { color: "#1F2937" },
} as const;

/** 所有图表共用的基础 option（字体与动画时长契约）。 */
export const CHART_BASE_OPTION = {
  textStyle: { fontFamily: "Inter Variable, Inter, PingFang SC, sans-serif" },
  animationDuration: 220,
  animationDurationUpdate: 150,
  // ECharts media rules keep mobile tooltips tap-driven and sticky until the next
  // tap, without branching business data or chart series in React pages.
  media: [{
    query: { maxWidth: 640 },
    option: {
      tooltip: {
        triggerOn: "click",
        alwaysShowContent: true,
        confine: true,
      },
    },
  }],
};

/**
 * 暗色模式下需要调整的颜色。
 *
 * 为什么是字面 hex 而不是语义 token：ECharts 画在 canvas 上，canvas 不解析 CSS
 * `var()`，必须拿到具体色值；写 `"var(--card)"` 会被当成非法颜色静默失效。
 * 因此这里只能手工镜像语义层。
 *
 * 已知漂移（2026-10-18 记录，本次刻意未改）：下面这组值仍是 95c8f26 换墨绿底之前的
 * GitHub 灰系 —— tooltipBg/itemBorder/pieBorder 的 #161b22 对应当时的卡片底，而现在
 * 卡片底是 --card #0f382f；axis #8b949e 对应当年的 --text-caption，现在是 #929aa3。
 * 也就是说暗色下图表 tooltip 仍是灰底，与全站墨绿不一致。修它属于视觉变更（要动图表
 * 截图基线），故与「旧 token 物理删除」分开处理。
 */
export const DARK_OVERRIDES = {
  axis: "#8b949e",
  grid: "#30363d",
  tooltipBg: "#161b22",
  tooltipBorder: "#30363d",
  tooltipText: "#e6edf3",
  itemBorder: "#161b22",
  pieBorder: "#161b22",
} as const;

/** 检测当前是否暗色模式 */
export function isDarkMode(): boolean {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

/** 暗色模式颜色覆盖：递归替换 tooltip 背景、轴颜色等 */
export function applyDarkOverrides(option: echarts.EChartsOption): echarts.EChartsOption {
  const o = { ...option } as any;

  // Tooltip 背景
  if (o.tooltip) {
    o.tooltip = {
      ...o.tooltip,
      backgroundColor: DARK_OVERRIDES.tooltipBg,
      borderColor: DARK_OVERRIDES.tooltipBorder,
      textStyle: { ...o.tooltip.textStyle, color: DARK_OVERRIDES.tooltipText },
    };
  }

  // X 轴标签颜色
  if (o.xAxis && typeof o.xAxis === "object" && !Array.isArray(o.xAxis)) {
    const axis = o.xAxis as any;
    if (axis.axisLabel) {
      axis.axisLabel = { ...axis.axisLabel, color: DARK_OVERRIDES.axis };
    }
  }

  // Y 轴标签颜色 + 分割线颜色
  if (o.yAxis && typeof o.yAxis === "object" && !Array.isArray(o.yAxis)) {
    const axis = o.yAxis as any;
    if (axis.axisLabel) {
      axis.axisLabel = { ...axis.axisLabel, color: DARK_OVERRIDES.axis };
    }
    if (axis.splitLine?.lineStyle) {
      axis.splitLine = {
        ...axis.splitLine,
        lineStyle: { ...axis.splitLine.lineStyle, color: DARK_OVERRIDES.grid },
      };
    }
  }

  // Legend 文字颜色
  if (o.legend && typeof o.legend === "object") {
    const legend = o.legend as any;
    if (legend.textStyle) {
      legend.textStyle = { ...legend.textStyle, color: DARK_OVERRIDES.axis };
    }
  }

  // 系列 itemStyle borderColor（饼图等）
  if (o.series && Array.isArray(o.series)) {
    o.series = o.series.map((s: any) => {
      // Sankey（资金流向）：暗色模式下节点标签与连线需重染，否则在深色背景上看不清。
      // 标签文字用暗色文字 token（DARK_OVERRIDES.axis），连线用暗色网格 token（DARK_OVERRIDES.grid）。
      if (s.type === "sankey") {
        return {
          ...s,
          label: { ...s.label, color: DARK_OVERRIDES.axis },
          lineStyle: { ...s.lineStyle, color: DARK_OVERRIDES.grid },
        };
      }
      if (s.itemStyle?.borderColor === "#FFFFFF") {
        return { ...s, itemStyle: { ...s.itemStyle, borderColor: DARK_OVERRIDES.pieBorder } };
      }
      return s;
    });
  }

  return o;
}

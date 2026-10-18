import { useEffect, useRef, useState } from "react";
import type * as echarts from "echarts";
import { BarChart, LineChart, PieChart, SankeyChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { init, use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { applyDarkOverrides, isDarkMode } from "../utils/chartThemes";

// ECharts 按需注册：只打包用到的图表/组件/renderer，减小 bundle。
// 放在 ChartWrapper（EChart 所在模块），任何使用 EChart 的页面都会先加载它完成注册。
use([
  BarChart,
  LineChart,
  PieChart,
  SankeyChart,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** ECharts 通用封装：支持 ResizeObserver，容器或窗口变动时自动重绘。 */
export function EChart({
  option,
  height = 260,
  ariaLabel,
}: {
  option: echarts.EChartsOption;
  /** number 保持旧行为（px）；string（如 "100%"）支持 CSS 驱动的响应式容器（spec §2.3）。 */
  height?: number | string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [dark, setDark] = useState(isDarkMode);

  // 监听主题变化
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(isDarkMode());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ref.current) return;
    const chart = init(ref.current);
    chartRef.current = chart;

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);

    const ro = new ResizeObserver(() => {
      chart.resize();
    });
    ro.observe(ref.current);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    // 暗色模式下覆盖硬编码颜色
    let finalOption = option;
    if (dark) {
      finalOption = applyDarkOverrides(option);
    }

    chartRef.current?.setOption(reduceMotion ? { ...finalOption, animation: false } : finalOption, { notMerge: true });
  }, [option, dark]);

  return <div ref={ref} style={{ height, width: "100%" }} role="img" aria-label={ariaLabel} />;
}

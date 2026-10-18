import { useMemo } from "react";
import { EChart } from "../ChartWrapper";
import { useMask } from "../MaskContext";
import { Amount } from "../Amount";
import {
  compositionDonutOption,
  type CompositionDonutSlice,
} from "../../utils/chartOptions";

/**
 * 构成分析 Donut（spec §7.3）：
 * - 中心金额是绝对定位的真实 DOM `<Amount>`，自动响应 MaskContext；
 * - ECharts tooltip 金额遮蔽为 ••••，百分比保留；
 * - aria-label 遮蔽时禁止包含真实金额，改为「金额已遮蔽」；
 * - 无 click / onSliceActivate：V1 扇区不承担导航（Ranking 行是权威交互面）。
 */
export interface CompositionDonutProps {
  slices: CompositionDonutSlice[];
  centerAmount: string;
  centerLabel: string;
  currency: string;
  caption: string;
  tooltipContext: "total" | "filtered";
  /** 未遮蔽时的完整 aria 描述（含 top labels、百分比与中心金额，由调用方构造）。 */
  ariaLabel: string;
}

export function CompositionDonut({
  slices,
  centerAmount,
  centerLabel,
  currency,
  caption,
  tooltipContext,
  ariaLabel,
}: CompositionDonutProps) {
  const { masked } = useMask();
  const option = useMemo(
    () => compositionDonutOption(slices, { masked, currency, context: tooltipContext }),
    [slices, masked, currency, tooltipContext],
  );

  return (
    <figure className="comp-donut m-0 flex flex-col gap-[var(--space-2)]">
      <div className="comp-donut-canvas relative h-[270px] max-sm:h-[190px]">
        <EChart
          option={option}
          height="100%"
          ariaLabel={masked ? "构成环形图，金额已遮蔽" : ariaLabel}
        />
        <div className="comp-donut-center absolute inset-0 flex flex-col items-center justify-center gap-1 pointer-events-none">
          <Amount value={centerAmount} currency={currency} />
          <span className="text-[var(--text-faint)] [font:var(--type-caption)]">{centerLabel}</span>
        </div>
      </div>
      <figcaption className="comp-donut-caption text-[var(--text-faint)] [font:var(--type-caption)] text-center [font-variant-numeric:tabular-nums]">
        {caption}
        {tooltipContext === "filtered" ? "（占当前筛选范围）" : ""}
      </figcaption>
    </figure>
  );
}

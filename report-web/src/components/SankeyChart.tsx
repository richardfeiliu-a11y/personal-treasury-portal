import type { EChartsOption } from "echarts";
import { EChart } from "./Chart";

/**
 * 资金流向 Sankey 图组件（Task 3.2）。
 *
 * 本组件只负责渲染：option 已在上层（IncomeExpense 分析卡的「资金流向」tab）
 * 通过 `buildSankeyOption` 预构建并做降级判断——若 option 为 null，上层直接渲染
 * 降级空状态，不会把本组件渲染成错图。因此这里假定拿到的 option 一定可画。
 *
 * `baseCurrency` 透传给底层用于无障碍语义与样式钩子（data-currency）。
 */
export function SankeyChart({
  option,
  baseCurrency,
}: {
  option: EChartsOption;
  baseCurrency: string;
}) {
  return (
    <div className="w-full" data-currency={baseCurrency}>
      <EChart option={option} ariaLabel="资金流向桑基图" height={340} />
    </div>
  );
}

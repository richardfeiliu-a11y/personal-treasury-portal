/**
 * 图表统一入口：EChart 组件（实现见 ./ChartWrapper）与页面在用的 option builder。
 * 历史上曾 re-export 全部 builder（WP-01 抽取后的兼容层）；A03 消融后仅保留
 * 生产实际经此路径 import 的符号，其余从 ../utils/chartOptions 直接引入。
 */
export { EChart } from "./ChartWrapper";
export {
  fxAttributionOption,
  exposureBarOption,
  monthlyBarOption,
} from "../utils/chartOptions";

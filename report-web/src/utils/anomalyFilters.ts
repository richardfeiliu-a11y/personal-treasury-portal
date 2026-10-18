/**
 * 异常流过滤与排序：纯函数，便于单元测试，渲染期不直接读 localStorage。
 * Snooze 存储读写委托给 utils/snooze.ts（唯一可信的本地存储层）。
 *
 * 这些函数只负责「给定异常列表 + 静音表 -> 排序 / 过滤 / 统计」的纯判断，
 * 与存储媒介解耦，镜像 snooze.test.ts 的测试约定。
 */
import type { AnomalyRow } from "../api/types";
import {
  clearExpiredSnoozes,
  type DismissalState,
  getDismissals,
  isAnomalyVisible,
} from "./snooze";

/** 严重度 -> 排序权重（高在前：Critical -> Warning -> Info）。 */
export const SEVERITY_RANK: Record<AnomalyRow["severity"], number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/** 严重度 -> 静态分组展示标签。 */
export const SEVERITY_LABEL: Record<AnomalyRow["severity"], string> = {
  critical: "严重",
  warning: "警告",
  info: "提示",
};

/** 显示/隐藏已静音异常的过滤器选项。 */
export type AnomalyFilters = { showSnoozed: boolean };

/** 归一化关闭表：id -> temporary/permanent 状态（语义由 snooze.ts 内聚）。 */
export type DismissalMap = Record<string, DismissalState>;

/** 已关闭的异常（带归一化状态，用于「显示已关闭异常」视图）。 */

const amountToNumber = (a: AnomalyRow): number => (a.amount ? Number(a.amount) : 0);

/** 页面挂载时读取并清理过期静音，返回当前仍生效的归一化关闭表。 */
export function loadSnoozedAnomalies(): DismissalMap {
  clearExpiredSnoozes();
  return getDismissals();
}

/**
 * 按严重度降序（Critical -> Warning -> Info），同级按金额绝对值降序。
 * 返回新数组，不改变入参（纯函数）。
 */
export function sortAnomaliesBySeverity(anomalies: AnomalyRow[]): AnomalyRow[] {
  return [...anomalies].sort((a, b) => {
    const byRank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (byRank !== 0) return byRank;
    return Math.abs(amountToNumber(b)) - Math.abs(amountToNumber(a));
  });
}

/**
 * badge 口径：该异常当前是否处于任一关闭状态（temporary/permanent 均计入）。
 * 与 UI 可见性解耦——badge 只回答「有没有未读异常」，不受 showSnoozed 开关影响。
 */
export function isAnomalyDismissed(
  anomaly: AnomalyRow,
  dismissals: DismissalMap,
): boolean {
  return !!dismissals[anomaly.id];
}

/** badge 计数口径：未关闭的异常条数（已关闭的不再提醒，不计入红点）。 */
export function countUndismissedAnomalies(
  anomalies: AnomalyRow[],
  dismissals: DismissalMap,
): number {
  return anomalies.filter((a) => !isAnomalyDismissed(a, dismissals)).length;
}

/** 当前异常是否被关闭（temporary 未到期 / permanent）。 */
export function isAnomalySnoozed(
  anomaly: AnomalyRow,
  dismissals: DismissalMap,
): boolean {
  return !isAnomalyVisible(anomaly, dismissals, false);
}

/** 应用过滤器后的可见异常：showSnoozed=false 时隐藏已静音项。 */
export function filterVisibleAnomalies(
  anomalies: AnomalyRow[],
  dismissals: DismissalMap,
  filters: AnomalyFilters,
): AnomalyRow[] {
  return anomalies.filter((a) =>
    isAnomalyVisible(a, dismissals, filters.showSnoozed),
  );
}


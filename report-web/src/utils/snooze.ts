// 异常「暂不提醒（Snooze）」：纯个人偏好，只存浏览器 localStorage，绝不上传服务器
// （Web Portal 是只读观察层，静音不构成任何写接口；安全边界同 report-web.mask / net-worth-goal）。
// 存的是 id → 过期时间戳（epoch ms），而不是"剩余天数"，这样刷新页面/跨天都不需要重新计算。

import type { AnomalyRow } from "../api/types";

const SNOOZE_KEY = "personal_treasury_snoozed_anomalies_v1";

const DAY_MS = 86400000;

export type SnoozeDuration = "7d" | "30d" | "forever";

/** 归一化后的关闭状态：业务/UI 层禁止自行根据时间戳推断永久（365 天阈值内聚在本模块）。 */
export type DismissalState =
  | { type: "temporary"; until: number }
  | { type: "permanent" };

/** 永久判定阈值（天）：30d 上限与 ~100 年之间有约 12 倍余量。模块私有，不导出。 */
const PERMANENT_THRESHOLD_DAYS = 365;

/** 单条记录（原始时间戳或已归一化状态）是否仍在生效期。 */
function isEntryActive(entry: number | DismissalState | undefined): boolean {
  if (entry === undefined) return false;
  if (typeof entry === "number") return entry > Date.now();
  return entry.type === "permanent" || entry.until > Date.now();
}

/**
 * 读取归一化后的关闭表：清理过期项后，按 365 天阈值把原始时间戳区分为
 * temporary / permanent。旧存储格式直接兼容，无需 migration。
 */
export function getDismissals(): Record<string, DismissalState> {
  const now = Date.now();
  const threshold = now + PERMANENT_THRESHOLD_DAYS * DAY_MS;
  const out: Record<string, DismissalState> = {};
  for (const [id, exp] of Object.entries(getSnoozedMap())) {
    if (exp <= now) continue;
    out[id] = exp > threshold ? { type: "permanent" } : { type: "temporary", until: exp };
  }
  return out;
}

/** 永久关闭一条异常（底层仍是 ~100 年时间戳，存储格式不变）。 */
export function dismissAnomalyPermanently(id: string): void {
  snoozeAnomaly(id, "forever");
}

/** 读取静音表。存储被写坏（手改/旧版本残留）时降级为空表，避免整页异常列表崩掉。 */
export function getSnoozedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    // JSON.parse("null") 返回 null（truthy 字符串但 falsy 结果），
    // Object.entries(null) 会抛 TypeError；加类型守卫降级为空表。
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 跨组件通知：静音表已变化（Layout/MobileDrawer badge 监听后重算）。 */
export const SNOOZE_CHANGED_EVENT = "pt:snooze-changed";

function notifySnoozeChanged(): void {
  window.dispatchEvent(new CustomEvent(SNOOZE_CHANGED_EVENT));
}

/** 静音一条异常。"永久"用 ~100 年后的时间戳表示，好处是过期判断只有一条时间比较分支。 */
export function snoozeAnomaly(id: string, duration: SnoozeDuration): void {
  const map = getSnoozedMap();
  const now = Date.now();
  let expireAt = now;
  if (duration === "7d") expireAt += 7 * DAY_MS;
  else if (duration === "30d") expireAt += 30 * DAY_MS;
  else expireAt += 100 * 365 * DAY_MS; // ~100 年，等价于永久

  map[id] = expireAt;
  localStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  notifySnoozeChanged();
}

/** 恢复提醒：删除该 id 的静音记录（不存在时也安全）。 */
export function unsnoozeAnomaly(id: string): void {
  const map = getSnoozedMap();
  delete map[id];
  localStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  notifySnoozeChanged();
}

/**
 * 清理已过期的静音项。页面挂载时调用一次即可：
 * 只在真的有变化时回写 localStorage，避免每次挂载都产生无意义的写入。
 */
export function clearExpiredSnoozes(): void {
  const map = getSnoozedMap();
  const now = Date.now();
  let changed = false;
  for (const [id, exp] of Object.entries(map)) {
    if (exp <= now) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  }
}

/**
 * 是否展示该异常。纯函数（静音表从外部传入），便于测试且渲染期不读 localStorage。
 * 这里仍复查过期时间，因为页面可能长时间停留、静音刚好在停留期间到期。
 */
export function isAnomalyVisible(
  anomaly: AnomalyRow,
  snoozed: Record<string, number> | Record<string, DismissalState>,
  showSnoozed: boolean,
): boolean {
  const isSnoozed = isEntryActive(snoozed[anomaly.id]);
  if (showSnoozed) return true;
  return !isSnoozed;
}

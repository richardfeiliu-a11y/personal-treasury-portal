import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearExpiredSnoozes,
  type DismissalState,
  dismissAnomalyPermanently,
  getDismissals,
  getSnoozedMap,
  isAnomalyVisible,
  snoozeAnomaly,
  unsnoozeAnomaly,
} from "../utils/snooze";
import type { AnomalyRow } from "../api/types";

const SNOOZE_KEY = "personal_treasury_snoozed_anomalies_v1";

describe("Alerts Snooze/Dismissal Storage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const anomaly: AnomalyRow = {
    id: "spending_trend:餐饮:2026-08",
    source: "spending:餐饮",
    severity: "warning",
    message: "餐饮偏离",
    category: "餐饮",
    amount: "3000.00",
    currency: "CNY",
  };

  it("temporary snooze: 7d 生效期内隐藏，8 天后过期恢复", () => {
    snoozeAnomaly(anomaly.id, "7d");
    const d = getDismissals();
    expect(d[anomaly.id]).toEqual({ type: "temporary", until: Date.now() + 7 * 86400000 });
    expect(isAnomalyVisible(anomaly, d, false)).toBe(false);
    expect(isAnomalyVisible(anomaly, d, true)).toBe(true);

    vi.advanceTimersByTime(8 * 86400000);
    clearExpiredSnoozes();
    expect(getDismissals()[anomaly.id]).toBeUndefined();
    expect(isAnomalyVisible(anomaly, getDismissals(), false)).toBe(true);
  });

  it("temporary snooze: 30 天在第 8 天仍生效、第 31 天过期", () => {
    snoozeAnomaly(anomaly.id, "30d");
    vi.advanceTimersByTime(8 * 86400000);
    clearExpiredSnoozes();
    expect(isAnomalyVisible(anomaly, getDismissals(), false)).toBe(false);

    vi.advanceTimersByTime(23 * 86400000);
    clearExpiredSnoozes();
    expect(isAnomalyVisible(anomaly, getDismissals(), false)).toBe(true);
  });

  it("permanent dismissal: dismissAnomalyPermanently 归一化为 permanent 且不被过期清理带走", () => {
    dismissAnomalyPermanently(anomaly.id);
    const state = getDismissals()[anomaly.id];
    expect(state).toEqual({ type: "permanent" });
    // 底层存储仍是 ~100 年时间戳（格式不变），业务代码禁止直接读它判断永久
    expect(getSnoozedMap()[anomaly.id]).toBeGreaterThan(Date.now() + 50 * 365 * 86400000);

    vi.advanceTimersByTime(10 * 365 * 86400000);
    clearExpiredSnoozes();
    expect(getDismissals()[anomaly.id]).toEqual({ type: "permanent" });
    expect(isAnomalyVisible(anomaly, getDismissals(), false)).toBe(false);
  });

  it("threshold boundary: 恰好 365 天判为 temporary，366 天判为 permanent", () => {
    const now = Date.now();
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ [anomaly.id]: now + 365 * 86400000 }));
    expect(getDismissals()[anomaly.id]).toMatchObject({ type: "temporary" });

    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ [anomaly.id]: now + 366 * 86400000 }));
    expect(getDismissals()[anomaly.id]).toMatchObject({ type: "permanent" });
  });

  it("restore: unsnoozeAnomaly 清除记录，permanent 与 temporary 均可恢复", () => {
    dismissAnomalyPermanently(anomaly.id);
    unsnoozeAnomaly(anomaly.id);
    expect(getSnoozedMap()).toEqual({});
    expect(getDismissals()[anomaly.id]).toBeUndefined();

    snoozeAnomaly(anomaly.id, "30d");
    unsnoozeAnomaly(anomaly.id);
    expect(getSnoozedMap()).toEqual({});
  });

  it("reload persistence: 写入后模拟新页面挂载（重新读取 localStorage）状态保持", () => {
    dismissAnomalyPermanently(anomaly.id);
    // 模拟 reload：不经过任何内存镜像，直接从存储读取
    const reloaded = getDismissals();
    expect(reloaded[anomaly.id]).toEqual({ type: "permanent" });
    expect(isAnomalyVisible(anomaly, reloaded, false)).toBe(false);
  });

  it("isolation: 关闭一条异常不影响另一条的可见性", () => {
    snoozeAnomaly("health:backup", "forever");
    dismissAnomalyPermanently("health:goal");
    const d = getDismissals();
    expect(d["health:backup"]).toEqual({ type: "permanent" }); // 旧 API forever 也归一化为 permanent
    expect(d["health:goal"]).toEqual({ type: "permanent" });
    expect(isAnomalyVisible(anomaly, d, false)).toBe(true);
  });

  it("旧格式时间戳兼容：<365 天 -> temporary；>=365 天 -> permanent", () => {
    const now = Date.now();
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({
      "a:old-temp": now + 30 * 86400000,
      "b:old-perm": now + 100 * 365 * 86400000,
    }));
    const d: Record<string, DismissalState> = getDismissals();
    expect(d["a:old-temp"]).toMatchObject({ type: "temporary" });
    expect(d["b:old-perm"]).toMatchObject({ type: "permanent" });
  });

  it("静音状态只写 localStorage 指定 key，不触碰其它存储项", () => {
    localStorage.setItem("report-web.mask", "1");
    snoozeAnomaly(anomaly.id, "7d");
    const raw = localStorage.getItem(SNOOZE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toHaveProperty(anomaly.id);
    expect(localStorage.getItem("report-web.mask")).toBe("1");
  });

  it("存储被写坏时降级为空 map 而非抛错", () => {
    localStorage.setItem(SNOOZE_KEY, "{ not json");
    expect(getSnoozedMap()).toEqual({});
    expect(getDismissals()).toEqual({});
    snoozeAnomaly(anomaly.id, "7d");
    expect(isAnomalyVisible(anomaly, getDismissals(), false)).toBe(false);
  });

  it("存储为合法 JSON 但非对象（null/数组/标量）时降级为空 map", () => {
    for (const bad of ["null", "[1,2]", "\"string\"", "42"]) {
      localStorage.setItem(SNOOZE_KEY, bad);
      expect(getSnoozedMap()).toEqual({});
      expect(() => getDismissals()).not.toThrow();
    }
  });

  it("clearExpiredSnoozes 只删过期项，保留未过期项", () => {
    snoozeAnomaly("health:backup", "7d");
    snoozeAnomaly("spending_trend:餐饮:2026-08", "30d");
    vi.advanceTimersByTime(8 * 86400000);
    clearExpiredSnoozes();
    const map = getSnoozedMap();
    expect(map).not.toHaveProperty("health:backup");
    expect(map).toHaveProperty("spending_trend:餐饮:2026-08");
  });

  it("unsnooze 不存在的 id 时安全无副作用", () => {
    snoozeAnomaly(anomaly.id, "7d");
    unsnoozeAnomaly("health:not-exist");
    expect(isAnomalyVisible(anomaly, getSnoozedMap(), false)).toBe(false);
  });
});

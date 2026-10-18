import { describe, expect, it } from "vitest";
import {
  type DismissalMap,
  SEVERITY_LABEL,
  SEVERITY_RANK,
  countUndismissedAnomalies,
  filterVisibleAnomalies,
  isAnomalyDismissed,
  isAnomalySnoozed,
  sortAnomaliesBySeverity,
} from "../utils/anomalyFilters";
import type { AnomalyRow } from "../api/types";

const CRIT: AnomalyRow = {
  id: "health:backup",
  source: "health:backup",
  severity: "critical",
  message: "备份过期或从未成功",
  category: null,
  amount: null,
  currency: null,
};
const WARN: AnomalyRow = {
  id: "spending_trend:餐饮:2026-08",
  source: "spending:餐饮",
  severity: "warning",
  message: "类别「餐饮」本月支出较历史月均偏差 200%",
  category: "餐饮",
  amount: "3000.00",
  currency: "CNY",
};
const INFO: AnomalyRow = {
  id: "health:goal",
  source: "health:goal",
  severity: "info",
  message: "储蓄目标进度良好",
  category: null,
  amount: null,
  currency: null,
};

describe("sortAnomaliesBySeverity", () => {
  it("Critical -> Warning -> Info", () => {
    const r = sortAnomaliesBySeverity([INFO, WARN, CRIT]).map((x) => x.severity);
    expect(r).toEqual(["critical", "warning", "info"]);
  });

  it("同级按金额绝对值降序", () => {
    const a: AnomalyRow = { ...WARN, id: "a", amount: "500.00" };
    const b: AnomalyRow = { ...WARN, id: "b", amount: "5000.00" };
    const r = sortAnomaliesBySeverity([a, b]).map((x) => x.id);
    expect(r).toEqual(["b", "a"]);
  });

  it("不改变入参（纯函数）", () => {
    const input = [INFO, CRIT, WARN];
    sortAnomaliesBySeverity(input);
    expect(input.map((x) => x.severity)).toEqual(["info", "critical", "warning"]);
  });

  it("SEVERITY_RANK/LABEL 一致且单调", () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.warning);
    expect(SEVERITY_RANK.warning).toBeGreaterThan(SEVERITY_RANK.info);
    expect(SEVERITY_LABEL.critical).toBe("严重");
    expect(SEVERITY_LABEL.warning).toBe("警告");
    expect(SEVERITY_LABEL.info).toBe("提示");
  });
});

describe("filterVisibleAnomalies", () => {
  it("showSnoozed=false 隐藏已关闭项（temporary/permanent 均隐藏）；true 时显示全部", () => {
    const dismissals: DismissalMap = {
      [WARN.id]: { type: "temporary", until: Date.now() + 999999 },
      [CRIT.id]: { type: "permanent" },
    };
    expect(filterVisibleAnomalies([WARN, CRIT], dismissals, { showSnoozed: false })).toHaveLength(0);
    expect(filterVisibleAnomalies([WARN, CRIT], dismissals, { showSnoozed: true })).toHaveLength(2);
  });
});

describe("isAnomalySnoozed", () => {
  it("生效关闭判为 snoozed，未设判为未 snoozed", () => {
    expect(isAnomalySnoozed(WARN, { [WARN.id]: { type: "temporary", until: Date.now() + 999999 } })).toBe(true);
    expect(isAnomalySnoozed(WARN, { [WARN.id]: { type: "permanent" } })).toBe(true);
    expect(isAnomalySnoozed(WARN, {})).toBe(false);
  });
});

describe("badge 口径：isAnomalyDismissed / countUndismissedAnomalies", () => {
  it("temporary 与 permanent 均计入 dismissed", () => {
    const dismissals: DismissalMap = {
      [WARN.id]: { type: "temporary", until: Date.now() + 1000 },
      [CRIT.id]: { type: "permanent" },
    };
    expect(isAnomalyDismissed(WARN, dismissals)).toBe(true);
    expect(isAnomalyDismissed(CRIT, dismissals)).toBe(true);
    expect(isAnomalyDismissed(INFO, dismissals)).toBe(false);
  });

  it("countUndismissedAnomalies 只统计未关闭条数", () => {
    const dismissals: DismissalMap = {
      [WARN.id]: { type: "permanent" },
    };
    expect(countUndismissedAnomalies([WARN, CRIT, INFO], dismissals)).toBe(2);
    expect(countUndismissedAnomalies([], dismissals)).toBe(0);
  });
});

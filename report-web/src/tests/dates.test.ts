import { describe, expect, it } from "vitest";
import {
  addDays,
  berlinCurrentMonth,
  berlinCurrentYear,
  berlinLastMonth,
  berlinLastMonthEnd,
  berlinLastNDays,
  berlinLastNMonthEnds,
  berlinLastYearEnd,
  berlinTodayIso,
  currentMonth,
  currentYear,
  lastMonth,
  lastMonthEnd,
  lastNDays,
  lastNMonthEnds,
  lastYearEnd,
  monthEnd,
  prevMonthEnd,
  prevYearEnd,
  previousPeriod,
  resolveBusinessPeriod,
  shiftMonths,
  todayIso,
} from "../utils/dates";

describe("dates", () => {
  it("lastNDays 最近30天含今天", () => {
    const now = new Date(2026, 7, 7); // 2026-08-07
    const { start, end } = lastNDays(30, now);
    expect(end).toBe("2026-08-07");
    expect(start).toBe("2026-07-09");
  });

  it("addDays 跨月/跨年", () => {
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("currentMonth / currentYear", () => {
    const now = new Date(2026, 7, 7);
    expect(currentMonth(now)).toEqual({ start: "2026-08-01", end: "2026-08-07" });
    expect(currentYear(now)).toEqual({ start: "2026-01-01", end: "2026-08-07" });
  });

  it("monthEnd 平闰年", () => {
    expect(monthEnd("2026-02-01")).toBe("2026-02-28");
    expect(monthEnd("2028-02-01")).toBe("2028-02-29"); // 闰年
    expect(monthEnd("2026-12-01")).toBe("2026-12-31");
  });

  it("lastNMonthEnds 最近6个完整月、升序、不含本月", () => {
    const now = new Date(2026, 7, 7); // 2026-08
    expect(lastNMonthEnds(6, now)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
    ]);
  });

  it("todayIso 本地日期", () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("lastMonthEnd / lastYearEnd / lastMonth", () => {
    const now = new Date(2026, 7, 16); // 2026-08-16
    expect(lastMonthEnd(now)).toBe("2026-07-31");
    expect(lastYearEnd(now)).toBe("2025-12-31");
    expect(lastMonth(now)).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    // 年初边界：2026-01-05 → 上月末 2025-12-31，去年末 2025-12-31
    const jan = new Date(2026, 0, 5);
    expect(lastMonthEnd(jan)).toBe("2025-12-31");
    expect(lastYearEnd(jan)).toBe("2025-12-31");
  });

  it("prevMonthEnd / prevYearEnd 基于 iso 日期字符串", () => {
    expect(prevMonthEnd("2026-08-07")).toBe("2026-07-31");
    expect(prevMonthEnd("2026-01-05")).toBe("2025-12-31"); // 年初边界
    expect(prevYearEnd("2026-08-07")).toBe("2025-12-31");
    expect(prevYearEnd("2026-01-01")).toBe("2025-12-31");
  });

  it("shiftMonths 平移与月末收敛", () => {
    expect(shiftMonths("2026-08-07", -1)).toBe("2026-07-07");
    expect(shiftMonths("2026-08-31", -1)).toBe("2026-07-31");
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28"); // 月末收敛
    expect(shiftMonths("2028-02-29", -12)).toBe("2027-02-28"); // 闰日收敛
    expect(shiftMonths("2026-01-01", -12)).toBe("2025-01-01");
  });

  it("previousPeriod：最近30天 → 等长前一30天窗口", () => {
    expect(previousPeriod("2026-07-09", "2026-08-07", "days")).toEqual({ start: "2026-06-09", end: "2026-07-08" });
  });

  it("previousPeriod：本月（MTD）→ 上月同期，不与本月重叠", () => {
    expect(previousPeriod("2026-08-01", "2026-08-07", "month")).toEqual({ start: "2026-07-01", end: "2026-07-07" });
    // 月末完整月 → 上一整月
    expect(previousPeriod("2026-08-01", "2026-08-31", "month")).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    // 月末收敛（3-31 → 2-28）
    expect(previousPeriod("2026-03-01", "2026-03-31", "month")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("previousPeriod：今年 → 去年同期，不重叠", () => {
    expect(previousPeriod("2026-01-01", "2026-08-07", "year")).toEqual({ start: "2025-01-01", end: "2025-08-07" });
  });

  it("previousPeriod：自定义期间 → 等长的前一窗口", () => {
    // 2026-06-15 ~ 07-20 共 36 天 → 前一 36 天窗口 2026-05-10 ~ 06-14
    expect(previousPeriod("2026-06-15", "2026-07-20", "days")).toEqual({ start: "2026-05-10", end: "2026-06-14" });
  });
});

// ---------------------------------------------------------------------------
// WP05：Europe/Berlin 业务期间（R05/R06/U05 回归锁定）
// ---------------------------------------------------------------------------

describe("berlin business period (WP05)", () => {
  it("berlinTodayIso 用柏林日历日，不受宿主时区影响", () => {
    // 2026-09-30T22:30Z：UTC 已是 09-30，柏林已是 10-01
    expect(berlinTodayIso(new Date("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
    // 冬令时 2026-12-31T17:00Z → 柏林 18:00 → 12-31
    expect(berlinTodayIso(new Date("2026-12-31T17:00:00Z"))).toBe("2026-12-31");
  });

  it("berlinCurrentMonth 月初按柏林日历", () => {
    // 柏林 10-01 → 本月 [10-01, 10-01]
    const { start, end } = berlinCurrentMonth(new Date("2026-09-30T22:30:00Z"));
    expect(start).toBe("2026-10-01");
    expect(end).toBe("2026-10-01");
  });

  it("resolveBusinessPeriod 无参数 → 显式柏林本月至今", () => {
    const r = resolveBusinessPeriod(null, null, new Date("2026-09-06T12:00:00Z"));
    expect(r).toEqual({ start: "2026-09-01", end: "2026-09-06" });
    expect(r.error).toBeUndefined();
  });

  it("resolveBusinessPeriod 非 ISO 串 → 显式错误，不静默回退", () => {
    const r = resolveBusinessPeriod("2026/09/01", "2026-09-06");
    expect(r.error).toBe("日期格式应为 YYYY-MM-DD");
    expect(r.start).toBe("2026/09/01"); // 原样返回供纠错展示
  });

  it("resolveBusinessPeriod 起>止 → 显式错误", () => {
    const r = resolveBusinessPeriod("2026-09-06", "2026-09-01");
    expect(r.error).toBe("起始日期不能晚于截止日期");
  });

  it("resolveBusinessPeriod 合法区间原样通过", () => {
    const r = resolveBusinessPeriod("2026-08-01", "2026-08-31");
    expect(r).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("RV-05：不存在的 2026-02-30 → 拒绝，不请求", () => {
    const r = resolveBusinessPeriod("2026-02-01", "2026-02-30");
    expect(r.error).toBeDefined();
  });

  it("RV-05：berlin 预设按柏林日历（洛杉矶仍 08-31 时柏林已 09-01）", () => {
    // 2026-08-31T22:30Z：洛杉矶 08-31 15:30，柏林 09-01 00:30
    const instant = new Date("2026-08-31T22:30:00Z");
    expect(berlinLastNDays(30, instant).end).toBe("2026-09-01");
    expect(berlinCurrentMonth(instant)).toEqual({ start: "2026-09-01", end: "2026-09-01" });
    expect(berlinLastMonth(instant)).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(berlinCurrentYear(instant).start).toBe("2026-01-01");
  });

  // DATA-01 补漏：资产负债页/工具栏的「上月末」「去年末」预设进入 as_of 请求参数，
  // 必须是柏林日历推导值（宿主时区版 lastMonthEnd/lastYearEnd 不得参与）。
  it("berlinLastMonthEnd 按柏林日历定月份", () => {
    // 柏林月中：2026-08-16 → 上月末 2026-07-31
    expect(berlinLastMonthEnd(new Date("2026-08-16T10:00:00Z"))).toBe("2026-07-31");
    // 月初边界（柏林已跨入 10-01，UTC 仍在 09-30）→ 上月末 2026-09-30
    expect(berlinLastMonthEnd(new Date("2026-09-30T22:30:00Z"))).toBe("2026-09-30");
    // 年初边界（柏林 2026-01-01）→ 上月末 2025-12-31
    expect(berlinLastMonthEnd(new Date("2025-12-31T23:30:00Z"))).toBe("2025-12-31");
  });

  it("berlinLastMonthEnd 月末边界含平闰年 2 月", () => {
    // 柏林 2026-03-01 00:30（UTC 02-28 23:30）→ 上月末 = 平年 2 月末 2026-02-28
    expect(berlinLastMonthEnd(new Date("2026-02-28T23:30:00Z"))).toBe("2026-02-28");
    // 柏林 2028-03-01 → 上月末 = 闰年 2 月末 2028-02-29
    expect(berlinLastMonthEnd(new Date("2028-02-29T23:30:00Z"))).toBe("2028-02-29");
    // 与 berlinLastMonth().end 同源一致（跨页钻取期间对象一致性）
    const instant = new Date("2026-09-30T22:30:00Z");
    expect(berlinLastMonth(instant).end).toBe(berlinLastMonthEnd(instant));
  });

  it("berlinLastYearEnd 按柏林日历定年份", () => {
    // 柏林 2026-01-01 00:30（UTC/洛杉矶仍是 2025-12-31，宿主版会给出 2024-12-31）
    expect(berlinLastYearEnd(new Date("2025-12-31T23:30:00Z"))).toBe("2025-12-31");
    // 柏林年内：2026-08-16 → 2025-12-31
    expect(berlinLastYearEnd(new Date("2026-08-16T10:00:00Z"))).toBe("2025-12-31");
    // 夏令时瞬间：柏林 2026-10-01 → 2025-12-31
    expect(berlinLastYearEnd(new Date("2026-09-30T22:30:00Z"))).toBe("2025-12-31");
  });

  it("berlinLastNMonthEnds 逐月窗口按柏林日历（收支页逐月趋势的请求参数）", () => {
    // 柏林 2026-09-01 00:30（UTC 仍是 08-31 22:30）→ 最近 6 个完整月为 3~8 月。
    // 期望值为字面量：宿主时区版 lastNMonthEnds 的口径随运行环境而变，不能作对照。
    const instant = new Date("2026-08-31T22:30:00Z");
    expect(berlinLastNMonthEnds(6, instant)).toEqual([
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
    ]);
    // 跨年：柏林 2026-01-01 → 2025 年 7~12 月末，升序且不含本月
    expect(berlinLastNMonthEnds(6, new Date("2025-12-31T23:30:00Z"))).toEqual([
      "2025-07-31",
      "2025-08-31",
      "2025-09-30",
      "2025-10-31",
      "2025-11-30",
      "2025-12-31",
    ]);
  });
});

/**
 * REL-05 / DATA-01：utils/timestamps.ts 的直接单元测试。
 *
 * 这里钉住两条口径：
 * ① 瞬间（instant）只接受**显式带偏移量**的 ISO 8601——无偏移量的串会被
 *    `new Date()` 按宿主时区解析，而输出却标注 Europe/Berlin，呈现口径与声明
 *    口径不符，故一律回退 "—"；文法本身按 ES 规范大小写敏感（`Z` 而非 `z`、
 *    `+00:00` 而非 `+0000`），不因引擎宽容而放宽；
 * ② 纯日历日与瞬间分属两个函数，绝不互相顶替（日历日不得被臆造成 UTC 午夜再偏移）。
 *
 * 组件级断言见 report-timestamp-footer.test.tsx；本文件只测格式化函数本身。
 */
import { describe, expect, it } from "vitest";
import { formatCalendarDate, formatTimestampBerlin } from "../utils/timestamps";

describe("formatTimestampBerlin — 合法瞬间（显式偏移量）", () => {
  it.each([
    // [输入, 期望的柏林 "YYYY-MM-DD HH:MM"]
    ["2026-08-09T10:00:00Z", "2026-08-09 12:00"], // CEST = UTC+2
    ["2026-08-09T10:00:00+00:00", "2026-08-09 12:00"],
    ["2026-08-09T23:30:00Z", "2026-08-10 01:30"], // 跨到次日
    ["2026-01-05T09:00:00Z", "2026-01-05 10:00"], // 冬令时 CET = UTC+1
    ["2026-08-09T10:00:00+02:00", "2026-08-09 10:00"], // 偏移量即柏林本地
    ["2026-08-09T10:00:00-05:00", "2026-08-09 17:00"],
    ["2026-08-09T10:00:00.123456Z", "2026-08-09 12:00"], // 微秒（后端 _now() 形态）
    ["2026-08-09T10:00Z", "2026-08-09 12:00"], // 省略秒
    ["2026-08-09 10:00:00+00:00", "2026-08-09 12:00"], // 空格分隔日期与时刻
  ])("%s → %s", (input, expected) => {
    expect(formatTimestampBerlin(input)).toBe(expected);
  });

  it("午夜不因 hour12:false 的 ICU 怪癖输出 24:00", () => {
    // UTC 2026-08-09 22:00 = 柏林 2026-08-10 00:00
    expect(formatTimestampBerlin("2026-08-09T22:00:00Z")).toBe("2026-08-10 00:00");
  });
});

describe("formatTimestampBerlin — 缺偏移量/非法输入回退 —", () => {
  it.each([
    ["无偏移量、有秒", "2026-08-09T10:00:00"],
    ["无偏移量、无秒", "2026-08-09T10:00"],
    ["空格分隔且无偏移量", "2026-08-09 10:00"],
    ["纯日历日（交给 formatCalendarDate）", "2026-08-09"],
    ["尾部垃圾", "2026-08-09T10:00:00+00:00Z"],
    ["非 ISO 文本", "not-a-date"],
    // new Date() 对下列变体同样宽容（实测可解析成瞬间），拒绝只可能来自 INSTANT_RE，
    // 因此这两行就是文法收紧的回归点。
    ["+0000（无冒号时区）超出 ES ISO Date Time String Format 文法，按 fail-closed 拒绝", "2026-08-09T10:00:00+0000"],
    ["小写 z 的 UTC 标记（与 [T ] 不认小写 t 同口径）", "2026-08-09T10:00:00z"],
  ])("%s → —", (_label, input) => {
    expect(formatTimestampBerlin(input)).toBe("—");
  });

  it("空值按缺失处理", () => {
    expect(formatTimestampBerlin(undefined)).toBe("—");
    expect(formatTimestampBerlin(null)).toBe("—");
    expect(formatTimestampBerlin("")).toBe("—");
  });

  it("同一时刻的两种写法（Z 与 +00:00）必须给出同一结果——不接受宿主时区参与换算", () => {
    expect(formatTimestampBerlin("2026-08-09T10:00:00Z"))
      .toBe(formatTimestampBerlin("2026-08-09T10:00:00+00:00"));
  });
});

describe("formatCalendarDate — 纯日历日原样回显", () => {
  it.each([
    "2026-08-09",
    "2026-02-28",
    "2024-02-29", // 真实闰日
    "2026-12-31",
  ])("%s → 原样", (input) => {
    expect(formatCalendarDate(input)).toBe(input);
  });

  it.each([
    ["不存在的日期", "2026-02-30"],
    ["闰年规则外的 2 月 29", "2026-02-29"],
    ["月份越界", "2026-13-01"],
    ["日期越界", "2026-01-32"],
    ["单位数月份/日期", "2026-8-9"],
    ["瞬间（不是日历日）", "2026-08-09T10:00:00Z"],
    ["日历日带时间", "2026-08-09 10:00"],
    ["非 ISO 文本", "not-a-date"],
  ])("%s → —", (_label, input) => {
    expect(formatCalendarDate(input)).toBe("—");
  });

  it("空值按缺失处理", () => {
    expect(formatCalendarDate(undefined)).toBe("—");
    expect(formatCalendarDate(null)).toBe("—");
    expect(formatCalendarDate("")).toBe("—");
  });
});

describe("两类字段的分界（INSTANT_RE 收紧的回归点）", () => {
  it("同一输入只有一个函数会接受：日历日不臆造时分，瞬间不回显日期", () => {
    const calendarDay = "2026-08-09";
    expect(formatCalendarDate(calendarDay)).toBe(calendarDay);
    expect(formatTimestampBerlin(calendarDay)).toBe("—");

    const instant = "2026-08-09T10:00:00+00:00";
    expect(formatTimestampBerlin(instant)).toBe("2026-08-09 12:00");
    expect(formatCalendarDate(instant)).toBe("—");
  });

  it("缺偏移量的瞬间两个函数都不接受（既不按宿主时区渲染，也不当成日历日）", () => {
    const offsetLess = "2026-08-09 10:00";
    expect(formatTimestampBerlin(offsetLess)).toBe("—");
    expect(formatCalendarDate(offsetLess)).toBe("—");
  });
});

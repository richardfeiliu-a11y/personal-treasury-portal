import { describe, expect, it } from "vitest";
import { calculateAccountDelta } from "../utils/balanceSheetDelta";
import { formatNumber } from "../utils/format";
import type { WebAccountRow } from "../api/types";

/** 造一行账户：delta 只读 balance_base，其余字段仅满足 WebAccountRow 类型。 */
function row(id: string, balanceBase: string | null): WebAccountRow {
  return {
    id,
    name: id,
    currency: "CNY",
    balance_native: balanceBase ?? "0.00",
    balance_base: balanceBase,
    active: true,
    include_net_worth: true,
  };
}

describe("calculateAccountDelta", () => {
  it("calculates delta correctly across positive and negative balances", () => {
    const curr = { id: "a1", name: "Card", balance_base: "10000.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "10000.00" };
    const prev = { id: "a1", name: "Card", balance_base: "-5000.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "-5000.00" };

    const res = calculateAccountDelta(curr, prev);
    expect(res.diff_amount).toBe("15000.00");
    expect(res.diff_percentage).toBe(300);
    expect(res.status).toBe("normal");
  });

  it("handles new accounts without compare baseline", () => {
    const curr = { id: "a2", name: "NewBank", balance_base: "5000.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "5000.00" };
    const res = calculateAccountDelta(curr, undefined);
    expect(res.status).toBe("new");
    expect(res.diff_amount).toBeNull();
    expect(res.diff_percentage).toBeNull();
  });

  it("handles incomplete FX rates without faking zeros", () => {
    const curr = { id: "a3", name: "USDBank", balance_base: null, currency: "USD", active: true, include_net_worth: true, balance_native: "500.00" };
    const prev = { id: "a3", name: "USDBank", balance_base: "3000.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "3000.00" };
    const res = calculateAccountDelta(curr, prev);
    expect(res.status).toBe("fx_incomplete");
    expect(res.diff_amount).toBeNull();
  });

  it("marks zero-balance current against a funded compare as closed", () => {
    const curr = { id: "a4", name: "ClosedBank", balance_base: "0.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "0.00" };
    const prev = { id: "a4", name: "ClosedBank", balance_base: "800.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "800.00" };
    const res = calculateAccountDelta(curr, prev);
    expect(res.status).toBe("closed");
    expect(res.diff_amount).toBeNull();
    expect(res.diff_percentage).toBeNull();
  });

  it("applies the FX gate when only the compare side lacks a base rate", () => {
    const curr = { id: "a5", name: "EURBank", balance_base: "7000.00", currency: "EUR", active: true, include_net_worth: true, balance_native: "1000.00" };
    const prev = { id: "a5", name: "EURBank", balance_base: null, currency: "EUR", active: true, include_net_worth: true, balance_native: "800.00" };
    const res = calculateAccountDelta(curr, prev);
    expect(res.status).toBe("fx_incomplete");
    expect(res.diff_amount).toBeNull();
    expect(res.diff_percentage).toBeNull();
  });

  it("treats zero-balance compare with a funded current as new (no +inf)", () => {
    const curr = { id: "a6", name: "RebornBank", balance_base: "1200.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "1200.00" };
    const prev = { id: "a6", name: "RebornBank", balance_base: "0.00", currency: "CNY", active: true, include_net_worth: true, balance_native: "0.00" };
    const res = calculateAccountDelta(curr, prev);
    expect(res.status).toBe("new");
    expect(res.diff_amount).toBeNull();
  });
});

/**
 * Batch 09 / CALC-02：环比差值脱离 Number() 浮点，走 decimal.ts 的 BigInt
 * 精确定点域 + format.ts 共享的 2 位量化规则。
 *
 * 下面每个期望值都是手算的十进制精确差值，并附上「为什么旧的 Number 路径必然
 * 算错」的 IEEE-754 依据（ulp = 该量级下两个相邻 double 的间距）：
 *   2^53 = 9_007_199_254_740_992，[2^53, 2^54) 区间 ulp = 2，
 *   [2^54, 2^55) ≈ [1.801e16, 3.603e16) 区间 ulp = 4。
 */
describe("calculateAccountDelta — 精确域差值（CALC-02 / Batch09）", () => {
  it(">2^53 的亚分差不被抹平：手算 10000000000000001.50 − 10000000000000002.25 = −0.75", () => {
    // 两操作数都落在 [2^53, 2^54)（ulp = 2）：
    //   Number("10000000000000001.5")  → 10000000000000002（+1.5 舍到最近的偶数倍 2）
    //   Number("10000000000000002.25") → 10000000000000002（+2.25 舍到 +2）
    // 旧路径 diff = 0 → toFixed(2) = "0.00"，把 0.75 的流出完全吃掉。
    const res = calculateAccountDelta(row("b1", "10000000000000001.5"), row("b1", "10000000000000002.25"));
    expect(res.status).toBe("normal");
    expect(res.diff_amount).toBe("-0.75");
    // 百分比按方案保留 float（仅展示口径）：−0.75 / 1e16 量级四舍五入到 0，
    // 组件里 `=== 0` 判零仍然成立，故此处只断言它是有限数、不假装精确。
    expect(Number.isFinite(res.diff_percentage!)).toBe(true);
  });

  it("2^53 正上方差值不翻倍：手算 (2^53+1.10) − (2^53+0.10) = 1.00", () => {
    // ulp = 2 ⇒ 9007199254740993.10 → 9007199254740994，9007199254740992.10 → 9007199254740992
    // 旧路径 diff = 2 → "2.00"（误差 100%）。
    const res = calculateAccountDelta(row("b2", "9007199254740993.10"), row("b2", "9007199254740992.10"));
    expect(res.diff_amount).toBe("1.00");
  });

  it("大数级差值保留低位与亚分：手算 30000000000000005.10 − 10000000000000001.20 = 20000000000000003.90", () => {
    // 3e16 落在 [2^54, 2^55)（ulp = 4）→ 30000000000000005.10 → 30000000000000004
    // 1e16（ulp = 2）→ 10000000000000001.20 → 10000000000000002
    // 差 20000000000000002 又超出 ulp=4 ⇒ 归到 20000000000000000 → 旧路径 "20000000000000000.00"
    const res = calculateAccountDelta(row("b3", "30000000000000005.10"), row("b3", "10000000000000001.20"));
    expect(res.diff_amount).toBe("20000000000000003.90");
    // 展示口径的百分比：2e16/1e16*100，双精度下仍是干净的 200。
    expect(res.diff_percentage).toBe(200);
  });

  it("半分按十进制 ROUND_HALF_UP 进位：手算 2.675 − 1.00 = 1.675 → 1.68", () => {
    // 浮动误差生在「减法」这一步，不在字面量也不在量化：double 存的 2.675 是
    // 2.6749999999999998224（(2.675).toPrecision(20)），而 1.6749999999999998 是
    // 「浮点减法 2.675 − 1」的结果。对正确的十进制差值量化仍然给对的数——
    // (1.675).toFixed(2) === "1.68"——所以旧实现的错全在先前经 Number 相减：
    // 拿到 1.6749999999999998 再 toFixed(2) 才输出 "1.67"。
    // 现在差值在 BigInt 精确域算出，量化按十进制第 3 位半进位，与
    // quantize2 / formatNumber 同一规则。
    const res = calculateAccountDelta(row("b4", "2.675"), row("b4", "1.00"));
    expect(res.diff_amount).toBe("1.68");
    expect(res.diff_percentage).toBe(167.5);
  });

  it("量化后恰好归零时不带负号：手算 1.000 − 1.004 = −0.004 → 0.00", () => {
    // 旧路径 (1 − 1.004).toFixed(2) = "-0.00"：负零会被读成「在跌」的假信号，
    // 与 format.ts normalizeZero 的既有口径（负零归一为正零）冲突。
    // 注意与 SignedAmount 的分工不同：diff_amount 是**量化后**的展示金额，符号随
    // 量化结果；formatSigned 的 − 号在量化前按原值判定，所以 formatSigned("-0.004")
    // 仍是 "−0.00"（方向即信息）。涨跌方向由 diff_percentage / 箭头负责，不靠这个串。
    const res = calculateAccountDelta(row("b5", "1.000"), row("b5", "1.004"));
    expect(res.status).toBe("normal");
    expect(res.diff_amount).toBe("0.00");
  });

  it("差值字符串与 formatNumber 同一量化口径（量化幂等，不再二次舍入）", () => {
    const res = calculateAccountDelta(row("b6", "30000000000000005.10"), row("b6", "10000000000000001.20"));
    // diff_amount 再进 formatNumber 只加分组、不改数字：卡片与 tooltip 口径一致。
    expect(formatNumber(res.diff_amount)).toBe("20,000,000,000,000,003.90");
  });

  it("无法解析的脏数据宁可为 null，也不输出 NaN", () => {
    // Number("1,234.50") = NaN → 旧路径 diff_amount = "NaN"，会被 formatNumber 当合法串。
    const res = calculateAccountDelta(row("b7", "1,234.50"), row("b7", "1000.00"));
    expect(res.diff_amount).toBeNull();
    expect(res.diff_percentage).toBeNull();
  });

  it("零余额判定也在字符串域：多尾随零的 0 仍算零", () => {
    expect(calculateAccountDelta(row("b8", "5.00"), row("b8", "0.0000")).status).toBe("new");
    expect(calculateAccountDelta(row("b8", "0.000"), row("b8", "5.00")).status).toBe("closed");
    // 亚分但非零的上期余额不能被当成「新增」。
    expect(calculateAccountDelta(row("b8", "5.00"), row("b8", "0.004")).status).toBe("normal");
  });
});

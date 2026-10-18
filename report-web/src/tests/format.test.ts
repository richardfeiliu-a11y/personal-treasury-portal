import { beforeEach, describe, expect, it } from "vitest";
import {
  formatAmount,
  formatNumber,
  formatPct,
  formatSigned,
  loadMaskPreference,
  maskAmount,
  quantize2,
  saveMaskPreference,
} from "../utils/format";

describe("format", () => {
  it("formatNumber 中文千分位", () => {
    expect(formatNumber("1234567.891")).toBe("1,234,567.89");
    expect(formatNumber("0")).toBe("0.00");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber("abc")).toBe("—");
  });

  it("formatAmount 带币种；null 显示汇率缺失", () => {
    expect(formatAmount("1234.5", "EUR")).toBe("1,234.50 EUR");
    expect(formatAmount(null, "CNY")).toBe("汇率缺失");
  });

  it("formatPct", () => {
    expect(formatPct("12.3")).toBe("12.3%");
    expect(formatPct(null)).toBe("—");
  });

  it("maskAmount 只遮蔽数字、保留币种", () => {
    expect(maskAmount("1,234.56 EUR")).toBe("•••• EUR");
    expect(maskAmount("−12.3 CNY")).toBe("•••• CNY");
  });

  it("遮蔽偏好只存 localStorage", () => {
    const storage = new Map<string, string>();
    const fake: Storage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
      clear: () => storage.clear(),
      key: (i) => [...storage.keys()][i] ?? null,
      get length() {
        return storage.size;
      },
    };
    expect(loadMaskPreference(fake)).toBe(false);
    saveMaskPreference(true, fake);
    expect(loadMaskPreference(fake)).toBe(true);
    expect([...storage.keys()]).toEqual(["report-web.mask"]);
  });

  it("默认不遮蔽（真实 localStorage 为空）", () => {
    localStorage.clear();
    expect(loadMaskPreference()).toBe(false);
  });
});

// 清理真实 localStorage，避免跨测试污染
beforeEach(() => {
  localStorage.clear();
});

/**
 * Batch 09 / CALC-02：带符号格式化与共享量化规则都不再经过 Number()。
 * quantize2 是 formatDecimalString 抽出来的共享 2 位量化规则（ROUND_HALF_UP，
 * 只看被舍弃的第 3 位），delta 计算复用它，保证「差值字符串 == 精确差值量化」。
 */
describe("quantize2 共享量化规则", () => {
  it("十进制半进位，不受二进制表示影响", () => {
    expect(quantize2("1.005")).toBe("1.01"); // (1.005).toFixed(2) === "1.00" 是浮点伪值
    expect(quantize2("2.675")).toBe("2.68"); // 对照 (2.675).toFixed(2) === "2.67"（double 存 2.6749999999999998224）；Intl 走最短十进制回环，给 "2.68"
    expect(quantize2("9.995")).toBe("10.00"); // 进位跨整数位
    expect(quantize2("-1.005")).toBe("-1.01"); // 负数同样半进位（half-up 指绝对值向上）
  });

  it("大数与亚分位全程字符串域", () => {
    expect(quantize2("10000000000000001.5")).toBe("10000000000000001.50");
    expect(quantize2("10000000000000002.25")).toBe("10000000000000002.25");
    expect(quantize2("0.00000000000000000001")).toBe("0.00");
    expect(quantize2("-0.004")).toBe("0.00"); // 归零后剥负号，避免 "-0.00" 假跌信号
  });

  it("补齐 2 位小数；非法输入返回 null 由调用方决定占位", () => {
    expect(quantize2("7")).toBe("7.00");
    expect(quantize2("7.5")).toBe("7.50");
    expect(quantize2(" 12.345 ")).toBe("12.35");
    expect(quantize2("abc")).toBeNull();
    expect(quantize2("1e5")).toBeNull();
    expect(quantize2(".5")).toBeNull();
    expect(quantize2("")).toBeNull();
  });

  it("量化幂等：已 2 位的值再进一次不变（delta 输出与 formatNumber 口径一致）", () => {
    for (const raw of ["0.01", "-3.20", "1234.56", "10000000000000001.50"]) {
      const once = quantize2(raw);
      expect(quantize2(once!)).toBe(once);
    }
  });
});

describe("formatSigned 判号走字符串域、不经 Number（CALC-02 / Batch09）", () => {
  it(">2^53 的金额不再被 Number 改掉低位与亚分", () => {
    // 旧实现先 Number() 判号再取 Math.abs：1e16 量级 ulp = 2，
    // "10000000000000001.5" → 10000000000000002，输出 "10,000,000,000,000,002.00 CNY"。
    expect(formatSigned("10000000000000001.5", "CNY")).toBe("10,000,000,000,000,001.50 CNY");
    expect(formatSigned("-10000000000000001.5", "CNY")).toBe("−10,000,000,000,000,001.50 CNY");
  });

  it("与 formatNumber 同一量化口径（同一金额不因走哪条路径而差一分）", () => {
    expect(formatSigned("2.675", "CNY")).toBe("2.68 CNY");
    expect(formatSigned("-2.675", "CNY")).toBe("−2.68 CNY");
    expect(formatSigned("2.675", "CNY")).toBe(`${formatNumber("2.675")} CNY`);
  });

  it("亚分负值保留 − 号；恰好归零的 -0 不带符号", () => {
    expect(formatSigned("-0.004", "CNY")).toBe("−0.00 CNY");
    expect(formatSigned("-0", "CNY")).toBe("0.00 CNY");
    expect(formatSigned("-0.00", "CNY")).toBe("0.00 CNY");
    expect(formatSigned("+1234.5", "EUR")).toBe("1,234.50 EUR");
  });

  it("常规正负值与 null 口径不变", () => {
    expect(formatSigned("-12.3", "CNY")).toBe("−12.30 CNY");
    expect(formatSigned("12.3", "CNY")).toBe("12.30 CNY");
    expect(formatSigned(null, "EUR")).toBe("汇率缺失");
    expect(formatSigned(undefined, "EUR")).toBe("汇率缺失");
    // "" 是占位符不是零：输出 "— CNY"，绝不渲染成 "0.00 CNY"。
    expect(formatSigned("", "CNY")).toBe("— CNY");
    expect(formatSigned("abc", "CNY")).toBe("— CNY");
  });
});

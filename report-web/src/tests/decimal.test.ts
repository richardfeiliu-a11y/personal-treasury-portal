import { describe, expect, it } from "vitest";
import { decCompareDesc, decSum, formatDecimal, parseDecimal } from "../utils/decimal";

describe("decimal comparisons", () => {
  it("sorts values above Number.MAX_SAFE_INTEGER without converting the difference", () => {
    const larger = parseDecimal("9007199254740992.01");
    const smaller = parseDecimal("9007199254740992.00");

    expect(larger).not.toBeNull();
    expect(smaller).not.toBeNull();
    expect(decCompareDesc(larger!, smaller!)).toBe(-1);
    expect(decCompareDesc(smaller!, larger!)).toBe(1);
  });

  it("returns zero for equal values with different decimal scales", () => {
    expect(decCompareDesc(parseDecimal("10.0")!, parseDecimal("10.00")!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WP06：现金聚合场景（U02）——缺失与零区分、浮点残差、大额、负值
// ---------------------------------------------------------------------------

describe("decimal aggregation (WP06)", () => {
  it("0.1 + 0.2 精确等于 0.3（不经浮点）", () => {
    const sum = decSum([parseDecimal("0.1")!, parseDecimal("0.2")!]);
    expect(formatDecimal(sum)).toBe("0.3");
  });

  it("大额（2^53 之外）整数求和不丢位", () => {
    const sum = decSum([parseDecimal("10000000000000001")!, parseDecimal("10000000000000002")!]);
    expect(formatDecimal(sum)).toBe("20000000000000003");
  });

  it("负值与正值混合求和", () => {
    const sum = decSum([parseDecimal("-15234.56")!, parseDecimal("15234.55")!, parseDecimal("0.01")!]);
    expect(formatDecimal(sum)).toBe("0");
  });

  it("parseDecimal(null) 返回 null：缺失不当作零（fail-closed 语义）", () => {
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("not-a-number")).toBeNull();
  });

  it("空集合求和为零值而非缺失", () => {
    expect(formatDecimal(decSum([]))).toBe("0");
  });
});

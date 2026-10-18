import { describe, expect, it } from "vitest";
import { reconcileWaterfallData, type IncomeStatementSummaryView } from "../utils/waterfallReconciliation";
import {
  parseDecimal,
  decSum,
  decDiff,
  decEquals,
  decAbs,
  formatDecimal,
} from "../utils/decimal";
import type { ReportEnvelope } from "../api/types";

/** 构造最小可用的 income-statement 信封（expenses 节）。 */
function makeReport(opts: {
  summary: IncomeStatementSummaryView;
  expenseRows: { label: string; currency: string; amount_base: string }[];
  fxComplete?: boolean;
}): ReportEnvelope {
  const expenseSum = opts.expenseRows
    .reduce((acc, r) => acc + Number(r.amount_base), 0)
    .toString();
  return {
    schema_version: "1.0",
    report_id: "test-ie",
    report_type: "income_statement",
    generated_at: "2026-08-09T00:00:00+00:00",
    base_currency: "CNY",
    period: { start_date: "2026-08-01", end_date: "2026-08-31" },
    fx_complete: opts.fxComplete ?? true,
    data_complete: true,
    warnings: [],
    summary: opts.summary as ReportEnvelope["summary"],
    sections: [
      {
        key: "income",
        title: "收入",
        rows: [{ label: "工资", currency: "CNY", amount: "20000", amount_base: "20000", count: 1 }],
        subtotal_base: "20000",
      },
      {
        key: "expenses",
        title: "支出",
        rows: opts.expenseRows.map((r) => ({
          label: r.label,
          currency: r.currency,
          amount: r.amount_base,
          amount_base: r.amount_base,
          count: 1,
        })),
        subtotal_base: expenseSum,
      },
    ],
  };
}

// 计划书示例数据（Task §5 自检）：收入 20000，支出 5 行 4000/2500/1000/600/400，
// 总支出 8500，净 11500，topN=3。
const PLAN_ROWS = [
  { label: "房租", currency: "CNY", amount_base: "4000" },
  { label: "餐饮", currency: "CNY", amount_base: "2500" },
  { label: "交通", currency: "CNY", amount_base: "1000" },
  { label: "娱乐", currency: "CNY", amount_base: "600" },
  { label: "其他", currency: "CNY", amount_base: "400" },
];
const PLAN_SUMMARY: IncomeStatementSummaryView = {
  total_income_cny: "20000",
  total_expenses_cny: "8500",
  net_result_cny: "11500",
};

describe("精确十进制工具", () => {
  it("parseDecimal 解析带亚分精度的字符串，且缺失返回 null 而非 0", () => {
    expect(parseDecimal("15234.567891")).toEqual({ units: 15234567891n, scale: 6 });
    expect(parseDecimal("-15234.567891")).toEqual({ units: -15234567891n, scale: 6 });
    expect(parseDecimal("0")).toEqual({ units: 0n, scale: 0 });
    expect(parseDecimal("0.0")).toEqual({ units: 0n, scale: 1 });
    expect(parseDecimal(".5")).toEqual({ units: 5n, scale: 1 });
    expect(parseDecimal("-0.50")).toEqual({ units: -50n, scale: 2 });
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });

  it("decSum / decDiff / decEquals 精确无残差", () => {
    const a = parseDecimal("5000.111111")!;
    const b = parseDecimal("4999.888889")!;
    const sum = decSum([a, b]);
    expect(decEquals(sum, parseDecimal("10000.000000")!)).toBe(true);
    expect(formatDecimal(sum)).toBe("10000");
    const d = decDiff(a, b);
    expect(formatDecimal(decAbs(d))).toBe("0.222222");
  });
});

describe("reconcileWaterfallData 门禁（G0~G3）", () => {
  it("G0：summary 字段缺失 → 阻断", () => {
    const r = makeReport({
      summary: { total_income_cny: "20000", total_expenses_cny: null, net_result_cny: "11500" },
      expenseRows: PLAN_ROWS,
    });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(false);
    expect(res.steps).toHaveLength(0);
    expect(res.error).toContain("数据不完整");
  });

  it("G0：无 expenses 节 → 阻断", () => {
    const r = makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS });
    const noExpense = { ...r, sections: r.sections.filter((s) => s.key !== "expenses") };
    const res = reconcileWaterfallData(noExpense);
    expect(res.is_complete).toBe(false);
    expect(res.error).toContain("expenses");
  });

  it("G1：fx_complete=false → 渲染可用数据 + fx_incomplete 标记", () => {
    const r = makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS, fxComplete: false });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(true);
    expect(res.fx_incomplete).toBe(true);
    expect(res.steps.length).toBeGreaterThan(0);
    expect(res.error).toBeNull();
  });

  it("G1：明细存在 amount_base=null 行 → 过滤缺汇率行，渲染可用数据 + fx_incomplete", () => {
    const r = makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS });
    // Set only SOME rows to null (not all) — keep at least one valid row
    const expIdx = r.sections.findIndex((s) => s.key === "expenses");
    const rows = r.sections[expIdx].rows.map((row, i) =>
      i === 0 ? { ...row, amount_base: null as any } : row,
    );
    r.sections[expIdx] = { ...r.sections[expIdx], rows };
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(true);
    expect(res.fx_incomplete).toBe(true);
    expect(res.steps.length).toBeGreaterThan(0);
  });

  it("G1：所有明细均缺 amount_base → 阻断", () => {
    const r = makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS });
    const expIdx = r.sections.findIndex((s) => s.key === "expenses");
    r.sections[expIdx] = { ...r.sections[expIdx], rows: r.sections[expIdx].rows.map((row) => ({ ...row, amount_base: null as any })) };
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(false);
    expect(res.fx_incomplete).toBe(true);
    expect(res.error).toContain("汇率不完整");
  });

  it("G2：合计内部不一致（净结余≠收入−支出）→ 阻断并披露差额", () => {
    const r = makeReport({
      summary: { total_income_cny: "20000", total_expenses_cny: "8500", net_result_cny: "9999" },
      expenseRows: PLAN_ROWS,
    });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(false);
    expect(res.error).toContain("合计内部不一致");
    expect(res.error).toContain("1501"); // 11500 − 9999 = 1501
  });

  it("G3：明细合计≠权威总支出 → 阻断并披露差额（核心门禁，绝非恒真式）", () => {
    // 明细 5 行求和 8400，但权威总支出声称为 8500 → 差 100
    const rows = PLAN_ROWS.map((r, i) => (i === 4 ? { ...r, amount_base: "300" } : r));
    const r = makeReport({ summary: PLAN_SUMMARY, expenseRows: rows });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(false);
    expect(res.error).toContain("明细合计与权威总支出差");
    expect(res.error).toContain("100 CNY");
  });

  it("R-D18：亚分精度金额可端到端解析并对平（单行，仅验证解析不截断）", () => {
    const r = makeReport({
      summary: { total_income_cny: "15234.567891", total_expenses_cny: "15234.567891", net_result_cny: "0" },
      expenseRows: [{ label: "餐饮", currency: "CNY", amount_base: "15234.567891" }],
    });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(true);
    expect(res.error).toBeNull();
    expect(res.steps).toHaveLength(3); // 总收入 + 1 支出 + 净结余
  });

  // ↓↓↓ 以下两条是 R-D18 的**区分性**用例：若把 decEquals 换成浮点或"四舍五入到分"，
  // 它们必然失败。单行用例做不到这一点（单行求和恒等于自身），故必须多行累加。
  it("R-D18 区分性①：多行浮点累加有残差的场景仍精确对平", () => {
    // 前提固化：0.1 + 0.2 在 IEEE-754 双精度下 ≠ 0.3，这是浮点实现的必败点
    expect(Number("0.1") + Number("0.2")).not.toBe(Number("0.3"));

    const r = makeReport({
      summary: { total_income_cny: "0.3", total_expenses_cny: "0.3", net_result_cny: "0" },
      expenseRows: [
        { label: "甲", currency: "CNY", amount_base: "0.1" },
        { label: "乙", currency: "CNY", amount_base: "0.2" },
      ],
    });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(true);
    expect(res.error).toBeNull();
    expect(res.steps).toHaveLength(4); // 总收入 + 2 支出 + 净结余
  });

  it("R-D18 区分性②：亚分金额下「先舍入再求和」会误判，精确十进制不会", () => {
    // 前提固化：舍入到分后 0.005+0.005 → 1分+1分=2分，而总额 0.01 → 1分，故必误判为不平
    const roundToCents = (s: string) => Math.round(Number(s) * 100);
    expect(roundToCents("0.005") + roundToCents("0.005")).not.toBe(roundToCents("0.01"));

    const r = makeReport({
      summary: { total_income_cny: "0.01", total_expenses_cny: "0.01", net_result_cny: "0" },
      expenseRows: [
        { label: "甲", currency: "CNY", amount_base: "0.005" },
        { label: "乙", currency: "CNY", amount_base: "0.005" },
      ],
    });
    const res = reconcileWaterfallData(r);
    expect(res.is_complete).toBe(true);
    expect(res.error).toBeNull();
    expect(res.steps).toHaveLength(4);
  });
});

describe("reconcileWaterfallData steps 几何（Task §5 自检，topN=3）", () => {
  const res = reconcileWaterfallData(makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS }), 3);

  it("门禁通过且共 6 步", () => {
    expect(res.is_complete).toBe(true);
    expect(res.steps).toHaveLength(6);
  });

  it("各步 base/value 与权威标签正确（label 字段，非 name）", () => {
    expect(res.steps[0]).toEqual({ label: "总收入", amount: "20000", type: "income", base: 0, value: 20000 });
    expect(res.steps[1]).toEqual({ label: "房租", amount: "4000", type: "expense", base: 16000, value: 4000 });
    expect(res.steps[4]).toEqual({ label: "其他支出", amount: "1000", type: "expense", base: 11500, value: 1000 });
    expect(res.steps[5]).toEqual({ label: "本期净结余", amount: "11500", type: "total", base: 0, value: 11500 });
  });

  it("本期净结余取权威值，不取累加结果", () => {
    expect(res.steps[5].amount).toBe("11500");
  });
});

describe("reconcileWaterfallData topN 只影响分组展示", () => {
  it("topN=5（全量）时不产生「其他支出」步", () => {
    const res = reconcileWaterfallData(makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS }), 5);
    expect(res.steps).toHaveLength(7); // 1 收入 + 5 支出 + 1 净结余
    expect(res.steps.some((s) => s.label === "其他支出")).toBe(false);
  });

  it("重名分类按币种消歧", () => {
    const rows = [
      { label: "餐饮", currency: "CNY", amount_base: "600" },
      { label: "餐饮", currency: "EUR", amount_base: "400" },
    ];
    const res = reconcileWaterfallData(
      makeReport({
        summary: { total_income_cny: "1000", total_expenses_cny: "1000", net_result_cny: "0" },
        expenseRows: rows,
      }),
    );
    const labels = res.steps.map((s) => s.label);
    expect(labels).toContain("餐饮 (CNY)");
    expect(labels).toContain("餐饮 (EUR)");
  });

  it("不重名分类保持原 label 不加后缀", () => {
    const res = reconcileWaterfallData(makeReport({ summary: PLAN_SUMMARY, expenseRows: PLAN_ROWS }), 3);
    expect(res.steps[1].label).toBe("房租");
  });
});

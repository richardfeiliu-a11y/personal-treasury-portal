// WP2：compositionSeries 纯函数单测（spec §10.1 全矩阵）。
// 只测纯计算：不依赖 DOM / ECharts / React Query。
import { describe, expect, it } from "vitest";

import type {
  IncomeStatementSummary,
  PersonalBalanceSheet,
  ReportEnvelope,
  ReportSection,
  WebAccountGroup,
  WebAccountRow,
} from "../api/types";
import {
  deriveBalanceSheetComposition,
  deriveIncomeComposition,
  type SelectionState,
} from "../utils/compositionSeries";

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

function acct(
  id: string,
  name: string,
  currency: string,
  balanceNative: string,
  balanceBase: string | null,
): WebAccountRow {
  return {
    id, name, currency, balance_native: balanceNative, balance_base: balanceBase,
    active: true, include_net_worth: true,
  };
}

function group(
  key: string,
  title: string,
  side: "asset" | "liability",
  accounts: WebAccountRow[],
  subtotalBase: string | null,
): WebAccountGroup {
  return { key, title, side, subtotal_base: subtotalBase, accounts };
}

function balanceSheet(partial: {
  groups?: WebAccountGroup[];
  totalAssets?: string | null;
  totalLiabilities?: string | null;
  fxComplete?: boolean;
}): PersonalBalanceSheet {
  return {
    schema_version: "1.0",
    source: "firefly_live",
    generated_at: "2026-08-22T00:00:00+00:00",
    base_currency: "CNY",
    balance_as_of: "2026-08-22",
    fx_complete: partial.fxComplete ?? true,
    missing_currencies: [],
    warnings: [],
    summary: {
      total_assets_base: partial.totalAssets ?? "0",
      total_liabilities_base: partial.totalLiabilities ?? "0",
      net_worth_base: "0",
      included_account_count: 0,
      pending_mapping_count: 0,
    },
    groups: partial.groups ?? [],
  };
}

function section(key: string, title: string, rows: Array<Partial<ReportSection["rows"][number]>>): ReportSection {
  return {
    key, title,
    rows: rows.map((r, i) => ({
      label: r.label ?? `label-${i}`,
      currency: r.currency ?? "CNY",
      amount: r.amount ?? "0",
      // 显式 null 必须保留（fx fail-closed），不要用 ?? 回退吞掉
      amount_base: r.amount_base !== undefined ? r.amount_base : (r.amount ?? null),
      count: r.count ?? 1,
      extra: r.extra,
    })),
    subtotal_base: null,
  };
}

function incomeEnvelope(partial: {
  income?: ReportSection;
  expenses?: ReportSection;
  totalIncome?: string | null;
  totalExpenses?: string | null;
  fxComplete?: boolean;
  missingCurrencies?: string[];
  accountingView?: "native" | "management";
}): ReportEnvelope<IncomeStatementSummary> {
  return {
    schema_version: "1.0",
    report_id: "r1",
    report_type: "income_statement",
    generated_at: "2026-08-22T00:00:00+00:00",
    base_currency: "CNY",
    period: { start_date: "2026-08-01", end_date: "2026-08-31" },
    accounting_view: partial.accountingView ?? "management",
    fx_complete: partial.fxComplete ?? true,
    data_complete: partial.fxComplete ?? true,
    warnings: [],
    summary: {
      accounting_view: partial.accountingView ?? "management",
      total_income_cny: partial.totalIncome ?? "0",
      total_expenses_cny: partial.totalExpenses ?? "0",
      net_result_cny: "0",
      savings_rate_pct: null,
      missing_currencies: partial.missingCurrencies ?? [],
    },
    sections: [
      partial.income ?? section("income", "收入", []),
      partial.expenses ?? section("expenses", "费用", []),
    ],
  };
}

const ALL: SelectionState = { kind: "all" };
const include = (...keys: string[]): SelectionState => ({ kind: "include", keys: new Set(keys) });

// ---------------------------------------------------------------------------
// Income：label 聚合 / Decimal 精度 / 符号
// ---------------------------------------------------------------------------

describe("deriveIncomeComposition — aggregation", () => {
  it("aggregates same label across currencies with exact Decimal (0.1 + 0.2)", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "餐饮", currency: "CNY", amount: "0.1", amount_base: "0.1" },
          { label: "餐饮", currency: "EUR", amount: "0.2", amount_base: "0.2" },
        ]),
        totalExpenses: "0.3",
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items).toHaveLength(1);
    expect(model.items[0].label).toBe("餐饮");
    expect(model.items[0].amountText).toBe("0.3"); // 不出现 0.30000000000000004
    expect(model.grossText).toBe("0.3");
  });

  it("decides sign only after label aggregation: +100 + (-150) becomes offset-only", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "购物", currency: "CNY", amount: "100", amount_base: "100" },
          { label: "购物", currency: "CNY", amount: "-150", amount_base: "-150" },
        ]),
        totalExpenses: "-50",
      }),
      side: "expense",
      selection: ALL,
    });
    // 聚合后净额为负：无正向扇区 → offset-only（§4.5 step 9），不 abs、不画空圆
    expect(model.status).toBe("offset-only");
    if (model.status !== "offset-only") return;
    expect(model.offsets).toHaveLength(1);
    expect(model.offsets[0].signedAmountText).toBe("-50");
    expect(model.netText).toBe("-50");
  });

  it("sorts by Decimal compare beyond 2^53", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "A", amount_base: "9007199254740993" }, // 2^53 + 1（大者）
          { label: "B", amount_base: "9007199254740992" }, // 2^53
        ]),
        totalExpenses: "18014398509481985",
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items.map((i) => i.label)).toEqual(["A", "B"]);
  });

  it("consumes only the current side section (income vs expenses)", () => {
    const report = incomeEnvelope({
      income: section("income", "收入", [
        { label: "工资", amount_base: "5000" },
      ]),
      expenses: section("expenses", "费用", [
        { label: "餐饮", amount_base: "100" },
      ]),
      totalIncome: "5000",
      totalExpenses: "100",
    });
    const income = deriveIncomeComposition({ report, side: "income", selection: ALL });
    const expense = deriveIncomeComposition({ report, side: "expense", selection: ALL });
    expect(income.status).toBe("ready");
    expect(expense.status).toBe("ready");
    if (income.status !== "ready" || expense.status !== "ready") return;
    expect(income.items[0].label).toBe("工资");
    expect(expense.items[0].label).toBe("餐饮");
  });
});

// ---------------------------------------------------------------------------
// Top7 + Other
// ---------------------------------------------------------------------------

describe("Top7 + Other", () => {
  function manyLabels(n: number): Array<Partial<ReportSection["rows"][number]>> {
    return Array.from({ length: n }, (_, i) => ({
      label: `类目${String(i + 1).padStart(2, "0")}`,
      amount_base: String(10 + i), // 10..10+n-1 严格递增，排序确定
    }));
  }
  function sumOfRange(from: number, to: number): number {
    let s = 0;
    for (let i = from; i <= to; i += 1) s += i;
    return s;
  }
  const totalOf = (n: number) => sumOfRange(10, 10 + n - 1);

  it("uses no Other with exactly 7 positive items", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", manyLabels(7)),
        totalExpenses: String(totalOf(7)),
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items).toHaveLength(7);
    expect(model.other).toBeNull();
  });

  it("uses Top7 + Other with 8 items; Other amount is exact gross − topSum", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          ...manyLabels(7),
          { label: "其他小额", amount_base: "0.1" },
        ]),
        totalExpenses: String(totalOf(7) + 0.1),
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items).toHaveLength(7);
    expect(model.other).not.toBeNull();
    expect(model.other?.children.map((c) => c.label)).toEqual(["其他小额"]);
    expect(model.other?.amountText).toBe("0.1"); // exact Decimal 差
    expect(model.grossText).toBe(String(totalOf(7) + 0.1));
  });

  it("keeps every rest item as Other child with 20 items, ordered by amount desc", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", manyLabels(20)),
        totalExpenses: String(totalOf(20)),
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items).toHaveLength(7);
    expect(model.other?.children).toHaveLength(13);
    // Top7 为金额最大的 7 项：类目20..类目14（金额 29..23）
    expect(model.items.map((i) => i.label)).toEqual(
      ["类目20", "类目19", "类目18", "类目17", "类目16", "类目15", "类目14"],
    );
    // Other 子行同样按金额降序
    expect(model.other?.children[0].label).toBe("类目13");
    expect(model.other?.children[12].label).toBe("类目01");
  });
});

// ---------------------------------------------------------------------------
// Income：reconciliation / blocked 状态
// ---------------------------------------------------------------------------

describe("deriveIncomeComposition — states", () => {
  it("is ready when gross − offsets equals summary total exactly", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "餐饮", amount_base: "300" },
          { label: "住房", amount_base: "200" },
          { label: "购物", amount_base: "-50" }, // refund offset
        ]),
        totalExpenses: "450",
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.offsetTotalText).toBe("50");
    expect(model.netText).toBe("450");
    expect(model.percentageContext).toBe("total");
  });

  it("is contract-blocked when full-section control fails, even if a filtered subset reconciles", () => {
    const report = incomeEnvelope({
      expenses: section("expenses", "费用", [
        { label: "餐饮", amount_base: "300" },
        { label: "误差源", amount_base: "200" },
      ]),
      totalExpenses: "499", // ≠ 500 → 全量勾稽失败
    });
    const model = deriveIncomeComposition({
      report,
      side: "expense",
      selection: include("餐饮"), // 子集自身可对平也不得画 Donut
    });
    expect(model.status).toBe("contract-blocked");
    if (model.status !== "contract-blocked") return;
    expect(model.controlText).toBe("499");
    expect(model.derivedText).toBe("500");
    expect(model.differenceText).toBe("-1");
  });

  it("is contract-blocked when accounting_view is native", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [{ label: "餐饮", amount_base: "1" }]),
        totalExpenses: "1",
        accountingView: "native",
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
  });

  it("is fx-blocked immediately when fx_complete=false; discloses rows by currency with native amounts", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "餐饮", currency: "EUR", amount: "10", amount_base: null },
          { label: "购物", currency: "EUR", amount: "100", amount_base: null },
          { label: "房租", currency: "CNY", amount: "3000", amount_base: null },
        ]),
        fxComplete: false,
        missingCurrencies: ["EUR"],
        totalExpenses: null,
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("fx-blocked");
    if (model.status !== "fx-blocked") return;
    expect(model.missingCurrencies).toEqual(["EUR"]);
    expect(model.subjectLabel).toBe("支出");
    // 按 currency 分组（字母序）、组内绝对金额降序；amount_base 为 null（fail closed）
    expect(model.rows.map((r) => r.label)).toEqual(["房租", "购物", "餐饮"]);
    expect(model.rows.every((r) => r.baseAmount === null)).toBe(true);
  });

  it("is offset-only when section has only negative labels; net is negative, no donut items", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        income: section("income", "收入", [
          { label: "工资", amount_base: "-120" }, // income reversal 净冲回
        ]),
        totalIncome: "-120",
      }),
      side: "income",
      selection: ALL,
    });
    expect(model.status).toBe("offset-only");
    if (model.status !== "offset-only") return;
    expect(model.grossText).toBe("0");
    expect(model.offsetTotalText).toBe("120");
    expect(model.netText).toBe("-120");
  });

  it("is empty when side section has no rows", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({ income: section("income", "收入", []), totalIncome: "0" }),
      side: "income",
      selection: ALL,
    });
    expect(model.status).toBe("empty");
    if (model.status !== "empty") return;
    expect(model.title).toBe("本期无收入记录");
  });

  it("is filtered-empty when selection matches no labels", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [{ label: "餐饮", amount_base: "10" }]),
        totalExpenses: "10",
      }),
      side: "expense",
      selection: include("不存在"),
    });
    expect(model.status).toBe("filtered-empty");
  });

  it("filtered scope uses selected labels as denominator and reports filtered context", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "餐饮", amount_base: "300" },
          { label: "住房", amount_base: "100" },
        ]),
        totalExpenses: "400",
      }),
      side: "expense",
      selection: include("餐饮"),
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.percentageContext).toBe("filtered");
    expect(model.grossText).toBe("300");
    expect(model.items[0].percentage).toBe(100);
  });

  it("is contract-blocked on invalid decimal amount_base", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "餐饮", amount: "1", amount_base: "abc" },
        ]),
        totalExpenses: "1",
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
  });

  it("is contract-blocked when decToNumber is non-finite (amount beyond double range)", () => {
    const huge = "1" + "0".repeat(400);
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [{ label: "巨款", amount_base: huge }]),
        totalExpenses: huge,
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
    if (model.status !== "contract-blocked") return;
    // 仍提供 amount-only 披露
    expect(model.rows[0].amountText).toBe(huge);
  });
});

// ---------------------------------------------------------------------------
// BalanceSheet adapter
// ---------------------------------------------------------------------------

describe("deriveBalanceSheetComposition — asset semantics", () => {
  const cashGroup = (extra: WebAccountRow[] = [], subtotal: string | null = null) =>
    group("cash", "现金", "asset",
      [acct("a1", "银行甲", "CNY", "1000", "1000"), acct("a2", "Wallet A", "CNY", "500", "500"), ...extra],
      subtotal);

  it("aggregates positive accounts by group; negative accounts go to offsets, never into slices", () => {
    const margin = acct("a3", "保证金", "CNY", "-200", "-200");
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [
          cashGroup([margin]),
          group("invest", "投资", "asset", [acct("a4", "Broker A", "CNY", "800", "800")], "800"),
        ],
        totalAssets: "2100", // 1000 + 500 - 200 + 800
      }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items.map((i) => [i.key, i.amountText])).toEqual([
      ["cash", "1500"], // 只含正向账户，不含 -200
      ["invest", "800"],
    ]);
    expect(model.offsets.map((o) => [o.label, o.signedAmountText])).toEqual([["保证金", "-200"]]);
    expect(model.grossText).toBe("2300");
    expect(model.offsetTotalText).toBe("200");
    expect(model.netText).toBe("2100");
    expect(model.percentageContext).toBe("total");
  });

  it("shows all non-zero positive groups at top level without Top7", () => {
    const groups = Array.from({ length: 9 }, (_, i) =>
      group(`g${i}`, `组${i}`, "asset", [acct(`a${i}`, `账户${i}`, "CNY", "100", "100")], "100"));
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({ groups, totalAssets: "900" }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items).toHaveLength(9);
    expect(model.other).toBeNull();
  });

  it("drill-down keys items by account and reconciles against group subtotal", () => {
    const margin = acct("a3", "保证金", "CNY", "-200", "-200");
    const zero = acct("a5", "空账户", "CNY", "0", "0");
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [cashGroup([margin, zero], "1300")],
        totalAssets: "1300",
      }),
      side: "asset",
      groupKey: "cash",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items.map((i) => [i.key, i.label])).toEqual([["a1", "银行甲"], ["a2", "Wallet A"]]);
    expect(model.offsets.map((o) => o.key)).toEqual(["a3"]);
    expect(model.zeroItems.map((z) => z.key)).toEqual(["a5"]);
    expect(model.netText).toBe("1300"); // 1500 − 200 = subtotal_base
  });

  it("drill-down with more than 7 positive accounts uses Top7 + Other", () => {
    const accounts = Array.from({ length: 9 }, (_, i) =>
      acct(`a${i}`, `账户${i}`, "CNY", String(100 + i), String(100 + i))); // 100..108
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("cash", "现金", "asset", accounts, "936")],
        totalAssets: "936",
      }),
      side: "asset",
      groupKey: "cash",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items).toHaveLength(7);
    expect(model.items[0].label).toBe("账户8"); // 108 最大
    expect(model.other?.children.map((c) => c.label)).toEqual(["账户1", "账户0"]); // 101,100 降序
    expect(model.other?.amountText).toBe("201");
  });

  it("is contract-blocked when top-level control mismatches (difference visible, not in Other)", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [cashGroup()],
        totalAssets: "1400", // ≠ 1500
      }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
    if (model.status !== "contract-blocked") return;
    expect(model.controlText).toBe("1400");
    expect(model.derivedText).toBe("1500");
    expect(model.differenceText).toBe("-100");
  });

  it("is contract-blocked on liability negative balance_base (no frontend abs)", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("credit", "信用卡", "liability",
          [acct("l1", "Card A", "CNY", "-30", "-30")], "-30")],
        totalLiabilities: "-30",
      }),
      side: "liability",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
    if (model.status !== "contract-blocked") return;
    expect(model.rows[0].amountText).toBe("-30"); // 负号保留
  });

  it("filtered scope derives control from selected leaves and marks filtered context", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [cashGroup()],
        totalAssets: "1500",
      }),
      side: "asset",
      groupKey: null,
      selection: include("a2"), // 只选 Wallet A 500
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.percentageContext).toBe("filtered");
    expect(model.grossText).toBe("500");
    expect(model.items[0].percentage).toBe(100);
  });

  it("filtered scope with only a negative account is offset-only", () => {
    const margin = acct("a3", "保证金", "CNY", "-200", "-200");
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [cashGroup([margin])],
        totalAssets: "1300",
      }),
      side: "asset",
      groupKey: null,
      selection: include("a3"),
    });
    expect(model.status).toBe("offset-only");
    if (model.status !== "offset-only") return;
    expect(model.netText).toBe("-200");
  });

  it("filtered scope selecting zero existing keys is filtered-empty", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({ groups: [cashGroup()], totalAssets: "1500" }),
      side: "asset",
      groupKey: null,
      selection: include(), // 显式空集
    });
    expect(model.status).toBe("filtered-empty");
  });

  it("empty side reports empty state", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({ groups: [], totalAssets: "0", totalLiabilities: "0" }),
      side: "liability",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("empty");
    if (model.status !== "empty") return;
    expect(model.title).toBe("暂无负债数据");
  });
});

describe("deriveBalanceSheetComposition — FX fail closed", () => {
  it("blocks when a selected non-zero account has null balance_base; discloses blocked rows", () => {
    const blocked = acct("h1", "Bank B", "HKD", "100", null);
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("cash", "现金", "asset",
          [acct("a1", "银行甲", "CNY", "1000", "1000"), blocked], null)],
        totalAssets: null,
        fxComplete: false,
      }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("fx-blocked");
    if (model.status !== "fx-blocked") return;
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      groupLabel: "现金", label: "Bank B", currency: "HKD", nativeAmount: "100", baseAmount: null,
    });
    expect(model.missingCurrencies).toEqual(["HKD"]);
    expect(model.subjectLabel).toBe("资产");
  });

  it("does not block on zero-native accounts with null base, and excludes them via filter", () => {
    const zeroNull = acct("z1", "空港币户", "HKD", "0", null);
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("cash", "现金", "asset",
          [acct("a1", "银行甲", "CNY", "1000", "1000"), zeroNull], "1000")],
        totalAssets: "1000",
      }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("ready"); // zero null 不阻断
    // 排除 missing account 后允许正确 filtered scope
    const filtered = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("cash", "现金", "asset",
          [acct("a1", "银行甲", "CNY", "1000", "1000"), zeroNull], "1000")],
        totalAssets: "1000",
      }),
      side: "asset",
      groupKey: null,
      selection: include("a1"),
    });
    expect(filtered.status).toBe("ready");
    if (filtered.status !== "ready") return;
    expect(filtered.percentageContext).toBe("filtered");
  });

  it("blocks the filtered scope only when the blocked account is inside the selection", () => {
    const blocked = acct("h1", "Bank B", "HKD", "100", null);
    const data = balanceSheet({
      groups: [group("cash", "现金", "asset",
        [acct("a1", "银行甲", "CNY", "1000", "1000"), blocked], null)],
      totalAssets: null,
      fxComplete: false,
    });
    const scoped = deriveBalanceSheetComposition({
      data, side: "asset", groupKey: null, selection: include("h1"),
    });
    expect(scoped.status).toBe("fx-blocked");
  });

  it("is contract-blocked on invalid balance_base decimal", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("cash", "现金", "asset",
          [acct("a1", "银行甲", "CNY", "1000", "oops")], null)],
        totalAssets: null,
      }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
  });

  it("is contract-blocked when control total is null but scope leaves are complete", () => {
    const model = deriveBalanceSheetComposition({
      data: balanceSheet({
        groups: [group("cash", "现金", "asset",
          [acct("a1", "银行甲", "CNY", "1000", "1000")], "1000")],
        totalAssets: null, // 与 leaf 状态矛盾
      }),
      side: "asset",
      groupKey: null,
      selection: ALL,
    });
    expect(model.status).toBe("contract-blocked");
  });
});

// ---------------------------------------------------------------------------
// Percentage 渲染边界
// ---------------------------------------------------------------------------

describe("percentage (render-only)", () => {
  it("rounds to 1 decimal and never feeds back into ordering or gating", () => {
    const model = deriveIncomeComposition({
      report: incomeEnvelope({
        expenses: section("expenses", "费用", [
          { label: "A", amount_base: "1" },
          { label: "B", amount_base: "2" },
        ]),
        totalExpenses: "3",
      }),
      side: "expense",
      selection: ALL,
    });
    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.items[0].percentage).toBe(66.7); // B
    expect(model.items[1].percentage).toBe(33.3); // A
    // colorIndex 连续分配
    expect(model.items.map((i) => i.colorIndex)).toEqual([0, 1]);
  });
});
